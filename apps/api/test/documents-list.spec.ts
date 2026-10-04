process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { DocumentListItemDto } from '@iso-dms/shared';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let app: INestApplication;
const organizationIds: string[] = [];

const ids = {} as {
  organizationId: string;
  deptA: string;
  deptB: string;
  catMain: string;
  catOther: string;
};
const tokens = {} as Record<'reader' | 'editorA' | 'editorB' | 'editorNoDept' | 'approver' | 'admin', string>;

async function sign(user: { id: string; role: UserRole; departmentId: string | null }): Promise<string> {
  return app.get(JwtService).signAsync(
    { sub: user.id, organizationId: ids.organizationId, role: user.role, departmentId: user.departmentId },
    { secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 300 },
  );
}

async function createUser(role: UserRole, departmentId: string | null, label: string) {
  return prisma.user.create({
    data: {
      organizationId: ids.organizationId,
      departmentId,
      email: `${label}@docs-list.local`,
      fullName: label,
      passwordHash: 'x',
      role,
    },
  });
}

async function createDocument(data: {
  code: string;
  title: string;
  departmentId: string;
  categoryId: string;
  status: DocumentStatus;
  ownerId: string;
  sequenceNo: number;
  revisionNo?: number;
  firstPublishedAt?: Date;
  revisedAt?: Date;
}) {
  const document = await prisma.document.create({
    data: {
      organizationId: ids.organizationId,
      categoryId: data.categoryId,
      departmentId: data.departmentId,
      ownerId: data.ownerId,
      code: data.code,
      sequenceNo: data.sequenceNo,
      title: data.title,
      fileType: 'DOCX',
      status: data.status,
      firstPublishedAt: data.firstPublishedAt,
      revisedAt: data.revisedAt,
    },
  });

  if (data.revisionNo !== undefined) {
    const revision = await prisma.revision.create({
      data: {
        organizationId: ids.organizationId,
        documentId: document.id,
        revisionNo: data.revisionNo,
        status: 'APPROVED',
        storageKey: `test/${document.id}.docx`,
        fileSize: 1,
        checksum: 'x',
        editorKey: randomUUID(),
        preparedById: data.ownerId,
      },
    });
    await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return document;
}

beforeAll(async () => {
  app = await createTestApp();

  const organization = await prisma.organization.create({
    data: { name: `Docs ${suffix}`, slug: `docs-${suffix}` },
  });
  const foreignOrganization = await prisma.organization.create({
    data: { name: `Foreign ${suffix}`, slug: `foreign-${suffix}` },
  });
  organizationIds.push(organization.id, foreignOrganization.id);
  ids.organizationId = organization.id;

  ids.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha Dept', code: 'AA' } })).id;
  ids.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta Dept', code: 'BB' } })).id;
  await prisma.department.create({ data: { organizationId: organization.id, name: 'Inactive Dept', code: 'II', isActive: false } });
  ids.catMain = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;
  ids.catOther = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Other', slug: 'other', codePrefix: 'OO' } })).id;

  const reader = await createUser('READER', ids.deptA, 'reader');
  const editorA = await createUser('EDITOR', ids.deptA, 'editor-a');
  const editorB = await createUser('EDITOR', ids.deptB, 'editor-b');
  const editorNoDept = await createUser('EDITOR', null, 'editor-nodept');
  const approver = await createUser('APPROVER', ids.deptA, 'approver');
  const admin = await createUser('ADMIN', null, 'admin');
  tokens.reader = await sign(reader);
  tokens.editorA = await sign(editorA);
  tokens.editorB = await sign(editorB);
  tokens.editorNoDept = await sign(editorNoDept);
  tokens.approver = await sign(approver);
  tokens.admin = await sign(admin);

  const owner = admin.id;
  const base = { ownerId: owner, categoryId: ids.catMain };
  await createDocument({ ...base, code: 'MM-AA-001', title: 'Alpha Procedure', departmentId: ids.deptA, status: 'PUBLISHED', sequenceNo: 1, revisionNo: 2, firstPublishedAt: new Date('2025-01-10T09:00:00Z'), revisedAt: new Date('2025-06-01T09:00:00Z') });
  await createDocument({ ...base, code: 'MM-AA-002', title: 'Beta Instruction', departmentId: ids.deptA, status: 'PUBLISHED', sequenceNo: 2, revisionNo: 0, firstPublishedAt: new Date('2025-02-01T09:00:00Z') });
  await createDocument({ ...base, code: 'MM-BB-001', title: 'Gamma Form', departmentId: ids.deptB, status: 'PUBLISHED', sequenceNo: 1, revisionNo: 1, firstPublishedAt: new Date('2025-03-01T09:00:00Z'), revisedAt: new Date('2025-04-01T09:00:00Z') });
  await createDocument({ ...base, code: 'MM-AA-003', title: 'Draft A', departmentId: ids.deptA, status: 'DRAFT', sequenceNo: 3 });
  await createDocument({ ...base, code: 'MM-BB-002', title: 'Draft B', departmentId: ids.deptB, status: 'DRAFT', sequenceNo: 2 });
  await createDocument({ ...base, code: 'MM-AA-004', title: 'Withdrawn A', departmentId: ids.deptA, status: 'WITHDRAWN', sequenceNo: 4 });
  await createDocument({ ...base, code: 'MM-AA-005', title: 'Review A', departmentId: ids.deptA, status: 'IN_REVIEW', sequenceNo: 5 });
  await createDocument({ ...base, categoryId: ids.catOther, code: 'OO-AA-001', title: 'Other Category Doc', departmentId: ids.deptA, status: 'PUBLISHED', sequenceNo: 1, revisionNo: 0, firstPublishedAt: new Date('2025-05-01T09:00:00Z') });

  // A published document of another organization must never show up
  const foreignDept = await prisma.department.create({ data: { organizationId: foreignOrganization.id, name: 'F', code: 'FF' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreignOrganization.id, email: 'f@docs-list.local', fullName: 'F', passwordHash: 'x' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreignOrganization.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  await prisma.document.create({ data: { organizationId: foreignOrganization.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'Foreign Alpha', fileType: 'DOCX', status: 'PUBLISHED' } });
});

afterAll(async () => {
  // Test cleanup only; the application never deletes documents or revisions physically.
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

async function list(token: string, query: Record<string, string | number> = {}) {
  const response = await request(app.getHttpServer())
    .get('/api/documents')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const items = response.body.items as DocumentListItemDto[];
  return { ...response.body, items, codes: items.map((item) => item.code) } as {
    items: DocumentListItemDto[];
    codes: string[];
    total: number;
    page: number;
    pageSize: number;
  };
}

describe('authentication', () => {
  it('requires a token', async () => {
    await request(app.getHttpServer()).get('/api/documents').expect(401);
    await request(app.getHttpServer()).get('/api/departments').expect(401);
  });
});

describe('visibility by role', () => {
  const published = ['MM-AA-001', 'MM-AA-002', 'MM-BB-001', 'OO-AA-001'];

  it('READER sees published documents only and the status filter cannot widen that', async () => {
    expect((await list(tokens.reader)).codes).toEqual(published);
    expect((await list(tokens.reader, { status: 'DRAFT' })).codes).toEqual(published);
  });

  it('EDITOR sees published documents plus non-published ones of their own department', async () => {
    expect((await list(tokens.editorA)).codes).toEqual([
      'MM-AA-001', 'MM-AA-002', 'MM-AA-003', 'MM-AA-004', 'MM-AA-005', 'MM-BB-001', 'OO-AA-001',
    ]);
    expect((await list(tokens.editorB)).codes).toEqual([
      'MM-AA-001', 'MM-AA-002', 'MM-BB-001', 'MM-BB-002', 'OO-AA-001',
    ]);
  });

  it('EDITOR without a department sees published documents only', async () => {
    expect((await list(tokens.editorNoDept)).codes).toEqual(published);
  });

  it('EDITOR status filter stays inside their visibility', async () => {
    expect((await list(tokens.editorA, { status: 'DRAFT' })).codes).toEqual(['MM-AA-003']);
  });

  it.each(['approver', 'admin'] as const)('%s sees every document of the organization', async (role) => {
    const result = await list(tokens[role]);
    expect(result.total).toBe(8);
    expect((await list(tokens[role], { status: 'DRAFT' })).codes).toEqual(['MM-AA-003', 'MM-BB-002']);
    expect((await list(tokens[role], { status: 'WITHDRAWN' })).codes).toEqual(['MM-AA-004']);
  });

  it('never returns documents of another organization', async () => {
    const result = await list(tokens.admin, { search: 'Foreign' });
    expect(result.total).toBe(0);
  });
});

describe('filters', () => {
  it('filters by category', async () => {
    expect((await list(tokens.admin, { categoryId: ids.catOther })).codes).toEqual(['OO-AA-001']);
  });

  it('filters by department', async () => {
    expect((await list(tokens.admin, { departmentId: ids.deptB })).codes).toEqual(['MM-BB-001', 'MM-BB-002']);
  });

  it('combines category, department and status', async () => {
    const result = await list(tokens.admin, { categoryId: ids.catMain, departmentId: ids.deptA, status: 'PUBLISHED' });
    expect(result.codes).toEqual(['MM-AA-001', 'MM-AA-002']);
  });

  it('searches the title case-insensitively', async () => {
    expect((await list(tokens.admin, { search: 'aLpHa' })).codes).toEqual(['MM-AA-001']);
  });

  it('searches the document code case-insensitively', async () => {
    expect((await list(tokens.admin, { search: 'mm-bb' })).codes).toEqual(['MM-BB-001', 'MM-BB-002']);
  });

  it('treats wildcard characters literally', async () => {
    expect((await list(tokens.admin, { search: '%' })).total).toBe(0);
    expect((await list(tokens.admin, { search: '_' })).total).toBe(0);
    // "_" must not act as a single-character wildcard: "MM_AA" would match "MM-AA-001" otherwise
    expect((await list(tokens.admin, { search: 'MM_AA' })).total).toBe(0);
    expect((await list(tokens.admin, { search: 'MM-AA' })).total).toBeGreaterThan(0);
  });

  it('finds documents whose title contains a wildcard character', async () => {
    const document = await prisma.document.findFirstOrThrow({
      where: { organizationId: ids.organizationId, code: 'MM-AA-004' },
    });
    await prisma.document.update({ where: { id: document.id }, data: { title: '100% Withdrawn_A' } });
    try {
      expect((await list(tokens.admin, { search: '100%' })).codes).toEqual(['MM-AA-004']);
      expect((await list(tokens.admin, { search: 'n_A' })).codes).toEqual(['MM-AA-004']);
    } finally {
      await prisma.document.update({ where: { id: document.id }, data: { title: 'Withdrawn A' } });
    }
  });

  it('ignores a blank search', async () => {
    expect((await list(tokens.admin, { search: '   ' })).total).toBe(8);
  });

  it('applies search on top of role visibility', async () => {
    expect((await list(tokens.reader, { search: 'Draft' })).total).toBe(0);
  });
});

describe('sorting', () => {
  it('sorts by code ascending by default', async () => {
    const { codes } = await list(tokens.admin);
    expect(codes).toEqual([...codes].sort());
  });

  it('sorts by title descending', async () => {
    const { items } = await list(tokens.admin, { sortBy: 'title', sortOrder: 'desc' });
    const titles = items.map((item) => item.title);
    expect(titles).toEqual([...titles].sort().reverse());
  });

  it('sorts by department name', async () => {
    const { items } = await list(tokens.admin, { sortBy: 'department' });
    const names = items.map((item) => item.department.name);
    expect(names).toEqual([...names].sort());
  });

  it('sorts by first publication date with unpublished documents last', async () => {
    const { codes } = await list(tokens.admin, { sortBy: 'firstPublishedAt', sortOrder: 'desc' });
    expect(codes.slice(0, 4)).toEqual(['OO-AA-001', 'MM-BB-001', 'MM-AA-002', 'MM-AA-001']);
  });

  it('sorts by revision number', async () => {
    const { items } = await list(tokens.reader, { sortBy: 'revisionNo', sortOrder: 'desc' });
    expect(items.map((item) => item.revisionNo)).toEqual([2, 1, 0, 0]);
  });
});

describe('pagination', () => {
  it('returns the requested page and the total', async () => {
    const first = await list(tokens.admin, { pageSize: 3, page: 1 });
    const second = await list(tokens.admin, { pageSize: 3, page: 2 });
    const third = await list(tokens.admin, { pageSize: 3, page: 3 });

    expect(first).toMatchObject({ total: 8, page: 1, pageSize: 3 });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([3, 3, 2]);
    expect(new Set([...first.codes, ...second.codes, ...third.codes]).size).toBe(8);
  });

  it('returns an empty page beyond the last one', async () => {
    const result = await list(tokens.admin, { page: 99 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(8);
  });

  it('keeps pages stable when sorting by a column with ties', async () => {
    const pages = [
      await list(tokens.admin, { sortBy: 'department', pageSize: 3, page: 1 }),
      await list(tokens.admin, { sortBy: 'department', pageSize: 3, page: 2 }),
      await list(tokens.admin, { sortBy: 'department', pageSize: 3, page: 3 }),
    ];
    expect(new Set(pages.flatMap((page) => page.codes)).size).toBe(8);
  });

  it('defaults to 20 items per page', async () => {
    expect((await list(tokens.admin)).pageSize).toBe(20);
  });
});

describe('list item shape', () => {
  it('exposes the fields the table needs', async () => {
    const { items } = await list(tokens.admin, { search: 'MM-AA-001' });

    expect(items[0]).toEqual({
      id: expect.any(String),
      code: 'MM-AA-001',
      title: 'Alpha Procedure',
      fileType: 'DOCX',
      status: 'PUBLISHED',
      categoryId: ids.catMain,
      department: { id: ids.deptA, name: 'Alpha Dept', code: 'AA' },
      firstPublishedAt: '2025-01-10T09:00:00.000Z',
      revisedAt: '2025-06-01T09:00:00.000Z',
      revisionNo: 2,
      canEdit: false, // published documents are not edited in place
    });
  });

  it('uses null for dates and revision number of unpublished documents', async () => {
    const { items } = await list(tokens.admin, { search: 'MM-AA-003' });
    expect(items[0]).toMatchObject({ firstPublishedAt: null, revisedAt: null, revisionNo: null });
  });
});

describe('canEdit flag', () => {
  const flags = async (token: string) =>
    Object.fromEntries((await list(token, { status: 'DRAFT' })).items.map((item) => [item.code, item.canEdit]));

  it('is true for drafts of the own department only (editor, approver)', async () => {
    expect(await flags(tokens.editorA)).toEqual({ 'MM-AA-003': true });
    expect(await flags(tokens.approver)).toEqual({ 'MM-AA-003': true, 'MM-BB-002': false });
  });

  it('is true for drafts of every department for quality managers and admins', async () => {
    expect(await flags(tokens.admin)).toEqual({ 'MM-AA-003': true, 'MM-BB-002': true });
  });

  it('is never true for readers or for documents that are not drafts', async () => {
    expect((await list(tokens.reader)).items.every((item) => !item.canEdit)).toBe(true);
    const all = (await list(tokens.admin)).items;
    expect(all.filter((item) => item.canEdit).map((item) => item.status)).toEqual(['DRAFT', 'DRAFT']);
  });
});

describe('query validation', () => {
  it.each([
    { pageSize: 101 },
    { pageSize: 0 },
    { page: 0 },
    { page: 'abc' },
    { sortBy: 'passwordHash' },
    { sortOrder: 'sideways' },
    { status: 'DELETED' },
    { categoryId: 'not-a-uuid' },
    { departmentId: 'not-a-uuid' },
    { unknownParam: 'x' },
    { search: 'x'.repeat(101) },
  ])('rejects %j', async (query) => {
    await request(app.getHttpServer())
      .get('/api/documents')
      .query(query)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(400);
  });
});

describe('GET /api/departments', () => {
  it('returns active departments of the own organization sorted by name', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/departments')
      .set('Authorization', `Bearer ${tokens.reader}`)
      .expect(200);

    expect(response.body).toEqual([
      { id: ids.deptA, name: 'Alpha Dept', code: 'AA' },
      { id: ids.deptB, name: 'Beta Dept', code: 'BB' },
    ]);
  });
});
