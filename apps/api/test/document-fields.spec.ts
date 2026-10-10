process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import JSZip from 'jszip';
import request from 'supertest';
import type { AdminTemplateDto, DocumentDetailDto, DocumentListItemDto } from '@iso-dms/shared';
import { buildStandardDocx, buildStandardXlsx } from '../prisma/standard-template';
import type { UserRole } from '../src/generated/prisma/enums';
import { DocumentFieldsService } from '../src/modules/documents/document-fields/document-fields.service';
import { fillDocumentFields } from '../src/modules/documents/document-fields/docx-fields';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { publishThroughApproval } from './helpers/approval-flow';
import { createTestApp } from './helpers/create-test-app';
import { startFakeCommandServer, type FakeCommandServer } from './helpers/fake-command-server';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let fields: DocumentFieldsService;
let commandServer: FakeCommandServer;
let blankDocx: Buffer;
let blankXlsx: Buffer;
let standardDocx: Buffer;
let standardXlsx: Buffer;
const org = {} as { id: string; dept: string; category: string; draftCategory: string; standardTemplate: string; blankTemplate: string; xlsxTemplate: string; standardXlsxTemplate: string };
type Label = 'admin' | 'qm' | 'approver' | 'editor' | 'preparer';
const users = {} as Record<Label, { id: string; name: string; token: string }>;
let counter = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

/** What the header of a stored revision shows, in the order of the controls. */
async function headerOf(storageKey: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await storage.getBuffer(storageKey));
  const xml = await zip.file('word/header1.xml')!.async('string');
  return [...xml.matchAll(/<w:sdtContent>[\s\S]*?<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
}
/** What the field cells of a stored Excel revision show: the value of B1, D1, B2, B3 and D3. */
async function cellsOf(storageKey: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await storage.getBuffer(storageKey));
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  return Object.fromEntries([...xml.matchAll(/<c r="([BD][123])"[^>]*><is><t[^>]*>([^<]*)<\/t>/g)].map((m) => [m[1], m[2]]));
}
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function putTemplate(name: string, fileType: 'DOCX' | 'XLSX', content: Buffer, fieldTags: string[]) {
  const storageKey = `${org.id}/templates/${randomUUID()}.${fileType.toLowerCase()}`;
  await storage.put(storageKey, content, 'application/octet-stream');
  return (await prisma.template.create({ data: { organizationId: org.id, name, fileType, storageKey, fieldTags } })).id;
}

/** A draft whose file is the given content, owned and prepared by the preparer. */
async function draftWith(content: Buffer, options: { fileType?: 'DOCX' | 'XLSX'; title?: string } = {}) {
  const sequenceNo = 200 + counter++;
  const fileType = options.fileType ?? 'DOCX';
  const document = await prisma.document.create({
    data: {
      // Their own category: the codes of documents made through the API count on from the highest number of a category
      organizationId: org.id, categoryId: org.draftCategory, departmentId: org.dept, ownerId: users.preparer.id,
      code: `AD-AA-${sequenceNo}`, sequenceNo, title: options.title ?? 'Alan denemesi', fileType, status: 'DRAFT',
    },
  });
  const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: 0, fileType });
  await storage.put(storageKey, content, 'application/octet-stream');
  const revision = await prisma.revision.create({
    data: {
      organizationId: org.id, documentId: document.id, revisionNo: 0, status: 'DRAFT', storageKey, fileSize: content.length,
      checksum: sha(content), editorKey: randomUUID(), preparedById: users.preparer.id,
    },
  });
  return { documentId: document.id, code: document.code, revisionId: revision.id, storageKey, editorKey: revision.editorKey, checksum: revision.checksum };
}

