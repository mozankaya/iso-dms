process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DashboardStatsDto, DocumentDetailDto, FeedbackDto, PaginatedDto } from '@iso-dms/shared';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { ageFeedback, deleteAuditLogs, deleteFeedback } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let foreignDocumentId: string;
let foreignFeedbackId: string;
const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'readerTwo' | 'editorA' | 'editorB' | 'approverA';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let codeCounter = 0;

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; title?: string; withRevision?: boolean } = {}) {
  const sequenceNo = 700 + codeCounter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: users.editorA.id,
      code: `FB-AA-${sequenceNo}`,
      sequenceNo,
      title: options.title ?? `Geri bildirim denemesi ${sequenceNo}`,
      fileType: 'DOCX',
      status: options.status ?? 'PUBLISHED',
      firstPublishedAt: new Date('2025-01-10T09:00:00Z'),
    },
  });
  let revisionId: string | null = null;
  if (options.withRevision !== false) {
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id,
        documentId: document.id,
        revisionNo: 2,
        status: 'APPROVED',
        storageKey: `feedback/${document.code}`,
        fileSize: 1,
        checksum: 'x',
        editorKey: randomUUID(),
        preparedById: users.editorA.id,
      },
    });
    revisionId = revision.id;
    await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisionId };
}

const send = (token: string, documentId: string, body: Record<string, unknown> = { message: 'Madde 3 anlaşılmıyor' }) =>
  request(app.getHttpServer()).post(`/api/documents/${documentId}/feedback`).set(auth(token)).send(body);
const list = (token: string, query: Record<string, string | number> = {}) =>
  request(app.getHttpServer()).get('/api/feedback').query({ pageSize: 100, ...query }).set(auth(token));
const resolve = (token: string, id: string, body: Record<string, unknown> = {}) =>
  request(app.getHttpServer()).post(`/api/feedback/${id}/resolve`).set(auth(token)).send(body);
const reopen = (token: string, id: string) => request(app.getHttpServer()).post(`/api/feedback/${id}/reopen`).set(auth(token));
const listBody = async (token: string, query: Record<string, string | number> = {}) => (await list(token, query).expect(200)).body as PaginatedDto<FeedbackDto>;
const stats = async (token: string) => (await request(app.getHttpServer()).get('/api/dashboard/stats').set(auth(token)).expect(200)).body as DashboardStatsDto;

const sentInLastMinute = (userId: string) => prisma.feedback.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } } });

/** Writes a feedback directly, as a user, with a chosen moment. */
async function feedbackRow(options: { documentId: string; userId?: string; message?: string; createdAt?: Date; organizationId?: string; isResolved?: boolean }) {
  return prisma.feedback.create({
    data: {
      organizationId: options.organizationId ?? org.id,
      documentId: options.documentId,
      userId: options.userId ?? users.reader.id,
      message: options.message ?? 'Hazır geri bildirim',
      createdAt: options.createdAt,
      isResolved: options.isResolved ?? false,
    },
  });
}

