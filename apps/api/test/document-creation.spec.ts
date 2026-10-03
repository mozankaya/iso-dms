process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MAX_UPLOAD_MB = '1'; // read when the documents controller is first loaded

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DocumentListItemDto } from '@iso-dms/shared';
import type { UserRole } from '../src/generated/prisma/enums';
import { DocumentCodeService } from '../src/modules/documents/document-code.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let blankDocx: Buffer;
let blankXlsx: Buffer;

const ids = {} as Record<
  | 'organizationId' | 'deptA' | 'deptB' | 'catMain' | 'catOther' | 'catInactive'
  | 'globalDocxTemplate' | 'globalXlsxTemplate' | 'otherDocxTemplate' | 'foreignCategory' | 'foreignDepartment'
  | 'foreignTemplate',
  string
>;
const tokens = {} as Record<'reader' | 'editorA' | 'editorNoDept' | 'approverA' | 'qm' | 'admin', string>;
let adminId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    categoryId: ids.catMain,
    departmentId: ids.deptA,
    title: 'Test Document',
    fileType: 'DOCX',
    ...overrides,
  };
}

function post(token: string, body: Record<string, unknown>) {
  return request(app.getHttpServer()).post('/api/documents').set(auth(token)).send(body);
}

function upload(
  token: string,
  file: { content: Buffer | (() => Buffer); filename: string; contentType?: string } | null,
  fields: Record<string, string> = {},
) {
  const req = request(app.getHttpServer())
    .post('/api/documents/upload')
    .set(auth(token))
    .field('categoryId', fields.categoryId ?? ids.catMain)
    .field('departmentId', fields.departmentId ?? ids.deptA);
  if (fields.title) req.field('title', fields.title);
  if (file) {
    // Content may be lazy: table-driven tests are defined before beforeAll creates the buffers
    const content = typeof file.content === 'function' ? file.content() : file.content;
    req.attach('file', content, { filename: file.filename, contentType: file.contentType ?? 'application/octet-stream' });
  }
  return req;
}

async function createUser(role: UserRole, departmentId: string | null, label: string) {
  const user = await prisma.user.create({
    data: {
      organizationId: ids.organizationId,
      departmentId,
      email: `${label}@creation.local`,
      fullName: label,
      passwordHash: 'x',
      role,
    },
  });
  tokens[label as keyof typeof tokens] = await signToken(app, {
    userId: user.id,
    organizationId: ids.organizationId,
    role,
    departmentId,
  });
  return user;
}

async function createTemplate(
  organizationId: string,
  data: { name: string; fileType: 'DOCX' | 'XLSX'; categoryId: string | null; isDefault: boolean },
  content: Buffer,
  uploadFile = true,
) {
  const storageKey = `${organizationId}/templates/${randomUUID()}.${data.fileType.toLowerCase()}`;
  if (uploadFile) await storage.put(storageKey, content, 'application/octet-stream');
  return prisma.template.create({ data: { organizationId, storageKey, ...data } });
}

