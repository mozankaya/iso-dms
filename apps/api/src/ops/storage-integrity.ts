import { createHash } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client';
import type { ObjectStorage } from '../modules/storage/object-storage';

/**
 * Checks that what the database says is stored really is (PROJECT.md 11.2): every revision file and PDF copy exists
 * and has the SHA-256 the database recorded when it was saved. It is the proof that a backup can be trusted (the
 * restore drill runs it against the restored copy) and it also finds damage in a live installation.
 * Read only: nothing is written or repaired.
 */

export interface IntegrityProblem {
  kind: 'REVISION_FILE' | 'PDF_COPY' | 'TEMPLATE_FILE';
  problem: 'MISSING' | 'CHECKSUM_MISMATCH';
  /** The revision or template the object belongs to */
  id: string;
  storageKey: string;
}

export interface DatabaseGuards {
  /** The triggers that keep the audit trail and the feedback records from being changed (PROJECT.md 6.6, 6.8) */
  auditLogAppendOnly: boolean;
  auditLogNoTruncate: boolean;
  feedbackProtected: boolean;
}

export interface IntegrityCounts {
  organizations: number;
  documents: number;
  revisions: number;
  users: number;
  auditLogs: number;
  feedback: number;
}

export interface IntegrityReport {
  checked: { revisionFiles: number; pdfCopies: number; templateFiles: number };
  problems: IntegrityProblem[];
  guards: DatabaseGuards;
  counts: IntegrityCounts;
  ok: boolean;
}

const PARALLEL = 4;

async function sha256Of(storage: ObjectStorage, key: string): Promise<string | null> {
  const stream = await storage.tryGetStream(key);
  if (!stream) return null;
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Runs the checks `PARALLEL` at a time; the files can be large and the storage is shared with the application. */
async function inBatches<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(work));
}

export async function collectCounts(prisma: PrismaClient): Promise<IntegrityCounts> {
  const [organizations, documents, revisions, users, auditLogs, feedback] = await Promise.all([
    prisma.organization.count(),
    prisma.document.count(),
    prisma.revision.count(),
    prisma.user.count(),
    prisma.auditLog.count(),
    prisma.feedback.count(),
  ]);
  return { organizations, documents, revisions, users, auditLogs, feedback };
}

async function checkGuards(prisma: PrismaClient): Promise<DatabaseGuards> {
  const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('AuditLog_append_only', 'AuditLog_no_truncate', 'Feedback_protect_record')`;
  const names = new Set(triggers.map((trigger) => trigger.tgname));
  return {
    auditLogAppendOnly: names.has('AuditLog_append_only'),
    auditLogNoTruncate: names.has('AuditLog_no_truncate'),
    feedbackProtected: names.has('Feedback_protect_record'),
  };
}

export async function verifyStorageIntegrity(prisma: PrismaClient, storage: ObjectStorage): Promise<IntegrityReport> {
  const problems: IntegrityProblem[] = [];

  const revisions = await prisma.revision.findMany({
    select: { id: true, storageKey: true, checksum: true, pdfStatus: true, pdfStorageKey: true, pdfChecksum: true },
    orderBy: { createdAt: 'asc' },
  });
  const pdfCopies = revisions.filter((revision) => revision.pdfStatus === 'READY' && revision.pdfStorageKey);
  const templates = await prisma.template.findMany({ select: { id: true, storageKey: true } });

  await inBatches(revisions, async (revision) => {
    const actual = await sha256Of(storage, revision.storageKey);
    if (actual === null) problems.push({ kind: 'REVISION_FILE', problem: 'MISSING', id: revision.id, storageKey: revision.storageKey });
    else if (actual !== revision.checksum) {
      problems.push({ kind: 'REVISION_FILE', problem: 'CHECKSUM_MISMATCH', id: revision.id, storageKey: revision.storageKey });
    }
  });

  await inBatches(pdfCopies, async (revision) => {
    const key = revision.pdfStorageKey!;
    const actual = await sha256Of(storage, key);
    if (actual === null) problems.push({ kind: 'PDF_COPY', problem: 'MISSING', id: revision.id, storageKey: key });
    // A copy made before its checksum was recorded has none to compare
    else if (revision.pdfChecksum && actual !== revision.pdfChecksum) {
      problems.push({ kind: 'PDF_COPY', problem: 'CHECKSUM_MISMATCH', id: revision.id, storageKey: key });
    }
  });

  // Templates are not records and have no checksum: they only have to exist
  await inBatches(templates, async (template) => {
    if (!(await storage.exists(template.storageKey))) {
      problems.push({ kind: 'TEMPLATE_FILE', problem: 'MISSING', id: template.id, storageKey: template.storageKey });
    }
  });

  const guards = await checkGuards(prisma);
  const counts = await collectCounts(prisma);
  problems.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  return {
    checked: { revisionFiles: revisions.length, pdfCopies: pdfCopies.length, templateFiles: templates.length },
    problems,
    guards,
    counts,
    ok: problems.length === 0 && guards.auditLogAppendOnly && guards.auditLogNoTruncate && guards.feedbackProtected,
  };
}
