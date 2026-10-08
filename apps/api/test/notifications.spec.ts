process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ApprovalStepDto, DocumentDetailDto, NotificationDto, PaginatedDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { MailService } from '../src/modules/notifications/mail.service';
import { NotificationMailer } from '../src/modules/notifications/notification-mailer.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { startFakeCommandServer, type FakeCommandServer } from './helpers/fake-command-server';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let mail: MailService;
let mailer: NotificationMailer;
let notifications: NotificationsService;
let commandServer: FakeCommandServer;
let blankDocx: Buffer;
const org = {} as { id: string; deptA: string; deptB: string; deptEmpty: string; category: string; foreignUser: string };
type Label = 'admin' | 'qm' | 'qm2' | 'reader' | 'editorA' | 'preparerA' | 'approverA' | 'approverA2' | 'approverB' | 'gone';
const users = {} as Record<Label, { id: string; email: string; token: string }>;
let counter = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const notificationsOf = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; revisions: { revisionNo: number; status: RevisionStatus; current?: boolean }[] }) {
  const sequenceNo = 300 + counter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id, categoryId: org.category, departmentId: options.departmentId ?? org.deptA, ownerId: users.editorA.id,
      code: `NT-AA-${sequenceNo}`, sequenceNo, title: 'Bildirim denemesi', fileType: 'DOCX', status: options.status ?? 'DRAFT',
      firstPublishedAt: options.status === 'PUBLISHED' ? new Date('2025-01-10T09:00:00Z') : undefined,
    },
  });
  const revisions: { id: string; revisionNo: number }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, status: spec.status, storageKey,
        fileSize: blankDocx.length, checksum: createHash('sha256').update(blankDocx).digest('hex'), editorKey: randomUUID(),
        changeSummary: spec.revisionNo > 0 ? 'Madde 3 güncellendi' : undefined, preparedById: users.preparerA.id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

