process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PdfConversionError } from '../src/modules/editor/pdf-conversion.error';
import { FileTokenService } from '../src/modules/editor/file-token.service';
import { PdfProcessor } from '../src/modules/pdf/pdf.processor';
import { RevisionPdfService } from '../src/modules/pdf/revision-pdf.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import type { RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { publishThroughApproval } from './helpers/approval-flow';
import { createTestApp } from './helpers/create-test-app';
import { FAKE_PDF, startFakeConverterServer, type FakeConverterServer } from './helpers/fake-converter-server';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let app: INestApplication;
let storage: StorageService;
let pdfs: RevisionPdfService;
let fileTokens: FileTokenService;
let converter: FakeConverterServer;
let blankDocx: Buffer;
let blankXlsx: Buffer;
let organizationId: string;
let departmentId: string;
let categoryId: string;
type Label = 'editor' | 'approver' | 'qm';
const users = {} as Record<Label, { id: string; token: string }>;
let counter = 0;

const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

/** A revision as the approval leaves it: in force, with its copy still to be made. */
async function publishedRevision(options: { fileType?: 'DOCX' | 'XLSX'; status?: RevisionStatus; published?: boolean; pdfStatus?: 'NONE' | 'PENDING' | 'READY' | 'FAILED' } = {}) {
  const fileType = options.fileType ?? 'DOCX';
  const content = fileType === 'DOCX' ? blankDocx : blankXlsx;
  const sequenceNo = 700 + counter++;
  const document = await prisma.document.create({
    data: { organizationId, categoryId, departmentId, ownerId: users.editor.id, code: `PD-AA-${sequenceNo}`, sequenceNo, title: 'PDF denemesi', fileType, status: 'PUBLISHED' },
  });
  const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: 0, fileType });
  await storage.put(storageKey, content, 'application/octet-stream');
  const revision = await prisma.revision.create({
    data: {
      organizationId,
      documentId: document.id,
      revisionNo: 0,
      status: options.status ?? 'APPROVED',
      storageKey,
      fileSize: content.length,
      checksum: createHash('sha256').update(content).digest('hex'),
      editorKey: randomUUID(),
      preparedById: users.editor.id,
      publishedAt: options.published === false ? null : new Date(),
      pdfStatus: options.pdfStatus ?? 'PENDING',
    },
  });
  return { documentId: document.id, code: document.code, revisionId: revision.id };
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));
  converter = await startFakeConverterServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = converter.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  pdfs = app.get(RevisionPdfService);
  fileTokens = app.get(FileTokenService);

  const organization = await prisma.organization.create({ data: { name: `Pdf ${suffix}`, slug: `pdf-${suffix}` } });
  organizationId = organization.id;
  departmentId = (await prisma.department.create({ data: { organizationId, name: 'Alpha', code: 'AA' } })).id;
  categoryId = (await prisma.category.create({ data: { organizationId, name: 'Main', slug: 'main', codePrefix: 'PD' } })).id;
  const make = async (label: Label, role: UserRole) => {
    const user = await prisma.user.create({ data: { organizationId, departmentId, email: `${label}@pdf.local`, fullName: label, passwordHash: 'x', role } });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId, role, departmentId }) };
  };
  await make('editor', 'EDITOR');
  await make('approver', 'APPROVER');
  await make('qm', 'QUALITY_MANAGER');
});

beforeEach(() => converter.reset());

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId }, select: { id: true, storageKey: true, pdfStorageKey: true } });
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
  await app.close();
  await converter.close();
});

