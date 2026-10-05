process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { DocumentDetailDto, DocumentListItemDto, RevisionHistoryItemDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { EditSessionGate } from '../src/modules/editor/edit-session-gate.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];
const ONLYOFFICE_SECRET = process.env.ONLYOFFICE_JWT_SECRET!;

let app: INestApplication;
let storage: StorageService;
let jwt: JwtService;
let blankDocx: Buffer;

// ---- fake ONLYOFFICE Command Service ----
interface CommandState {
  info: Record<string, unknown>;
  httpStatus: number;
  down: boolean;
}
const IDLE: CommandState = { info: { error: 1 }, httpStatus: 200, down: false };
let commandState: CommandState;
let commandRequests: { command: string; key: string; tokenValid: boolean }[] = [];
let commandServer: http.Server;

async function startCommandServer(): Promise<string> {
  commandServer = http.createServer((req, res) => {
    if (commandState.down) return void req.socket.destroy();
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { c: string; key: string };
      let tokenValid = false;
      try {
        const decoded = jwt.verify((req.headers.authorization ?? '').replace('Bearer ', ''), { secret: ONLYOFFICE_SECRET }) as { payload?: unknown };
        tokenValid = JSON.stringify(decoded.payload) === JSON.stringify(body);
      } catch {
        // an invalid token stays invalid
      }
      commandRequests.push({ command: body.c, key: body.key, tokenValid });
      const answer = tokenValid ? (commandState as unknown as Record<string, unknown>)[body.c] : { error: 6 };
      res.writeHead(commandState.httpStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key: body.key, ...(answer as object) }));
    });
  });
  await new Promise<void>((resolve) => commandServer.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(commandServer.address() as AddressInfo).port}`;
}

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'editorA' | 'editorB' | 'approverA';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let codeCounter = 0;

interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
  preparedBy?: Label;
}

async function createDocument(options: {
  status?: DocumentStatus;
  departmentId?: string;
  organizationId?: string;
  firstPublishedAt?: Date;
  revisions: RevisionSpec[];
}) {
  const organizationId = options.organizationId ?? org.id;
  const sequenceNo = 100 + codeCounter++;
  const document = await prisma.document.create({
    data: {
      organizationId,
      categoryId: org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: users.editorA.id,
      code: `MM-AA-${sequenceNo}`,
      sequenceNo,
      title: 'Yayınlama denemesi',
      fileType: 'DOCX',
      status: options.status ?? 'DRAFT',
      firstPublishedAt: options.firstPublishedAt,
    },
  });

  const revisions: { id: string; revisionNo: number; editorKey: string }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: spec.revisionNo, fileType: 'DOCX' });
    await storage.put(storageKey, blankDocx, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId,
        documentId: document.id,
        revisionNo: spec.revisionNo,
        status: spec.status,
        storageKey,
        fileSize: blankDocx.length,
        checksum: createHash('sha256').update(blankDocx).digest('hex'),
        editorKey: randomUUID(),
        preparedById: users[spec.preparedBy ?? 'editorA'].id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo, editorKey: revision.editorKey });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

/** A draft that was never published. */
const newDraft = (options: { departmentId?: string; preparedBy?: Label } = {}) =>
  createDocument({ departmentId: options.departmentId, revisions: [{ revisionNo: 0, status: 'DRAFT', preparedBy: options.preparedBy }] });

/** A published document with a new draft revision waiting. */
const publishedWithDraft = () =>
  createDocument({
    status: 'PUBLISHED',
    firstPublishedAt: new Date('2025-01-10T09:00:00Z'),
    revisions: [
      { revisionNo: 0, status: 'SUPERSEDED' },
      { revisionNo: 1, status: 'APPROVED', current: true },
      { revisionNo: 2, status: 'DRAFT' },
    ],
  });

const publish = (token: string, revisionId: string, body: Record<string, unknown> = {}) =>
  request(app.getHttpServer()).post(`/api/revisions/${revisionId}/publish`).set(auth(token)).send(body);

/** What the closing callback of the editor does once the last user has left and the content is stored. */
const closeEditSession = (revisionId: string) =>
  prisma.revision.update({ where: { id: revisionId }, data: { editSessionStartedAt: null } });
/** What handing out an editing session does. */
const openEditSession = (revisionId: string, startedAt = new Date()) =>
  prisma.revision.update({ where: { id: revisionId }, data: { editSessionStartedAt: startedAt } });

const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const auditActions = async (entityId: string) =>
  (await prisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } })).map((entry) => entry.action);

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  const commandOrigin = await startCommandServer();
  process.env.ONLYOFFICE_INTERNAL_URL = commandOrigin;

  app = await createTestApp();
  storage = app.get(StorageService);
  jwt = app.get(JwtService);

  const organization = await prisma.organization.create({ data: { name: `Publish ${suffix}`, slug: `publish-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `publish-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@publish.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('approverA', 'APPROVER', org.deptA);

  // a draft in another organization
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@publish.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX' },
  });
  foreignRevisionId = (
    await prisma.revision.create({
      data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'DRAFT', storageKey: 'foreign/none', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
    })
  ).id;
});

let foreignRevisionId: string;

beforeEach(() => {
  commandState = { ...IDLE };
  commandRequests = [];
});

afterAll(async () => {
  // Test cleanup only: the application never deletes revisions or their files
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
  await Promise.all(revisions.map((revision) => storage.delete(revision.storageKey).catch(() => undefined)));
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
  await new Promise<void>((resolve) => commandServer.close(() => resolve()));
});

describe('who may publish', () => {
  it('requires authentication and a valid id', async () => {
    const draft = await newDraft();
    await request(app.getHttpServer()).post(`/api/revisions/${draft.revisions[0].id}/publish`).expect(401);
    await publish(users.qm.token, 'not-a-uuid').expect(400);
    await publish(users.qm.token, randomUUID()).expect(404);
  });

  it.each(['reader', 'editorA', 'approverA'] as const)('refuses %s with 403 and changes nothing', async (who) => {
    const draft = await newDraft();

    const response = await publish(users[who].token, draft.revisions[0].id).expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
    expect((await documentRow(draft.id)).status).toBe('DRAFT');
  });

  it.each(['qm', 'admin'] as const)('lets %s publish, in any department', async (who) => {
    const draft = await newDraft({ departmentId: org.deptB });
    await publish(users[who].token, draft.revisions[0].id).expect(200);
    expect((await documentRow(draft.id)).status).toBe('PUBLISHED');
  });

  it('lets the preparer publish their own document (until the approval flow exists)', async () => {
    const draft = await newDraft({ preparedBy: 'qm' });
    await publish(users.qm.token, draft.revisions[0].id).expect(200);
  });

  it('does not reveal revisions of another organization', async () => {
    const response = await publish(users.admin.token, foreignRevisionId).expect(404);
    expect(response.body.code).toBe('REVISION_NOT_FOUND');
    expect((await revisionRow(foreignRevisionId)).status).toBe('DRAFT');
  });
});

describe('first publication', () => {
  it('makes the draft the revision in force and the document published', async () => {
    const draft = await newDraft();
    const revisionId = draft.revisions[0].id;

    const response = await publish(users.qm.token, revisionId).expect(200);
    const detail = response.body as DocumentDetailDto;

    expect(detail).toMatchObject({
      id: draft.id,
      status: 'PUBLISHED',
      currentRevisionId: revisionId,
      revisionNo: 0,
      openRevision: { id: revisionId, revisionNo: 0, status: 'APPROVED' },
      canEdit: false,
      canPublish: false,
      revisedAt: null,
    });
    expect(detail.firstPublishedAt).toEqual(expect.any(String));

    const revision = await revisionRow(revisionId);
    expect(revision).toMatchObject({ status: 'APPROVED', approvedById: users.qm.id });
    expect(revision.approvedAt).toBeInstanceOf(Date);
    expect(revision.publishedAt).toBeInstanceOf(Date);
    expect(revision.publishedAt!.getTime()).toBe(revision.approvedAt!.getTime());

    const document = await documentRow(draft.id);
    expect(document).toMatchObject({ status: 'PUBLISHED', currentRevisionId: revisionId, revisedAt: null });
    expect(document.firstPublishedAt!.getTime()).toBe(revision.publishedAt!.getTime());
  });

  it('keeps the stored file untouched', async () => {
    const draft = await newDraft();
    const before = await revisionRow(draft.revisions[0].id);

    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const after = await revisionRow(draft.revisions[0].id);
    expect(after).toMatchObject({ storageKey: before.storageKey, checksum: before.checksum, fileSize: before.fileSize, editorKey: before.editorKey });
    expect((await storage.getBuffer(after.storageKey)).equals(blankDocx)).toBe(true);
  });

  it('stores the change summary when one is given, and does not require it for revision 0', async () => {
    const without = await newDraft();
    await publish(users.qm.token, without.revisions[0].id).expect(200);
    expect((await revisionRow(without.revisions[0].id)).changeSummary).toBeNull();

    const withSummary = await newDraft();
    await publish(users.qm.token, withSummary.revisions[0].id, { changeSummary: '  İlk yayın  ' }).expect(200);
    expect((await revisionRow(withSummary.revisions[0].id)).changeSummary).toBe('İlk yayın');
  });

  it('writes one audit entry that names the revision and says it is the first publication', async () => {
    const draft = await newDraft();
    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const entries = await prisma.auditLog.findMany({ where: { entityId: draft.id, action: 'DOCUMENT_PUBLISHED' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: users.qm.id, entityType: 'Document', organizationId: org.id });
    expect(entries[0].metadata).toMatchObject({
      code: draft.code,
      revisionId: draft.revisions[0].id,
      revisionNo: 0,
      previousRevisionNo: null,
      firstPublication: true,
    });
  });
});

describe('publishing a later revision', () => {
  it('supersedes the revision in force and keeps the first publication date', async () => {
    const doc = await publishedWithDraft();
    const [, previous, draft] = doc.revisions;
    const firstPublishedAt = (await documentRow(doc.id)).firstPublishedAt!;

    const response = await publish(users.qm.token, draft.id, { changeSummary: 'Madde 3 güncellendi' }).expect(200);

    expect(response.body).toMatchObject({ status: 'PUBLISHED', currentRevisionId: draft.id, revisionNo: 2 });
    expect(await revisionRow(previous.id)).toMatchObject({ status: 'SUPERSEDED' });
    expect(await revisionRow(draft.id)).toMatchObject({ status: 'APPROVED', changeSummary: 'Madde 3 güncellendi', approvedById: users.qm.id });
    const document = await documentRow(doc.id);
    expect(document.firstPublishedAt!.getTime()).toBe(firstPublishedAt.getTime());
    expect(document.revisedAt).toBeInstanceOf(Date);
    expect(document.currentRevisionId).toBe(draft.id);
  });

  it('records the superseded revision in the audit entry', async () => {
    const doc = await publishedWithDraft();
    await publish(users.admin.token, doc.revisions[2].id, { changeSummary: 'Güncelleme' }).expect(200);

    const [entry] = await prisma.auditLog.findMany({ where: { entityId: doc.id, action: 'DOCUMENT_PUBLISHED' } });
    expect(entry.metadata).toMatchObject({ revisionNo: 2, previousRevisionNo: 1, firstPublication: false });
  });

  it.each([
    ['missing', {}],
    ['empty', { changeSummary: '' }],
    ['only spaces', { changeSummary: '    ' }],
  ])('requires a change summary from the second revision on (%s)', async (_label, body) => {
    const doc = await publishedWithDraft();

    const response = await publish(users.qm.token, doc.revisions[2].id, body).expect(400);

    expect(response.body.code).toBe('CHANGE_SUMMARY_REQUIRED');
    expect((await revisionRow(doc.revisions[2].id)).status).toBe('DRAFT');
    expect((await revisionRow(doc.revisions[1].id)).status).toBe('APPROVED');
    expect(commandRequests).toEqual([]); // refused before the editor server was asked
  });

  it('rejects a change summary that is too long', async () => {
    const doc = await publishedWithDraft();
    await publish(users.qm.token, doc.revisions[2].id, { changeSummary: 'x'.repeat(2001) }).expect(400);
  });

  it('rejects unknown fields', async () => {
    const draft = await newDraft();
    await publish(users.qm.token, draft.revisions[0].id, { status: 'APPROVED' }).expect(400);
  });
});

describe('what cannot be published', () => {
  it.each([
    ['a revision that is already in force', async () => (await publishedWithDraft()).revisions[1].id],
    ['a superseded revision', async () => (await publishedWithDraft()).revisions[0].id],
    ['a revision in review', async () => (await createDocument({ status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] })).revisions[0].id],
    ['a rejected revision', async () => (await createDocument({ revisions: [{ revisionNo: 0, status: 'REJECTED' }] })).revisions[0].id],
    [
      'a draft of a withdrawn document',
      async () => (await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'DRAFT' }] })).revisions[0].id,
    ],
  ])('refuses %s', async (_label, makeRevisionId) => {
    const revisionId = await makeRevisionId();
    const before = await revisionRow(revisionId);

    const response = await publish(users.qm.token, revisionId, { changeSummary: 'Deneme' }).expect(409);

    expect(response.body.code).toBe('REVISION_NOT_PUBLISHABLE');
    expect(await revisionRow(revisionId)).toEqual(before);
    expect(await auditActions(before.documentId)).not.toContain('DOCUMENT_PUBLISHED');
  });

  it('refuses publishing the same revision twice', async () => {
    const draft = await newDraft();
    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const again = await publish(users.qm.token, draft.revisions[0].id).expect(409);

    expect(again.body.code).toBe('REVISION_NOT_PUBLISHABLE');
    expect((await auditActions(draft.id)).filter((action) => action === 'DOCUMENT_PUBLISHED')).toHaveLength(1);
  });
});

describe('open editor sessions', () => {
  it('asks the editor server about the key of the revision, with a signed request', async () => {
    const draft = await newDraft();

    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    expect(commandRequests.length).toBeGreaterThan(0);
    for (const sent of commandRequests) {
      expect(sent).toMatchObject({ command: 'info', key: draft.revisions[0].editorKey, tokenValid: true });
    }
  });

  it('refuses while somebody is editing, and changes nothing', async () => {
    const draft = await newDraft();
    commandState.info = { error: 0, users: [users.editorA.id] };

    const response = await publish(users.qm.token, draft.revisions[0].id).expect(409);

    expect(response.body.code).toBe('EDITOR_SESSION_ACTIVE');
    expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
    expect((await documentRow(draft.id)).status).toBe('DRAFT');
    expect(await auditActions(draft.id)).not.toContain('DOCUMENT_PUBLISHED');
  });

  it.each([
    ['the server knows the session but lists nobody', { error: 0, users: [] }],
    ['the server does not know the session (yet)', { error: 1 }],
  ])('refuses while the closing save is still to come, even though %s', async (_label, info) => {
    const draft = await newDraft();
    await openEditSession(draft.revisions[0].id);
    commandState.info = info;

    const response = await publish(users.qm.token, draft.revisions[0].id).expect(409);

    expect(response.body.code).toBe('EDITOR_SESSION_ACTIVE');
    expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
    expect(await auditActions(draft.id)).not.toContain('DOCUMENT_PUBLISHED');
  });

  it('refuses when a session was handed out between the first check and the lock', async () => {
    const draft = await newDraft();
    const revisionId = draft.revisions[0].id;
    // The first check sees an idle revision; the session starts right after it
    jest.spyOn(app.get(EditSessionGate), 'assertIdle').mockImplementationOnce(async () => {
      await openEditSession(revisionId);
    });

    const response = await publish(users.qm.token, revisionId).expect(409);

    expect(response.body.code).toBe('EDITOR_SESSION_ACTIVE');
    expect((await revisionRow(revisionId)).status).toBe('DRAFT');
    expect((await documentRow(draft.id)).status).toBe('DRAFT');
  });

  it('publishes once the closing callback has cleared the mark', async () => {
    const draft = await newDraft();
    await openEditSession(draft.revisions[0].id);
    await publish(users.qm.token, draft.revisions[0].id).expect(409);

    await closeEditSession(draft.revisions[0].id);
    await publish(users.qm.token, draft.revisions[0].id).expect(200);
  });

  it('publishes a revision whose mark is stale: the server dropped the session long ago', async () => {
    const draft = await newDraft();
    await openEditSession(draft.revisions[0].id, new Date(Date.now() - 10 * 60_000));

    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    expect((await revisionRow(draft.revisions[0].id)).editSessionStartedAt).toBeNull();
  });

  it('lets the publisher retry: the same request succeeds after the session ended', async () => {
    const draft = await newDraft();
    commandState.info = { error: 0, users: [users.admin.id] };
    await publish(users.qm.token, draft.revisions[0].id).expect(409);

    commandState.info = { error: 1 };
    await publish(users.qm.token, draft.revisions[0].id).expect(200);
  });

  it.each([
    ['cannot be reached', () => { commandState.down = true; }],
    ['answers with an HTTP error', () => { commandState.httpStatus = 502; }],
    ['rejects the signature', () => { commandState.info = { error: 6 }; }],
  ])('refuses with 503 when the editor server %s, because the answer cannot be trusted', async (_label, break_) => {
    const draft = await newDraft();
    break_();

    const response = await publish(users.qm.token, draft.revisions[0].id).expect(503);

    expect(response.body.code).toBe('EDITOR_SERVER_UNAVAILABLE');
    expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
  });
});

describe('consistency', () => {
  it('lets exactly one of two simultaneous publications win', async () => {
    const draft = await newDraft();

    const [first, second] = await Promise.all([
      publish(users.qm.token, draft.revisions[0].id),
      publish(users.admin.token, draft.revisions[0].id),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await auditActions(draft.id)).filter((action) => action === 'DOCUMENT_PUBLISHED')).toHaveLength(1);
    expect((await documentRow(draft.id)).currentRevisionId).toBe(draft.revisions[0].id);
  });

  it('rolls everything back when the audit entry cannot be written', async () => {
    const doc = await publishedWithDraft();
    const [, previous, draft] = doc.revisions;
    const before = { document: await documentRow(doc.id), previous: await revisionRow(previous.id), draft: await revisionRow(draft.id) };
    jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

    await publish(users.qm.token, draft.id, { changeSummary: 'Deneme' }).expect(500);

    expect(await documentRow(doc.id)).toEqual(before.document);
    expect(await revisionRow(previous.id)).toEqual(before.previous);
    expect(await revisionRow(draft.id)).toEqual(before.draft);
  });
});

describe('after publication', () => {
  it('turns the editor read only for the published revision', async () => {
    const draft = await newDraft();
    const config = () => request(app.getHttpServer()).get(`/api/editor/config/${draft.revisions[0].id}`).set(auth(users.admin.token));
    expect((await config().expect(200)).body.mode).toBe('edit');
    await closeEditSession(draft.revisions[0].id);

    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const after = (await config().expect(200)).body;
    expect(after.mode).toBe('view');
    expect(after.config.editorConfig).not.toHaveProperty('callbackUrl');
  });

  it('refuses a late save of the editor, so the published content cannot change', async () => {
    const draft = await newDraft();
    const session = (await request(app.getHttpServer()).get(`/api/editor/config/${draft.revisions[0].id}`).set(auth(users.admin.token)).expect(200)).body;
    const callbackPath = (() => {
      const url = new URL(session.config.editorConfig.callbackUrl as string);
      return `${url.pathname}${url.search}`;
    })();
    await closeEditSession(draft.revisions[0].id);
    await publish(users.qm.token, draft.revisions[0].id).expect(200);
    const published = await revisionRow(draft.revisions[0].id);

    const data = { key: published.editorKey, status: 2, url: 'http://127.0.0.1:1/never-fetched.docx' };
    const response = await request(app.getHttpServer())
      .post(callbackPath)
      .set('Authorization', `Bearer ${jwt.sign({ payload: data }, { secret: ONLYOFFICE_SECRET })}`)
      .send(data)
      .expect(200);

    expect(response.body).toEqual({ error: 0 });
    expect(await revisionRow(draft.revisions[0].id)).toEqual(published);
    expect(await auditActions(draft.revisions[0].id)).toContain('REVISION_SAVE_REJECTED');
  });

  it('shows readers the document in the list and lets them download the file', async () => {
    const draft = await newDraft();
    const search = () =>
      request(app.getHttpServer()).get('/api/documents').query({ search: draft.code }).set(auth(users.reader.token)).expect(200);
    expect((await search()).body.items).toEqual([]);

    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const items = (await search()).body.items as DocumentListItemDto[];
    expect(items.map((item) => item.code)).toEqual([draft.code]);
    expect(items[0]).toMatchObject({ status: 'PUBLISHED', revisionNo: 0 });
    await request(app.getHttpServer()).get(`/api/documents/${draft.id}/download`).set(auth(users.reader.token)).expect(200);
  });

  it('shows the readers the revision as the one in force in the history', async () => {
    const draft = await newDraft();
    await publish(users.qm.token, draft.revisions[0].id).expect(200);

    const history = (await request(app.getHttpServer()).get(`/api/documents/${draft.id}/revisions`).set(auth(users.reader.token)).expect(200)).body as RevisionHistoryItemDto[];

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'APPROVED', isCurrent: true, approvedBy: { id: users.qm.id }, canEdit: false, canPublish: false });
  });
});

describe('the canPublish flags', () => {
  it('are true for the open draft of a publisher and false for everybody else', async () => {
    const draft = await newDraft();
    const detail = async (who: Label) =>
      (await request(app.getHttpServer()).get(`/api/documents/${draft.id}`).set(auth(users[who].token)).expect(200)).body as DocumentDetailDto;
    const history = async (who: Label) =>
      (await request(app.getHttpServer()).get(`/api/documents/${draft.id}/revisions`).set(auth(users[who].token)).expect(200)).body as RevisionHistoryItemDto[];

    for (const who of ['qm', 'admin'] as const) {
      expect((await detail(who)).canPublish).toBe(true);
      expect((await history(who))[0].canPublish).toBe(true);
    }
    for (const who of ['editorA', 'approverA'] as const) {
      expect((await detail(who)).canPublish).toBe(false);
      expect((await history(who))[0].canPublish).toBe(false);
    }
  });

  it('are false once the revision is published or locked', async () => {
    const doc = await publishedWithDraft();
    const rows = (await request(app.getHttpServer()).get(`/api/documents/${doc.id}/revisions`).set(auth(users.qm.token)).expect(200)).body as RevisionHistoryItemDto[];

    expect(rows.map((row) => [row.revisionNo, row.canPublish])).toEqual([[2, true], [1, false], [0, false]]);
  });
});