const draft = (departmentId?: string) => createDocument({ departmentId, revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
const published = () => createDocument({ status: 'PUBLISHED', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] });

const submit = async (token: string, revisionId: string) => ((await api().post(`/api/revisions/${revisionId}/submit`).set(auth(token)).expect(200)).body as DocumentDetailDto).approval!.steps as ApprovalStepDto[];
const approve = (token: string, stepId: string) => api().post(`/api/approvals/${stepId}/approve`).set(auth(token)).send({});
const reject = (token: string, stepId: string, comment = 'Madde 3 eksik') => api().post(`/api/approvals/${stepId}/reject`).set(auth(token)).send({ comment });
const withdrawal = async (token: string, documentId: string) =>
  ((await api().post(`/api/documents/${documentId}/withdrawal-requests`).set(auth(token)).send({ reason: 'Süreç artık yok' }).expect(200)).body as DocumentDetailDto).approval!.steps;

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  mail = app.get(MailService);
  mailer = app.get(NotificationMailer);
  notifications = app.get(NotificationsService);

  const organization = await prisma.organization.create({ data: { name: `Notify ${suffix}`, slug: `notify-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `notify-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.deptEmpty = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Boş', code: 'ZZ' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'NT' } })).id;
  org.foreignUser = (await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@notify.local', fullName: 'f', passwordHash: 'x', role: 'EDITOR' } })).id;

  const make = async (label: Label, role: UserRole, departmentId: string | null, isActive = true) => {
    const email = `${label}@notify.local`;
    const user = await prisma.user.create({ data: { organizationId: organization.id, departmentId, email, fullName: label, passwordHash: 'x', role, isActive } });
    users[label] = { id: user.id, email, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await make('admin', 'ADMIN', org.deptA);
  await make('qm', 'QUALITY_MANAGER', org.deptA);
  await make('qm2', 'QUALITY_MANAGER', org.deptB);
  await make('reader', 'READER', org.deptA);
  await make('editorA', 'EDITOR', org.deptA);
  await make('preparerA', 'EDITOR', org.deptA);
  await make('approverA', 'APPROVER', org.deptA);
  await make('approverA2', 'APPROVER', org.deptA);
  await make('approverB', 'APPROVER', org.deptB);
  await make('gone', 'APPROVER', org.deptA, false);
});

beforeEach(() => {
  mail.outbox.length = 0;
});

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  await Promise.all(revisions.map((revision) => storage.delete(revision.storageKey).catch(() => undefined)));
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.approvalStep.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.documentRequest.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
  await commandServer.close();
});

describe('the approval flow tells people', () => {
  it('tells the approvers of the department when a draft is sent to review, not the sender, other departments or other roles', async () => {
    const doc = await draft();
    await submit(users.editorA.token, doc.revisions[0].id);

    const link = '/approvals';
    const got = (await prisma.notification.findMany({ where: { organizationId: org.id, title: { contains: doc.code } } })).map((row) => row.userId).sort();
    expect(got).toEqual([users.approverA.id, users.approverA2.id].sort());
    const [first] = await notificationsOf(users.approverA.id);
    expect(first).toMatchObject({ type: 'APPROVAL_STEP_WAITING', link, readAt: null, organizationId: org.id });
    expect(first.title).toBe(`Onayınızı bekleyen yeni doküman: ${doc.code}`);
    expect(first.body).toBe(`${doc.code} Bildirim denemesi için 1. adım onayınızı bekliyor (yeni doküman).`);
    // Nothing for those who cannot decide the first step
    for (const who of ['qm', 'qm2', 'approverB', 'editorA', 'preparerA', 'reader', 'admin', 'gone'] as const) {
      expect((await notificationsOf(users[who].id)).filter((row) => row.title.includes(doc.code))).toHaveLength(0);
    }
  });

  it('says "revizyon" for a revision, and a withdrawal request for what it is', async () => {
    const revising = await createDocument({ status: 'PUBLISHED', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'DRAFT' }] });
    await submit(users.editorA.token, revising.revisions[1].id);
    const asking = await published();
    await withdrawal(users.editorA.token, asking.id);

    const titles = (await notificationsOf(users.approverA.id)).map((row) => row.title);
    expect(titles).toContain(`Onayınızı bekleyen revizyon: ${revising.code}`);
    expect(titles).toContain(`Onayınızı bekleyen yayından kaldırma talebi: ${asking.code}`);
  });

  it('asks the administrators when the department has nobody to give the first step', async () => {
    const doc = await draft(org.deptEmpty);

    const steps = await submit(users.qm.token, doc.revisions[0].id);

    expect(steps).toHaveLength(2);
    expect((await notificationsOf(users.admin.id)).some((row) => row.title.includes(doc.code))).toBe(true);
    expect((await notificationsOf(users.approverA.id)).some((row) => row.title.includes(doc.code))).toBe(false);
  });

  it('tells the quality managers when the first step is approved, not the people who sent it', async () => {
    const doc = await draft();
    const [first] = await submit(users.editorA.token, doc.revisions[0].id);
    await prisma.notification.deleteMany({ where: { organizationId: org.id, userId: { in: [users.qm.id, users.qm2.id] } } });

    await approve(users.approverA.token, first.id).expect(200);

    for (const who of ['qm', 'qm2'] as const) {
      const [row] = (await notificationsOf(users[who].id)).filter((candidate) => candidate.title.includes(doc.code));
      expect(row).toMatchObject({ type: 'APPROVAL_STEP_WAITING', link: '/approvals' });
      expect(row.body).toContain('2. adım');
    }
    for (const who of ['approverA', 'approverA2', 'editorA', 'preparerA', 'admin'] as const) {
      const rows = (await notificationsOf(users[who].id)).filter((candidate) => candidate.body.includes('2. adım') && candidate.title.includes(doc.code));
      expect(rows).toHaveLength(0);
    }
  });

  it('does not tell the preparer when the preparer is a quality manager who cannot decide', async () => {
    const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    await prisma.revision.update({ where: { id: doc.revisions[0].id }, data: { preparedById: users.qm.id } });
    const [first] = await submit(users.qm.token, doc.revisions[0].id);

    await approve(users.approverA.token, first.id).expect(200);

    expect((await notificationsOf(users.qm.id)).filter((row) => row.title.includes(doc.code))).toHaveLength(0);
    expect((await notificationsOf(users.qm2.id)).filter((row) => row.title.includes(doc.code))).toHaveLength(1);
  });

  it('tells whoever prepared and sent it that it is in force, not the one who approved', async () => {
    const doc = await draft();
    const [first, second] = await submit(users.editorA.token, doc.revisions[0].id);
    await approve(users.approverA.token, first.id).expect(200);
    await approve(users.qm.token, second.id).expect(200);

    for (const who of ['editorA', 'preparerA'] as const) {
      const rows = (await notificationsOf(users[who].id)).filter((row) => row.type === 'REQUEST_APPROVED' && row.title.includes(doc.code));
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe(`${doc.code} onaylandı ve yürürlüğe girdi`);
      expect(rows[0].link).toBe(`/documents/${doc.id}`);
    }
    expect((await notificationsOf(users.qm.id)).filter((row) => row.type === 'REQUEST_APPROVED')).toHaveLength(0);
  });

  it('tells them why it was rejected', async () => {
    const doc = await draft();
    const [first] = await submit(users.editorA.token, doc.revisions[0].id);

    await reject(users.approverA.token, first.id, 'Kapsam eksik').expect(200);

    const [row] = (await notificationsOf(users.preparerA.id)).filter((candidate) => candidate.type === 'REQUEST_REJECTED' && candidate.title.includes(doc.code));
    expect(row.title).toBe(`${doc.code} için yeni doküman reddedildi`);
    expect(row.body).toBe(`${doc.code} Bildirim denemesi için gönderilen yeni doküman reddedildi. Gerekçe: Kapsam eksik`);
    expect(row.link).toBe(`/documents/${doc.id}`);
    // The one who rejected is not told of their own decision
    expect((await notificationsOf(users.approverA.id)).filter((candidate) => candidate.type === 'REQUEST_REJECTED')).toHaveLength(0);
  });

  it('tells the one who asked when a withdrawal is approved', async () => {
    const doc = await published();
    const [first, second] = await withdrawal(users.editorA.token, doc.id);
    await approve(users.approverA.token, first.id).expect(200);
    await approve(users.qm.token, second.id).expect(200);

    const [row] = (await notificationsOf(users.editorA.id)).filter((candidate) => candidate.type === 'REQUEST_APPROVED' && candidate.title.includes(doc.code));
    expect(row.title).toBe(`${doc.code} onaylandı ve doküman yayından kaldırıldı`);
    // The preparer of the revision in force did not ask for it
    expect((await notificationsOf(users.preparerA.id)).filter((candidate) => candidate.title.includes(doc.code))).toHaveLength(0);
  });

  it('tells nobody when a decision is refused', async () => {
    const doc = await draft();
    const [first] = await submit(users.editorA.token, doc.revisions[0].id);
    const before = await prisma.notification.count({ where: { organizationId: org.id } });

    await approve(users.approverB.token, first.id).expect(403);
    await approve(users.reader.token, first.id).expect(403);

    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(before);
  });
});

describe('the e-mail', () => {
  it('goes to the people who were told, with the same subject and text and a link into the application', async () => {
    const doc = await draft();
    await submit(users.editorA.token, doc.revisions[0].id);

    expect(mail.outbox.map((message) => message.to).sort()).toEqual([users.approverA.email, users.approverA2.email].sort());
    const [message] = mail.outbox;
    expect(message.subject).toBe(`Onayınızı bekleyen yeni doküman: ${doc.code}`);
    expect(message.text).toContain(`${doc.code} Bildirim denemesi için 1. adım onayınızı bekliyor`);
    expect(message.text).toContain('/approvals');
    expect(message.text).toMatch(/https?:\/\/[^\s]+\/approvals/);
    const rows = await notificationsOf(users.approverA.id);
    expect(rows.find((row) => row.title.includes(doc.code))).toMatchObject({ emailStatus: 'SENT' });
    expect(rows.find((row) => row.title.includes(doc.code))!.emailedAt).toBeInstanceOf(Date);
  });

  it('is not sent twice for the same message', async () => {
    const doc = await draft();
    await submit(users.editorA.token, doc.revisions[0].id);
    const [row] = (await notificationsOf(users.approverA.id)).filter((candidate) => candidate.title.includes(doc.code));
    const sent = mail.outbox.length;

    await mailer.send(row.id, true);

    expect(mail.outbox).toHaveLength(sent);
  });

  it('writes a failure down only when no more attempts follow, and throws either way', async () => {
    const [first, second] = await prisma.$transaction(async (tx) =>
      notifications.create(tx, [users.reader, users.editorA].map((user) => ({
        organizationId: org.id, userId: user.id, type: 'REVIEW_DUE' as const, title: 'Deneme', body: 'Deneme gövdesi', link: '/',
      }))),
    );
    const spy = jest.spyOn(mail, 'send').mockRejectedValue(new Error('SMTP down'));
    try {
      await expect(mailer.send(first, false)).rejects.toThrow('SMTP down');
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: first } })).emailStatus).toBe('PENDING');
      await expect(mailer.send(second, true)).rejects.toThrow('SMTP down');
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: second } })).emailStatus).toBe('FAILED');
    } finally {
      spy.mockRestore();
    }
    // The message itself is there whatever happened to the mail
    expect(await prisma.notification.count({ where: { id: { in: [first, second] } } })).toBe(2);
  });

  it('does not write to a user who is not active any more', async () => {
    const [id] = await prisma.$transaction(async (tx) =>
      notifications.create(tx, [{ organizationId: org.id, userId: users.gone.id, type: 'REVIEW_DUE', title: 'Eski', body: 'Eski gövde', link: '/' }]),
    );

    await mailer.send(id, true);

    expect(mail.outbox.some((message) => message.to === users.gone.email)).toBe(false);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).emailStatus).toBe('SKIPPED');
  });

  it('keeps the message and the decision even when the mail cannot be sent', async () => {
    const spy = jest.spyOn(mail, 'send').mockRejectedValue(new Error('SMTP down'));
    try {
      const doc = await draft();
      await submit(users.editorA.token, doc.revisions[0].id);

      const rows = (await notificationsOf(users.approverA.id)).filter((row) => row.title.includes(doc.code));
      expect(rows).toHaveLength(1);
      expect(rows[0].emailStatus).toBe('FAILED');
      expect((await prisma.revision.findUniqueOrThrow({ where: { id: doc.revisions[0].id } })).status).toBe('IN_REVIEW');
    } finally {
      spy.mockRestore();
    }
  });

  it('drops a message whose key was used already', async () => {
    const draftMessage = { organizationId: org.id, userId: users.reader.id, type: 'REVIEW_DUE' as const, title: 'Hatırlatma', body: 'gövde', link: '/', dedupeKey: `once-${suffix}` };

    const first = await prisma.$transaction(async (tx) => notifications.create(tx, [draftMessage]));
    const second = await prisma.$transaction(async (tx) => notifications.create(tx, [draftMessage, { ...draftMessage, userId: users.editorA.id }]));

    expect(first).toHaveLength(1);
    // Only the other user's message is new
    expect(second).toHaveLength(1);
    expect(await prisma.notification.count({ where: { dedupeKey: `once-${suffix}` } })).toBe(2);
  });
});

