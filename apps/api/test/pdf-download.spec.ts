process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DocumentDetailDto, DocumentListItemDto, PaginatedDto, RevisionHistoryItemDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { RevisionPdfService } from '../src/modules/pdf/revision-pdf.service';
import { buildPdfKey, buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { FAKE_PDF, startFakeConverterServer, type FakeConverterServer } from './helpers/fake-converter-server';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let pdfs: RevisionPdfService;
let converter: FakeConverterServer;
let blankDocx: Buffer;
let foreignRevisionId: string;
const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'approver' | 'editorA' | 'editorB' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;
let counter = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });

type PdfState = 'NONE' | 'PENDING' | 'READY' | 'FAILED';
interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
  published?: boolean;
  pdf?: PdfState;
  /** The PDF is READY in the database but its object is gone from storage */
  pdfMissing?: boolean;
}

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; revisions: RevisionSpec[] }) {
  const sequenceNo = 600 + counter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id, categoryId: org.category, departmentId: options.departmentId ?? org.deptA, ownerId: users.editorA.id,
      code: `PL-AA-${sequenceNo}`, sequenceNo, title: 'İndirme denemesi', fileType: 'DOCX', status: options.status ?? 'PUBLISHED',
    },
  });
  const revisions: { id: string; revisionNo: number }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const pdf = spec.pdf ?? 'NONE';
    let pdfStorageKey: string | null = null;
    if (pdf === 'READY') {
      pdfStorageKey = buildPdfKey({ organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo });
      if (!spec.pdfMissing) await storage.put(pdfStorageKey, FAKE_PDF, 'application/pdf');
    }
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, status: spec.status, storageKey,
        fileSize: blankDocx.length, checksum: createHash('sha256').update(blankDocx).digest('hex'), editorKey: randomUUID(),
        preparedById: users.editorA.id,
        publishedAt: spec.published ?? (spec.status === 'APPROVED' || spec.status === 'SUPERSEDED') ? new Date() : null,
        pdfStatus: pdf, pdfStorageKey,
        ...(pdf === 'READY' && { pdfChecksum: createHash('sha256').update(FAKE_PDF).digest('hex'), pdfFileSize: FAKE_PDF.length, pdfGeneratedAt: new Date() }),
        ...(pdf === 'FAILED' && { pdfFailureReason: 'CONVERSION_FAILED' }),
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

/** A document in force whose current revision has its PDF. */
const withPdf = (options: { departmentId?: string } = {}) =>
  createDocument({ departmentId: options.departmentId, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'READY' }] });

const pdfOf = (token: string, documentId: string) => api().get(`/api/documents/${documentId}/download`).query({ format: 'pdf' }).set(auth(token)).buffer().parse(binary);
const revisionPdf = (token: string, revisionId: string, format = 'pdf') => api().get(`/api/revisions/${revisionId}/download`).query({ format }).set(auth(token)).buffer().parse(binary);
const ask = (token: string, revisionId: string) => api().post(`/api/revisions/${revisionId}/pdf`).set(auth(token));

function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  converter = await startFakeConverterServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = converter.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  pdfs = app.get(RevisionPdfService);

  const organization = await prisma.organization.create({ data: { name: `PdfDl ${suffix}`, slug: `pdfdl-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `pdfdl-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'PL' } })).id;

  const make = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({ data: { organizationId: organization.id, departmentId, email: `${label}@pdfdl.local`, fullName: label, passwordHash: 'x', role } });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await make('admin', 'ADMIN', org.deptA);
  await make('qm', 'QUALITY_MANAGER', org.deptA);
  await make('approver', 'APPROVER', org.deptA);
  await make('editorA', 'EDITOR', org.deptA);
  await make('editorB', 'EDITOR', org.deptB);
  await make('reader', 'READER', org.deptA);

  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@pdfdl.local', fullName: 'f', passwordHash: 'x', role: 'EDITOR' } });
  const foreignDepartment = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FF' } });
  const foreignDocument = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDepartment.id, ownerId: foreignUser.id, code: 'FF-FF-001', sequenceNo: 1, title: 'x', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  const foreignRevision = await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDocument.id, revisionNo: 0, status: 'APPROVED', storageKey: `${foreign.id}/x.docx`, fileSize: 1, checksum: 'x', editorKey: 'k', preparedById: foreignUser.id, publishedAt: new Date(), pdfStatus: 'FAILED' },
  });
  foreignRevisionId = foreignRevision.id;
});

beforeEach(() => converter.reset());

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true, pdfStorageKey: true } });
  await Promise.all(revisions.flatMap((r) => [r.storageKey, r.pdfStorageKey]).filter((key): key is string => !!key).map((key) => storage.delete(key).catch(() => undefined)));
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
  await converter.close();
});