const create = (body: Record<string, unknown>, token = users.editor.token) =>
  api().post('/api/documents').set(auth(token)).send({ title: 'Doküman Kontrol Prosedürü', categoryId: org.category, departmentId: org.dept, fileType: 'DOCX', ...body });

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));
  standardDocx = await buildStandardDocx();
  standardXlsx = await buildStandardXlsx();
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  fields = app.get(DocumentFieldsService);

  const organization = await prisma.organization.create({ data: { name: `Fields ${suffix}`, slug: `fields-${suffix}` } });
  organizationIds.push(organization.id);
  org.id = organization.id;
  org.dept = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Kalite Koordinatörlüğü', code: 'AA' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'AL' } })).id;
  org.draftCategory = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Taslaklar', slug: 'drafts', codePrefix: 'AD' } })).id;
  org.standardTemplate = await putTemplate('Antetli', 'DOCX', standardDocx, ['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
  org.blankTemplate = await putTemplate('Boş', 'DOCX', blankDocx, []);
  org.xlsxTemplate = await putTemplate('Tablo', 'XLSX', blankXlsx, []);
  org.standardXlsxTemplate = await putTemplate('Antetli Tablo', 'XLSX', standardXlsx, ['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);

  const make = async (label: Label, role: UserRole) => {
    const name = `Kişi ${label}`;
    const user = await prisma.user.create({ data: { organizationId: organization.id, departmentId: org.dept, email: `${label}@fields.local`, fullName: name, passwordHash: 'x', role } });
    users[label] = { id: user.id, name, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId: org.dept }) };
  };
  await make('admin', 'ADMIN');
  await make('qm', 'QUALITY_MANAGER');
  await make('approver', 'APPROVER');
  await make('editor', 'EDITOR');
  await make('preparer', 'EDITOR');
});

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  const templates = await prisma.template.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  await Promise.all([...revisions, ...templates].map((item) => storage.delete(item.storageKey).catch(() => undefined)));
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.approvalStep.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.documentRequest.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.template.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
  await commandServer.close();
});

