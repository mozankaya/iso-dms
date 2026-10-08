process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MAX_UPLOAD_MB = '1'; // read when the templates controller is first loaded

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import JSZip from 'jszip';
import request from 'supertest';
import type { AdminTemplateDto } from '@iso-dms/shared';
import type { UserRole } from '../src/generated/prisma/enums';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let blankDocx: Buffer;
let blankXlsx: Buffer;
let organizationId: string;
let categoryA: string;
let categoryB: string;
let foreignCategory: string;
let foreignTemplateId: string;
let departmentId: string;
type Label = 'admin' | 'qm' | 'editor' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const uniqueName = (prefix = 'Şablon') => `${prefix} ${randomUUID().slice(0, 6)}`;

/** A real, small docx with a marker, so a stored file can be told from another. */
async function docxWith(marker: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(blankDocx);
  zip.file('marker.txt', marker);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function upload(token: string, fields: Record<string, string>, file?: { content: Buffer; filename: string; contentType?: string }) {
  const req = api().post('/api/templates').set(auth(token));
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  if (file) req.attach('file', file.content, { filename: file.filename, contentType: file.contentType ?? 'application/octet-stream' });
  return req;
}
const patch = (token: string, id: string, body: Record<string, unknown>) => api().patch(`/api/templates/${id}`).set(auth(token)).send(body);
const replace = (token: string, id: string, file: { content: Buffer; filename: string }) =>
  api().put(`/api/templates/${id}/file`).set(auth(token)).attach('file', file.content, { filename: file.filename, contentType: 'application/octet-stream' });
const remove = (token: string, id: string) => api().delete(`/api/templates/${id}`).set(auth(token));
const overview = async () => (await api().get('/api/templates/overview').set(auth(users.admin.token)).expect(200)).body as AdminTemplateDto[];

async function newTemplate(fields: Record<string, string> = {}, fileType: 'docx' | 'xlsx' = 'docx') {
  const response = await upload(
    users.admin.token,
    { name: uniqueName(), ...fields },
    { content: fileType === 'docx' ? await docxWith(randomUUID()) : blankXlsx, filename: `file.${fileType}` },
  ).expect(201);
  return response.body as AdminTemplateDto;
}

beforeAll(async () => {
  app = await createTestApp();
  storage = app.get(StorageService);
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));

  const organization = await prisma.organization.create({ data: { name: `Templates ${suffix}`, slug: `templates-${suffix}` } });
  const other = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `templates-f-${suffix}` } });
  organizationIds.push(organization.id, other.id);
  organizationId = organization.id;
  categoryA = (await prisma.category.create({ data: { organizationId, name: 'Kategori A', slug: 'a', codePrefix: 'AA' } })).id;
  categoryB = (await prisma.category.create({ data: { organizationId, name: 'Kategori B', slug: 'b', codePrefix: 'BB' } })).id;
  departmentId = (await prisma.department.create({ data: { organizationId, name: 'Birim', code: 'BR' } })).id;
  foreignCategory = (await prisma.category.create({ data: { organizationId: other.id, name: 'Yabancı', slug: 'y', codePrefix: 'YY' } })).id;
  const foreignKey = `${other.id}/templates/${randomUUID()}.docx`;
  await storage.put(foreignKey, blankDocx, 'application/octet-stream');
  foreignTemplateId = (await prisma.template.create({ data: { organizationId: other.id, name: 'Yabancı Şablon', fileType: 'DOCX', storageKey: foreignKey } })).id;

  const make = async (label: Label, role: UserRole) => {
    const user = await prisma.user.create({ data: { organizationId, departmentId, email: `${label}@templates.local`, fullName: label, passwordHash: 'x', role } });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId, role, departmentId }) };
  };
  await make('admin', 'ADMIN');
  await make('qm', 'QUALITY_MANAGER');
  await make('editor', 'EDITOR');
  await make('reader', 'READER');
  // The organization starts with one template of each type, like a seeded one
  for (const [name, fileType, content] of [['Başlangıç Word', 'DOCX', blankDocx], ['Başlangıç Excel', 'XLSX', blankXlsx]] as const) {
    const key = `${organizationId}/templates/${randomUUID()}.${fileType.toLowerCase()}`;
    await storage.put(key, content, 'application/octet-stream');
    await prisma.template.create({ data: { organizationId, name, fileType, storageKey: key, isDefault: true } });
  }
});