describe('downloading the PDF copy', () => {
  it('gives the PDF of the revision in force to everybody who may open it', async () => {
    const doc = await withPdf();

    for (const who of ['reader', 'editorA', 'editorB', 'approver', 'qm', 'admin'] as const) {
      const response = await pdfOf(users[who].token, doc.id).expect(200);
      expect(Buffer.from(response.body).equals(FAKE_PDF)).toBe(true);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-length']).toBe(String(FAKE_PDF.length));
      expect(decodeURIComponent(response.headers['content-disposition'])).toContain(`${doc.code} İndirme denemesi (Rev 0).pdf`);
    }
  });

  it('gives the file as it was stored when no format is asked for, or "original"', async () => {
    const doc = await withPdf();

    const plain = await api().get(`/api/documents/${doc.id}/download`).set(auth(users.reader.token)).buffer().parse(binary).expect(200);
    const original = await api().get(`/api/documents/${doc.id}/download`).query({ format: 'original' }).set(auth(users.reader.token)).buffer().parse(binary).expect(200);

    for (const response of [plain, original]) {
      expect(Buffer.from(response.body).equals(blankDocx)).toBe(true);
      expect(response.headers['content-disposition']).toContain('.docx');
    }
  });

  it('refuses a format nobody knows', async () => {
    const doc = await withPdf();
    expect((await api().get(`/api/documents/${doc.id}/download`).query({ format: 'html' }).set(auth(users.reader.token)).expect(400)).body.code).toBe('UNSUPPORTED_FORMAT');
    await revisionPdf(users.admin.token, doc.revisions[0].id, 'epub').expect(400);
  });

  it('requires a session', async () => {
    const doc = await withPdf();
    await api().get(`/api/documents/${doc.id}/download`).query({ format: 'pdf' }).expect(401);
    await api().get(`/api/revisions/${doc.revisions[0].id}/download`).query({ format: 'pdf' }).expect(401);
  });

  it('is audited as a download of the PDF, and an ordinary download is not marked', async () => {
    const doc = await withPdf();
    await pdfOf(users.reader.token, doc.id).expect(200);
    await api().get(`/api/documents/${doc.id}/download`).set(auth(users.reader.token)).buffer().parse(binary).expect(200);

    const entries = (await auditOf(doc.revisions[0].id)).filter((entry) => entry.action === 'REVISION_DOWNLOADED');

    expect(entries).toHaveLength(2);
    expect(entries[0].metadata).toEqual({ documentId: doc.id, code: doc.code, revisionNo: 0, fileSize: FAKE_PDF.length, format: 'PDF' });
    expect(entries[1].metadata).toEqual({ documentId: doc.id, code: doc.code, revisionNo: 0, fileSize: blankDocx.length });
    expect(entries[0]).toMatchObject({ userId: users.reader.id });
  });

  it.each([
    ['still waiting', 'PENDING' as const],
    ['failed', 'FAILED' as const],
    ['never asked for', 'NONE' as const],
  ])('answers 404 when the copy is %s, without an audit record', async (_label, pdf) => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf }] });

    const response = await api().get(`/api/documents/${doc.id}/download`).query({ format: 'pdf' }).set(auth(users.reader.token));
    expect(response.body.code).toBe('PDF_NOT_AVAILABLE');
    expect(await auditOf(doc.revisions[0].id)).toHaveLength(0);
  });

  it('answers 404 when the object is gone from storage', async () => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'READY', pdfMissing: true }] });
    const response = await api().get(`/api/documents/${doc.id}/download`).query({ format: 'pdf' }).set(auth(users.reader.token));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PDF_NOT_AVAILABLE');
  });

  it('gives the PDF of an older revision to those who may open it, and only to them', async () => {
    const doc = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'SUPERSEDED', pdf: 'READY' },
        { revisionNo: 1, status: 'APPROVED', current: true, pdf: 'READY' },
      ],
    });
    const old = doc.revisions[0].id;

    expect(Buffer.from((await revisionPdf(users.approver.token, old).expect(200)).body).equals(FAKE_PDF)).toBe(true);
    await revisionPdf(users.editorA.token, old).expect(200);
    // Not their department, and a reader only sees what is in force: the old revision does not exist for them
    expect((await api().get(`/api/revisions/${old}/download`).query({ format: 'pdf' }).set(auth(users.reader.token)).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    await api().get(`/api/revisions/${old}/download`).query({ format: 'pdf' }).set(auth(users.editorB.token)).expect(404);
  });

  it('has none for a draft, and does not show a draft to those who may not see it', async () => {
    const doc = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'APPROVED', current: true, pdf: 'READY' },
        { revisionNo: 1, status: 'DRAFT' },
      ],
    });
    const draft = doc.revisions[1].id;

    expect((await api().get(`/api/revisions/${draft}/download`).query({ format: 'pdf' }).set(auth(users.editorA.token)).expect(404)).body.code).toBe('PDF_NOT_AVAILABLE');
    expect((await api().get(`/api/revisions/${draft}/download`).query({ format: 'pdf' }).set(auth(users.reader.token)).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
  });

  it('keeps the PDF of a withdrawn document as a record for those who may see it, and hides it from readers', async () => {
    const doc = await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'READY' }] });

    expect((await api().get(`/api/documents/${doc.id}/download`).query({ format: 'pdf' }).set(auth(users.approver.token)).expect(404)).body.code).toBe('NO_PUBLISHED_REVISION');
    await revisionPdf(users.approver.token, doc.revisions[0].id).expect(200);
    await revisionPdf(users.reader.token, doc.revisions[0].id).expect(404);
  });

  it('never gives the PDF of another organization', async () => {
    await revisionPdf(users.admin.token, foreignRevisionId).expect(404);
  });
});