describe('making the copy', () => {
  it('converts the file of the revision, stores the PDF as a record and audits it', async () => {
    const { revisionId, documentId, code } = await publishedRevision();

    const outcome = await pdfs.generate(revisionId);

    expect(outcome).toBe('GENERATED');
    const revision = await revisionRow(revisionId);
    expect(revision).toMatchObject({ pdfStatus: 'READY', pdfChecksum: createHash('sha256').update(FAKE_PDF).digest('hex'), pdfFailureReason: null });
    expect(revision.pdfGeneratedAt).toBeInstanceOf(Date);
    expect(revision.pdfStorageKey).toMatch(new RegExp(`^${organizationId}/${documentId}/0/[0-9a-f-]{36}\\.pdf$`));
    expect((await storage.getBuffer(revision.pdfStorageKey!)).equals(FAKE_PDF)).toBe(true);
    // The Word file is untouched
    expect(await storage.exists(revision.storageKey)).toBe(true);

    const entries = await auditOf(revisionId);
    expect(entries.map((entry) => entry.action)).toEqual(['REVISION_PDF_GENERATED']);
    expect(entries[0]).toMatchObject({ userId: null, entityType: 'Revision', organizationId });
    expect(entries[0].metadata).toEqual({ documentId, code, revisionNo: 0, fileSize: FAKE_PDF.length, checksum: revision.pdfChecksum });
  });

  it('asks the document server in its own way: signed, with a download address only that revision can use', async () => {
    const { revisionId, code } = await publishedRevision();

    await pdfs.generate(revisionId);

    expect(converter.requests).toHaveLength(1);
    const { body, tokenValid } = converter.requests[0];
    expect(tokenValid).toBe(true);
    expect(body).toMatchObject({ async: false, filetype: 'docx', outputtype: 'pdf', title: `${code}.docx` });
    expect(String(body.key)).toMatch(new RegExp(`^pdf-${revisionId}-[0-9a-f]{16}$`));
    const url = new URL(String(body.url));
    expect(url.pathname).toBe(`/api/editor/files/${revisionId}`);
    const claims = await fileTokens.verify(url.searchParams.get('token') ?? undefined, 'download', revisionId);
    expect(claims).toMatchObject({ revisionId, organizationId });
    await expect(fileTokens.verify(url.searchParams.get('token') ?? undefined, 'download', randomUUID())).rejects.toThrow();
  });

  it('converts Excel files too', async () => {
    const { revisionId } = await publishedRevision({ fileType: 'XLSX' });
    await pdfs.generate(revisionId);
    expect(converter.requests[0].body).toMatchObject({ filetype: 'xlsx' });
    expect((await revisionRow(revisionId)).pdfStatus).toBe('READY');
  });

  it('makes the copy of a revision that was replaced since, as well', async () => {
    const { revisionId } = await publishedRevision({ status: 'SUPERSEDED' });
    expect(await pdfs.generate(revisionId)).toBe('GENERATED');
  });

  it('does nothing twice: a revision with its copy is left alone', async () => {
    const { revisionId } = await publishedRevision();
    await pdfs.generate(revisionId);
    const key = (await revisionRow(revisionId)).pdfStorageKey;

    expect(await pdfs.generate(revisionId)).toBe('ALREADY_READY');

    expect(converter.requests).toHaveLength(1);
    expect((await revisionRow(revisionId)).pdfStorageKey).toBe(key);
    expect((await auditOf(revisionId)).filter((entry) => entry.action === 'REVISION_PDF_GENERATED')).toHaveLength(1);
  });

  it.each([
    ['a draft', { status: 'DRAFT' as const, published: false, pdfStatus: 'NONE' as const }],
    ['a revision in review', { status: 'IN_REVIEW' as const, published: false, pdfStatus: 'NONE' as const }],
    ['a cancelled revision', { status: 'REJECTED' as const, published: false, pdfStatus: 'NONE' as const }],
  ])('makes no copy of %s', async (_label, options) => {
    const { revisionId } = await publishedRevision(options);

    expect(await pdfs.generate(revisionId)).toBe('NOT_PUBLISHED');

    expect(converter.requests).toHaveLength(0);
    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'NONE', pdfStorageKey: null });
  });

  it('knows nothing of a revision that does not exist', async () => {
    expect(await pdfs.generate(randomUUID())).toBe('NOT_PUBLISHED');
  });

  it('keeps one copy when two attempts run at the same moment', async () => {
    const { revisionId } = await publishedRevision();

    const outcomes = await Promise.all([pdfs.generate(revisionId), pdfs.generate(revisionId)]);

    expect([...outcomes].sort()).toEqual(['ALREADY_READY', 'GENERATED']);
    const revision = await revisionRow(revisionId);
    expect(await storage.exists(revision.pdfStorageKey!)).toBe(true);
    expect((await auditOf(revisionId)).filter((entry) => entry.action === 'REVISION_PDF_GENERATED')).toHaveLength(1);
  });
});