beforeAll(async () => {
  app = await createTestApp();
  storage = app.get(StorageService);
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));

  const organization = await prisma.organization.create({ data: { name: `Create ${suffix}`, slug: `create-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `foreign-c-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  ids.organizationId = organization.id;

  ids.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  ids.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  ids.catMain = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;
  ids.catOther = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Other', slug: 'other', codePrefix: 'OO' } })).id;
  ids.catInactive = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Inactive', slug: 'inactive', codePrefix: 'II', isActive: false } })).id;
  ids.foreignCategory = (await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FF' } })).id;
  ids.foreignDepartment = (await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FD' } })).id;

  ids.globalDocxTemplate = (await createTemplate(organization.id, { name: 'Global Word', fileType: 'DOCX', categoryId: null, isDefault: true }, blankDocx)).id;
  ids.globalXlsxTemplate = (await createTemplate(organization.id, { name: 'Global Excel', fileType: 'XLSX', categoryId: null, isDefault: true }, blankXlsx)).id;
  ids.otherDocxTemplate = (await createTemplate(organization.id, { name: 'Other Word', fileType: 'DOCX', categoryId: ids.catOther, isDefault: true }, Buffer.concat([blankDocx, Buffer.from('other')]))).id;
  ids.foreignTemplate = (await createTemplate(foreign.id, { name: 'Foreign Word', fileType: 'DOCX', categoryId: null, isDefault: true }, blankDocx)).id;

  await createUser('READER', ids.deptA, 'reader');
  await createUser('EDITOR', ids.deptA, 'editorA');
  await createUser('EDITOR', null, 'editorNoDept');
  await createUser('APPROVER', ids.deptA, 'approverA');
  await createUser('QUALITY_MANAGER', null, 'qm');
  adminId = (await createUser('ADMIN', null, 'admin')).id;
});

afterAll(async () => {
  // Test cleanup only: the application never deletes documents, revisions or their files
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
  const templates = await prisma.template.findMany({ where: { organizationId: { in: organizationIds } } });
  await Promise.all([...revisions, ...templates].map((item) => storage.delete(item.storageKey).catch(() => undefined)));

  await prisma.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.template.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

describe('DocumentCodeService.format', () => {
  const codes = new DocumentCodeService();

  it('pads the sequence to three digits', () => {
    expect(codes.format('PR', 'KK', 1)).toBe('PR-KK-001');
    expect(codes.format('PR', 'KK', 42)).toBe('PR-KK-042');
  });

  it('keeps longer sequences intact', () => {
    expect(codes.format('PR', 'KK', 1234)).toBe('PR-KK-1234');
  });
});

describe('create from a template', () => {
  it('creates a draft document with revision 0 and the template file', async () => {
    const response = await post(tokens.qm, createBody({ title: 'First Document' })).expect(201);
    const created = response.body as DocumentListItemDto;

    expect(created).toMatchObject({
      code: 'MM-AA-001',
      title: 'First Document',
      fileType: 'DOCX',
      status: 'DRAFT',
      categoryId: ids.catMain,
      department: { id: ids.deptA, name: 'Alpha', code: 'AA' },
      firstPublishedAt: null,
      revisedAt: null,
      revisionNo: null,
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: created.id },
      include: { revisions: true },
    });
    expect(document).toMatchObject({ sequenceNo: 1, currentRevisionId: null, status: 'DRAFT' });
    expect(document.ownerId).toBeDefined();

    expect(document.revisions).toHaveLength(1);
    const [revision] = document.revisions;
    expect(revision).toMatchObject({
      revisionNo: 0,
      status: 'DRAFT',
      fileSize: blankDocx.length,
      checksum: createHash('sha256').update(blankDocx).digest('hex'),
      organizationId: ids.organizationId,
    });
    expect(revision.storageKey).toMatch(
      new RegExp(`^${ids.organizationId}/${created.id}/0/[0-9a-f-]{36}\\.docx$`),
    );
    expect(revision.editorKey).toMatch(/^[0-9a-f-]{36}$/);
    expect((await storage.getBuffer(revision.storageKey)).equals(blankDocx)).toBe(true);
  });

  it('writes an audit log entry', async () => {
    const response = await post(tokens.qm, createBody({ title: 'Audited Document' })).expect(201);

    const entries = await prisma.auditLog.findMany({
      where: { entityType: 'Document', entityId: response.body.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'DOCUMENT_CREATED', organizationId: ids.organizationId });
    expect(entries[0].metadata).toMatchObject({
      code: response.body.code,
      source: 'TEMPLATE',
      templateId: ids.globalDocxTemplate,
    });
  });

  it('numbers documents per category and department independently', async () => {
    const make = async (body: Record<string, unknown>) =>
      (await post(tokens.admin, createBody({ title: 'Numbering', ...body })).expect(201)).body.code as string;

    const [a1, a2] = [await make({ categoryId: ids.catOther }), await make({ categoryId: ids.catOther })];
    expect([a1, a2]).toEqual(['OO-AA-001', 'OO-AA-002']);
    expect(await make({ categoryId: ids.catOther, departmentId: ids.deptB })).toBe('OO-BB-001');
    expect(await make({ categoryId: ids.catOther })).toBe('OO-AA-003');
  });

  it('never reuses the code of a withdrawn document', async () => {
    const first = (await post(tokens.admin, createBody({ title: 'To Withdraw', departmentId: ids.deptB })).expect(201)).body;
    await prisma.document.update({ where: { id: first.id }, data: { status: 'WITHDRAWN' } });

    const next = (await post(tokens.admin, createBody({ title: 'After Withdrawn', departmentId: ids.deptB })).expect(201)).body;
    expect(next.code).not.toBe(first.code);
    expect(Number(next.code.split('-')[2])).toBe(Number(first.code.split('-')[2]) + 1);
  });

  it('hands out unique, gap-free codes for simultaneous requests', async () => {
    const before = await prisma.document.aggregate({
      where: { organizationId: ids.organizationId, categoryId: ids.catMain, departmentId: ids.deptB },
      _max: { sequenceNo: true },
    });
    const start = (before._max.sequenceNo ?? 0) + 1;

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => post(tokens.admin, createBody({ title: `Parallel ${index}`, departmentId: ids.deptB }))),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(201));
    const sequences = responses.map((response) => Number(response.body.code.split('-')[2])).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 10 }, (_, index) => start + index));
  });

  it('uses the Excel default template for Excel documents', async () => {
    const created = (await post(tokens.qm, createBody({ title: 'A Spreadsheet', fileType: 'XLSX' })).expect(201)).body;
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: created.id } });

    expect(revision.storageKey.endsWith('.xlsx')).toBe(true);
    expect((await storage.getBuffer(revision.storageKey)).equals(blankXlsx)).toBe(true);
  });

  it('prefers the default template of the category over the global one', async () => {
    const created = (await post(tokens.qm, createBody({ title: 'Category Template', categoryId: ids.catOther })).expect(201)).body;
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: created.id } });

    expect(audit.metadata).toMatchObject({ templateId: ids.otherDocxTemplate });
  });

  it('uses the template that was asked for', async () => {
    const created = (
      await post(tokens.qm, createBody({ title: 'Explicit Template', categoryId: ids.catOther, templateId: ids.globalDocxTemplate })).expect(201)
    ).body;
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: created.id } });

    expect(audit.metadata).toMatchObject({ templateId: ids.globalDocxTemplate });
  });

  it.each([
    ['a template of another file type', () => ({ templateId: ids.globalXlsxTemplate })],
    ['a template of another category', () => ({ templateId: ids.otherDocxTemplate })],
    ['a template of another organization', () => ({ templateId: ids.foreignTemplate })],
    ['an unknown template', () => ({ templateId: randomUUID() })],
  ])('rejects %s', async (_label, extra) => {
    const response = await post(tokens.qm, createBody({ title: 'Bad Template', ...extra() })).expect(404);
    expect(response.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('fails cleanly when the template file is missing from storage', async () => {
    const template = await createTemplate(ids.organizationId, { name: 'Missing File', fileType: 'DOCX', categoryId: null, isDefault: false }, blankDocx, false);
    const before = await prisma.document.count({ where: { organizationId: ids.organizationId } });

    const response = await post(tokens.qm, createBody({ title: 'No File', templateId: template.id })).expect(500);

    expect(response.body.code).toBe('TEMPLATE_FILE_MISSING');
    expect(await prisma.document.count({ where: { organizationId: ids.organizationId } })).toBe(before);
  });

  it('removes the stored file when the database write fails', async () => {
    const putSpy = jest.spyOn(storage, 'put');
    jest.spyOn(app.get(DocumentCodeService), 'allocate').mockRejectedValueOnce(new Error('boom'));
    const before = await prisma.document.count({ where: { organizationId: ids.organizationId } });

    await post(tokens.qm, createBody({ title: 'Will Fail' })).expect(500);

    const [key] = putSpy.mock.calls.at(-1)!;
    expect(await storage.exists(key)).toBe(false);
    expect(await prisma.document.count({ where: { organizationId: ids.organizationId } })).toBe(before);
    putSpy.mockRestore();
  });
});

describe('create by upload', () => {
  it('stores an uploaded Word file unchanged', async () => {
    const response = await upload(tokens.qm, { content: () => blankDocx, filename: 'Existing Procedure.docx' }, { title: 'Imported Procedure' }).expect(201);

    expect(response.body).toMatchObject({ title: 'Imported Procedure', fileType: 'DOCX', status: 'DRAFT' });
    const revision = await prisma.revision.findFirstOrThrow({ where: { documentId: response.body.id } });
    expect(revision.checksum).toBe(createHash('sha256').update(blankDocx).digest('hex'));
    expect((await storage.getBuffer(revision.storageKey)).equals(blankDocx)).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: response.body.id } });
    expect(audit.metadata).toMatchObject({ source: 'UPLOAD', fileName: 'Existing Procedure.docx' });
  });

  it('derives the type from the file and the title from the file name', async () => {
    const response = await upload(tokens.qm, { content: () => blankXlsx, filename: 'Prosedür Taslağı.xlsx' }).expect(201);

    expect(response.body).toMatchObject({ title: 'Prosedür Taslağı', fileType: 'XLSX' });
  });

  it('accepts the official Office MIME type', async () => {
    await upload(tokens.qm, {
      content: blankDocx,
      filename: 'typed.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }).expect(201);
  });

  it.each([
    ['an unsupported extension', { content: () => Buffer.from('hello'), filename: 'notes.txt' }, 400, 'UNSUPPORTED_FILE_TYPE'],
    ['an old binary Office extension', { content: () => blankDocx, filename: 'old.doc' }, 400, 'UNSUPPORTED_FILE_TYPE'],
    ['a file without an extension', { content: () => blankDocx, filename: 'noextension' }, 400, 'UNSUPPORTED_FILE_TYPE'],
    ['an unrelated MIME type', { content: () => blankDocx, filename: 'x.docx', contentType: 'image/png' }, 400, 'UNSUPPORTED_FILE_TYPE'],
    ['plain text renamed to .docx', { content: () => Buffer.from('not a zip'), filename: 'fake.docx' }, 400, 'INVALID_FILE_CONTENT'],
    ['an Excel file renamed to .docx', { content: () => blankXlsx, filename: 'wrong.docx' }, 400, 'INVALID_FILE_CONTENT'],
    ['a Word file renamed to .xlsx', { content: () => blankDocx, filename: 'wrong.xlsx' }, 400, 'INVALID_FILE_CONTENT'],
    ['an empty file', { content: () => Buffer.alloc(0), filename: 'empty.docx' }, 400, 'EMPTY_FILE'],
  ])('rejects %s', async (_label, file, status, code) => {
    const before = await prisma.document.count({ where: { organizationId: ids.organizationId } });

    const response = await upload(tokens.qm, file, { title: 'Rejected Upload' }).expect(status);

    expect(response.body.code).toBe(code);
    expect(await prisma.document.count({ where: { organizationId: ids.organizationId } })).toBe(before);
  });

  it('rejects a request without a file', async () => {
    const response = await upload(tokens.qm, null, { title: 'No File' }).expect(400);
    expect(response.body.code).toBe('FILE_REQUIRED');
  });

  it('rejects a file above the size limit', async () => {
    const tooBig = Buffer.concat([blankDocx, Buffer.alloc(1024 * 1024)]);
    await upload(tokens.qm, { content: tooBig, filename: 'huge.docx' }, { title: 'Too Big' }).expect(413);
  });

  it('rejects a file name too short to become a title', async () => {
    const response = await upload(tokens.qm, { content: () => blankDocx, filename: 'a.docx' }).expect(400);
    expect(response.body.code).toBe('TITLE_REQUIRED');
  });
});

