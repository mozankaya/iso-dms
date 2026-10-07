process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AUDIT_ACTIONS, type AuditLogDto, type PaginatedDto } from '@iso-dms/shared';
import type { UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
const org = {} as { id: string; deptA: string; category: string };
const foreign = {} as { id: string; userId: string; documentId: string };
type Label = 'admin' | 'qm' | 'approver' | 'editor' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;
const docs = {} as Record<'one' | 'two', { id: string; code: string; revisionId: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const list = (token: string, query: Record<string, string | number> = {}) =>
  request(app.getHttpServer()).get('/api/audit-logs').query(query).set(auth(token));
const listForDocument = (token: string, documentId: string, query: Record<string, string | number> = {}) =>
  request(app.getHttpServer()).get(`/api/documents/${documentId}/audit-logs`).query(query).set(auth(token));

/** Writes an entry directly, with a chosen moment. */
async function entry(data: {
  organizationId?: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: object;
  ipAddress?: string | null;
  createdAt?: string;
}) {
  return prisma.auditLog.create({
    data: {
      organizationId: data.organizationId ?? org.id,
      userId: data.userId === undefined ? users.editor.id : data.userId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      metadata: data.metadata,
      ipAddress: data.ipAddress ?? null,
      createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
    },
  });
}

async function createDocument(code: string) {
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId: org.deptA,
      ownerId: users.editor.id,
      code,
      sequenceNo: Number(code.slice(-3)),
      title: `Title ${code}`,
      fileType: 'DOCX',
    },
  });
  const revision = await prisma.revision.create({
    data: {
      organizationId: org.id,
      documentId: document.id,
      revisionNo: 0,
      storageKey: `audit-test/${code}`,
      fileSize: 1,
      checksum: 'x',
      editorKey: randomUUID(),
      preparedById: users.editor.id,
    },
  });
  return { id: document.id, code, revisionId: revision.id };
}