afterAll(async () => {
  const templates = await prisma.template.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  await Promise.all(templates.map((template) => storage.delete(template.storageKey).catch(() => undefined)));
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.template.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

describe('who may', () => {
  it('requires authentication', async () => {
    await api().get('/api/templates/overview').expect(401);
    await api().post('/api/templates').expect(401);
    await api().patch(`/api/templates/${randomUUID()}`).send({}).expect(401);
    await api().put(`/api/templates/${randomUUID()}/file`).expect(401);
    await api().get(`/api/templates/${randomUUID()}/download`).expect(401);
    await api().delete(`/api/templates/${randomUUID()}`).expect(401);
  });

  it.each(['qm', 'editor', 'reader'] as const)('refuses %s with 403 on every administration endpoint', async (who) => {
    const token = users[who].token;
    const target = (await overview())[0].id;
    await api().get('/api/templates/overview').set(auth(token)).expect(403);
    await upload(token, { name: uniqueName() }, { content: blankDocx, filename: 'a.docx' }).expect(403);
    await patch(token, target, { name: 'Kaçak' }).expect(403);
    await replace(token, target, { content: blankDocx, filename: 'a.docx' }).expect(403);
    await api().get(`/api/templates/${target}/download`).set(auth(token)).expect(403);
    await remove(token, target).expect(403);
    expect(await prisma.template.count({ where: { id: target } })).toBe(1);
  });

  it('keeps the picker of the new-document screen open to those who write', async () => {
    for (const who of ['editor', 'qm', 'admin'] as const) await api().get('/api/templates').set(auth(users[who].token)).expect(200);
    await api().get('/api/templates').set(auth(users.reader.token)).expect(403);
  });
});

describe('the overview', () => {
  it('lists the templates of the organization with their category, and never those of another', async () => {
    const made = await newTemplate({ categoryId: categoryA });

    const rows = await overview();

    expect(rows.find((row) => row.id === made.id)).toEqual({
      id: made.id,
      name: made.name,
      fileType: 'DOCX',
      category: { id: categoryA, name: 'Kategori A' },
      isDefault: false,
      createdAt: expect.any(String),
    });
    expect(rows.map((row) => row.id)).not.toContain(foreignTemplateId);
    expect(JSON.stringify(rows)).not.toContain('storageKey');
  });
});

describe('adding', () => {
  it('stores the file, takes the file type from it, and the template is then offered to editors', async () => {
    const content = await docxWith('stored');
    const response = await upload(users.admin.token, { name: '  Yeni Prosedür Şablonu ', categoryId: categoryA }, { content, filename: 'şablon.docx' }).expect(201);

    expect(response.body).toMatchObject({ name: 'Yeni Prosedür Şablonu', fileType: 'DOCX', category: { id: categoryA }, isDefault: false });
    const row = await prisma.template.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(row.storageKey).toMatch(new RegExp(`^${organizationId}/templates/[0-9a-f-]{36}\\.docx$`));
    expect((await storage.getBuffer(row.storageKey)).equals(content)).toBe(true);
    const offered = (await api().get('/api/templates').query({ categoryId: categoryA }).set(auth(users.editor.token)).expect(200)).body as { id: string }[];
    expect(offered.map((item) => item.id)).toContain(response.body.id);
  });

  it('makes an Excel template and a template for every category', async () => {
    const excel = await newTemplate({}, 'xlsx');
    expect(excel).toMatchObject({ fileType: 'XLSX', category: null });
    const empty = await newTemplate({ categoryId: '' });
    expect(empty.category).toBeNull();
  });

  it('takes the default place, and only one template is the default per category and file type', async () => {
    const first = await newTemplate({ categoryId: categoryB, isDefault: 'true' });
    expect(first.isDefault).toBe(true);
    const second = await newTemplate({ categoryId: categoryB, isDefault: 'true' });
    const otherCategory = await newTemplate({ categoryId: categoryA, isDefault: 'true' });
    const otherType = await newTemplate({ categoryId: categoryB, isDefault: 'true' }, 'xlsx');

    const rows = await overview();
    const isDefault = (id: string) => rows.find((row) => row.id === id)!.isDefault;
    expect(isDefault(first.id)).toBe(false);
    expect(isDefault(second.id)).toBe(true);
    expect(isDefault(otherCategory.id)).toBe(true);
    expect(isDefault(otherType.id)).toBe(true);
  });

  it('refuses a name another template of the same type has, in any letter case, but not of the other type', async () => {
    const name = uniqueName('Aynı Ad');
    await upload(users.admin.token, { name }, { content: blankDocx, filename: 'a.docx' }).expect(201);

    const again = await upload(users.admin.token, { name: name.toLocaleUpperCase('tr-TR') }, { content: blankDocx, filename: 'a.docx' }).expect(409);

    expect(again.body.code).toBe('TEMPLATE_NAME_TAKEN');
    await upload(users.admin.token, { name }, { content: blankXlsx, filename: 'a.xlsx' }).expect(201);
  });

  it('lets exactly one of two simultaneous requests for the same name win, and leaves no orphan file', async () => {
    const name = uniqueName('Yarış');
    const before = await prisma.template.count({ where: { organizationId } });

    const [one, two] = await Promise.all([
      upload(users.admin.token, { name }, { content: blankDocx, filename: 'a.docx' }),
      upload(users.admin.token, { name }, { content: blankDocx, filename: 'a.docx' }),
    ]);

    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(await prisma.template.count({ where: { organizationId } })).toBe(before + 1);
  });

  it.each([
    ['no file', { name: 'Dosyasız' }, undefined, 'FILE_REQUIRED'],
    ['a file that is not an Office file', { name: 'Metin' }, () => ({ content: Buffer.from('plain text'), filename: 'a.docx' }), 'INVALID_FILE_CONTENT'],
    ['an extension nobody accepts', { name: 'Pdf' }, () => ({ content: blankDocx, filename: 'a.pdf' }), 'UNSUPPORTED_FILE_TYPE'],
    ['an empty file', { name: 'Boş' }, () => ({ content: Buffer.alloc(0), filename: 'a.docx' }), 'EMPTY_FILE'],
    ['a docx named xlsx', { name: 'Yanlış Uzantı' }, () => ({ content: blankDocx, filename: 'a.xlsx' }), 'INVALID_FILE_CONTENT'],
  ])('refuses %s', async (_label, fields, file, code) => {
    const before = await prisma.template.count({ where: { organizationId } });
    const response = await upload(users.admin.token, fields, file?.()).expect(400);
    expect(response.body.code).toBe(code);
    expect(await prisma.template.count({ where: { organizationId } })).toBe(before);
  });

  it('refuses a file over the limit', async () => {
    const big = Buffer.concat([blankDocx, Buffer.alloc(1024 * 1024 + 10)]);
    await upload(users.admin.token, { name: 'Büyük' }, { content: big, filename: 'a.docx' }).expect(413);
  });

  it.each([
    ['no name', {}],
    ['a name of one character', { name: 'A' }],
    ['a name that is too long', { name: 'A'.repeat(101) }],
    ['a category that is not an id', { name: 'Kategori', categoryId: 'abc' }],
    ['a default flag that is not a boolean', { name: 'Bayrak', isDefault: 'belki' }],
    ['an unknown field', { name: 'Alan', fileType: 'XLSX' }],
  ])('refuses %s', async (_label, fields) => {
    const before = await prisma.template.count({ where: { organizationId } });
    await upload(users.admin.token, fields as Record<string, string>, { content: blankDocx, filename: 'a.docx' }).expect(400);
    expect(await prisma.template.count({ where: { organizationId } })).toBe(before);
  });

  it('answers 404 for a category that is unknown or of another organization, and keeps no file', async () => {
    for (const categoryId of [randomUUID(), foreignCategory]) {
      const response = await upload(users.admin.token, { name: uniqueName(), categoryId }, { content: blankDocx, filename: 'a.docx' }).expect(404);
      expect(response.body.code).toBe('CATEGORY_NOT_FOUND');
    }
  });

  it('is audited', async () => {
    const made = await newTemplate({ categoryId: categoryA, isDefault: 'true' });

    const [entry] = await auditOf(made.id);

    expect(entry).toMatchObject({ action: 'TEMPLATE_CREATED', entityType: 'Template', userId: users.admin.id, organizationId });
    expect(entry.metadata).toEqual({ name: made.name, fileType: 'DOCX', categoryId: categoryA, isDefault: true });
  });
});

describe('changing', () => {
  it('renames, moves to another category or to all of them, and makes the default', async () => {
    const made = await newTemplate({ categoryId: categoryA });

    const moved = await patch(users.admin.token, made.id, { name: '  Yeni Ad ', categoryId: categoryB, isDefault: true }).expect(200);
    expect(moved.body).toMatchObject({ name: 'Yeni Ad', category: { id: categoryB }, isDefault: true });
    const global = await patch(users.admin.token, made.id, { categoryId: null }).expect(200);
    expect(global.body.category).toBeNull();
  });

  it('takes the place of the default when moved into a category, and when made one', async () => {
    const holder = await newTemplate({ categoryId: categoryB, isDefault: 'true' });
    const mover = await newTemplate({ categoryId: categoryA, isDefault: 'true' });

    await patch(users.admin.token, mover.id, { categoryId: categoryB }).expect(200);

    const rows = await overview();
    expect(rows.find((row) => row.id === mover.id)!.isDefault).toBe(true);
    expect(rows.find((row) => row.id === holder.id)!.isDefault).toBe(false);
  });

  it('refuses a file type, a file, an organization and bad values', async () => {
    const made = await newTemplate();
    for (const body of [{ fileType: 'XLSX' }, { storageKey: 'x' }, { organizationId: randomUUID() }, { name: 'A' }, { categoryId: 'abc' }, { isDefault: 'yes' }]) {
      await patch(users.admin.token, made.id, body).expect(400);
    }
    expect((await overview()).find((row) => row.id === made.id)).toMatchObject({ name: made.name, fileType: 'DOCX' });
  });

  it('refuses a name another template of the type has, but lets a template keep its own', async () => {
    const first = await newTemplate();
    const second = await newTemplate();
    expect((await patch(users.admin.token, second.id, { name: first.name.toUpperCase() }).expect(409)).body.code).toBe('TEMPLATE_NAME_TAKEN');
    await patch(users.admin.token, first.id, { name: first.name.toUpperCase() }).expect(200);
  });

  it('answers 404 for unknown templates, those of another organization, and categories that are not usable', async () => {
    expect((await patch(users.admin.token, randomUUID(), { name: 'Şablon' }).expect(404)).body.code).toBe('TEMPLATE_NOT_FOUND');
    await patch(users.admin.token, foreignTemplateId, { name: 'Ele Geçirilen' }).expect(404);
    expect((await prisma.template.findUniqueOrThrow({ where: { id: foreignTemplateId } })).name).toBe('Yabancı Şablon');
    const made = await newTemplate();
    expect((await patch(users.admin.token, made.id, { categoryId: foreignCategory }).expect(404)).body.code).toBe('CATEGORY_NOT_FOUND');
    await patch(users.admin.token, 'not-a-uuid', { name: 'Şablon' }).expect(400);
  });

  it('is audited with what changed, and a request that changes nothing is not', async () => {
    const made = await newTemplate({ categoryId: categoryA });
    await patch(users.admin.token, made.id, { name: 'Yeni Denetim Adı', isDefault: true }).expect(200);
    await patch(users.admin.token, made.id, { name: 'Yeni Denetim Adı' }).expect(200);
    await patch(users.admin.token, made.id, {}).expect(200);

    const entries = await auditOf(made.id);

    expect(entries.map((entry) => entry.action)).toEqual(['TEMPLATE_CREATED', 'TEMPLATE_UPDATED']);
    expect(entries[1].metadata).toEqual({ name: made.name, changes: { name: { from: made.name, to: 'Yeni Denetim Adı' }, isDefault: { from: false, to: true } } });
  });
});

describe('replacing the file', () => {
  it('stores the new content, removes the old file, and leaves documents made earlier alone', async () => {
    const made = await newTemplate({ categoryId: categoryA });
    const before = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });
    const content = await docxWith('second version');

    await replace(users.admin.token, made.id, { content, filename: 'yeni.docx' }).expect(200);

    const after = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });
    expect(after.storageKey).not.toBe(before.storageKey);
    expect((await storage.getBuffer(after.storageKey)).equals(content)).toBe(true);
    expect(await storage.exists(before.storageKey)).toBe(false);
  });

  it('refuses a file of another type, an invalid one and none, and keeps the file it has', async () => {
    const made = await newTemplate();
    const before = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });

    expect((await replace(users.admin.token, made.id, { content: blankXlsx, filename: 'a.xlsx' }).expect(400)).body.code).toBe('TEMPLATE_FILE_TYPE_MISMATCH');
    expect((await replace(users.admin.token, made.id, { content: Buffer.from('nope'), filename: 'a.docx' }).expect(400)).body.code).toBe('INVALID_FILE_CONTENT');
    expect((await api().put(`/api/templates/${made.id}/file`).set(auth(users.admin.token)).expect(400)).body.code).toBe('FILE_REQUIRED');

    const after = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });
    expect(after.storageKey).toBe(before.storageKey);
    expect(await storage.exists(before.storageKey)).toBe(true);
  });

  it('answers 404 for unknown templates and those of another organization, and keeps no new file', async () => {
    const keys = async () => (await prisma.template.findMany({ where: { organizationId }, select: { storageKey: true } })).length;
    const count = await keys();
    expect((await replace(users.admin.token, randomUUID(), { content: blankDocx, filename: 'a.docx' }).expect(404)).body.code).toBe('TEMPLATE_NOT_FOUND');
    await replace(users.admin.token, foreignTemplateId, { content: blankDocx, filename: 'a.docx' }).expect(404);
    expect(await keys()).toBe(count);
  });

  it('is audited with the size of the file', async () => {
    const made = await newTemplate();
    const content = await docxWith('audited');
    await replace(users.admin.token, made.id, { content, filename: 'a.docx' }).expect(200);

    const entries = (await auditOf(made.id)).filter((entry) => entry.action === 'TEMPLATE_FILE_REPLACED');

    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toEqual({ name: made.name, fileType: 'DOCX', fileSize: content.length });
  });
});