describe('what the lists and the history say about the copy', () => {
  it('shows the state in the document list, the detail and the revision history', async () => {
    const doc = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'SUPERSEDED', pdf: 'FAILED' },
        { revisionNo: 1, status: 'APPROVED', current: true, pdf: 'READY' },
        { revisionNo: 2, status: 'DRAFT' },
      ],
    });

    const list = (await api().get('/api/documents').query({ search: doc.code }).set(auth(users.admin.token)).expect(200)).body as PaginatedDto<DocumentListItemDto>;
    expect(list.items[0]).toMatchObject({ id: doc.id, pdfStatus: 'READY' });
    const detail = (await api().get(`/api/documents/${doc.id}`).set(auth(users.admin.token)).expect(200)).body as DocumentDetailDto;
    expect(detail.pdfStatus).toBe('READY');
    const history = (await api().get(`/api/documents/${doc.id}/revisions`).set(auth(users.admin.token)).expect(200)).body as RevisionHistoryItemDto[];
    expect(history.map((row) => [row.revisionNo, row.pdfStatus])).toEqual([[2, 'NONE'], [1, 'READY'], [0, 'FAILED']]);
  });

  it('has no state for a document that was never published', async () => {
    const doc = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    const detail = (await api().get(`/api/documents/${doc.id}`).set(auth(users.admin.token)).expect(200)).body as DocumentDetailDto;
    expect(detail.pdfStatus).toBeNull();
  });
});

describe('asking for the copy again', () => {
  it.each(['qm', 'admin'] as const)('is allowed for %s', async (who) => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'FAILED' }] });
    const response = await ask(users[who].token, doc.revisions[0].id).expect(200);
    expect(response.body).toEqual({ id: doc.revisions[0].id, pdfStatus: 'PENDING' });
  });

  it.each(['approver', 'editorA', 'reader'] as const)('is refused for %s', async (who) => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'FAILED' }] });
    expect((await ask(users[who].token, doc.revisions[0].id).expect(403)).body.code).toBe('FORBIDDEN');
    expect((await revisionRow(doc.revisions[0].id)).pdfStatus).toBe('FAILED');
  });

  it('requires a session', async () => {
    await api().post(`/api/revisions/${randomUUID()}/pdf`).expect(401);
  });

  it('clears the failure, leaves the revision waiting, and audits who asked and what it was before', async () => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'FAILED' }] });
    const id = doc.revisions[0].id;

    await ask(users.qm.token, id).expect(200);

    expect(await revisionRow(id)).toMatchObject({ pdfStatus: 'PENDING', pdfFailureReason: null });
    const [entry] = (await auditOf(id)).filter((candidate) => candidate.action === 'REVISION_PDF_REQUESTED');
    expect(entry).toMatchObject({ userId: users.qm.id, entityType: 'Revision', organizationId: org.id });
    expect(entry.metadata).toEqual({ documentId: doc.id, code: doc.code, revisionNo: 0, previousStatus: 'FAILED' });
  });

  it('makes the copy of a revision from before copies existed, and then the copy can be made', async () => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'NONE' }] });
    const id = doc.revisions[0].id;

    await ask(users.admin.token, id).expect(200);
    expect((await revisionRow(id)).pdfStatus).toBe('PENDING');
    expect(await pdfs.generate(id)).toBe('GENERATED');

    expect((await revisionRow(id)).pdfStatus).toBe('READY');
    expect(Buffer.from((await pdfOf(users.reader.token, doc.id).expect(200)).body).equals(FAKE_PDF)).toBe(true);
  });

  it('is harmless for a revision that is waiting already', async () => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, pdf: 'PENDING' }] });
    await ask(users.qm.token, doc.revisions[0].id).expect(200);
    expect((await revisionRow(doc.revisions[0].id)).pdfStatus).toBe('PENDING');
  });

  it('refuses when the copy exists (it is a record), and when the revision was never put in force', async () => {
    const ready = await withPdf();
    expect((await ask(users.qm.token, ready.revisions[0].id).expect(409)).body.code).toBe('PDF_ALREADY_EXISTS');
    expect((await revisionRow(ready.revisions[0].id)).pdfStatus).toBe('READY');

    const draft = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    expect((await ask(users.qm.token, draft.revisions[0].id).expect(409)).body.code).toBe('REVISION_NOT_PUBLISHED');
    expect((await revisionRow(draft.revisions[0].id)).pdfStatus).toBe('NONE');
  });

  it('answers 404 for unknown revisions and those of another organization, and 400 for an id that is none', async () => {
    expect((await ask(users.admin.token, randomUUID()).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    await ask(users.admin.token, foreignRevisionId).expect(404);
    expect((await revisionRow(foreignRevisionId)).pdfStatus).toBe('FAILED');
    await ask(users.admin.token, 'not-a-uuid').expect(400);
  });
});