beforeAll(async () => {
  app = await createTestApp();

  const organization = await prisma.organization.create({ data: { name: `Audit ${suffix}`, slug: `audit-${suffix}` } });
  const other = await prisma.organization.create({ data: { name: `Audit other ${suffix}`, slug: `audit-o-${suffix}` } });
  organizationIds.push(organization.id, other.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: org.id, name: 'Alpha', code: 'AA' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: org.id, name: 'Main', slug: 'main', codePrefix: 'AU' } })).id;

  const names: Record<Label, [string, UserRole]> = {
    admin: ['Ada Admin', 'ADMIN'],
    qm: ['Kemal Kalite', 'QUALITY_MANAGER'],
    approver: ['Aylin Onay', 'APPROVER'],
    editor: ['Emre Editor', 'EDITOR'],
    reader: ['Reyhan Okur', 'READER'],
  };
  for (const label of Object.keys(names) as Label[]) {
    const [fullName, role] = names[label];
    const user = await prisma.user.create({
      data: { organizationId: org.id, departmentId: org.deptA, email: `${label}@audit.local`, fullName, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: org.id, role, departmentId: org.deptA }) };
  }

  docs.one = await createDocument('AU-AA-001');
  docs.two = await createDocument('AU-AA-002');

  // Another organization with an entry of its own
  const foreignUser = await prisma.user.create({
    data: { organizationId: other.id, email: 'f@audit.local', fullName: 'Foreign Person', passwordHash: 'x' },
  });
  const foreignDept = await prisma.department.create({ data: { organizationId: other.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: other.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignDocument = await prisma.document.create({
    data: {
      organizationId: other.id,
      categoryId: foreignCategory.id,
      departmentId: foreignDept.id,
      ownerId: foreignUser.id,
      code: 'AU-AA-001',
      sequenceNo: 1,
      title: 'Same code, other organization',
      fileType: 'DOCX',
    },
  });
  Object.assign(foreign, { id: other.id, userId: foreignUser.id, documentId: foreignDocument.id });
  await entry({ organizationId: other.id, userId: foreignUser.id, action: 'DOCUMENT_CREATED', entityType: 'Document', entityId: foreignDocument.id });
});

afterAll(async () => {
  // Test cleanup only: the application never deletes any of this
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

/** Entries of this suite's organization, in the order the API returns them. */
async function ownEntries(token = users.admin.token, query: Record<string, string | number> = {}) {
  return ((await list(token, { pageSize: 100, ...query }).expect(200)).body as PaginatedDto<AuditLogDto>).items;
}

describe('who may read the audit trail', () => {
  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/audit-logs').expect(401);
    await request(app.getHttpServer()).get(`/api/documents/${docs.one.id}/audit-logs`).expect(401);
  });

  it.each(['reader', 'editor', 'approver'] as const)('refuses %s with 403 on both endpoints', async (who) => {
    const response = await list(users[who].token).expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
    await listForDocument(users[who].token, docs.one.id).expect(403);
  });

  it.each(['qm', 'admin'] as const)('lets %s read both endpoints', async (who) => {
    await list(users[who].token).expect(200);
    await listForDocument(users[who].token, docs.one.id).expect(200);
  });
});

describe('query validation', () => {
  it.each([
    ['an unknown action', { action: 'EVERYTHING' }],
    ['an unknown entity type', { entityType: 'Banana' }],
    ['a user id that is not a uuid', { userId: 'abc' }],
    ['a date that is not a calendar day', { from: '2026-02-31' }],
    ['a date in the wrong format', { to: '31.01.2026' }],
    ['a timestamp instead of a day', { from: '2026-01-31T10:00:00Z' }],
    ['page 0', { page: 0 }],
    ['a page size above the maximum', { pageSize: 101 }],
    ['a search text that is too long', { search: 'x'.repeat(101) }],
    ['an unknown parameter', { sortBy: 'createdAt' }],
  ])('rejects %s', async (_label, query) => {
    await list(users.qm.token, query as Record<string, string | number>).expect(400);
  });
});

describe('the listing', () => {
  it('returns the newest entries first and breaks ties by id', async () => {
    const same = '2031-05-05T10:00:00Z';
    const [a, b, c] = [
      await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, createdAt: '2031-05-05T09:00:00Z' }),
      await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, createdAt: same }),
      await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, createdAt: same }),
    ];

    const items = await ownEntries(users.admin.token, { from: '2031-05-05', to: '2031-05-05' });

    const tied = [b.id, c.id].sort().reverse();
    expect(items.map((item) => item.id)).toEqual([...tied, a.id]);
  });

  it('pages through the results with a stable total', async () => {
    for (let index = 0; index < 5; index++) {
      await entry({ action: 'USER_LOGOUT', entityType: 'User', entityId: users.reader.id, createdAt: `2032-01-0${index + 1}T08:00:00Z` });
    }
    const query = { action: 'USER_LOGOUT', pageSize: 2 };

    const first = (await list(users.qm.token, { ...query, page: 1 }).expect(200)).body as PaginatedDto<AuditLogDto>;
    const third = (await list(users.qm.token, { ...query, page: 3 }).expect(200)).body as PaginatedDto<AuditLogDto>;

    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(third.items).toHaveLength(1);
    expect(third.items[0].createdAt).toBe('2032-01-01T08:00:00.000Z');
    expect((await list(users.qm.token, { ...query, page: 9 }).expect(200)).body.items).toEqual([]);
  });

  it('names the user and the document an entry is about', async () => {
    const created = await entry({
      action: 'DOCUMENT_CREATED',
      entityType: 'Document',
      entityId: docs.one.id,
      metadata: { code: docs.one.code, source: 'TEMPLATE' },
      createdAt: '2033-01-01T10:00:00Z',
    });
    const downloaded = await entry({
      userId: users.reader.id,
      action: 'REVISION_DOWNLOADED',
      entityType: 'Revision',
      entityId: docs.one.revisionId,
      createdAt: '2033-01-01T11:00:00Z',
    });
    const login = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, metadata: undefined, createdAt: '2033-01-01T12:00:00Z' });

    const items = await ownEntries(users.admin.token, { from: '2033-01-01', to: '2033-01-01' });
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get(created.id)).toMatchObject({
      action: 'DOCUMENT_CREATED',
      user: { id: users.editor.id, fullName: 'Emre Editor', email: 'editor@audit.local' },
      document: { id: docs.one.id, code: 'AU-AA-001', title: 'Title AU-AA-001', revisionNo: null },
      metadata: { code: 'AU-AA-001', source: 'TEMPLATE' },
    });
    expect(byId.get(downloaded.id)).toMatchObject({
      user: { fullName: 'Reyhan Okur' },
      document: { id: docs.one.id, code: 'AU-AA-001', revisionNo: 0 },
    });
    expect(byId.get(login.id)).toMatchObject({ document: null, metadata: null });
  });

  it('shows entries nobody caused, such as failed logins of unknown accounts', async () => {
    const failed = await entry({
      userId: null,
      action: 'USER_LOGIN_FAILED',
      entityType: 'User',
      entityId: 'unknown',
      metadata: { email: 'nobody@example.com', reason: 'UNKNOWN_USER' },
      createdAt: '2034-01-01T10:00:00Z',
    });

    const items = await ownEntries(users.qm.token, { from: '2034-01-01', to: '2034-01-01' });

    expect(items.find((item) => item.id === failed.id)).toMatchObject({ user: null, document: null });
  });

  it('shows network addresses to the administrator only', async () => {
    const logged = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, ipAddress: '203.0.113.7', createdAt: '2035-01-01T10:00:00Z' });
    const query = { from: '2035-01-01', to: '2035-01-01' };

    const asAdmin = (await ownEntries(users.admin.token, query)).find((item) => item.id === logged.id);
    const asQualityManager = (await ownEntries(users.qm.token, query)).find((item) => item.id === logged.id);

    expect(asAdmin?.ipAddress).toBe('203.0.113.7');
    expect(asQualityManager).toBeDefined();
    expect(asQualityManager?.ipAddress).toBeNull();
    expect(JSON.stringify(asQualityManager)).not.toContain('203.0.113.7');
  });

  it('never shows entries of another organization, whatever the filter', async () => {
    const everything = await ownEntries(users.admin.token);
    expect(everything.map((item) => item.entityId)).not.toContain(foreign.documentId);

    expect((await ownEntries(users.admin.token, { userId: foreign.userId })).length).toBe(0);
    // The foreign document has the same code as one of ours: only ours is found
    const found = await ownEntries(users.admin.token, { search: 'AU-AA-001' });
    expect(found.every((item) => item.document?.id === docs.one.id)).toBe(true);
  });

  it('does not write audit entries of its own', async () => {
    const before = await prisma.auditLog.count({ where: { organizationId: org.id } });
    await list(users.admin.token).expect(200);
    await listForDocument(users.admin.token, docs.one.id).expect(200);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id } })).toBe(before);
  });
});