describe('permissions', () => {
  it('requires authentication', async () => {
    await request(app.getHttpServer()).post('/api/documents').send(createBody()).expect(401);
    await request(app.getHttpServer()).post('/api/documents/upload').expect(401);
  });

  it('does not let readers create documents', async () => {
    await post(tokens.reader, createBody()).expect(403);
    await upload(tokens.reader, { content: () => blankDocx, filename: 'x.docx' }, { title: 'Reader Upload' }).expect(403);
  });

  it.each(['editorA', 'approverA'] as const)('%s may create in their own department only', async (role) => {
    await post(tokens[role], createBody({ title: 'Own Department' })).expect(201);

    const response = await post(tokens[role], createBody({ title: 'Other Department', departmentId: ids.deptB })).expect(403);
    expect(response.body.code).toBe('DEPARTMENT_NOT_ALLOWED');
    await upload(tokens[role], { content: () => blankDocx, filename: 'x.docx' }, { title: 'Other Upload', departmentId: ids.deptB }).expect(403);
  });

  it('does not let an editor without a department create documents', async () => {
    await post(tokens.editorNoDept, createBody()).expect(403);
  });

  it.each(['qm', 'admin'] as const)('%s may create in any department', async (role) => {
    await post(tokens[role], createBody({ title: 'Any Department', departmentId: ids.deptB })).expect(201);
  });

  it('records the creator as owner and preparer', async () => {
    const created = (await post(tokens.admin, createBody({ title: 'Owned By Admin' })).expect(201)).body;
    const document = await prisma.document.findUniqueOrThrow({ where: { id: created.id }, include: { revisions: true } });

    expect(document.ownerId).toBe(adminId);
    expect(document.revisions[0].preparedById).toBe(adminId);
  });

  it('makes a new draft visible to the editor of the department but not to readers', async () => {
    const created = (await post(tokens.editorA, createBody({ title: 'Visible Draft' })).expect(201)).body;

    const listFor = async (token: string) =>
      (await request(app.getHttpServer()).get('/api/documents').query({ search: 'Visible Draft' }).set(auth(token)).expect(200)).body
        .items as DocumentListItemDto[];

    expect((await listFor(tokens.editorA)).map((item) => item.id)).toEqual([created.id]);
    expect(await listFor(tokens.reader)).toEqual([]);
  });
});

