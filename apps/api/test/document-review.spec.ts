process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DashboardStatsDto, DocumentDetailDto, PaginatedDto, ReviewDueItemDto } from '@iso-dms/shared';
import { addMonths } from '../src/common/utils/dates';
import type { AuthenticatedUser } from '../src/common/types/authenticated-user';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { canMarkReviewed, canSetReviewInterval, isReviewResponsible } from '../src/modules/documents/document-access.policy';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { publishThroughApproval } from './helpers/approval-flow';
import { createTestApp } from './helpers/create-test-app';
import { startFakeCommandServer, type FakeCommandServer } from './helpers/fake-command-server';
import { signToken } from './helpers/tokens';

const DAY_MS = 24 * 60 * 60 * 1000;
const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let commandServer: FakeCommandServer;
let blankDocx: Buffer;
const org = {} as { id: string; deptA: string; deptB: string; category: string; categoryWithPeriod: string; foreignDocument: string };
type Label = 'admin' | 'qm' | 'approverA' | 'approverB' | 'ownerA' | 'otherA' | 'editorB' | 'reader';
const users = {} as Record<Label, { id: string; token: string; departmentId: string | null; role: UserRole }>;
let counter = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const asUser = (label: Label): AuthenticatedUser => ({ id: users[label].id, organizationId: org.id, role: users[label].role, departmentId: users[label].departmentId });
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

async function createDocument(options: {
  status?: DocumentStatus;
  departmentId?: string;
  owner?: Label;
  intervalMonths?: number | null;
  lastReviewedAt?: Date | null;
  nextReviewAt?: Date | null;
  title?: string;
  withRevision?: boolean;
}) {
  const sequenceNo = 400 + counter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id, categoryId: org.category, departmentId: options.departmentId ?? org.deptA, ownerId: users[options.owner ?? 'ownerA'].id,
      code: `RV-AA-${sequenceNo}`, sequenceNo, title: options.title ?? 'Gözden geçirme denemesi', fileType: 'DOCX', status: options.status ?? 'PUBLISHED',
      reviewIntervalMonths: options.intervalMonths ?? null, lastReviewedAt: options.lastReviewedAt ?? null, nextReviewAt: options.nextReviewAt ?? null,
      firstPublishedAt: (options.status ?? 'PUBLISHED') === 'DRAFT' ? undefined : new Date('2025-01-10T09:00:00Z'),
    },
  });
  const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: 0, fileType: 'DOCX' });
  await storage.put(storageKey, blankDocx, 'application/octet-stream');
  const status = options.status ?? 'PUBLISHED';
  const revision = await prisma.revision.create({
    data: {
      organizationId: org.id, documentId: document.id, revisionNo: 0, status: status === 'DRAFT' ? 'DRAFT' : 'APPROVED', storageKey,
      fileSize: blankDocx.length, checksum: createHash('sha256').update(blankDocx).digest('hex'), editorKey: randomUUID(), preparedById: users.ownerA.id,
      publishedAt: status === 'PUBLISHED' || status === 'WITHDRAWN' ? new Date('2025-01-10T09:00:00Z') : null,
    },
  });
  if (status === 'PUBLISHED' || status === 'WITHDRAWN') await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  return { id: document.id, code: document.code, revisionId: revision.id };
}