describe('when the conversion fails', () => {
  it.each([
    ['the converter reports an error', 'error-code', 'CONVERSION_FAILED'],
    ['the conversion does not finish', 'unfinished', 'CONVERSION_FAILED'],
    ['the converter answers with an HTTP error', 'http-error', 'CONVERTER_UNAVAILABLE'],
    ['the converter cannot be reached', 'down', 'CONVERTER_UNAVAILABLE'],
    ['the converted file is somewhere we do not fetch from', 'foreign-url', 'UNTRUSTED_URL'],
    ['the converted file is not a PDF', 'not-pdf', 'INVALID_OUTPUT'],
  ] as const)('throws when %s, and leaves the revision waiting with nothing stored', async (_label, mode, reason) => {
    const { revisionId } = await publishedRevision();
    converter.mode = mode;

    const failure = await pdfs.generate(revisionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PdfConversionError);
    expect((failure as PdfConversionError).reason).toBe(reason);
    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'PENDING', pdfStorageKey: null, pdfChecksum: null });
    expect(await auditOf(revisionId)).toHaveLength(0);
  });

  it('does not fetch from an address the converter named outside the configured ones', async () => {
    const { revisionId } = await publishedRevision();
    converter.mode = 'foreign-url';

    await pdfs.generate(revisionId).catch(() => undefined);

    expect(converter.downloads).toBe(0);
  });

  it('can be done again after a failure', async () => {
    const { revisionId } = await publishedRevision();
    converter.mode = 'http-error';
    await pdfs.generate(revisionId).catch(() => undefined);
    converter.mode = 'ok';

    expect(await pdfs.generate(revisionId)).toBe('GENERATED');
  });

  it('shows the failure once the last attempt is over, with the reason, and audits it', async () => {
    const { revisionId, code, documentId } = await publishedRevision();

    await pdfs.markFailed(revisionId, 'CONVERTER_UNAVAILABLE');

    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'FAILED', pdfFailureReason: 'CONVERTER_UNAVAILABLE', pdfStorageKey: null });
    const [entry] = await auditOf(revisionId);
    expect(entry).toMatchObject({ action: 'REVISION_PDF_FAILED', userId: null, entityType: 'Revision' });
    expect(entry.metadata).toEqual({ documentId, code, revisionNo: 0, reason: 'CONVERTER_UNAVAILABLE' });
  });

  it('never turns a copy that exists into a failure', async () => {
    const { revisionId } = await publishedRevision();
    await pdfs.generate(revisionId);

    await pdfs.markFailed(revisionId, 'CONVERSION_FAILED');

    expect((await revisionRow(revisionId)).pdfStatus).toBe('READY');
    expect((await auditOf(revisionId)).map((entry) => entry.action)).toEqual(['REVISION_PDF_GENERATED']);
  });

  it('makes the copy of a revision whose earlier attempts failed, and forgets the reason', async () => {
    const { revisionId } = await publishedRevision();
    await pdfs.markFailed(revisionId, 'CONVERSION_FAILED');
    await prisma.revision.update({ where: { id: revisionId }, data: { pdfStatus: 'PENDING' } });

    await pdfs.generate(revisionId);

    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'READY', pdfFailureReason: null });
  });
});

describe('the worker', () => {
  const job = (revisionId: string, attemptsMade: number) => ({ data: { revisionId }, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<{ revisionId: string }>;

  it('retries quietly: an early failure is thrown back to the queue and shown nowhere', async () => {
    const { revisionId } = await publishedRevision();
    converter.mode = 'http-error';
    const processor = new PdfProcessor(pdfs);

    await expect(processor.process(job(revisionId, 0))).rejects.toBeInstanceOf(PdfConversionError);
    await expect(processor.process(job(revisionId, 1))).rejects.toBeInstanceOf(PdfConversionError);

    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'PENDING', pdfFailureReason: null });
  });

  it('marks the revision as failed when the last attempt fails, still throwing', async () => {
    const { revisionId } = await publishedRevision();
    converter.mode = 'error-code';
    const processor = new PdfProcessor(pdfs);

    await expect(processor.process(job(revisionId, 2))).rejects.toBeInstanceOf(PdfConversionError);

    expect(await revisionRow(revisionId)).toMatchObject({ pdfStatus: 'FAILED', pdfFailureReason: 'CONVERSION_FAILED' });
  });

  it('succeeds without ceremony', async () => {
    const { revisionId } = await publishedRevision();
    await new PdfProcessor(pdfs).process(job(revisionId, 0));
    expect((await revisionRow(revisionId)).pdfStatus).toBe('READY');
  });
});

describe('publishing', () => {
  it('leaves the revision waiting for its copy, and the document published, whatever happens to the conversion', async () => {
    // A draft taken through the real approval
    const sequenceNo = 900 + counter++;
    const document = await prisma.document.create({
      data: { organizationId, categoryId, departmentId, ownerId: users.editor.id, code: `PD-AA-${sequenceNo}`, sequenceNo, title: 'Yayın denemesi', fileType: 'DOCX', status: 'DRAFT' },
    });
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: 0, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: { organizationId, documentId: document.id, revisionNo: 0, storageKey, fileSize: blankDocx.length, checksum: createHash('sha256').update(blankDocx).digest('hex'), editorKey: randomUUID(), preparedById: users.editor.id },
    });
    expect(revision.pdfStatus).toBe('NONE');
    // The editor server answers "nobody is editing" for the gate; conversion is not asked for while the queue is off
    const detail = await publishThroughApproval(app, { revisionId: revision.id, submitToken: users.editor.token, approverToken: users.approver.token, qualityToken: users.qm.token });

    expect(detail.status).toBe('PUBLISHED');
    expect(await revisionRow(revision.id)).toMatchObject({ status: 'APPROVED', pdfStatus: 'PENDING', pdfStorageKey: null });
    expect(converter.requests).toHaveLength(0);
  });
});
