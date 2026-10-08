process.env.LOGIN_RATE_LIMIT = '1000';
// The queue and its worker (they need Redis) exist only when this is not 'false'; read when the module is loaded
process.env.PDF_WORKER_ENABLED = 'true';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { UserRole } from '../src/generated/prisma/enums';
import { PDF_QUEUE } from '../src/modules/pdf/pdf.constants';
import { PdfQueueService } from '../src/modules/pdf/pdf-queue.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { publishThroughApproval } from './helpers/approval-flow';
import { createTestApp } from './helpers/create-test-app';
import { startFakeConverterServer, type FakeConverterServer } from './helpers/fake-converter-server';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let app: INestApplication;
let storage: StorageService;
let queueService: PdfQueueService;
let queue: Queue;
let converter: FakeConverterServer;
let blankDocx: Buffer;
let organizationId: string;
let departmentId: string;
let categoryId: string;
type Label = 'editor' | 'approver' | 'qm';
const users = {} as Record<Label, { id: string; token: string }>;
let counter = 0;

const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function newRevision(options: { published: boolean }) {
  const sequenceNo = 800 + counter++;
  const document = await prisma.document.create({
    data: {
      organizationId, categoryId, departmentId, ownerId: users.editor.id,
      code: `PQ-AA-${sequenceNo}`, sequenceNo, title: 'Kuyruk denemesi', fileType: 'DOCX',
      status: options.published ? 'PUBLISHED' : 'DRAFT',
    },
  });
  const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: 0, fileType: 'DOCX' });
  await storage.put(storageKey, blankDocx, 'application/octet-stream');
  return prisma.revision.create({
    data: {
      organizationId, documentId: document.id, revisionNo: 0, storageKey, fileSize: blankDocx.length,
      checksum: createHash('sha256').update(blankDocx).digest('hex'), editorKey: randomUUID(), preparedById: users.editor.id,
      ...(options.published && { status: 'APPROVED' as const, publishedAt: new Date(), pdfStatus: 'PENDING' as const }),
    },
  });
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  converter = await startFakeConverterServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = converter.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  queueService = app.get(PdfQueueService);
  queue = app.get<Queue>(getQueueToken(PDF_QUEUE));
  await queue.obliterate({ force: true });

  const organization = await prisma.organization.create({ data: { name: `Queue ${suffix}`, slug: `queue-${suffix}` } });
  organizationId = organization.id;
  departmentId = (await prisma.department.create({ data: { organizationId, name: 'Alpha', code: 'AA' } })).id;
  categoryId = (await prisma.category.create({ data: { organizationId, name: 'Main', slug: 'main', codePrefix: 'PQ' } })).id;
  const make = async (label: Label, role: UserRole) => {
    const user = await prisma.user.create({ data: { organizationId, departmentId, email: `${label}@queue.local`, fullName: label, passwordHash: 'x', role } });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId, role, departmentId }) };
  };
  await make('editor', 'EDITOR');
  await make('approver', 'APPROVER');
  await make('qm', 'QUALITY_MANAGER');
});

beforeEach(() => converter.reset());

afterAll(async () => {
  // The worker stops first: a conversion still running would write its audit entry after the cleanup
  await queue.obliterate({ force: true }).catch(() => undefined);
  await app.close();
  const revisions = await prisma.revision.findMany({ where: { organizationId }, select: { storageKey: true, pdfStorageKey: true } });
  await Promise.all(revisions.flatMap((r) => [r.storageKey, r.pdfStorageKey]).filter((key): key is string => !!key).map((key) => storage.delete(key).catch(() => undefined)));
  await deleteAuditLogs(prisma, { organizationId });
  await prisma.approvalStep.deleteMany({ where: { organizationId } });
  await prisma.documentRequest.deleteMany({ where: { organizationId } });
  await prisma.document.updateMany({ where: { organizationId }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId } });
  await prisma.document.deleteMany({ where: { organizationId } });
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.department.deleteMany({ where: { organizationId } });
  await prisma.category.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
  await converter.close();
});

describe('the queue (needs Redis)', () => {
  it('makes the copy after the last approval, without anybody asking for it', async () => {
    const revision = await newRevision({ published: false });

    const detail = await publishThroughApproval(app, { revisionId: revision.id, submitToken: users.editor.token, approverToken: users.approver.token, qualityToken: users.qm.token });

    expect(detail.status).toBe('PUBLISHED');
    const done = await waitFor(() => revisionRow(revision.id), (row) => row.pdfStatus === 'READY');
    expect(done).toMatchObject({ pdfStatus: 'READY', status: 'APPROVED' });
    expect(done.pdfStorageKey).toMatch(/\.pdf$/);
    expect(await storage.exists(done.pdfStorageKey!)).toBe(true);
    expect(converter.requests).toHaveLength(1);
  });

  it('picks up a revision whose job was lost, when the queue is swept', async () => {
    const revision = await newRevision({ published: true });
    expect((await revisionRow(revision.id)).pdfStatus).toBe('PENDING');

    const looked = await queueService.sweep();

    expect(looked).toBeGreaterThanOrEqual(1);
    const done = await waitFor(() => revisionRow(revision.id), (row) => row.pdfStatus === 'READY');
    expect(done.pdfStatus).toBe('READY');
  });

  it('adds the job of one revision only once', async () => {
    converter.mode = 'down'; // keeps the job around long enough to look at
    const revision = await newRevision({ published: true });

    await queueService.enqueue(revision.id);
    await queueService.enqueue(revision.id);

    const jobs = (await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized'])).filter((job) => job.data.revisionId === revision.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(revision.id);

    // The first attempt fails at once and the job waits for its retry; take it away so nothing is left running
    const job = jobs[0];
    await waitFor(() => job.getState(), (state) => state === 'delayed');
    await job.remove();
  });

  it('does not look at revisions that are not published', async () => {
    const draft = await newRevision({ published: false });

    await queueService.sweep();

    const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
    expect(jobs.some((job) => job.data.revisionId === draft.id)).toBe(false);
    expect((await revisionRow(draft.id)).pdfStatus).toBe('NONE');
  });
});