const due = (days: number, extra: Parameters<typeof createDocument>[0] = {}) => createDocument({ intervalMonths: 12, nextReviewAt: daysFromNow(days), ...extra });
const setPeriod = (token: string, id: string, body: Record<string, unknown>) => api().patch(`/api/documents/${id}/review-settings`).set(auth(token)).send(body);
const review = (token: string, id: string, body: Record<string, unknown> = {}) => api().post(`/api/documents/${id}/review`).set(auth(token)).send(body);
const reviewList = (token: string, query: Record<string, string> = {}) => api().get('/api/lists/review-due').query(query).set(auth(token));

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;

  app = await createTestApp();
  storage = app.get(StorageService);

  const organization = await prisma.organization.create({ data: { name: `Review ${suffix}`, slug: `review-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `review-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'RV' } })).id;
  org.categoryWithPeriod = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Yıllık', slug: 'yillik', codePrefix: 'YL', defaultReviewIntervalMonths: 12 } })).id;

  const make = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({ data: { organizationId: organization.id, departmentId, email: `${label}@review.local`, fullName: label, passwordHash: 'x', role } });
    users[label] = { id: user.id, departmentId, role, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await make('admin', 'ADMIN', org.deptA);
  await make('qm', 'QUALITY_MANAGER', org.deptA);
  await make('approverA', 'APPROVER', org.deptA);
  await make('approverB', 'APPROVER', org.deptB);
  await make('ownerA', 'EDITOR', org.deptA);
  await make('otherA', 'EDITOR', org.deptA);
  await make('editorB', 'EDITOR', org.deptB);
  await make('reader', 'READER', org.deptA);

  const templateKey = `${organization.id}/templates/${randomUUID()}.docx`;
  await storage.put(templateKey, blankDocx, 'application/octet-stream');
  await prisma.template.create({ data: { organizationId: organization.id, name: 'Boş', fileType: 'DOCX', storageKey: templateKey, isDefault: true } });

  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@review.local', fullName: 'f', passwordHash: 'x', role: 'EDITOR' } });
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FF' } });
  org.foreignDocument = (
    await prisma.document.create({
      data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FF-FF-001', sequenceNo: 1, title: 'x', fileType: 'DOCX', status: 'PUBLISHED', reviewIntervalMonths: 12, nextReviewAt: daysFromNow(-5) },
    })
  ).id;
});

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  const templates = await prisma.template.findMany({ where: { organizationId: { in: organizationIds } }, select: { storageKey: true } });
  await Promise.all([...revisions, ...templates].map((item) => storage.delete(item.storageKey).catch(() => undefined)));
  await prisma.template.deleteMany({ where: { organizationId: { in: organizationIds } } });
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

describe('addMonths', () => {
  it.each([
    ['2026-01-15T10:00:00.000Z', 12, '2027-01-15T10:00:00.000Z'],
    ['2026-01-31T10:00:00.000Z', 1, '2026-02-28T10:00:00.000Z'],
    ['2028-01-31T10:00:00.000Z', 1, '2028-02-29T10:00:00.000Z'],
    ['2026-03-31T10:00:00.000Z', 1, '2026-04-30T10:00:00.000Z'],
    ['2026-11-30T10:00:00.000Z', 3, '2027-02-28T10:00:00.000Z'],
    ['2026-06-10T10:00:00.000Z', 24, '2028-06-10T10:00:00.000Z'],
    ['2026-02-28T10:00:00.000Z', 12, '2027-02-28T10:00:00.000Z'],
  ])('%s plus %i months is %s', (from, months, expected) => {
    expect(addMonths(new Date(from), months).toISOString()).toBe(expected);
  });

  it('does not change the date it is given', () => {
    const from = new Date('2026-01-31T10:00:00.000Z');
    addMonths(from, 1);
    expect(from.toISOString()).toBe('2026-01-31T10:00:00.000Z');
  });
});

describe('who answers for the review (policy)', () => {
  const document = (overrides: Partial<{ status: DocumentStatus; ownerId: string; departmentId: string }> = {}) => ({
    status: 'PUBLISHED' as DocumentStatus,
    ownerId: users.ownerA.id,
    departmentId: org.deptA,
    ...overrides,
  });

  it.each([
    ['ownerA', true],
    ['otherA', false],
    ['editorB', false],
    ['approverA', true],
    ['approverB', false],
    ['qm', true],
    ['admin', true],
    ['reader', false],
  ] as const)('%s: responsible = %s', (who, expected) => {
    expect(isReviewResponsible(asUser(who), document())).toBe(expected);
  });

  it('lets the owner answer whatever department the document is in', () => {
    expect(isReviewResponsible(asUser('ownerA'), document({ departmentId: org.deptB }))).toBe(true);
  });

  it('lets a document be reviewed only while it is in force, and its period be set until it is withdrawn', () => {
    for (const status of ['DRAFT', 'IN_REVIEW', 'WITHDRAWN'] as const) expect(canMarkReviewed(asUser('qm'), document({ status }))).toBe(false);
    expect(canMarkReviewed(asUser('qm'), document())).toBe(true);
    for (const status of ['DRAFT', 'IN_REVIEW', 'PUBLISHED'] as const) expect(canSetReviewInterval(asUser('qm'), document({ status }))).toBe(true);
    expect(canSetReviewInterval(asUser('qm'), document({ status: 'WITHDRAWN' }))).toBe(false);
    expect(canSetReviewInterval(asUser('reader'), document())).toBe(false);
  });
});

