process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DocumentDetailDto, RevisionHistoryItemDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
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
let blankDocx: Buffer;
let commandServer: FakeCommandServer;
let foreignRevisionId: string;

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'editorA' | 'editorB' | 'approverA' | 'approverB';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let codeCounter = 0;

interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
}

async function createDocument(options: { status?: DocumentStatus; revisions: RevisionSpec[] }) {
  const sequenceNo = 400 + codeCounter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId: org.deptA,
      ownerId: users.editorA.id,
      code: `MM-AA-${sequenceNo}`,
      sequenceNo,
      title: 'İptal denemesi',
      fileType: 'DOCX',
      status: options.status ?? 'PUBLISHED',
      firstPublishedAt: new Date('2025-01-10T09:00:00Z'),
    },
  });
  const revisions: { id: string; revisionNo: number; storageKey: string }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id,
        documentId: document.id,
        revisionNo: spec.revisionNo,
        status: spec.status,
        storageKey,
        fileSize: blankDocx.length,
        checksum: createHash('sha256').update(blankDocx).digest('hex'),
        editorKey: randomUUID(),
        changeSummary: spec.revisionNo > 0 ? 'Madde 3 güncellendi' : undefined,
        preparedById: users.editorA.id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo, storageKey });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, revisions };
}

/** A document in force with a revision 1 that was started and is waiting as a draft. */
const withStartedRevision = () =>
  createDocument({
    revisions: [
      { revisionNo: 0, status: 'APPROVED', current: true },
      { revisionNo: 1, status: 'DRAFT' },
    ],
  });

const cancel = (token: string, revisionId: string, body: Record<string, unknown> = { reason: 'Artık gerekli değil' }) =>
  request(app.getHttpServer()).post(`/api/revisions/${revisionId}/cancel`).set(auth(token)).send(body);
const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const detail = async (token: string, documentId: string) =>
  (await request(app.getHttpServer()).get(`/api/documents/${documentId}`).set(auth(token)).expect(200)).body as DocumentDetailDto;

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;
  app = await createTestApp();
  storage = app.get(StorageService);

  const organization = await prisma.organization.create({ data: { name: `Cancel ${suffix}`, slug: `cancel-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `cancel-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@cancel.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('approverA', 'APPROVER', org.deptA);
  await makeUser('approverB', 'APPROVER', org.deptB);

  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@cancel.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  const foreignCurrent = await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'APPROVED', storageKey: 'foreign/none0', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
  });
  await prisma.document.update({ where: { id: foreignDoc.id }, data: { currentRevisionId: foreignCurrent.id } });
  foreignRevisionId = (
    await prisma.revision.create({
      data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 1, status: 'DRAFT', storageKey: 'foreign/none1', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
    })
  ).id;
});

beforeEach(() => {
  commandServer.reset();
});

afterAll(async () => {
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
  await Promise.all(revisions.map((revision) => storage.delete(revision.storageKey).catch(() => undefined)));
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
  await commandServer.close();
});