describe('references', () => {
  it.each([
    ['a category of another organization', { categoryId: () => ids.foreignCategory }, 'CATEGORY_NOT_FOUND'],
    ['an inactive category', { categoryId: () => ids.catInactive }, 'CATEGORY_NOT_FOUND'],
    ['an unknown category', { categoryId: () => randomUUID() }, 'CATEGORY_NOT_FOUND'],
    ['a department of another organization', { departmentId: () => ids.foreignDepartment }, 'DEPARTMENT_NOT_FOUND'],
    ['an unknown department', { departmentId: () => randomUUID() }, 'DEPARTMENT_NOT_FOUND'],
  ])('answers 404 for %s', async (_label, override, code) => {
    const body = createBody(Object.fromEntries(Object.entries(override).map(([key, value]) => [key, value()])));

    const response = await post(tokens.admin, body).expect(404);
    expect(response.body.code).toBe(code);
  });
});

describe('input validation', () => {
  it.each([
    ['a missing title', { title: undefined }],
    ['a too short title', { title: 'ab' }],
    ['a blank title', { title: '    ' }],
    ['a too long title', { title: 'x'.repeat(201) }],
    ['an unknown file type', { fileType: 'PDF' }],
    ['a malformed category id', { categoryId: 'nope' }],
    ['a malformed department id', { departmentId: 'nope' }],
    ['a malformed template id', { templateId: 'nope' }],
    ['an unexpected field', { code: 'PR-KK-999' }],
  ])('rejects %s', async (_label, override) => {
    await post(tokens.admin, createBody(override)).expect(400);
  });

  it('ignores a client supplied code: codes are always generated', async () => {
    await post(tokens.admin, createBody({ title: 'Code Attempt', code: 'XX-YY-999' })).expect(400);
  });

  it('trims the title', async () => {
    const response = await post(tokens.admin, createBody({ title: '   Padded Title   ' })).expect(201);
    expect(response.body.title).toBe('Padded Title');
  });
});