describe('making a document', () => {
  it('writes the code, title, department, revision number and preparer into the fields of the file', async () => {
    const response = await create({ templateId: org.standardTemplate }).expect(201);
    const document = response.body as DocumentListItemDto;
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: document.id } });

    expect(await headerOf(revision.storageKey)).toEqual([document.code, '0', 'Doküman Kontrol Prosedürü', 'Kalite Koordinatörlüğü', users.editor.name]);
    // Size and checksum are those of the file that is stored, and the editor gets a key for the new content
    const stored = await storage.getBuffer(revision.storageKey);
    expect(revision).toMatchObject({ fileSize: stored.length, checksum: sha(stored), status: 'DRAFT', revisionNo: 0 });
  });

  it('leaves a template without fields exactly as it is', async () => {
    const response = await create({ templateId: org.blankTemplate }).expect(201);
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: response.body.id } });
    expect((await storage.getBuffer(revision.storageKey)).equals(blankDocx)).toBe(true);
    expect(revision.checksum).toBe(sha(blankDocx));
    // The file was not replaced: no entry for a change that did not happen
    expect((await auditOf(revision.id)).map((entry) => entry.action)).toEqual([]);
  });

  it('leaves an Excel file without named cells alone', async () => {
    const response = await create({ templateId: org.xlsxTemplate, fileType: 'XLSX' }).expect(201);
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: response.body.id } });
    expect((await storage.getBuffer(revision.storageKey)).equals(blankXlsx)).toBe(true);
  });

  it('fills the fields of a Word file that was uploaded, and leaves an uploaded file without fields alone', async () => {
    const withFields = await api().post('/api/documents/upload').set(auth(users.editor.token)).field('categoryId', org.category).field('departmentId', org.dept).field('title', 'Yüklenen Antetli')
      .attach('file', standardDocx, { filename: 'antetli.docx', contentType: 'application/octet-stream' }).expect(201);
    const without = await api().post('/api/documents/upload').set(auth(users.editor.token)).field('categoryId', org.category).field('departmentId', org.dept).field('title', 'Yüklenen Düz')
      .attach('file', blankDocx, { filename: 'duz.docx', contentType: 'application/octet-stream' }).expect(201);

    const filled = await prisma.revision.findFirstOrThrow({ where: { documentId: withFields.body.id } });
    expect(await headerOf(filled.storageKey)).toEqual([withFields.body.code, '0', 'Yüklenen Antetli', 'Kalite Koordinatörlüğü', users.editor.name]);
    const plain = await prisma.revision.findFirstOrThrow({ where: { documentId: without.body.id } });
    expect((await storage.getBuffer(plain.storageKey)).equals(blankDocx)).toBe(true);
  });

  it('is not undone when filling the fields fails: the document is there, with the file as it was', async () => {
    const spy = jest.spyOn(fields, 'apply').mockRejectedValue(new Error('storage is down'));
    try {
      const response = await create({ templateId: org.standardTemplate, title: 'Alan hatası' }).expect(201);
      const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: response.body.id } });
      expect((await storage.getBuffer(revision.storageKey)).equals(standardDocx)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('apply', () => {
  it('fills a draft once, and the second time there is nothing to do', async () => {
    const draft = await draftWith(standardDocx);

    expect(await fields.apply(draft.revisionId, 'CREATED')).toBe('UPDATED');
    const first = await revisionRow(draft.revisionId);
    expect(first.storageKey).not.toBe(draft.storageKey);
    expect(first.editorKey).not.toBe(draft.editorKey);
    expect(first.checksum).not.toBe(draft.checksum);
    expect(await headerOf(first.storageKey)).toEqual([draft.code, '0', 'Alan denemesi', 'Kalite Koordinatörlüğü', users.preparer.name]);
    // The content that was replaced is not kept
    expect(await storage.exists(draft.storageKey)).toBe(false);

    expect(await fields.apply(draft.revisionId, 'CREATED')).toBe('UNCHANGED');
    expect((await revisionRow(draft.revisionId)).storageKey).toBe(first.storageKey);
  });

  it.each([
    ['an Excel file without named cells', () => draftWith(blankXlsx, { fileType: 'XLSX' }), 'UNCHANGED'],
    ['a file that is not a readable docx', () => draftWith(Buffer.from('not a zip')), 'SKIPPED'],
  ])('leaves %s alone', async (_label, make, outcome) => {
    const draft = await make();
    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe(outcome);
    const row = await revisionRow(draft.revisionId);
    expect(row).toMatchObject({ storageKey: draft.storageKey, checksum: draft.checksum, editorKey: draft.editorKey });
  });

  it.each([
    ['a revision in review', { status: 'IN_REVIEW' as const }],
    ['a revision in force', { status: 'APPROVED' as const }],
    ['a revision somebody has open in the editor', { editSessionStartedAt: new Date() }],
  ])('leaves %s alone', async (_label, data) => {
    const draft = await draftWith(standardDocx);
    await prisma.revision.update({ where: { id: draft.revisionId }, data });

    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('SKIPPED');
    expect((await revisionRow(draft.revisionId)).storageKey).toBe(draft.storageKey);
  });

  it('knows nothing of a revision that does not exist', async () => {
    expect(await fields.apply(randomUUID(), 'CREATED')).toBe('SKIPPED');
  });

  it('leaves the draft alone when it was saved while the fields were being prepared, and removes what it wrote', async () => {
    const draft = await draftWith(standardDocx);
    const original = storage.getBuffer.bind(storage);
    const spy = jest.spyOn(storage, 'getBuffer').mockImplementation(async (key: string) => {
      const buffer = await original(key);
      // The "editor" saved a new version right after the file was read
      await prisma.revision.update({ where: { id: draft.revisionId }, data: { storageKey: `${draft.storageKey}.saved` } });
      return buffer;
    });
    try {
      expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('SKIPPED');
    } finally {
      spy.mockRestore();
    }
    expect((await revisionRow(draft.revisionId)).storageKey).toBe(`${draft.storageKey}.saved`);
    expect(await storage.exists(draft.storageKey)).toBe(true);
  });
});

describe('starting a revision', () => {
  it('gives the new draft its own revision number and preparer, and leaves the revision in force as it was', async () => {
    const created = await create({ templateId: org.standardTemplate, title: 'Revizyon alanları' }).expect(201);
    const inForce = await prisma.revision.findFirstOrThrow({ where: { documentId: created.body.id } });
    const before = await storage.getBuffer(inForce.storageKey);
    await prisma.revision.update({ where: { id: inForce.id }, data: { status: 'APPROVED', publishedAt: new Date() } });
    await prisma.document.update({ where: { id: created.body.id }, data: { status: 'PUBLISHED', currentRevisionId: inForce.id, firstPublishedAt: new Date() } });

    const started = await api().post(`/api/documents/${created.body.id}/revisions`).set(auth(users.preparer.token)).send({ changeSummary: 'Madde 3 güncellendi' }).expect(201);

    const draft = (started.body as DocumentDetailDto).openRevision!;
    const draftRow = await revisionRow(draft.id);
    expect(draft.revisionNo).toBe(1);
    expect(await headerOf(draftRow.storageKey)).toEqual([created.body.code, '1', 'Revizyon alanları', 'Kalite Koordinatörlüğü', users.preparer.name]);
    // What the readers see is the file in force, untouched
    expect((await storage.getBuffer((await revisionRow(inForce.id)).storageKey)).equals(before)).toBe(true);
    expect((await revisionRow(inForce.id)).checksum).toBe(inForce.checksum);
  });
});

describe('sending to review', () => {
  it('corrects fields that were changed in the draft, and writes that down', async () => {
    const wrong = (await fillDocumentFields(standardDocx, { DOC_CODE: 'YANLIŞ-KOD', DOC_REVISION_NO: '9', DOC_TITLE: 'Başka Ad' })).buffer;
    const draft = await draftWith(wrong);

    await api().post(`/api/revisions/${draft.revisionId}/submit`).set(auth(users.preparer.token)).expect(200);

    const row = await revisionRow(draft.revisionId);
    expect(row.status).toBe('IN_REVIEW');
    expect(await headerOf(row.storageKey)).toEqual([draft.code, '0', 'Alan denemesi', 'Kalite Koordinatörlüğü', users.preparer.name]);
    expect(row.checksum).not.toBe(draft.checksum);
    expect(row.editorKey).not.toBe(draft.editorKey);

    const entries = (await auditOf(draft.revisionId)).filter((entry) => entry.action === 'REVISION_FIELDS_UPDATED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: users.preparer.id, entityType: 'Revision' });
    expect(entries[0].metadata).toMatchObject({
      documentId: draft.documentId,
      code: draft.code,
      revisionNo: 0,
      reason: 'SUBMITTED',
      changes: {
        DOC_CODE: { from: 'YANLIŞ-KOD', to: draft.code, count: 1 },
        DOC_REVISION_NO: { from: '9', to: '0', count: 1 },
        DOC_TITLE: { from: 'Başka Ad', to: 'Alan denemesi', count: 1 },
      },
    });
  });

  it('leaves a file whose fields are right as it is, with no entry', async () => {
    const draft = await draftWith(standardDocx);
    expect(await fields.apply(draft.revisionId, 'CREATED')).toBe('UPDATED');
    const filled = await revisionRow(draft.revisionId);

    await api().post(`/api/revisions/${draft.revisionId}/submit`).set(auth(users.preparer.token)).expect(200);

    const row = await revisionRow(draft.revisionId);
    expect(row).toMatchObject({ status: 'IN_REVIEW', storageKey: filled.storageKey, checksum: filled.checksum, editorKey: filled.editorKey });
    expect((await auditOf(draft.revisionId)).filter((entry) => entry.action === 'REVISION_FIELDS_UPDATED')).toHaveLength(0);
  });

  it('does not stop for a file without fields or one that is not a readable docx', async () => {
    const plain = await draftWith(blankDocx);
    const broken = await draftWith(Buffer.from('not a zip'));

    for (const draft of [plain, broken]) {
      await api().post(`/api/revisions/${draft.revisionId}/submit`).set(auth(users.preparer.token)).expect(200);
      expect(await revisionRow(draft.revisionId)).toMatchObject({ status: 'IN_REVIEW', storageKey: draft.storageKey, checksum: draft.checksum });
    }
  });

  it('keeps the file from the start of the review to the publication: what was approved is what is in force', async () => {
    const draft = await draftWith(standardDocx);
    // The file as the approvers will read it: made right at the moment of sending
    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('UPDATED');
    const atReview = await revisionRow(draft.revisionId);

    await publishThroughApproval(app, { revisionId: draft.revisionId, submitToken: users.preparer.token, approverToken: users.approver.token, qualityToken: users.qm.token });

    const published = await revisionRow(draft.revisionId);
    expect(published.status).toBe('APPROVED');
    expect(published).toMatchObject({ checksum: atReview.checksum, storageKey: atReview.storageKey });
    expect(await headerOf(published.storageKey)).toEqual([draft.code, '0', 'Alan denemesi', 'Kalite Koordinatörlüğü', users.preparer.name]);
  });
});

describe('the fields of a template', () => {
  const upload = (name: string, file: Buffer, filename: string) =>
    api().post('/api/templates').set(auth(users.admin.token)).field('name', name).attach('file', file, { filename, contentType: 'application/octet-stream' });

  it('are read when it is added and shown in the list', async () => {
    const withFields = (await upload(`Antet ${suffix}`, standardDocx, 'a.docx').expect(201)).body as AdminTemplateDto;
    const without = (await upload(`Düz ${suffix}`, blankDocx, 'b.docx').expect(201)).body as AdminTemplateDto;
    const excel = (await upload(`Tablo ${suffix}`, blankXlsx, 'c.xlsx').expect(201)).body as AdminTemplateDto;

    expect(withFields.fields).toEqual(['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
    expect(without.fields).toEqual([]);
    expect(excel.fields).toEqual([]);
    const rows = (await api().get('/api/templates/overview').set(auth(users.admin.token)).expect(200)).body as AdminTemplateDto[];
    expect(rows.find((row) => row.id === withFields.id)!.fields).toHaveLength(5);
  });

  it('are read again when the file is replaced', async () => {
    const made = (await upload(`Değişecek ${suffix}`, blankDocx, 'd.docx').expect(201)).body as AdminTemplateDto;
    expect(made.fields).toEqual([]);

    const replaced = await api().put(`/api/templates/${made.id}/file`).set(auth(users.admin.token)).attach('file', standardDocx, { filename: 'e.docx', contentType: 'application/octet-stream' }).expect(200);

    expect((replaced.body as AdminTemplateDto).fields).toHaveLength(5);
    const audit = (await auditOf(made.id)).find((entry) => entry.action === 'TEMPLATE_FILE_REPLACED')!;
    expect((audit.metadata as { fields: string[] }).fields).toHaveLength(5);
  });
});

describe('Excel files', () => {
  it('are filled when the document is made from a template with named cells', async () => {
    const response = await create({ templateId: org.standardXlsxTemplate, fileType: 'XLSX', title: 'Tedarikçi Listesi' }).expect(201);
    const document = response.body as DocumentListItemDto;
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: document.id } });

    expect(await cellsOf(revision.storageKey)).toEqual({ B1: document.code, D1: '0', B2: 'Tedarikçi Listesi', B3: 'Kalite Koordinatörlüğü', D3: users.editor.name });
    const stored = await storage.getBuffer(revision.storageKey);
    expect(revision).toMatchObject({ fileSize: stored.length, checksum: sha(stored), status: 'DRAFT' });
  });

  it('are filled when they are uploaded, and a file without named cells is left alone', async () => {
    const withFields = await api().post('/api/documents/upload').set(auth(users.editor.token)).field('categoryId', org.category).field('departmentId', org.dept).field('title', 'Yüklenen Antetli Tablo')
      .attach('file', standardXlsx, { filename: 'antetli.xlsx', contentType: 'application/octet-stream' }).expect(201);
    const without = await api().post('/api/documents/upload').set(auth(users.editor.token)).field('categoryId', org.category).field('departmentId', org.dept).field('title', 'Yüklenen Düz Tablo')
      .attach('file', blankXlsx, { filename: 'duz.xlsx', contentType: 'application/octet-stream' }).expect(201);

    const filled = await prisma.revision.findFirstOrThrow({ where: { documentId: withFields.body.id } });
    expect((await cellsOf(filled.storageKey)).B1).toBe(withFields.body.code);
    const plain = await prisma.revision.findFirstOrThrow({ where: { documentId: without.body.id } });
    expect((await storage.getBuffer(plain.storageKey)).equals(blankXlsx)).toBe(true);
  });

  it('are corrected when the draft is sent to review, with an entry of what was corrected, and then they stay as they are', async () => {
    const draft = await draftWith(standardXlsx, { fileType: 'XLSX' });
    expect(await fields.apply(draft.revisionId, 'CREATED')).toBe('UPDATED');
    const filled = await revisionRow(draft.revisionId);

    // A person typed over a field in the editor
    const zip = await JSZip.loadAsync(await storage.getBuffer(filled.storageKey));
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace(/(<c r="B1"[^>]*><is><t[^>]*>)[^<]*/, '$1ELLE YAZILDI');
    zip.file('xl/worksheets/sheet1.xml', sheet);
    const tampered = await zip.generateAsync({ type: 'nodebuffer' });
    await storage.put(filled.storageKey, tampered, 'application/octet-stream');
    await prisma.revision.update({ where: { id: draft.revisionId }, data: { checksum: sha(tampered), fileSize: tampered.length } });

    expect(await fields.apply(draft.revisionId, 'SUBMITTED', { userId: users.preparer.id, ipAddress: null })).toBe('UPDATED');

    const corrected = await revisionRow(draft.revisionId);
    expect((await cellsOf(corrected.storageKey)).B1).toBe(draft.code);
    const entry = (await auditOf(draft.revisionId)).find((item) => item.action === 'REVISION_FIELDS_UPDATED')!;
    expect(entry.metadata).toMatchObject({ reason: 'SUBMITTED', changes: { DOC_CODE: { from: 'ELLE YAZILDI', to: draft.code, count: 1 } } });
    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('UNCHANGED');
  });

  it('are not touched once they are in review or in force: the file is what was approved', async () => {
    const draft = await draftWith(standardXlsx, { fileType: 'XLSX' });
    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('UPDATED');
    const atReview = await revisionRow(draft.revisionId);

    await publishThroughApproval(app, { revisionId: draft.revisionId, submitToken: users.preparer.token, approverToken: users.approver.token, qualityToken: users.qm.token });

    const published = await revisionRow(draft.revisionId);
    expect(published).toMatchObject({ status: 'APPROVED', checksum: atReview.checksum, storageKey: atReview.storageKey });
    expect(await fields.apply(draft.revisionId, 'SUBMITTED')).toBe('SKIPPED');
    expect((await cellsOf(published.storageKey)).D3).toBe(users.preparer.name);
  });

  it('are skipped, and nothing is thrown, when the file is not an Excel package', async () => {
    const draft = await draftWith(Buffer.from('not a package'), { fileType: 'XLSX' });
    expect(await fields.apply(draft.revisionId, 'CREATED')).toBe('SKIPPED');
    expect((await revisionRow(draft.revisionId)).storageKey).toBe(draft.storageKey);
  });

  it('are listed with their fields when an Excel template is added', async () => {
    const response = await api().post('/api/templates').set(auth(users.admin.token)).field('name', `Antetli Excel ${suffix}`)
      .attach('file', standardXlsx, { filename: 'a.xlsx', contentType: 'application/octet-stream' }).expect(201);
    expect((response.body as AdminTemplateDto).fields).toEqual(['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
  });
});