describe('who may give up a started revision', () => {
  it('requires authentication and a valid id', async () => {
    const doc = await withStartedRevision();
    await request(app.getHttpServer()).post(`/api/revisions/${doc.revisions[1].id}/cancel`).send({ reason: 'x' }).expect(401);
    await cancel(users.editorA.token, 'not-a-uuid').expect(400);
    expect((await cancel(users.editorA.token, randomUUID()).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    expect((await cancel(users.admin.token, foreignRevisionId).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
  });

  it('refuses readers with 403', async () => {
    const doc = await withStartedRevision();
    expect((await cancel(users.reader.token, doc.revisions[1].id).expect(403)).body.code).toBe('FORBIDDEN');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('DRAFT');
  });

  it('does not reveal the draft to an editor of another department', async () => {
    const doc = await withStartedRevision();
    expect((await cancel(users.editorB.token, doc.revisions[1].id).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
  });

  it('refuses an approver of another department, who can see the draft but may not touch it', async () => {
    const doc = await withStartedRevision();
    expect((await cancel(users.approverB.token, doc.revisions[1].id).expect(403)).body.code).toBe('CANCEL_NOT_ALLOWED');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('DRAFT');
  });

  it.each(['editorA', 'approverA', 'qm', 'admin'] as const)('lets %s give up the draft of department A', async (who) => {
    const doc = await withStartedRevision();
    await cancel(users[who].token, doc.revisions[1].id).expect(200);
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('REJECTED');
  });
});

describe('the reason', () => {
  it.each([
    ['missing', {}],
    ['empty', { reason: '' }],
    ['only spaces', { reason: '    ' }],
  ])('is required (%s)', async (_label, body) => {
    const doc = await withStartedRevision();

    const response = await cancel(users.editorA.token, doc.revisions[1].id, body).expect(400);

    expect(response.body.code).toBe('REASON_REQUIRED');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('DRAFT');
  });

  it('is limited to 2000 characters, and unknown fields are rejected', async () => {
    const doc = await withStartedRevision();
    await cancel(users.editorA.token, doc.revisions[1].id, { reason: 'x'.repeat(2001) }).expect(400);
    await cancel(users.editorA.token, doc.revisions[1].id, { reason: 'ok', status: 'DRAFT' }).expect(400);
  });
});

describe('what giving up does', () => {
  it('marks the draft rejected, keeps it and its file on record, and leaves the document as it was', async () => {
    const doc = await withStartedRevision();
    const [inForce, draft] = doc.revisions;
    const before = await revisionRow(draft.id);

    const response = await cancel(users.editorA.token, draft.id, { reason: '  Artık gerekli değil  ' }).expect(200);

    expect(await revisionRow(draft.id)).toEqual({ ...before, status: 'REJECTED' });
    expect(await storage.exists(draft.storageKey)).toBe(true);
    expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', currentRevisionId: inForce.id });
    expect(await revisionRow(inForce.id)).toMatchObject({ status: 'APPROVED' });
    expect(response.body).toMatchObject({
      status: 'PUBLISHED',
      openRevision: { id: inForce.id },
      canEdit: false,
      canSubmit: false,
      canCancelRevision: false,
      canStartRevision: true,
    });
  });

  it('audits who gave it up and why', async () => {
    const doc = await withStartedRevision();
    await cancel(users.editorA.token, doc.revisions[1].id, { reason: '  Artık gerekli değil  ' }).expect(200);

    const [entry] = await prisma.auditLog.findMany({ where: { entityId: doc.revisions[1].id, action: 'REVISION_CANCELLED' } });

    expect(entry).toMatchObject({ userId: users.editorA.id, entityType: 'Revision', organizationId: org.id });
    expect(entry.metadata).toMatchObject({ documentId: doc.id, revisionNo: 1, reason: 'Artık gerekli değil' });
  });

  it('shows the revision as rejected in the history of those who may see it', async () => {
    const doc = await withStartedRevision();
    await cancel(users.editorA.token, doc.revisions[1].id).expect(200);

    const history = (await request(app.getHttpServer()).get(`/api/documents/${doc.id}/revisions`).set(auth(users.editorA.token)).expect(200)).body as RevisionHistoryItemDto[];

    expect(history.map((row) => [row.revisionNo, row.status, row.canEdit])).toEqual([[1, 'REJECTED', false], [0, 'APPROVED', false]]);
  });

  it('makes room for a new revision, which gets the next number', async () => {
    const doc = await withStartedRevision();
    await cancel(users.editorA.token, doc.revisions[1].id).expect(200);

    const response = await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).set(auth(users.editorA.token)).send({ changeSummary: 'Yeniden' }).expect(201);

    expect(response.body.openRevision.revisionNo).toBe(2);
  });

  it('turns the editor read only for the given up draft', async () => {
    const doc = await withStartedRevision();
    await cancel(users.editorA.token, doc.revisions[1].id).expect(200);

    const session = (await request(app.getHttpServer()).get(`/api/editor/config/${doc.revisions[1].id}`).set(auth(users.editorA.token)).expect(200)).body;

    expect(session.mode).toBe('view');
  });

  it('does not change what readers see', async () => {
    const doc = await withStartedRevision();
    const before = await detail(users.reader.token, doc.id);

    await cancel(users.editorA.token, doc.revisions[1].id).expect(200);

    expect(await detail(users.reader.token, doc.id)).toEqual({ ...before, canStartRevision: false });
  });
});

describe('when it cannot be given up', () => {
  it.each([
    ['the draft of a document that was never published', async () => (await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] })).revisions[0].id],
    ['a revision in review', async () => (await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'IN_REVIEW' }] })).revisions[1].id],
    ['the revision in force', async () => (await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] })).revisions[0].id],
    ['a revision that was already given up', async () => (await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'REJECTED' }] })).revisions[1].id],
    ['a draft of a withdrawn document', async () => (await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'DRAFT' }] })).revisions[1].id],
  ])('refuses %s', async (_label, makeRevisionId) => {
    const revisionId = await makeRevisionId();
    const before = await revisionRow(revisionId);

    const response = await cancel(users.qm.token, revisionId).expect(409);

    expect(response.body.code).toBe('REVISION_NOT_CANCELLABLE');
    expect(await revisionRow(revisionId)).toEqual(before);
  });

  it('refuses while somebody edits the draft, or while its last changes are on their way', async () => {
    const doc = await withStartedRevision();
    commandServer.state.info = { error: 0, users: [users.editorA.id] };
    expect((await cancel(users.qm.token, doc.revisions[1].id).expect(409)).body.code).toBe('EDITOR_SESSION_ACTIVE');

    commandServer.state.info = { error: 0, users: [] };
    await prisma.revision.update({ where: { id: doc.revisions[1].id }, data: { editSessionStartedAt: new Date() } });
    expect((await cancel(users.qm.token, doc.revisions[1].id).expect(409)).body.code).toBe('EDITOR_SESSION_ACTIVE');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('DRAFT');

    await prisma.revision.update({ where: { id: doc.revisions[1].id }, data: { editSessionStartedAt: null } });
    await cancel(users.qm.token, doc.revisions[1].id).expect(200);
  });

  it('refuses with 503 when the editor server cannot be reached', async () => {
    const doc = await withStartedRevision();
    commandServer.state.down = true;

    expect((await cancel(users.qm.token, doc.revisions[1].id).expect(503)).body.code).toBe('EDITOR_SERVER_UNAVAILABLE');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('DRAFT');
  });

  it('lets exactly one of two simultaneous requests win', async () => {
    const doc = await withStartedRevision();

    const [first, second] = await Promise.all([cancel(users.qm.token, doc.revisions[1].id), cancel(users.admin.token, doc.revisions[1].id)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { entityId: doc.revisions[1].id, action: 'REVISION_CANCELLED' } })).toBe(1);
  });

  it('rolls back when the audit entry cannot be written', async () => {
    const doc = await withStartedRevision();
    const before = await revisionRow(doc.revisions[1].id);
    jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

    await cancel(users.qm.token, doc.revisions[1].id).expect(500);

    expect(await revisionRow(doc.revisions[1].id)).toEqual(before);
  });
});

describe('the canCancelRevision flag', () => {
  it('is true for those who may give up the draft of a document in force, and only then', async () => {
    const doc = await withStartedRevision();
    for (const who of ['editorA', 'approverA', 'qm', 'admin'] as const) {
      expect((await detail(users[who].token, doc.id)).canCancelRevision).toBe(true);
    }
    for (const who of ['reader', 'approverB'] as const) {
      expect((await detail(users[who].token, doc.id)).canCancelRevision).toBe(false);
    }
    const neverPublished = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    expect((await detail(users.qm.token, neverPublished.id)).canCancelRevision).toBe(false);
  });
});