beforeAll(async () => {
  app = await createTestApp();

  const organization = await prisma.organization.create({ data: { name: `Feedback ${suffix}`, slug: `feedback-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `feedback-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'FB' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null, fullName = `Name ${label}`) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@feedback.local`, fullName, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA, 'Reyhan Okur');
  await makeUser('readerTwo', 'READER', org.deptB);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('approverA', 'APPROVER', org.deptA);

  // A published document of another organization, with a feedback
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@feedback.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDocument = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  foreignDocumentId = foreignDocument.id;
  foreignFeedbackId = (
    await prisma.feedback.create({ data: { organizationId: foreign.id, documentId: foreignDocument.id, userId: foreignUser.id, message: 'Başka kurumun geri bildirimi' } })
  ).id;
});

afterAll(async () => {
  // Test cleanup only: the application never deletes any of this
  await deleteFeedback(prisma, { organizationId: { in: organizationIds } });
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
});

describe('sending feedback', () => {
  // Every user may send five a minute: the tests of this part share their users, so what was sent before is moved
  // out of the last minute and each test starts with a full allowance
  beforeEach(() => ageFeedback(prisma, { organizationId: org.id }, 2));

  describe('who may, and about what', () => {
    it('requires authentication and a valid id', async () => {
      const doc = await createDocument();
      await request(app.getHttpServer()).post(`/api/documents/${doc.id}/feedback`).send({ message: 'Deneme' }).expect(401);
      await send(users.reader.token, 'not-a-uuid').expect(400);
      expect((await send(users.reader.token, randomUUID()).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
      expect((await send(users.admin.token, foreignDocumentId).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it.each(['reader', 'readerTwo', 'editorA', 'editorB', 'approverA', 'qm', 'admin'] as const)('lets %s send feedback about a document in force', async (who) => {
      const doc = await createDocument();

      const response = await send(users[who].token, doc.id).expect(201);

      expect(response.body).toEqual({ id: expect.any(String), createdAt: expect.any(String) });
      // Nothing of the feedback itself is handed back: that is for the quality managers
      expect(Object.keys(response.body).sort()).toEqual(['createdAt', 'id']);
    });

    it('does not accept feedback about documents the sender cannot see', async () => {
      const draft = await createDocument({ status: 'DRAFT' });
      expect((await send(users.reader.token, draft.id).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
      expect((await send(users.editorB.token, draft.id).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it.each([
      ['a draft', 'DRAFT'],
      ['a document in review', 'IN_REVIEW'],
      ['a withdrawn document', 'WITHDRAWN'],
    ] as const)('refuses feedback about %s even for those who can see it (FEEDBACK_NOT_ACCEPTED)', async (_label, status) => {
      const doc = await createDocument({ status });

      const response = await send(users.editorA.token, doc.id).expect(409);

      expect(response.body.code).toBe('FEEDBACK_NOT_ACCEPTED');
      expect(await prisma.feedback.count({ where: { documentId: doc.id } })).toBe(0);
    });
  });

  describe('the message', () => {
    it.each([
      ['missing', {}],
      ['empty', { message: '' }],
      ['only spaces', { message: '     ' }],
      ['too short', { message: 'ab' }],
      ['too long', { message: 'x'.repeat(2001) }],
      ['not a text', { message: 42 }],
    ])('is refused when it is %s', async (_label, body) => {
      const doc = await createDocument();

      await send(users.reader.token, doc.id, body).expect(400);

      expect(await prisma.feedback.count({ where: { documentId: doc.id } })).toBe(0);
    });

    it('rejects unknown fields, so nobody can send feedback in another one\'s name', async () => {
      const doc = await createDocument();
      await send(users.reader.token, doc.id, { message: 'Deneme', userId: users.admin.id }).expect(400);
    });

    it('is trimmed, and the limits are inclusive', async () => {
      const doc = await createDocument();
      const shortest = await send(users.reader.token, doc.id, { message: '  abc  ' }).expect(201);
      const longest = await send(users.editorA.token, doc.id, { message: 'ş'.repeat(2000) }).expect(201);

      expect((await prisma.feedback.findUniqueOrThrow({ where: { id: shortest.body.id } })).message).toBe('abc');
      expect((await prisma.feedback.findUniqueOrThrow({ where: { id: longest.body.id } })).message).toHaveLength(2000);
    });
  });

  describe('what is recorded', () => {
    it('keeps the message, the sender, and the revision in force at that moment', async () => {
      const doc = await createDocument();

      const response = await send(users.reader.token, doc.id, { message: 'Madde 3 anlaşılmıyor' }).expect(201);

      const row = await prisma.feedback.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(row).toMatchObject({
        organizationId: org.id,
        documentId: doc.id,
        revisionId: doc.revisionId,
        userId: users.reader.id,
        message: 'Madde 3 anlaşılmıyor',
        isResolved: false,
        resolvedAt: null,
        resolvedById: null,
        resolutionNote: null,
      });
    });

    it('audits the feedback against the document', async () => {
      const doc = await createDocument();
      const response = await send(users.reader.token, doc.id).expect(201);

      const entries = await prisma.auditLog.findMany({ where: { entityId: doc.id, action: 'FEEDBACK_SENT' } });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ userId: users.reader.id, entityType: 'Document', organizationId: org.id });
      expect(entries[0].metadata).toMatchObject({ feedbackId: response.body.id, code: doc.code, revisionNo: 2 });
    });

    it('cannot be edited or deleted afterwards, not even by mistake', async () => {
      const doc = await createDocument();
      const { body } = await send(users.reader.token, doc.id).expect(201);

      await expect(prisma.feedback.update({ where: { id: body.id }, data: { message: 'Başka bir şey' } })).rejects.toThrow(/content of a feedback cannot be changed/);
      await expect(prisma.feedback.update({ where: { id: body.id }, data: { userId: users.admin.id } })).rejects.toThrow(/content of a feedback cannot be changed/);
      await expect(prisma.feedback.delete({ where: { id: body.id } })).rejects.toThrow(/cannot be deleted/);
      await expect(prisma.feedback.deleteMany({ where: { documentId: doc.id } })).rejects.toThrow(/cannot be deleted/);

      expect((await prisma.feedback.findUniqueOrThrow({ where: { id: body.id } })).message).toBe('Madde 3 anlaşılmıyor');
    });

    it('can still be closed and reopened, which is all the application does to it', async () => {
      const doc = await createDocument();
      const { body } = await send(users.reader.token, doc.id).expect(201);

      await expect(prisma.feedback.update({ where: { id: body.id }, data: { isResolved: true, resolvedAt: new Date() } })).resolves.toBeDefined();
    });
  });

  describe('the limit per sender', () => {
    it('lets a user send five feedbacks a minute and refuses the sixth, with a code of its own', async () => {
      const doc = await createDocument();
      for (let index = 0; index < 5; index++) await send(users.readerTwo.token, doc.id, { message: `Geri bildirim ${index}` }).expect(201);

      const response = await send(users.readerTwo.token, doc.id).expect(429);

      expect(response.body.code).toBe('FEEDBACK_RATE_LIMITED');
      expect(await sentInLastMinute(users.readerTwo.id)).toBe(5);
      // Other people are not held back by it, and the limit is per sender, not per document
      await send(users.editorB.token, doc.id).expect(201);
      const another = await createDocument();
      await send(users.readerTwo.token, another.id).expect(429);
    });

    it('cannot be beaten by sending in parallel', async () => {
      const doc = await createDocument();

      const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => send(users.approverA.token, doc.id, { message: `Paralel ${index}` })));

      expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
      expect(await sentInLastMinute(users.approverA.id)).toBe(5);
    });

    it('lets the user go on once the minute is over', async () => {
      const doc = await createDocument();
      await send(users.admin.token, doc.id).expect(201);
      for (let index = 0; index < 4; index++) await send(users.admin.token, doc.id).expect(201);
      await send(users.admin.token, doc.id).expect(429);

      await ageFeedback(prisma, { userId: users.admin.id }, 2);

      await send(users.admin.token, doc.id).expect(201);
    });
  });

  it('is announced on the document page only while the document is in force', async () => {
    const published = await createDocument();
    const draft = await createDocument({ status: 'DRAFT' });
    const withdrawn = await createDocument({ status: 'WITHDRAWN' });
    const detail = async (who: Label, id: string) =>
      (await request(app.getHttpServer()).get(`/api/documents/${id}`).set(auth(users[who].token)).expect(200)).body as DocumentDetailDto;

    for (const who of ['reader', 'editorA', 'approverA', 'qm', 'admin'] as const) {
      expect((await detail(who, published.id)).canSendFeedback).toBe(true);
    }
    expect((await detail('editorA', draft.id)).canSendFeedback).toBe(false);
    expect((await detail('editorA', withdrawn.id)).canSendFeedback).toBe(false);
  });
});

describe('reading feedback', () => {
  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/feedback').expect(401);
  });

  it.each(['reader', 'editorA', 'approverA'] as const)('refuses %s with 403', async (who) => {
    expect((await list(users[who].token).expect(403)).body.code).toBe('FORBIDDEN');
  });

  it.each(['qm', 'admin'] as const)('lets %s read it', async (who) => {
    await list(users[who].token).expect(200);
  });

  it.each([
    ['an unknown status', { status: 'closed' }],
    ['an unknown period', { period: '365' }],
    ['page 0', { page: 0 }],
    ['a page size above the maximum', { pageSize: 101 }],
    ['a department that is not a uuid', { departmentId: 'abc' }],
    ['a search text that is too long', { search: 'x'.repeat(101) }],
    ['an unknown parameter', { sortBy: 'createdAt' }],
  ])('rejects %s', async (_label, query) => {
    await list(users.qm.token, query as Record<string, string | number>).expect(400);
  });

  describe('what it shows', () => {
    const made = {} as Record<string, { id: string }>;
    let alphaCode = '';

    beforeAll(async () => {
      const alpha = await createDocument({ title: 'Okuma Alfa' });
      const beta = await createDocument({ title: 'Okuma Beta', departmentId: org.deptB });
      const gone = await createDocument({ title: 'Okuma Gama' });
      const now = Date.now();
      made.old = await feedbackRow({ documentId: alpha.id, message: 'Eski ve açık', createdAt: new Date(now - 100 * 86_400_000) });
      made.recent = await feedbackRow({ documentId: alpha.id, message: 'Yeni ve açık', createdAt: new Date(now - 2 * 86_400_000), userId: users.editorA.id });
      made.other = await feedbackRow({ documentId: beta.id, message: 'Beta birimi için %50 oranı', createdAt: new Date(now - 1 * 86_400_000) });
      made.closed = await feedbackRow({ documentId: gone.id, message: 'Kapatılmış olan', createdAt: new Date(now - 3 * 86_400_000), isResolved: true });
      alphaCode = alpha.code;
    });

    const messages = (page: PaginatedDto<FeedbackDto>) => page.items.map((item) => item.message);
    const own = (page: PaginatedDto<FeedbackDto>) => page.items.filter((item) => [made.old.id, made.recent.id, made.other.id, made.closed.id].includes(item.id));

    it('shows the open ones, newest first, by default', async () => {
      const page = await listBody(users.qm.token);
      expect(own(page).map((item) => item.id)).toEqual([made.other.id, made.recent.id, made.old.id]);
    });

    it('filters by status', async () => {
      expect(own(await listBody(users.qm.token, { status: 'resolved' })).map((item) => item.id)).toEqual([made.closed.id]);
      expect(own(await listBody(users.qm.token, { status: 'all' })).map((item) => item.id)).toEqual([made.other.id, made.recent.id, made.closed.id, made.old.id]);
    });

    it('describes the feedback, who sent it, and what it is about', async () => {
      const item = (await listBody(users.qm.token, { search: 'Yeni ve açık' })).items[0];

      expect(item).toEqual({
        id: made.recent.id,
        message: 'Yeni ve açık',
        createdAt: expect.any(String),
        user: { id: users.editorA.id, fullName: 'Name editorA', department: { id: org.deptA, name: 'Alpha', code: 'AA' } },
        document: { id: expect.any(String), code: expect.stringMatching(/^FB-AA-/), title: 'Okuma Alfa' },
        revisionNo: null,
        isResolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      });
    });

    it('searches message, document code and title, and the name of the sender, in any letter case', async () => {
      expect(messages(await listBody(users.qm.token, { search: 'eski ve' }))).toEqual(['Eski ve açık']);
      expect(messages(await listBody(users.qm.token, { search: 'okuma beta' }))).toEqual(['Beta birimi için %50 oranı']);
      expect(messages(await listBody(users.qm.token, { search: alphaCode.toLowerCase() }))).toEqual(['Yeni ve açık', 'Eski ve açık']);
      expect(messages(await listBody(users.qm.token, { search: 'reyhan' })).sort()).toEqual(expect.arrayContaining(['Eski ve açık', 'Beta birimi için %50 oranı']));
    });

    it('treats % and _ as plain characters', async () => {
      expect(messages(await listBody(users.qm.token, { search: '%50' }))).toEqual(['Beta birimi için %50 oranı']);
      expect(await listBody(users.qm.token, { search: '%' })).toMatchObject({ total: 1 });
      expect((await listBody(users.qm.token, { search: 'Okuma_' })).items).toEqual([]);
    });

    it('filters by the department of the document and by period', async () => {
      expect(messages(await listBody(users.qm.token, { departmentId: org.deptB }))).toEqual(['Beta birimi için %50 oranı']);
      expect(own(await listBody(users.qm.token, { period: '7' })).map((item) => item.id)).toEqual([made.other.id, made.recent.id]);
      expect(own(await listBody(users.qm.token, { period: '90' })).map((item) => item.id)).toEqual([made.other.id, made.recent.id]);
      expect(own(await listBody(users.qm.token, { period: 'all' })).map((item) => item.id)).toEqual([made.other.id, made.recent.id, made.old.id]);
    });

    it('pages through the result with a stable total', async () => {
      const first = await listBody(users.qm.token, { pageSize: 2, page: 1, status: 'all', search: 'Okuma' });
      const second = await listBody(users.qm.token, { pageSize: 2, page: 2, status: 'all', search: 'Okuma' });

      expect(first).toMatchObject({ total: 4, page: 1, pageSize: 2 });
      expect([...first.items, ...second.items].map((item) => item.id)).toEqual([made.other.id, made.recent.id, made.closed.id, made.old.id]);
    });

    it('never shows the feedback of another organization', async () => {
      const page = await listBody(users.admin.token, { status: 'all' });
      expect(page.items.map((item) => item.id)).not.toContain(foreignFeedbackId);
    });
  });
});

describe('closing and reopening feedback', () => {
  const open = async () => {
    const doc = await createDocument();
    return { doc, feedback: await feedbackRow({ documentId: doc.id, userId: users.reader.id, message: 'Kapatılacak olan' }) };
  };

  it('requires authentication, a valid id and the right role', async () => {
    const { feedback } = await open();
    await request(app.getHttpServer()).post(`/api/feedback/${feedback.id}/resolve`).send({}).expect(401);
    await resolve(users.qm.token, 'not-a-uuid').expect(400);
    for (const who of ['reader', 'editorA', 'approverA'] as const) {
      expect((await resolve(users[who].token, feedback.id).expect(403)).body.code).toBe('FORBIDDEN');
      expect((await reopen(users[who].token, feedback.id).expect(403)).body.code).toBe('FORBIDDEN');
    }
    expect((await resolve(users.qm.token, randomUUID()).expect(404)).body.code).toBe('FEEDBACK_NOT_FOUND');
    expect((await resolve(users.admin.token, foreignFeedbackId).expect(404)).body.code).toBe('FEEDBACK_NOT_FOUND');
    expect((await reopen(users.admin.token, foreignFeedbackId).expect(404)).body.code).toBe('FEEDBACK_NOT_FOUND');
    expect((await prisma.feedback.findUniqueOrThrow({ where: { id: feedback.id } })).isResolved).toBe(false);
  });

  it.each(['qm', 'admin'] as const)('lets %s close it with a note, and shows who did and when', async (who) => {
    const { feedback } = await open();

    const response = await resolve(users[who].token, feedback.id, { note: '  Madde 3 yeniden yazıldı  ' }).expect(200);

    expect(response.body).toMatchObject({
      id: feedback.id,
      isResolved: true,
      resolvedBy: { id: users[who].id },
      resolutionNote: 'Madde 3 yeniden yazıldı',
      resolvedAt: expect.any(String),
    });
    expect(await prisma.feedback.findUniqueOrThrow({ where: { id: feedback.id } })).toMatchObject({ isResolved: true, resolvedById: users[who].id, resolutionNote: 'Madde 3 yeniden yazıldı' });
  });

  it('needs no note', async () => {
    const { feedback } = await open();
    const response = await resolve(users.qm.token, feedback.id).expect(200);
    expect(response.body).toMatchObject({ isResolved: true, resolutionNote: null });
  });

  it('limits the note to 2000 characters and rejects unknown fields', async () => {
    const { feedback } = await open();
    await resolve(users.qm.token, feedback.id, { note: 'x'.repeat(2001) }).expect(400);
    await resolve(users.qm.token, feedback.id, { note: 'ok', isResolved: false }).expect(400);
    expect((await prisma.feedback.findUniqueOrThrow({ where: { id: feedback.id } })).isResolved).toBe(false);
  });

  it('refuses to close it twice, and lets exactly one of two simultaneous closings win', async () => {
    const { feedback } = await open();
    await resolve(users.qm.token, feedback.id).expect(200);
    expect((await resolve(users.admin.token, feedback.id).expect(409)).body.code).toBe('FEEDBACK_ALREADY_RESOLVED');

    const other = await open();
    const [one, two] = await Promise.all([resolve(users.qm.token, other.feedback.id), resolve(users.admin.token, other.feedback.id)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { entityId: other.doc.id, action: 'FEEDBACK_RESOLVED' } })).toBe(1);
  });

  it('reopens a closed one, which then shows nothing of the earlier closing', async () => {
    const { feedback } = await open();
    await resolve(users.qm.token, feedback.id, { note: 'İlk kapatma' }).expect(200);

    const response = await reopen(users.admin.token, feedback.id).expect(200);

    expect(response.body).toMatchObject({ isResolved: false, resolvedAt: null, resolvedBy: null, resolutionNote: null });
    expect((await listBody(users.qm.token, { status: 'open', search: 'Kapatılacak' })).items.map((item) => item.id)).toContain(feedback.id);
  });

  it('refuses to reopen one that is open, and closes again with a new note', async () => {
    const { feedback } = await open();
    expect((await reopen(users.qm.token, feedback.id).expect(409)).body.code).toBe('FEEDBACK_NOT_RESOLVED');

    await resolve(users.qm.token, feedback.id, { note: 'Birinci' }).expect(200);
    await reopen(users.qm.token, feedback.id).expect(200);
    const again = await resolve(users.admin.token, feedback.id, { note: 'İkinci' }).expect(200);

    expect(again.body).toMatchObject({ isResolved: true, resolutionNote: 'İkinci', resolvedBy: { id: users.admin.id } });
  });

  it('audits every step against the document, so the history stays', async () => {
    const { doc, feedback } = await open();
    await resolve(users.qm.token, feedback.id, { note: 'Madde 3 yeniden yazıldı' }).expect(200);
    await reopen(users.admin.token, feedback.id).expect(200);

    const entries = await prisma.auditLog.findMany({ where: { entityId: doc.id, action: { in: ['FEEDBACK_RESOLVED', 'FEEDBACK_REOPENED'] } }, orderBy: { createdAt: 'asc' } });

    expect(entries.map((entry) => [entry.action, entry.userId, entry.entityType])).toEqual([
      ['FEEDBACK_RESOLVED', users.qm.id, 'Document'],
      ['FEEDBACK_REOPENED', users.admin.id, 'Document'],
    ]);
    expect(entries[0].metadata).toMatchObject({ feedbackId: feedback.id, code: doc.code, note: 'Madde 3 yeniden yazıldı' });
    expect(entries[1].metadata).toMatchObject({ feedbackId: feedback.id, code: doc.code });
  });
});

describe('the dashboard counter', () => {
  it('counts the open feedback for quality managers and administrators, and for nobody else', async () => {
    for (const who of ['reader', 'editorA', 'approverA'] as const) expect((await stats(users[who].token)).openFeedback).toBeNull();
    for (const who of ['qm', 'admin'] as const) expect((await stats(users[who].token)).openFeedback).toEqual(expect.any(Number));
  });

  it('agrees with the list it leads to, and moves as feedback is sent and closed', async () => {
    const doc = await createDocument();
    const before = (await stats(users.qm.token)).openFeedback!;
    expect(before).toBe((await listBody(users.qm.token)).total);

    const sent = await send(users.editorB.token, doc.id).expect(201);
    expect((await stats(users.qm.token)).openFeedback).toBe(before + 1);
    expect((await stats(users.admin.token)).openFeedback).toBe(before + 1);

    await resolve(users.qm.token, sent.body.id).expect(200);
    expect((await stats(users.qm.token)).openFeedback).toBe(before);
    await reopen(users.qm.token, sent.body.id).expect(200);
    expect((await stats(users.qm.token)).openFeedback).toBe(before + 1);
  });

  it('does not count the feedback of other organizations', async () => {
    const before = (await stats(users.qm.token)).openFeedback;
    await prisma.feedback.create({ data: { organizationId: organizationIds[1], documentId: foreignDocumentId, userId: (await prisma.user.findFirstOrThrow({ where: { organizationId: organizationIds[1] } })).id, message: 'Bir tane daha' } });
    expect((await stats(users.qm.token)).openFeedback).toBe(before);
  });
});