describe('filters', () => {
  beforeAll(async () => {
    await entry({ action: 'DOCUMENT_OPENED', entityType: 'Document', entityId: docs.two.id, metadata: { mode: 'edit' }, createdAt: '2036-03-10T20:59:59Z' }); // 23:59:59 on the 10th in Istanbul
    await entry({ action: 'DOCUMENT_OPENED', entityType: 'Document', entityId: docs.two.id, metadata: { mode: 'view' }, createdAt: '2036-03-10T21:00:00Z' }); // 00:00:00 on the 11th
    await entry({ userId: users.approver.id, action: 'REVISION_SAVED', entityType: 'Revision', entityId: docs.two.revisionId, createdAt: '2036-03-11T20:59:59Z' }); // last second of the 11th
    await entry({ userId: users.approver.id, action: 'REVISION_SAVED', entityType: 'Revision', entityId: docs.two.revisionId, createdAt: '2036-03-11T21:00:00Z' }); // the 12th
  });

  const modes = async (query: Record<string, string>) =>
    (await ownEntries(users.qm.token, { action: 'DOCUMENT_OPENED', ...query })).map((item) => (item.metadata as { mode: string }).mode).sort();

  it('filters by action, entity type and user', async () => {
    const saved = await ownEntries(users.qm.token, { action: 'REVISION_SAVED' });
    expect(saved).toHaveLength(2);
    expect(saved.every((item) => item.action === 'REVISION_SAVED')).toBe(true);

    expect((await ownEntries(users.qm.token, { entityType: 'Revision', from: '2036-03-01', to: '2036-03-31' })).every((item) => item.entityType === 'Revision')).toBe(true);
    const byUser = await ownEntries(users.qm.token, { userId: users.approver.id });
    expect(byUser).toHaveLength(2);
    expect(byUser.every((item) => item.user?.id === users.approver.id)).toBe(true);
  });

  it('counts calendar days on Istanbul time, both ends included', async () => {
    expect(await modes({ from: '2036-03-10', to: '2036-03-10' })).toEqual(['edit']);
    expect(await modes({ from: '2036-03-11', to: '2036-03-11' })).toEqual(['view']);
    expect(await modes({ from: '2036-03-10', to: '2036-03-11' })).toEqual(['edit', 'view']);
    expect(await modes({ from: '2036-03-12' })).toEqual([]);
    expect(await modes({ to: '2036-03-09' })).toEqual([]);

    const savedOnThe11th = await ownEntries(users.qm.token, { action: 'REVISION_SAVED', from: '2036-03-11', to: '2036-03-11' });
    expect(savedOnThe11th.map((item) => item.createdAt)).toEqual(['2036-03-11T20:59:59.000Z']);
  });

  it('returns nothing when the range is reversed', async () => {
    expect(await modes({ from: '2036-03-11', to: '2036-03-10' })).toEqual([]);
  });

  describe('search', () => {
    it('finds the entries of a document by its code, in any letter case, including its revisions', async () => {
      for (const term of ['AU-AA-002', 'au-aa-002', 'aa-002']) {
        const items = await ownEntries(users.qm.token, { search: term, from: '2036-03-01', to: '2036-03-31' });
        expect(items.length).toBe(4);
        expect(items.every((item) => item.document?.id === docs.two.id)).toBe(true);
      }
    });

    it('finds the entries of a user by name or e-mail address', async () => {
      const byName = await ownEntries(users.qm.token, { search: 'aylin' });
      const byEmail = await ownEntries(users.qm.token, { search: 'approver@audit' });

      expect(byName.length).toBeGreaterThan(0);
      expect(byName.every((item) => item.user?.id === users.approver.id)).toBe(true);
      expect(byEmail.map((item) => item.id)).toEqual(byName.map((item) => item.id));
    });

    it('treats % and _ as plain characters', async () => {
      expect(await ownEntries(users.qm.token, { search: '%' })).toEqual([]);
      expect(await ownEntries(users.qm.token, { search: 'AU_AA' })).toEqual([]);
    });

    it('combines with the other filters', async () => {
      const items = await ownEntries(users.qm.token, { search: 'AU-AA-002', action: 'REVISION_SAVED', from: '2036-03-12', to: '2036-03-12' });
      expect(items).toHaveLength(1);
      expect(items[0].createdAt).toBe('2036-03-11T21:00:00.000Z');
    });
  });
});