describe('downloading', () => {
  it('gives the file under the name of the template, Turkish characters included', async () => {
    const content = await docxWith('download');
    const made = (await upload(users.admin.token, { name: 'Çalışma Talimatı' }, { content, filename: 'x.docx' }).expect(201)).body as AdminTemplateDto;

    const response = await api().get(`/api/templates/${made.id}/download`).set(auth(users.admin.token)).buffer().parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200);

    expect(Buffer.from(response.body).equals(content)).toBe(true);
    expect(response.headers['content-type']).toContain('wordprocessingml');
    expect(decodeURIComponent(response.headers['content-disposition'])).toContain('Çalışma Talimatı.docx');
  });

  it('answers 404 for unknown templates, those of another organization and a file that is gone', async () => {
    await api().get(`/api/templates/${randomUUID()}/download`).set(auth(users.admin.token)).expect(404);
    await api().get(`/api/templates/${foreignTemplateId}/download`).set(auth(users.admin.token)).expect(404);
    const made = await newTemplate();
    const row = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });
    await storage.delete(row.storageKey);
    expect((await api().get(`/api/templates/${made.id}/download`).set(auth(users.admin.token)).expect(404)).body.code).toBe('TEMPLATE_FILE_MISSING');
  });
});

describe('deleting', () => {
  it('removes the template and its file, and new documents no longer offer it', async () => {
    const made = await newTemplate({ categoryId: categoryA });
    const row = await prisma.template.findUniqueOrThrow({ where: { id: made.id } });

    await remove(users.admin.token, made.id).expect(204);

    expect(await prisma.template.count({ where: { id: made.id } })).toBe(0);
    expect(await storage.exists(row.storageKey)).toBe(false);
    const offered = (await api().get('/api/templates').set(auth(users.editor.token)).expect(200)).body as { id: string }[];
    expect(offered.map((item) => item.id)).not.toContain(made.id);
  });

  it('still lets documents be made when the default is deleted (another template takes over)', async () => {
    const made = await newTemplate({ categoryId: categoryA, isDefault: 'true' });
    await remove(users.admin.token, made.id).expect(204);

    const response = await api().post('/api/documents').set(auth(users.admin.token)).send({ title: 'Şablon Yedek Denemesi', categoryId: categoryA, departmentId, fileType: 'DOCX' }).expect(201);

    expect(response.body.id).toEqual(expect.any(String));
    await prisma.revision.deleteMany({ where: { documentId: response.body.id } });
    await deleteAuditLogs(prisma, { entityId: response.body.id });
    await prisma.document.delete({ where: { id: response.body.id } });
  });

  it('refuses to delete the last template of a file type, until another is added', async () => {
    // A file type nobody else has: remove the extra Excel templates of this organization first
    const excel = await prisma.template.findMany({ where: { organizationId, fileType: 'XLSX' }, orderBy: { createdAt: 'asc' } });
    for (const extra of excel.slice(1)) await remove(users.admin.token, extra.id).expect(204);
    const last = excel[0];

    const response = await remove(users.admin.token, last.id).expect(409);
    expect(response.body.code).toBe('LAST_TEMPLATE_PROTECTED');
    expect(await prisma.template.count({ where: { id: last.id } })).toBe(1);
    expect(await storage.exists(last.storageKey)).toBe(true);

    const another = await newTemplate({}, 'xlsx');
    await remove(users.admin.token, last.id).expect(204);
    await remove(users.admin.token, another.id).expect(409);
  });

  it('answers 404 for unknown templates and those of another organization', async () => {
    expect((await remove(users.admin.token, randomUUID()).expect(404)).body.code).toBe('TEMPLATE_NOT_FOUND');
    await remove(users.admin.token, foreignTemplateId).expect(404);
    expect(await prisma.template.count({ where: { id: foreignTemplateId } })).toBe(1);
    await remove(users.admin.token, 'not-a-uuid').expect(400);
  });

  it('is audited with what was deleted', async () => {
    const made = await newTemplate({ categoryId: categoryA, isDefault: 'true' });
    await remove(users.admin.token, made.id).expect(204);

    const entries = (await auditOf(made.id)).filter((entry) => entry.action === 'TEMPLATE_DELETED');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: users.admin.id });
    expect(entries[0].metadata).toEqual({ name: made.name, fileType: 'DOCX', categoryId: categoryA, wasDefault: true });
  });
});