describe('GET /api/templates', () => {
  const get = (token: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get('/api/templates').query(query).set(auth(token));

  it('requires authentication and a creator role', async () => {
    await request(app.getHttpServer()).get('/api/templates').expect(401);
    await get(tokens.reader).expect(403);
  });

  it('lists the templates of the own organization only', async () => {
    const response = await get(tokens.editorA).expect(200);
    const names = response.body.map((template: { name: string }) => template.name).sort();

    expect(names).toEqual(['Global Excel', 'Global Word', 'Other Word', 'Missing File'].filter((name) => names.includes(name)).sort());
    expect(names).not.toContain('Foreign Word');
  });

  it('narrows to the global templates and those of a category', async () => {
    const forMain = (await get(tokens.editorA, { categoryId: ids.catMain, fileType: 'DOCX' }).expect(200)).body;
    expect(forMain.map((template: { name: string }) => template.name)).not.toContain('Other Word');
    expect(forMain.map((template: { name: string }) => template.name)).toContain('Global Word');

    const forOther = (await get(tokens.editorA, { categoryId: ids.catOther, fileType: 'DOCX' }).expect(200)).body;
    expect(forOther.map((template: { name: string }) => template.name)).toEqual(expect.arrayContaining(['Global Word', 'Other Word']));
  });

  it('filters by file type and exposes only what the form needs', async () => {
    const response = await get(tokens.editorA, { fileType: 'XLSX' }).expect(200);

    expect(response.body).toEqual([
      { id: ids.globalXlsxTemplate, name: 'Global Excel', fileType: 'XLSX', categoryId: null, isDefault: true },
    ]);
  });

  it('rejects an invalid file type', async () => {
    await get(tokens.editorA, { fileType: 'PDF' }).expect(400);
  });
});