describe('reading the messages', () => {
  const seed = async (userId: string, count: number, prefix: string) => {
    await prisma.notification.deleteMany({ where: { userId } });
    for (let i = 0; i < count; i += 1) {
      await prisma.notification.create({
        data: { organizationId: org.id, userId, type: 'REVIEW_DUE', title: `${prefix} ${i}`, body: 'gövde', link: '/', emailStatus: 'SKIPPED', createdAt: new Date(Date.now() - (count - i) * 60_000) },
      });
    }
  };
  const list = (token: string, query: Record<string, string> = {}) => api().get('/api/notifications').query(query).set(auth(token));

  it('requires a session', async () => {
    await api().get('/api/notifications').expect(401);
    await api().get('/api/notifications/unread-count').expect(401);
    await api().post('/api/notifications/read-all').expect(401);
    await api().post(`/api/notifications/${randomUUID()}/read`).expect(401);
  });

  it('lists the own messages, newest first, in pages, and never anybody else\'s', async () => {
    await seed(users.reader.id, 3, 'Okuyucu');
    await seed(users.editorA.id, 2, 'Editör');

    const page = (await list(users.reader.token, { pageSize: '2' }).expect(200)).body as PaginatedDto<NotificationDto>;

    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page.items.map((item) => item.title)).toEqual(['Okuyucu 2', 'Okuyucu 1']);
    expect(page.items[0]).toEqual({ id: expect.any(String), type: 'REVIEW_DUE', title: 'Okuyucu 2', body: 'gövde', link: '/', isRead: false, createdAt: expect.any(String) });
    const second = (await list(users.reader.token, { pageSize: '2', page: '2' }).expect(200)).body as PaginatedDto<NotificationDto>;
    expect(second.items.map((item) => item.title)).toEqual(['Okuyucu 0']);
  });

  it('counts the unread ones, marks one read (again and again without harm), and filters', async () => {
    await seed(users.approverB.id, 3, 'Sayaç');
    const unread = async () => ((await api().get('/api/notifications/unread-count').set(auth(users.approverB.token)).expect(200)).body as { count: number }).count;
    expect(await unread()).toBe(3);
    const [newest] = ((await list(users.approverB.token).expect(200)).body as PaginatedDto<NotificationDto>).items;

    const read = await api().post(`/api/notifications/${newest.id}/read`).set(auth(users.approverB.token)).expect(200);
    await api().post(`/api/notifications/${newest.id}/read`).set(auth(users.approverB.token)).expect(200);

    expect(read.body).toMatchObject({ id: newest.id, isRead: true });
    expect(await unread()).toBe(2);
    const onlyUnread = (await list(users.approverB.token, { status: 'unread' }).expect(200)).body as PaginatedDto<NotificationDto>;
    expect(onlyUnread.items.map((item) => item.id)).not.toContain(newest.id);
    expect(onlyUnread.total).toBe(2);
    const kept = await prisma.notification.findUniqueOrThrow({ where: { id: newest.id } });
    expect(kept.readAt).toBeInstanceOf(Date);
  });

  it('marks everything of the user read, and nothing of anybody else', async () => {
    await seed(users.qm2.id, 2, 'Toplu');
    await seed(users.gone.id, 1, 'Başkası');

    const response = await api().post('/api/notifications/read-all').set(auth(users.qm2.token)).expect(200);

    expect(response.body.count).toBeGreaterThanOrEqual(2);
    expect((await api().get('/api/notifications/unread-count').set(auth(users.qm2.token))).body.count).toBe(0);
    expect((await notificationsOf(users.gone.id)).every((row) => row.readAt === null)).toBe(true);
  });

  it('answers 404 for a message that is somebody else\'s, from another organization, or unknown', async () => {
    const other = await prisma.notification.create({ data: { organizationId: org.id, userId: users.editorA.id, type: 'REVIEW_DUE', title: 'x', body: 'x', link: '/', emailStatus: 'SKIPPED' } });

    expect((await api().post(`/api/notifications/${other.id}/read`).set(auth(users.reader.token)).expect(404)).body.code).toBe('NOTIFICATION_NOT_FOUND');
    await api().post(`/api/notifications/${randomUUID()}/read`).set(auth(users.reader.token)).expect(404);
    await api().post('/api/notifications/not-a-uuid/read').set(auth(users.reader.token)).expect(400);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt).toBeNull();
  });

  it.each([['status', 'maybe'], ['page', '0'], ['pageSize', '101']])('refuses a bad %s', async (key, value) => {
    await list(users.reader.token, { [key]: value }).expect(400);
  });
});