describe('GET /documents/:id/audit-logs', () => {
  it('returns the entries of the document and of its revisions, and nothing else', async () => {
    const own = await entry({ action: 'DOCUMENT_OPENED', entityType: 'Document', entityId: docs.one.id, createdAt: '2037-01-01T10:00:00Z' });
    const ofRevision = await entry({ action: 'REVISION_SAVED', entityType: 'Revision', entityId: docs.one.revisionId, createdAt: '2037-01-01T11:00:00Z' });
    const other = await entry({ action: 'DOCUMENT_OPENED', entityType: 'Document', entityId: docs.two.id, createdAt: '2037-01-01T12:00:00Z' });
    const aboutUser = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id, createdAt: '2037-01-01T13:00:00Z' });

    const page = (await listForDocument(users.qm.token, docs.one.id, { from: '2037-01-01', to: '2037-01-01' }).expect(200)).body as PaginatedDto<AuditLogDto>;

    expect(page.items.map((item) => item.id)).toEqual([ofRevision.id, own.id]);
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).not.toContain(other.id);
    expect(page.items.map((item) => item.id)).not.toContain(aboutUser.id);
  });

  it('applies the filters inside the document', async () => {
    const items = ((await listForDocument(users.qm.token, docs.one.id, { action: 'REVISION_SAVED' }).expect(200)).body as PaginatedDto<AuditLogDto>).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.action === 'REVISION_SAVED' && item.document?.id === docs.one.id)).toBe(true);
  });

  it('hides network addresses from quality managers here as well', async () => {
    await entry({ action: 'DOCUMENT_OPENED', entityType: 'Document', entityId: docs.one.id, ipAddress: '198.51.100.9', createdAt: '2038-01-01T10:00:00Z' });
    const query = { from: '2038-01-01', to: '2038-01-01' };

    const asAdmin = (await listForDocument(users.admin.token, docs.one.id, query).expect(200)).body as PaginatedDto<AuditLogDto>;
    const asQualityManager = (await listForDocument(users.qm.token, docs.one.id, query).expect(200)).body as PaginatedDto<AuditLogDto>;

    expect(asAdmin.items[0].ipAddress).toBe('198.51.100.9');
    expect(asQualityManager.items[0].ipAddress).toBeNull();
  });

  it('answers 404 for unknown documents and for documents of another organization', async () => {
    expect((await listForDocument(users.admin.token, randomUUID()).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    expect((await listForDocument(users.admin.token, foreign.documentId).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    await listForDocument(users.admin.token, 'not-a-uuid').expect(400);
  });
});

describe('the trail cannot be rewritten', () => {
  it('lets new entries in', async () => {
    await expect(entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id })).resolves.toBeDefined();
  });

  it('refuses to change an entry', async () => {
    const kept = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id });

    await expect(prisma.auditLog.update({ where: { id: kept.id }, data: { action: 'USER_LOGOUT' } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(prisma.auditLog.updateMany({ where: { id: kept.id }, data: { userId: null } })).rejects.toThrow(/cannot be changed or deleted/);

    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: kept.id } })).toEqual(kept);
  });

  it('refuses to delete an entry, one by one or in bulk', async () => {
    const kept = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id });

    await expect(prisma.auditLog.delete({ where: { id: kept.id } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(prisma.auditLog.deleteMany({ where: { organizationId: org.id } })).rejects.toThrow(/cannot be changed or deleted/);

    expect(await prisma.auditLog.count({ where: { id: kept.id } })).toBe(1);
  });

  it('refuses to empty the table', async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow(/cannot be changed or deleted/);
  });

  it('only gives way inside a transaction that announces maintenance, and only for that transaction', async () => {
    const doomed = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id });
    const kept = await entry({ action: 'USER_LOGIN', entityType: 'User', entityId: users.editor.id });

    await deleteAuditLogs(prisma, { id: doomed.id });

    expect(await prisma.auditLog.count({ where: { id: doomed.id } })).toBe(0);
    // The setting does not outlive its transaction
    await expect(prisma.auditLog.delete({ where: { id: kept.id } })).rejects.toThrow(/cannot be changed or deleted/);
  });
});

describe('the list of actions', () => {
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) return name === 'generated' ? [] : sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('matches the actions the application really writes', () => {
    const written = new Set<string>();
    for (const file of sourceFiles(path.resolve(__dirname, '../src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/action: '([A-Z_]+)'/g)) written.add(match[1]);
    }

    // A new action has to be added to AUDIT_ACTIONS (packages/shared) and to the Turkish labels of the web app
    expect([...written].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