describe('the dates follow publication', () => {
  async function publish(options: { intervalMonths: number | null }) {
    const doc = await createDocument({ status: 'DRAFT', intervalMonths: options.intervalMonths });
    const before = Date.now();
    await publishThroughApproval(app, { revisionId: doc.revisionId, submitToken: users.ownerA.token, approverToken: users.approverA.token, qualityToken: users.qm.token });
    return { ...doc, before, row: await documentRow(doc.id) };
  }

  it('counts the next review from the moment a revision is put in force', async () => {
    const { row, before } = await publish({ intervalMonths: 12 });

    expect(row.lastReviewedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.nextReviewAt!.toISOString()).toBe(addMonths(row.lastReviewedAt!, 12).toISOString());
  });

  it('records the publication as a review even without a period, and sets no date', async () => {
    const { row } = await publish({ intervalMonths: null });
    expect(row.lastReviewedAt).toBeInstanceOf(Date);
    expect(row.nextReviewAt).toBeNull();
  });

  it('starts the period again when a later revision is published', async () => {
    const doc = await createDocument({ intervalMonths: 6, lastReviewedAt: new Date('2025-01-10T09:00:00Z'), nextReviewAt: new Date('2025-07-10T09:00:00Z') });
    const storageKey = buildRevisionKey({ organizationId: org.id, documentId: doc.id, revisionNo: 1, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const next = await prisma.revision.create({
      data: { organizationId: org.id, documentId: doc.id, revisionNo: 1, status: 'DRAFT', storageKey, fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: users.ownerA.id, changeSummary: 'Yeni' },
    });

    await publishThroughApproval(app, { revisionId: next.id, submitToken: users.ownerA.token, approverToken: users.approverA.token, qualityToken: users.qm.token });

    const row = await documentRow(doc.id);
    expect(row.lastReviewedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.nextReviewAt!.toISOString()).toBe(addMonths(row.lastReviewedAt!, 6).toISOString());
  });
});

describe('the default period of a category', () => {
  const create = (token: string, categoryId: string) =>
    api().post('/api/documents').set(auth(token)).send({ title: 'Varsayılan periyot', categoryId, departmentId: org.deptA, fileType: 'DOCX' });

  it('is the period of new documents of the category, and a category without one leaves them without', async () => {
    const withPeriod = await create(users.ownerA.token, org.categoryWithPeriod).expect(201);
    const without = await create(users.ownerA.token, org.category).expect(201);

    expect((await documentRow(withPeriod.body.id)).reviewIntervalMonths).toBe(12);
    expect((await documentRow(withPeriod.body.id)).nextReviewAt).toBeNull();
    expect((await documentRow(without.body.id)).reviewIntervalMonths).toBeNull();
    // Cleanup of documents made through the API
    for (const id of [withPeriod.body.id, without.body.id]) {
      await prisma.revision.deleteMany({ where: { documentId: id } });
      await deleteAuditLogs(prisma, { entityId: id });
      await prisma.document.delete({ where: { id } });
    }
  });

  it('is not applied to documents that exist already when the category changes', async () => {
    const doc = await createDocument({ intervalMonths: null });
    await api().patch(`/api/categories/${org.category}`).set(auth(users.admin.token)).send({ defaultReviewIntervalMonths: 6 }).expect(200);

    expect((await documentRow(doc.id)).reviewIntervalMonths).toBeNull();
    await api().patch(`/api/categories/${org.category}`).set(auth(users.admin.token)).send({ defaultReviewIntervalMonths: null }).expect(200);
  });

  it('is set and cleared by the administrator, validated, and audited', async () => {
    const make = (body: Record<string, unknown>) => api().post('/api/categories').set(auth(users.admin.token)).send({ name: `Periyotlu ${randomUUID().slice(0, 5)}`, codePrefix: `P${String.fromCharCode(65 + (counter++ % 26))}`, ...body });
    const created = await make({ defaultReviewIntervalMonths: 18 }).expect(201);
    expect(created.body.defaultReviewIntervalMonths).toBe(18);

    const patched = await api().patch(`/api/categories/${created.body.id}`).set(auth(users.admin.token)).send({ defaultReviewIntervalMonths: 24 }).expect(200);
    expect(patched.body.defaultReviewIntervalMonths).toBe(24);
    expect((await auditOf(created.body.id))[1].metadata).toMatchObject({ changes: { defaultReviewIntervalMonths: { from: 18, to: 24 } } });
    const cleared = await api().patch(`/api/categories/${created.body.id}`).set(auth(users.admin.token)).send({ defaultReviewIntervalMonths: null }).expect(200);
    expect(cleared.body.defaultReviewIntervalMonths).toBeNull();

    for (const bad of [0, 121, 1.5, 'x']) {
      await api().patch(`/api/categories/${created.body.id}`).set(auth(users.admin.token)).send({ defaultReviewIntervalMonths: bad }).expect(400);
    }
  });
});

describe('setting the period', () => {
  it.each(['ownerA', 'approverA', 'qm', 'admin'] as const)('is allowed for %s', async (who) => {
    const doc = await createDocument({});
    const response = await setPeriod(users[who].token, doc.id, { intervalMonths: 12 }).expect(200);
    expect(response.body).toMatchObject({ id: doc.id, reviewIntervalMonths: 12 });
  });

  it.each(['otherA', 'editorB', 'approverB', 'reader'] as const)('is refused for %s, who sees the document but does not answer for it', async (who) => {
    const doc = await createDocument({});
    expect((await setPeriod(users[who].token, doc.id, { intervalMonths: 12 }).expect(403)).body.code).toBe('REVIEW_NOT_ALLOWED');
    expect((await documentRow(doc.id)).reviewIntervalMonths).toBeNull();
  });

  it('counts the next review from the last one, not from today', async () => {
    const last = new Date('2026-03-15T09:00:00Z');
    const doc = await createDocument({ lastReviewedAt: last });

    const response = await setPeriod(users.qm.token, doc.id, { intervalMonths: 6 }).expect(200);

    expect(response.body.nextReviewAt).toBe('2026-09-15T09:00:00.000Z');
    expect((await documentRow(doc.id)).nextReviewAt!.toISOString()).toBe('2026-09-15T09:00:00.000Z');
  });

  it('removes the review when the period is removed', async () => {
    const doc = await due(5);
    const response = await setPeriod(users.qm.token, doc.id, { intervalMonths: null }).expect(200);
    expect(response.body).toMatchObject({ reviewIntervalMonths: null, nextReviewAt: null });
  });

  it('can be set before the document is published, without a date', async () => {
    const doc = await createDocument({ status: 'DRAFT' });
    const response = await setPeriod(users.ownerA.token, doc.id, { intervalMonths: 12 }).expect(200);
    expect(response.body).toMatchObject({ reviewIntervalMonths: 12, nextReviewAt: null });
  });

  it('is not possible for a withdrawn document', async () => {
    const doc = await createDocument({ status: 'WITHDRAWN' });
    expect((await setPeriod(users.qm.token, doc.id, { intervalMonths: 12 }).expect(409)).body.code).toBe('DOCUMENT_NOT_REVIEWABLE');
  });

  it.each([[0], [121], [1.5], ['x'], [undefined]])('refuses the period %p', async (value) => {
    const doc = await createDocument({});
    await setPeriod(users.qm.token, doc.id, { intervalMonths: value }).expect(400);
    await setPeriod(users.qm.token, doc.id, {}).expect(400);
    expect((await documentRow(doc.id)).reviewIntervalMonths).toBeNull();
  });

  it('answers 404 for documents the user cannot see or that are another organization\'s, and 400 for an id that is none', async () => {
    expect((await setPeriod(users.qm.token, randomUUID(), { intervalMonths: 12 }).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    await setPeriod(users.admin.token, org.foreignDocument, { intervalMonths: 12 }).expect(404);
    const draftOfB = await createDocument({ status: 'DRAFT', departmentId: org.deptB, owner: 'editorB' });
    await setPeriod(users.ownerA.token, draftOfB.id, { intervalMonths: 12 }).expect(404);
    await setPeriod(users.qm.token, 'not-a-uuid', { intervalMonths: 12 }).expect(400);
  });

  it('is audited, and a request that changes nothing is not', async () => {
    const doc = await createDocument({ intervalMonths: 6, lastReviewedAt: new Date('2026-01-31T09:00:00Z') });
    await setPeriod(users.qm.token, doc.id, { intervalMonths: 12 }).expect(200);
    await setPeriod(users.qm.token, doc.id, { intervalMonths: 12 }).expect(200);

    const entries = await auditOf(doc.id);

    expect(entries.map((entry) => entry.action)).toEqual(['DOCUMENT_REVIEW_SETTINGS_CHANGED']);
    expect(entries[0]).toMatchObject({ userId: users.qm.id, entityType: 'Document' });
    expect(entries[0].metadata).toEqual({ code: doc.code, from: 6, to: 12, nextReviewAt: '2027-01-31T09:00:00.000Z' });
  });
});

describe('marking a document as reviewed', () => {
  it.each(['ownerA', 'approverA', 'qm', 'admin'] as const)('is allowed for %s', async (who) => {
    const doc = await due(-3);
    await review(users[who].token, doc.id).expect(200);
    expect((await documentRow(doc.id)).nextReviewAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it.each(['otherA', 'editorB', 'approverB', 'reader'] as const)('is refused for %s', async (who) => {
    const doc = await due(-3);
    expect((await review(users[who].token, doc.id).expect(403)).body.code).toBe('REVIEW_NOT_ALLOWED');
    expect((await documentRow(doc.id)).lastReviewedAt).toBeNull();
  });

  it('starts the next period now, keeps the revision in force, and the document stays published', async () => {
    const doc = await due(-10, { intervalMonths: 6 });
    const before = await documentRow(doc.id);
    const start = Date.now();

    const response = await review(users.ownerA.token, doc.id, { note: 'Madde 3 hâlâ güncel' }).expect(200);

    const row = await documentRow(doc.id);
    expect(row.lastReviewedAt!.getTime()).toBeGreaterThanOrEqual(start - 1000);
    expect(row.nextReviewAt!.toISOString()).toBe(addMonths(row.lastReviewedAt!, 6).toISOString());
    expect(row).toMatchObject({ status: 'PUBLISHED', currentRevisionId: before.currentRevisionId, reviewIntervalMonths: 6 });
    expect((response.body as DocumentDetailDto).nextReviewAt).toBe(row.nextReviewAt!.toISOString());
    // No new revision, no approval
    expect(await prisma.revision.count({ where: { documentId: doc.id } })).toBe(1);
    expect(await prisma.documentRequest.count({ where: { documentId: doc.id } })).toBe(0);
  });

  it('records the review of a document without a period, and leaves it without a date', async () => {
    const doc = await createDocument({});
    await review(users.qm.token, doc.id).expect(200);
    const row = await documentRow(doc.id);
    expect(row.lastReviewedAt).toBeInstanceOf(Date);
    expect(row.nextReviewAt).toBeNull();
  });

  it('is audited with the note and the dates', async () => {
    const doc = await due(-2, { intervalMonths: 12 });
    const previous = (await documentRow(doc.id)).nextReviewAt!.toISOString();
    await review(users.approverA.token, doc.id, { note: '  Gözden geçirildi  ' }).expect(200);

    const [entry] = await auditOf(doc.id);

    expect(entry).toMatchObject({ action: 'DOCUMENT_REVIEWED', userId: users.approverA.id, entityType: 'Document' });
    expect(entry.metadata).toEqual({ code: doc.code, revisionNo: 0, note: 'Gözden geçirildi', previousNextReviewAt: previous, nextReviewAt: (await documentRow(doc.id)).nextReviewAt!.toISOString() });
  });

  it.each(['DRAFT', 'IN_REVIEW', 'WITHDRAWN'] as const)('is not possible while the document is %s', async (status) => {
    const doc = await createDocument({ status });
    expect((await review(users.qm.token, doc.id).expect(409)).body.code).toBe('DOCUMENT_NOT_REVIEWABLE');
    expect((await documentRow(doc.id)).lastReviewedAt).toBeNull();
  });

  it('refuses a note that is too long, and unknown fields', async () => {
    const doc = await createDocument({});
    await review(users.qm.token, doc.id, { note: 'x'.repeat(2001) }).expect(400);
    await review(users.qm.token, doc.id, { surprise: true }).expect(400);
  });

  it('answers 404 for unknown documents and another organization\'s', async () => {
    expect((await review(users.qm.token, randomUUID()).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    await review(users.admin.token, org.foreignDocument).expect(404);
    await review(users.qm.token, 'not-a-uuid').expect(400);
  });

  it('makes two reviews at the same moment harmless', async () => {
    const doc = await due(-1);
    const results = await Promise.all([review(users.qm.token, doc.id), review(users.admin.token, doc.id)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect((await auditOf(doc.id)).filter((entry) => entry.action === 'DOCUMENT_REVIEWED')).toHaveLength(2);
  });
});

describe('the detail of a document', () => {
  it('says what the user may do about the review, and when it was last done', async () => {
    const last = new Date('2026-02-01T09:00:00Z');
    const doc = await createDocument({ intervalMonths: 12, lastReviewedAt: last, nextReviewAt: new Date('2027-02-01T09:00:00Z') });
    const detail = async (who: Label) => (await api().get(`/api/documents/${doc.id}`).set(auth(users[who].token)).expect(200)).body as DocumentDetailDto;

    expect(await detail('ownerA')).toMatchObject({ canMarkReviewed: true, canSetReviewInterval: true, lastReviewedAt: '2026-02-01T09:00:00.000Z', reviewIntervalMonths: 12 });
    expect(await detail('qm')).toMatchObject({ canMarkReviewed: true, canSetReviewInterval: true });
    expect(await detail('otherA')).toMatchObject({ canMarkReviewed: false, canSetReviewInterval: false });
    expect(await detail('reader')).toMatchObject({ canMarkReviewed: false, canSetReviewInterval: false });
  });

  it('allows the period but not the review before the document is published', async () => {
    const doc = await createDocument({ status: 'DRAFT' });
    const body = (await api().get(`/api/documents/${doc.id}`).set(auth(users.qm.token)).expect(200)).body as DocumentDetailDto;
    expect(body).toMatchObject({ canMarkReviewed: false, canSetReviewInterval: true });
  });
});

describe('the list of reviews that are due', () => {
  /** A fresh organization-wide state is not possible (other documents exist), so every check looks for its own documents. */
  const idsFor = async (who: Label, query: Record<string, string> = {}) =>
    ((await reviewList(users[who].token, { pageSize: '100', ...query }).expect(200)).body as PaginatedDto<ReviewDueItemDto>).items.map((item) => item.id);

  it('includes the documents due within 30 days and the overdue ones, and leaves out those further away', async () => {
    const overdue = await due(-20, { title: 'Pencere gecikmiş' });
    const soon = await due(29, { title: 'Pencere yakın' });
    const far = await due(31, { title: 'Pencere uzak' });
    const none = await createDocument({ title: 'Pencere periyotsuz' });

    const ids = await idsFor('qm', { search: 'Pencere' });

    expect(ids).toEqual([overdue.id, soon.id]);
    expect(ids).not.toContain(far.id);
    expect(ids).not.toContain(none.id);
  });

  it('shows what the table needs: the date, whether it is overdue, the one responsible', async () => {
    const overdue = await due(-5, { title: 'Alan gecikmiş' });
    const upcoming = await due(10, { title: 'Alan yaklaşan' });

    const items = ((await reviewList(users.qm.token, { search: 'Alan ' }).expect(200)).body as PaginatedDto<ReviewDueItemDto>).items;

    expect(items[0]).toMatchObject({ id: overdue.id, overdue: true, owner: { id: users.ownerA.id, fullName: 'ownerA' }, code: overdue.code, status: 'PUBLISHED' });
    expect(items[1]).toMatchObject({ id: upcoming.id, overdue: false });
    expect(typeof items[0].nextReviewAt).toBe('string');
  });

  it('puts the longest overdue first, and the code decides between equal dates', async () => {
    const date = daysFromNow(3);
    const second = await createDocument({ intervalMonths: 12, nextReviewAt: date, title: 'Sıra eşit' });
    const first = await createDocument({ intervalMonths: 12, nextReviewAt: daysFromNow(-9), title: 'Sıra eşit' });
    const third = await createDocument({ intervalMonths: 12, nextReviewAt: date, title: 'Sıra eşit' });

    expect(await idsFor('qm', { search: 'Sıra eşit' })).toEqual([first.id, second.id, third.id]);
  });

  it('gives each role the documents it answers for', async () => {
    const ownedByA = await due(-1, { title: 'Kapsam A sahip', owner: 'ownerA', departmentId: org.deptA });
    const otherInA = await due(-1, { title: 'Kapsam A diğer', owner: 'otherA', departmentId: org.deptA });
    const inB = await due(-1, { title: 'Kapsam B', owner: 'editorB', departmentId: org.deptB });
    const ownedByAInB = await due(-1, { title: 'Kapsam sahibi A, birim B', owner: 'ownerA', departmentId: org.deptB });
    const mine = { search: 'Kapsam' };

    expect(await idsFor('ownerA', mine)).toEqual(expect.arrayContaining([ownedByA.id, ownedByAInB.id]));
    expect(await idsFor('ownerA', mine)).not.toEqual(expect.arrayContaining([otherInA.id]));
    expect((await idsFor('ownerA', mine)).sort()).toEqual([ownedByA.id, ownedByAInB.id].sort());
    expect((await idsFor('otherA', mine)).sort()).toEqual([otherInA.id]);
    expect((await idsFor('approverA', mine)).sort()).toEqual([ownedByA.id, otherInA.id].sort());
    expect((await idsFor('approverB', mine)).sort()).toEqual([inB.id, ownedByAInB.id].sort());
    expect((await idsFor('qm', mine)).sort()).toEqual([ownedByA.id, otherInA.id, inB.id, ownedByAInB.id].sort());
    expect((await idsFor('admin', mine)).sort()).toEqual((await idsFor('qm', mine)).sort());
  });

  it('is closed to readers, and needs a session', async () => {
    expect((await reviewList(users.reader.token).expect(403)).body.code).toBe('FORBIDDEN');
    await api().get('/api/lists/review-due').expect(401);
  });

  it('lists only documents in force, and never another organization\'s', async () => {
    const draft = await createDocument({ status: 'DRAFT', intervalMonths: 12, nextReviewAt: daysFromNow(-4), title: 'Durum taslak' });
    const withdrawn = await createDocument({ status: 'WITHDRAWN', intervalMonths: 12, nextReviewAt: daysFromNow(-4), title: 'Durum kaldırılmış' });
    const ids = await idsFor('admin', { search: 'Durum' });

    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(withdrawn.id);
    expect(await idsFor('admin')).not.toContain(org.foreignDocument);
  });

  it('filters by department and search, in pages, with % and _ as plain characters', async () => {
    const a = await due(-1, { title: 'Süzgeç Alfa', departmentId: org.deptA, owner: 'ownerA' });
    const b = await due(-1, { title: 'Süzgeç Beta', departmentId: org.deptB, owner: 'editorB' });

    expect(await idsFor('qm', { search: 'süzgeç', departmentId: org.deptB })).toEqual([b.id]);
    expect(await idsFor('qm', { search: 'SÜZGEÇ ALFA' })).toEqual([a.id]);
    expect(await idsFor('qm', { search: '%' })).toEqual([]);
    const page = (await reviewList(users.qm.token, { search: 'Süzgeç', pageSize: '1', page: '2' }).expect(200)).body as PaginatedDto<ReviewDueItemDto>;
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
  });

  it.each([['page', '0'], ['pageSize', '101'], ['departmentId', 'x']])('refuses a bad %s', async (key, value) => {
    await reviewList(users.qm.token, { [key]: value }).expect(400);
  });
});

describe('the dashboard counter', () => {
  const stats = async (who: Label) => (await api().get('/api/dashboard/stats').set(auth(users[who].token)).expect(200)).body as DashboardStatsDto;
  const total = async (who: Label) => ((await reviewList(users[who].token, { pageSize: '1' }).expect(200)).body as PaginatedDto<ReviewDueItemDto>).total;

  it.each(['ownerA', 'otherA', 'editorB', 'approverA', 'approverB', 'qm', 'admin'] as const)('counts exactly what the list shows for %s', async (who) => {
    await due(-2, { owner: 'ownerA', departmentId: org.deptA, title: 'Sayaç bir' });
    await due(5, { owner: 'otherA', departmentId: org.deptA, title: 'Sayaç iki' });
    await due(5, { owner: 'editorB', departmentId: org.deptB, title: 'Sayaç üç' });

    expect((await stats(who)).reviewDue).toBe(await total(who));
  });

  it('is not shown to readers', async () => {
    expect((await stats('reader')).reviewDue).toBeNull();
  });
});
