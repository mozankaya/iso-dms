import { createHash, randomUUID } from 'node:crypto';
import { collectCounts, verifyStorageIntegrity } from '../src/ops/storage-integrity';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { ObjectStorage, objectStorageOptionsFromEnv } from '../src/modules/storage/object-storage';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';

const prisma = createPrismaClient();
const storage = new ObjectStorage(objectStorageOptionsFromEnv());
const suffix = randomUUID().slice(0, 8);
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

let organizationId: string;
let documentId: string;
let userId: string;
let revisionNo = 0;
const keys: string[] = [];

async function createRevision(options: {
  content: Buffer | null;
  checksum?: string;
  pdf?: { content: Buffer | null; checksum: string | null };
}) {
  const storageKey = buildRevisionKey({ organizationId, documentId, revisionNo, fileType: 'DOCX' });
  if (options.content) {
    await storage.put(storageKey, options.content, 'application/octet-stream');
    keys.push(storageKey);
  }
  let pdfStorageKey: string | null = null;
  if (options.pdf) {
    pdfStorageKey = storageKey.replace(/\.docx$/, '.pdf');
    if (options.pdf.content) {
      await storage.put(pdfStorageKey, options.pdf.content, 'application/pdf');
      keys.push(pdfStorageKey);
    }
  }
  const revision = await prisma.revision.create({
    data: {
      organizationId,
      documentId,
      revisionNo: revisionNo++,
      status: 'SUPERSEDED',
      storageKey,
      fileSize: options.content?.length ?? 1,
      checksum: options.checksum ?? sha256(options.content ?? Buffer.from('x')),
      editorKey: randomUUID(),
      preparedById: userId,
      publishedAt: new Date(),
      ...(options.pdf && { pdfStatus: 'READY', pdfStorageKey, pdfChecksum: options.pdf.checksum, pdfFileSize: 3 }),
    },
  });
  return { id: revision.id, storageKey, pdfStorageKey };
}

beforeAll(async () => {
  const organization = await prisma.organization.create({ data: { name: `Integrity ${suffix}`, slug: `integrity-${suffix}` } });
  organizationId = organization.id;
  const department = await prisma.department.create({ data: { organizationId, name: 'Birim', code: 'IB' } });
  const category = await prisma.category.create({ data: { organizationId, name: 'Kategori', slug: 'cat', codePrefix: 'IC' } });
  userId = (await prisma.user.create({ data: { organizationId, departmentId: department.id, email: `u@integrity-${suffix}.local`, fullName: 'U', passwordHash: 'x', role: 'ADMIN' } })).id;
  documentId = (
    await prisma.document.create({
      data: { organizationId, categoryId: category.id, departmentId: department.id, ownerId: userId, code: 'IC-IB-001', sequenceNo: 1, title: 'T', fileType: 'DOCX', status: 'PUBLISHED' },
    })
  ).id;
});

afterAll(async () => {
  await Promise.all(keys.map((key) => storage.delete(key).catch(() => undefined)));
  await prisma.template.deleteMany({ where: { organizationId } });
  await deleteAuditLogs(prisma, { organizationId });
  await prisma.revision.deleteMany({ where: { organizationId } });
  await prisma.document.deleteMany({ where: { organizationId } });
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.category.deleteMany({ where: { organizationId } });
  await prisma.department.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
});

/** The report is for the whole database, which other data (the development one) shares: only look at ours. */
async function problemsOf(ids: string[]) {
  const report = await verifyStorageIntegrity(prisma, storage);
  return { report, ours: report.problems.filter((problem) => ids.includes(problem.id)) };
}

describe('verifyStorageIntegrity', () => {
  it('finds nothing wrong with files that are in place and have the recorded checksum', async () => {
    const content = Buffer.from('revision content');
    const pdf = Buffer.from('%PDF-1.7 copy');
    const plain = await createRevision({ content });
    const withPdf = await createRevision({ content: Buffer.from('another one'), pdf: { content: pdf, checksum: sha256(pdf) } });

    const { ours } = await problemsOf([plain.id, withPdf.id]);

    expect(ours).toEqual([]);
  });

  it('reports a file that is gone', async () => {
    const gone = await createRevision({ content: null });

    const { ours } = await problemsOf([gone.id]);

    expect(ours).toEqual([{ kind: 'REVISION_FILE', problem: 'MISSING', id: gone.id, storageKey: gone.storageKey }]);
  });

  it('reports a file whose content is not what was saved, even by one byte', async () => {
    const original = Buffer.from('the text that was approved');
    const tampered = await createRevision({ content: Buffer.from('the text that was approveD'), checksum: sha256(original) });

    const { ours } = await problemsOf([tampered.id]);

    expect(ours).toEqual([{ kind: 'REVISION_FILE', problem: 'CHECKSUM_MISMATCH', id: tampered.id, storageKey: tampered.storageKey }]);
  });

  it('checks the PDF copies too: missing and altered ones', async () => {
    const pdf = Buffer.from('%PDF-1.7 good');
    const noPdf = await createRevision({ content: Buffer.from('one'), pdf: { content: null, checksum: sha256(pdf) } });
    const badPdf = await createRevision({ content: Buffer.from('two'), pdf: { content: Buffer.from('%PDF-1.7 evil'), checksum: sha256(pdf) } });
    const oldPdf = await createRevision({ content: Buffer.from('three'), pdf: { content: Buffer.from('%PDF-1.7 made before checksums'), checksum: null } });

    const { ours } = await problemsOf([noPdf.id, badPdf.id, oldPdf.id]);

    expect(ours).toEqual(
      expect.arrayContaining([
        { kind: 'PDF_COPY', problem: 'MISSING', id: noPdf.id, storageKey: noPdf.pdfStorageKey },
        { kind: 'PDF_COPY', problem: 'CHECKSUM_MISMATCH', id: badPdf.id, storageKey: badPdf.pdfStorageKey },
      ]),
    );
    // A copy without a recorded checksum only has to exist
    expect(ours).toHaveLength(2);
  });

  it('wants the template files to exist', async () => {
    const key = `${organizationId}/templates/${randomUUID()}.docx`;
    const template = await prisma.template.create({ data: { organizationId, name: 'Şablon', fileType: 'DOCX', storageKey: key } });

    const { ours } = await problemsOf([template.id]);

    expect(ours).toEqual([{ kind: 'TEMPLATE_FILE', problem: 'MISSING', id: template.id, storageKey: key }]);
  });

  it('says the database guards are in place and counts the rows', async () => {
    const { report } = await problemsOf([]);

    expect(report.guards).toEqual({ auditLogAppendOnly: true, auditLogNoTruncate: true, feedbackProtected: true });
    expect(report.counts.revisions).toBeGreaterThanOrEqual(1);
    expect(Object.keys(report.counts).sort()).toEqual(Object.keys(await collectCounts(prisma)).sort());
    // The database is shared with whatever else is running: the counts can only have grown between the two reads
    expect(report.checked.revisionFiles).toBeGreaterThanOrEqual(1);
  });

  it('is not ok while anything is wrong', async () => {
    const gone = await createRevision({ content: null });
    const { report } = await problemsOf([gone.id]);
    expect(report.ok).toBe(false);
  });
});
