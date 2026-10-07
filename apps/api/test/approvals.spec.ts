process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { ApprovalStepDto, DocumentDetailDto, DocumentListItemDto, PaginatedDto, PendingApprovalDto } from '@iso-dms/shared';
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
const ONLYOFFICE_SECRET = process.env.ONLYOFFICE_JWT_SECRET!;

let app: INestApplication;
let storage: StorageService;
let jwt: JwtService;
let blankDocx: Buffer;
let commandServer: FakeCommandServer;
let foreignStepId: string;
let foreignRevisionId: string;
let foreignRequestId: string;

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'qm2' | 'reader' | 'editorA' | 'editorB' | 'approverA' | 'approverA2' | 'approverB';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let codeCounter = 0;

interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
  preparedBy?: Label;
  changeSummary?: string;
}

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; published?: boolean; revisions: RevisionSpec[] }) {
  const sequenceNo = 300 + codeCounter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: users.editorA.id,
      code: `MM-AA-${sequenceNo}`,
      sequenceNo,
      title: 'Onay denemesi',
      fileType: 'DOCX',
      status: options.status ?? 'DRAFT',
      firstPublishedAt: options.published ? new Date('2025-01-10T09:00:00Z') : undefined,
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
        changeSummary: spec.changeSummary,
        preparedById: users[spec.preparedBy ?? 'editorA'].id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo, storageKey });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

/** A document that was never published: its revision 0 is a draft. */
const newDraft = (options: { departmentId?: string; preparedBy?: Label } = {}) =>
  createDocument({ departmentId: options.departmentId, revisions: [{ revisionNo: 0, status: 'DRAFT', preparedBy: options.preparedBy }] });

/** A published document with a revision 1 draft waiting. */
const publishedWithDraft = (options: { preparedBy?: Label } = {}) =>
  createDocument({
    status: 'PUBLISHED',
    published: true,
    revisions: [
      { revisionNo: 0, status: 'APPROVED', current: true },
      { revisionNo: 1, status: 'DRAFT', preparedBy: options.preparedBy, changeSummary: 'Madde 3 güncellendi' },
    ],
  });

const submit = (token: string, revisionId: string) => request(app.getHttpServer()).post(`/api/revisions/${revisionId}/submit`).set(auth(token));
const approve = (token: string, stepId: string, body: Record<string, unknown> = {}) =>
  request(app.getHttpServer()).post(`/api/approvals/${stepId}/approve`).set(auth(token)).send(body);
const reject = (token: string, stepId: string, body: Record<string, unknown> = { comment: 'Madde 2 eksik' }) =>
  request(app.getHttpServer()).post(`/api/approvals/${stepId}/reject`).set(auth(token)).send(body);
const cancelRequest = (token: string, requestId: string) => request(app.getHttpServer()).post(`/api/approval-requests/${requestId}/cancel`).set(auth(token));
const pending = (token: string, query: Record<string, number> = {}) =>
  request(app.getHttpServer()).get('/api/approvals/pending').query(query).set(auth(token));
const detail = async (token: string, documentId: string) =>
  (await request(app.getHttpServer()).get(`/api/documents/${documentId}`).set(auth(token)).expect(200)).body as DocumentDetailDto;

const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const requestsOf = (revisionId: string) => prisma.documentRequest.findMany({ where: { revisionId }, include: { steps: { orderBy: { stepOrder: 'asc' } } }, orderBy: { createdAt: 'asc' } });
const auditEntries = (entityIds: string[]) => prisma.auditLog.findMany({ where: { entityId: { in: entityIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const auditActions = async (entityIds: string[]) => (await auditEntries(entityIds)).map((entry) => entry.action);

/** Sends a draft to review as the person who prepared it, and returns the steps. */
async function submitted(draft: { id: string; revisionNo?: number }, token = users.editorA.token) {
  const body = (await submit(token, draft.id).expect(200)).body as DocumentDetailDto;
  return body.approval!.steps as ApprovalStepDto[];
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  commandServer = await startFakeCommandServer(ONLYOFFICE_SECRET);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;

  app = await createTestApp();
  storage = app.get(StorageService);
  jwt = app.get(JwtService);

  const organization = await prisma.organization.create({ data: { name: `Approvals ${suffix}`, slug: `approvals-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `approvals-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@approvals.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('qm2', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('approverA', 'APPROVER', org.deptA);
  await makeUser('approverA2', 'APPROVER', org.deptA);
  await makeUser('approverB', 'APPROVER', org.deptB);

  // A request of another organization, with its first step waiting
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@approvals.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'IN_REVIEW' },
  });
  const foreignRevision = await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'IN_REVIEW', storageKey: 'foreign/none', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
  });
  const foreignRequest = await prisma.documentRequest.create({
    data: {
      organizationId: foreign.id,
      type: 'NEW',
      documentId: foreignDoc.id,
      revisionId: foreignRevision.id,
      requestedById: foreignUser.id,
      reason: '',
      steps: { create: [{ organizationId: foreign.id, stepOrder: 1, approverRole: 'APPROVER' }, { organizationId: foreign.id, stepOrder: 2, approverRole: 'QUALITY_MANAGER' }] },
    },
    include: { steps: true },
  });
  foreignRevisionId = foreignRevision.id;
  foreignRequestId = foreignRequest.id;
  foreignStepId = foreignRequest.steps.find((step) => step.stepOrder === 1)!.id;
});

beforeEach(() => {
  commandServer.reset();
});

afterAll(async () => {
  // Test cleanup only: the application never deletes any of this
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
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

describe('sending a draft to review', () => {
  describe('who may', () => {
    it('requires authentication and a valid id', async () => {
      const draft = await newDraft();
      await request(app.getHttpServer()).post(`/api/revisions/${draft.revisions[0].id}/submit`).expect(401);
      await submit(users.editorA.token, 'not-a-uuid').expect(400);
      expect((await submit(users.editorA.token, randomUUID()).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    });

    it('refuses readers with 403', async () => {
      const draft = await newDraft();
      expect((await submit(users.reader.token, draft.revisions[0].id).expect(403)).body.code).toBe('FORBIDDEN');
      expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
    });

    it('does not reveal drafts of other departments to editors, nor revisions of other organizations', async () => {
      const draft = await newDraft();
      expect((await submit(users.editorB.token, draft.revisions[0].id).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
      await submit(users.admin.token, foreignRevisionId).expect(404);
    });

    it('refuses an approver of another department, who can see the draft but may not touch it', async () => {
      const draft = await newDraft();
      const response = await submit(users.approverB.token, draft.revisions[0].id).expect(403);
      expect(response.body.code).toBe('SUBMIT_NOT_ALLOWED');
      expect((await revisionRow(draft.revisions[0].id)).status).toBe('DRAFT');
    });

    it.each(['editorA', 'approverA', 'qm', 'admin'] as const)('lets %s send a draft of department A', async (who) => {
      const draft = await newDraft();
      await submit(users[who].token, draft.revisions[0].id).expect(200);
      expect((await revisionRow(draft.revisions[0].id)).status).toBe('IN_REVIEW');
    });
  });

  describe('a document that was never published', () => {
    it('locks the draft, puts the document in review and opens a request with both steps', async () => {
      const draft = await newDraft();

      const response = await submit(users.editorA.token, draft.revisions[0].id).expect(200);

      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'IN_REVIEW' });
      expect(await documentRow(draft.id)).toMatchObject({ status: 'IN_REVIEW', currentRevisionId: null });
      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_).toMatchObject({ type: 'NEW', status: 'PENDING', requestedById: users.editorA.id, documentId: draft.id, resolvedAt: null });
      expect(request_.steps.map((step) => [step.stepOrder, step.approverRole, step.decision, step.approverId])).toEqual([
        [1, 'APPROVER', 'PENDING', null],
        [2, 'QUALITY_MANAGER', 'PENDING', null],
      ]);

      expect(response.body).toMatchObject({
        status: 'IN_REVIEW',
        canEdit: false,
        canSubmit: false,
        canCancelRevision: false,
        approval: {
          id: request_.id,
          type: 'NEW',
          status: 'PENDING',
          revision: { id: draft.revisions[0].id, revisionNo: 0 },
          requestedBy: { id: users.editorA.id },
          canCancel: true,
          steps: [
            { stepOrder: 1, approverRole: 'APPROVER', decision: 'PENDING', approver: null, canDecide: false },
            { stepOrder: 2, approverRole: 'QUALITY_MANAGER', decision: 'PENDING', approver: null, canDecide: false },
          ],
        },
      });
    });

    it('writes one audit entry that names the request', async () => {
      const draft = await newDraft();
      await submit(users.editorA.token, draft.revisions[0].id).expect(200);
      const [request_] = await requestsOf(draft.revisions[0].id);

      const entries = await prisma.auditLog.findMany({ where: { entityId: draft.revisions[0].id, action: 'REVISION_SUBMITTED' } });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ userId: users.editorA.id, entityType: 'Revision', organizationId: org.id });
      expect(entries[0].metadata).toMatchObject({ documentId: draft.id, code: draft.code, revisionNo: 0, requestId: request_.id, type: 'NEW' });
    });

    it('keeps the file as it is', async () => {
      const draft = await newDraft();
      const before = await revisionRow(draft.revisions[0].id);

      await submit(users.editorA.token, draft.revisions[0].id).expect(200);

      const after = await revisionRow(draft.revisions[0].id);
      expect(after).toMatchObject({ storageKey: before.storageKey, checksum: before.checksum, fileSize: before.fileSize, editorKey: before.editorKey });
    });
  });

  describe('a revision of a document in force', () => {
    it('leaves the document published and opens a request of the type REVISION with the summary as its reason', async () => {
      const doc = await publishedWithDraft();

      const response = await submit(users.editorA.token, doc.revisions[1].id).expect(200);

      expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', currentRevisionId: doc.revisions[0].id });
      expect(await revisionRow(doc.revisions[0].id)).toMatchObject({ status: 'APPROVED' });
      expect(await revisionRow(doc.revisions[1].id)).toMatchObject({ status: 'IN_REVIEW' });
      const [request_] = await requestsOf(doc.revisions[1].id);
      expect(request_).toMatchObject({ type: 'REVISION', reason: 'Madde 3 güncellendi' });
      expect(response.body).toMatchObject({ status: 'PUBLISHED', approval: { type: 'REVISION', revision: { revisionNo: 1 } }, canStartRevision: false });
    });

    it('shows the review to those who open the document, while readers keep the revision in force', async () => {
      const doc = await publishedWithDraft();
      await submit(users.editorA.token, doc.revisions[1].id).expect(200);

      const asApprover = await detail(users.approverA.token, doc.id);
      expect(asApprover).toMatchObject({ approval: { status: 'PENDING', revision: { revisionNo: 1 } }, openRevision: { id: doc.revisions[0].id } });

      const asReader = await detail(users.reader.token, doc.id);
      expect(asReader).toMatchObject({ approval: null, openRevision: { id: doc.revisions[0].id }, currentRevisionId: doc.revisions[0].id });
    });
  });

  describe('when it cannot be sent', () => {
    it.each([
      ['a revision that is already in review', async () => (await createDocument({ status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] })).revisions[0].id],
      ['a revision in force', async () => (await createDocument({ status: 'PUBLISHED', published: true, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] })).revisions[0].id],
      ['a superseded revision', async () => (await createDocument({ status: 'PUBLISHED', published: true, revisions: [{ revisionNo: 0, status: 'SUPERSEDED' }, { revisionNo: 1, status: 'APPROVED', current: true }] })).revisions[0].id],
      ['a rejected revision', async () => (await createDocument({ status: 'PUBLISHED', published: true, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'REJECTED' }] })).revisions[1].id],
      ['a draft of a withdrawn document', async () => (await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'DRAFT' }] })).revisions[0].id],
    ])('refuses %s', async (_label, makeRevisionId) => {
      const revisionId = await makeRevisionId();
      const before = await revisionRow(revisionId);

      const response = await submit(users.qm.token, revisionId).expect(409);

      expect(response.body.code).toBe('REVISION_NOT_SUBMITTABLE');
      expect(await revisionRow(revisionId)).toEqual(before);
      expect(await requestsOf(revisionId)).toEqual([]);
    });

    it('refuses sending the same draft twice, and does not open a second request', async () => {
      const draft = await newDraft();
      await submit(users.editorA.token, draft.revisions[0].id).expect(200);

      expect((await submit(users.editorA.token, draft.revisions[0].id).expect(409)).body.code).toBe('REVISION_NOT_SUBMITTABLE');
      expect(await requestsOf(draft.revisions[0].id)).toHaveLength(1);
    });

    it('lets exactly one of two simultaneous submissions win', async () => {
      const draft = await newDraft();

      const [first, second] = await Promise.all([submit(users.editorA.token, draft.revisions[0].id), submit(users.admin.token, draft.revisions[0].id)]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect(await requestsOf(draft.revisions[0].id)).toHaveLength(1);
      expect((await auditActions([draft.revisions[0].id])).filter((action) => action === 'REVISION_SUBMITTED')).toHaveLength(1);
    });
  });

  describe('while somebody edits it', () => {
    it('refuses while somebody is connected, and changes nothing', async () => {
      const draft = await newDraft();
      commandServer.state.info = { error: 0, users: [users.editorA.id] };

      const response = await submit(users.editorA.token, draft.revisions[0].id).expect(409);

      expect(response.body.code).toBe('EDITOR_SESSION_ACTIVE');
      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'DRAFT' });
      expect(await requestsOf(draft.revisions[0].id)).toEqual([]);
    });

    it('refuses while the last changes are still on their way (the closing save has not arrived)', async () => {
      const draft = await newDraft();
      await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: new Date() } });
      commandServer.state.info = { error: 0, users: [] };

      expect((await submit(users.editorA.token, draft.revisions[0].id).expect(409)).body.code).toBe('EDITOR_SESSION_ACTIVE');
    });

    it('refuses when a session was handed out between the first check and the lock', async () => {
      const draft = await newDraft();
      const { EditSessionGate } = await import('../src/modules/editor/edit-session-gate.service');
      jest.spyOn(app.get(EditSessionGate), 'assertIdle').mockImplementationOnce(async () => {
        await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: new Date() } });
      });

      expect((await submit(users.editorA.token, draft.revisions[0].id).expect(409)).body.code).toBe('EDITOR_SESSION_ACTIVE');
      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'DRAFT' });
    });

    it('lets the author try again: the same request succeeds once the editor is closed', async () => {
      const draft = await newDraft();
      await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: new Date() } });
      await submit(users.editorA.token, draft.revisions[0].id).expect(409);

      await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: null } });
      await submit(users.editorA.token, draft.revisions[0].id).expect(200);
    });

    it.each([
      ['cannot be reached', () => { commandServer.state.down = true; }],
      ['answers with an HTTP error', () => { commandServer.state.httpStatus = 502; }],
    ])('refuses with 503 when the editor server %s, because the answer cannot be trusted', async (_label, breakIt) => {
      const draft = await newDraft();
      breakIt();

      expect((await submit(users.editorA.token, draft.revisions[0].id).expect(503)).body.code).toBe('EDITOR_SERVER_UNAVAILABLE');
      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'DRAFT' });
    });
  });

  describe('afterwards', () => {
    it('turns the editor read only, and refuses a late save of the editor', async () => {
      const draft = await newDraft();
      const config = () => request(app.getHttpServer()).get(`/api/editor/config/${draft.revisions[0].id}`).set(auth(users.editorA.token));
      const session = (await config().expect(200)).body;
      const callbackUrl = new URL(session.config.editorConfig.callbackUrl as string);
      // the editor is closed before the draft is sent
      await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: null } });
      await submit(users.editorA.token, draft.revisions[0].id).expect(200);
      const locked = await revisionRow(draft.revisions[0].id);

      const after = (await config().expect(200)).body;
      expect(after.mode).toBe('view');
      expect(after.config.editorConfig).not.toHaveProperty('callbackUrl');

      const data = { key: locked.editorKey, status: 2, url: 'http://127.0.0.1:1/never-fetched.docx' };
      const response = await request(app.getHttpServer())
        .post(`${callbackUrl.pathname}${callbackUrl.search}`)
        .set('Authorization', `Bearer ${jwt.sign({ payload: data }, { secret: ONLYOFFICE_SECRET })}`)
        .send(data)
        .expect(200);
      expect(response.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ checksum: locked.checksum, storageKey: locked.storageKey });
    });

    it('shows the document in review to its department, not to readers', async () => {
      const draft = await newDraft();
      await submit(users.editorA.token, draft.revisions[0].id).expect(200);
      const search = (token: string) =>
        request(app.getHttpServer()).get('/api/documents').query({ search: draft.code }).set(auth(token)).expect(200).then((res) => res.body.items as DocumentListItemDto[]);

      expect(await search(users.editorA.token)).toMatchObject([{ code: draft.code, status: 'IN_REVIEW', canEdit: false }]);
      expect(await search(users.reader.token)).toEqual([]);
    });
  });
});

describe('deciding a step', () => {
  describe('who may', () => {
    it('requires authentication and valid ids', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await request(app.getHttpServer()).post(`/api/approvals/${first.id}/approve`).send({}).expect(401);
      await approve(users.approverA.token, 'not-a-uuid').expect(400);
      expect((await approve(users.approverA.token, randomUUID()).expect(404)).body.code).toBe('APPROVAL_STEP_NOT_FOUND');
      expect((await reject(users.approverA.token, randomUUID()).expect(404)).body.code).toBe('APPROVAL_STEP_NOT_FOUND');
    });

    it('does not reveal steps of another organization', async () => {
      expect((await approve(users.admin.token, foreignStepId).expect(404)).body.code).toBe('APPROVAL_STEP_NOT_FOUND');
    });

    it.each(['reader', 'editorA', 'editorB'] as const)('refuses %s with 403 (these roles decide nothing)', async (who) => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      expect((await approve(users[who].token, first.id).expect(403)).body.code).toBe('FORBIDDEN');
      expect((await reject(users[who].token, first.id).expect(403)).body.code).toBe('FORBIDDEN');
    });

    it('gives the first step to the approvers of the department and to the administrator', async () => {
      for (const who of ['approverA', 'approverA2', 'admin'] as const) {
        const draft = await newDraft();
        const [first] = await submitted({ id: draft.revisions[0].id });
        await approve(users[who].token, first.id).expect(200);
      }
    });

    it.each([
      ['an approver of another department', 'approverB'],
      ['a quality manager (step 1 is the department\'s)', 'qm'],
    ] as const)('refuses %s on the first step', async (_label, who) => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const response = await approve(users[who].token, first.id).expect(403);

      expect(response.body.code).toBe('APPROVAL_NOT_ALLOWED');
      expect((await requestsOf(draft.revisions[0].id))[0].steps[0].decision).toBe('PENDING');
    });

    it('gives the second step to quality managers and to the administrator, not to approvers', async () => {
      for (const who of ['qm', 'qm2', 'admin'] as const) {
        const draft = await newDraft();
        const [first, second] = await submitted({ id: draft.revisions[0].id });
        await approve(users.approverA.token, first.id).expect(200);
        await approve(users[who].token, second.id).expect(200);
        expect(await documentRow(draft.id)).toMatchObject({ status: 'PUBLISHED' });
      }

      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);
      expect((await approve(users.approverA.token, second.id).expect(403)).body.code).toBe('APPROVAL_NOT_ALLOWED');
      expect((await approve(users.approverB.token, second.id).expect(403)).body.code).toBe('APPROVAL_NOT_ALLOWED');
    });

    it.each([
      ['an approver', 'approverA', async (preparedBy: Label) => (await newDraft({ preparedBy })).revisions[0].id, 1],
      ['the administrator', 'admin', async (preparedBy: Label) => (await newDraft({ preparedBy })).revisions[0].id, 1],
    ] as const)('refuses %s on the revision they prepared, whatever their role', async (_label, who, makeRevisionId, stepOrder) => {
      const revisionId = await makeRevisionId(who);
      const steps = await submitted({ id: revisionId }, users[who].token);

      const response = await approve(users[who].token, steps[stepOrder - 1].id).expect(403);

      expect(response.body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      expect((await reject(users[who].token, steps[stepOrder - 1].id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      expect((await requestsOf(revisionId))[0].steps[0].decision).toBe('PENDING');
    });

    it('also refuses the quality manager who prepared the revision, on the second step', async () => {
      const draft = await newDraft({ preparedBy: 'qm' });
      const [first, second] = await submitted({ id: draft.revisions[0].id }, users.qm.token);
      await approve(users.approverA.token, first.id).expect(200);

      expect((await approve(users.qm.token, second.id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      // somebody else can
      await approve(users.qm2.token, second.id).expect(200);
    });
  });

  describe('the order of the steps', () => {
    it('does not accept the second step before the first is approved', async () => {
      const draft = await newDraft();
      const [, second] = await submitted({ id: draft.revisions[0].id });

      const response = await approve(users.qm.token, second.id).expect(409);

      expect(response.body.code).toBe('APPROVAL_STEP_NOT_ACTIVE');
      expect((await reject(users.qm.token, second.id).expect(409)).body.code).toBe('APPROVAL_STEP_NOT_ACTIVE');
      expect((await requestsOf(draft.revisions[0].id))[0]).toMatchObject({ status: 'PENDING' });
    });
  });

  describe('approving', () => {
    it('records who decided and what they said, and waits for the next step', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const response = await approve(users.approverA.token, first.id, { comment: '  Uygundur  ' }).expect(200);

      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_.status).toBe('PENDING');
      expect(request_.steps[0]).toMatchObject({ decision: 'APPROVED', approverId: users.approverA.id, comment: 'Uygundur' });
      expect(request_.steps[0].decidedAt).toBeInstanceOf(Date);
      expect(request_.steps[1]).toMatchObject({ decision: 'PENDING', approverId: null });
      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'IN_REVIEW', approvedById: null, publishedAt: null });
      expect(await documentRow(draft.id)).toMatchObject({ status: 'IN_REVIEW' });
      expect(response.body.approval.steps[0]).toMatchObject({ decision: 'APPROVED', approver: { id: users.approverA.id }, comment: 'Uygundur' });
    });

    it('needs no comment', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);
      expect((await requestsOf(draft.revisions[0].id))[0].steps[0].comment).toBeNull();
    });

    it('rejects a comment that is too long, and unknown fields', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id, { comment: 'x'.repeat(2001) }).expect(400);
      await approve(users.approverA.token, first.id, { decision: 'APPROVED' }).expect(400);
      expect((await requestsOf(draft.revisions[0].id))[0].steps[0].decision).toBe('PENDING');
    });

    it('hands the second step to the quality manager once the first is approved', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      expect((await detail(users.qm.token, draft.id)).approval!.steps.map((step) => step.canDecide)).toEqual([false, false]);

      await approve(users.approverA.token, first.id).expect(200);

      expect((await detail(users.qm.token, draft.id)).approval!.steps.map((step) => step.canDecide)).toEqual([false, true]);
      expect((await detail(users.approverA2.token, draft.id)).approval!.steps.map((step) => step.canDecide)).toEqual([false, false]);
      expect(second.id).toBeDefined();
    });

    it('audits every approval with its comment', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id, { comment: 'Uygundur' }).expect(200);

      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisions[0].id, action: 'APPROVAL_APPROVED' } });

      expect(entry).toMatchObject({ userId: users.approverA.id, entityType: 'Revision' });
      expect(entry.metadata).toMatchObject({ documentId: draft.id, revisionNo: 0, stepOrder: 1, comment: 'Uygundur', final: false });
    });
  });

  describe('the last approval', () => {
    it('publishes a new document: the revision is in force and the request is closed', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);

      const response = await approve(users.qm.token, second.id, { comment: 'Yayınlansın' }).expect(200);

      expect(response.body).toMatchObject({
        status: 'PUBLISHED',
        currentRevisionId: draft.revisions[0].id,
        revisionNo: 0,
        canEdit: false,
        canSubmit: false,
        // The revision is in force now: its approval is history, not something to act on
        approval: null,
      });
      const revision = await revisionRow(draft.revisions[0].id);
      expect(revision).toMatchObject({ status: 'APPROVED', approvedById: users.qm.id });
      expect(revision.approvedAt).toBeInstanceOf(Date);
      expect(revision.publishedAt!.getTime()).toBe(revision.approvedAt!.getTime());
      const document = await documentRow(draft.id);
      expect(document).toMatchObject({ status: 'PUBLISHED', currentRevisionId: draft.revisions[0].id, revisedAt: null });
      expect(document.firstPublishedAt!.getTime()).toBe(revision.publishedAt!.getTime());
      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_.status).toBe('APPROVED');
      expect(request_.resolvedAt).toBeInstanceOf(Date);
      expect(request_.steps.map((step) => step.decision)).toEqual(['APPROVED', 'APPROVED']);
    });

    it('audits the approvals and the publication', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);
      await approve(users.qm.token, second.id).expect(200);

      const actions = await auditActions([draft.id, draft.revisions[0].id]);

      // The last approval and the publication are written in one transaction: their order is not defined
      expect([...actions].sort()).toEqual(['APPROVAL_APPROVED', 'APPROVAL_APPROVED', 'DOCUMENT_PUBLISHED', 'REVISION_SUBMITTED']);
      const entries = await auditEntries([draft.id, draft.revisions[0].id]);
      const final = entries.find((entry) => entry.action === 'APPROVAL_APPROVED' && (entry.metadata as { final: boolean }).final);
      expect(final).toMatchObject({ userId: users.qm.id });
      expect(final!.metadata).toMatchObject({ stepOrder: 2, final: true });
      const published = entries.find((entry) => entry.action === 'DOCUMENT_PUBLISHED');
      expect(published).toMatchObject({ userId: users.qm.id, entityType: 'Document' });
      expect(published!.metadata).toMatchObject({ code: draft.code, revisionNo: 0, previousRevisionNo: null, firstPublication: true });
    });

    it('puts a revision in force and supersedes the one before, keeping the first publication date', async () => {
      const doc = await publishedWithDraft();
      const firstPublishedAt = (await documentRow(doc.id)).firstPublishedAt!;
      const [first, second] = await submitted({ id: doc.revisions[1].id });
      await approve(users.approverA.token, first.id).expect(200);

      const response = await approve(users.qm.token, second.id).expect(200);

      expect(response.body).toMatchObject({ status: 'PUBLISHED', currentRevisionId: doc.revisions[1].id, revisionNo: 1 });
      expect(await revisionRow(doc.revisions[0].id)).toMatchObject({ status: 'SUPERSEDED' });
      expect(await revisionRow(doc.revisions[1].id)).toMatchObject({ status: 'APPROVED', approvedById: users.qm.id, changeSummary: 'Madde 3 güncellendi' });
      const document = await documentRow(doc.id);
      expect(document.firstPublishedAt!.getTime()).toBe(firstPublishedAt.getTime());
      expect(document.revisedAt).toBeInstanceOf(Date);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: doc.id, action: 'DOCUMENT_PUBLISHED' } });
      expect(entry.metadata).toMatchObject({ revisionNo: 1, previousRevisionNo: 0, firstPublication: false });
    });

    it('lets readers see and download the document from then on', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);
      await approve(users.qm.token, second.id).expect(200);

      const items = (await request(app.getHttpServer()).get('/api/documents').query({ search: draft.code }).set(auth(users.reader.token)).expect(200)).body.items as DocumentListItemDto[];
      expect(items).toMatchObject([{ code: draft.code, status: 'PUBLISHED', revisionNo: 0 }]);
      await request(app.getHttpServer()).get(`/api/documents/${draft.id}/download`).set(auth(users.reader.token)).expect(200);
    });

    it('rolls everything back when the audit entry cannot be written', async () => {
      const doc = await publishedWithDraft();
      const [first, second] = await submitted({ id: doc.revisions[1].id });
      await approve(users.approverA.token, first.id).expect(200);
      const before = { document: await documentRow(doc.id), old: await revisionRow(doc.revisions[0].id), draft: await revisionRow(doc.revisions[1].id), request: (await requestsOf(doc.revisions[1].id))[0] };
      jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

      await approve(users.qm.token, second.id).expect(500);

      expect(await documentRow(doc.id)).toEqual(before.document);
      expect(await revisionRow(doc.revisions[0].id)).toEqual(before.old);
      expect(await revisionRow(doc.revisions[1].id)).toEqual(before.draft);
      expect((await requestsOf(doc.revisions[1].id))[0]).toEqual(before.request);
    });
  });

  describe('rejecting', () => {
    it.each([
      ['missing', {}],
      ['empty', { comment: '' }],
      ['only spaces', { comment: '    ' }],
    ])('needs a reason (%s)', async (_label, body) => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const response = await reject(users.approverA.token, first.id, body).expect(400);

      expect(response.body.code).toBe('COMMENT_REQUIRED');
      expect((await requestsOf(draft.revisions[0].id))[0].status).toBe('PENDING');
    });

    it('hands a new document back to its authors', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const response = await reject(users.approverA.token, first.id, { comment: '  Madde 2 eksik  ' }).expect(200);

      expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'DRAFT', approvedById: null, publishedAt: null });
      expect(await documentRow(draft.id)).toMatchObject({ status: 'DRAFT', currentRevisionId: null });
      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_.status).toBe('REJECTED');
      expect(request_.resolvedAt).toBeInstanceOf(Date);
      expect(request_.steps[0]).toMatchObject({ decision: 'REJECTED', approverId: users.approverA.id, comment: 'Madde 2 eksik' });
      expect(response.body).toMatchObject({
        status: 'DRAFT',
        canEdit: true,
        canSubmit: true,
        approval: { status: 'REJECTED', canCancel: false, steps: [{ decision: 'REJECTED', comment: 'Madde 2 eksik' }, { decision: 'PENDING' }] },
      });
    });

    it('leaves a published document published and puts only the revision back to draft', async () => {
      const doc = await publishedWithDraft();
      const [first] = await submitted({ id: doc.revisions[1].id });

      await reject(users.approverA.token, first.id).expect(200);

      expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', currentRevisionId: doc.revisions[0].id });
      expect(await revisionRow(doc.revisions[0].id)).toMatchObject({ status: 'APPROVED' });
      expect(await revisionRow(doc.revisions[1].id)).toMatchObject({ status: 'DRAFT' });
    });

    it('also works on the second step, after the first was approved', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);

      await reject(users.qm.token, second.id, { comment: 'Kalite gereklilikleri karşılanmıyor' }).expect(200);

      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_.status).toBe('REJECTED');
      expect(request_.steps.map((step) => step.decision)).toEqual(['APPROVED', 'REJECTED']);
      expect(await documentRow(draft.id)).toMatchObject({ status: 'DRAFT' });
    });

    it('audits the rejection with the reason', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await reject(users.approverA.token, first.id, { comment: 'Madde 2 eksik' }).expect(200);

      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisions[0].id, action: 'APPROVAL_REJECTED' } });

      expect(entry).toMatchObject({ userId: users.approverA.id });
      expect(entry.metadata).toMatchObject({ stepOrder: 1, comment: 'Madde 2 eksik', final: false });
    });

    it('lets the authors fix the draft and send it again, with a request of its own', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await reject(users.approverA.token, first.id).expect(200);
      const config = await request(app.getHttpServer()).get(`/api/editor/config/${draft.revisions[0].id}`).set(auth(users.editorA.token)).expect(200);
      expect(config.body.mode).toBe('edit');
      await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: null } });

      const second = await submitted({ id: draft.revisions[0].id });

      const requests = await requestsOf(draft.revisions[0].id);
      expect(requests.map((item) => item.status)).toEqual(['REJECTED', 'PENDING']);
      expect(second[0].id).not.toBe(first.id);
      expect((await detail(users.approverA.token, draft.id)).approval).toMatchObject({ id: requests[1].id, status: 'PENDING' });
    });

    it('does not accept the other step after a rejection', async () => {
      const draft = await newDraft();
      const [first, second] = await submitted({ id: draft.revisions[0].id });
      await reject(users.approverA.token, first.id).expect(200);

      expect((await approve(users.qm.token, second.id).expect(409)).body.code).toBe('APPROVAL_NOT_PENDING');
    });
  });

  describe('decisions that are no longer open', () => {
    it('refuses to decide a step twice', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      await approve(users.approverA.token, first.id).expect(200);

      expect((await approve(users.approverA2.token, first.id).expect(409)).body.code).toBe('STEP_ALREADY_DECIDED');
      expect((await reject(users.approverA2.token, first.id).expect(409)).body.code).toBe('STEP_ALREADY_DECIDED');
    });

    it('refuses a decision on a request that was taken back', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });
      const [request_] = await requestsOf(draft.revisions[0].id);
      await cancelRequest(users.editorA.token, request_.id).expect(200);

      expect((await approve(users.approverA.token, first.id).expect(409)).body.code).toBe('APPROVAL_NOT_PENDING');
    });

    it('lets exactly one of two simultaneous decisions on the same step win', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const [one, two] = await Promise.all([approve(users.approverA.token, first.id), approve(users.approverA2.token, first.id)]);

      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect((await auditActions([draft.revisions[0].id])).filter((action) => action === 'APPROVAL_APPROVED')).toHaveLength(1);
    });

    it('lets exactly one of an approval and a rejection of the same step win', async () => {
      const draft = await newDraft();
      const [first] = await submitted({ id: draft.revisions[0].id });

      const [one, two] = await Promise.all([approve(users.approverA.token, first.id), reject(users.approverA2.token, first.id)]);

      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const [request_] = await requestsOf(draft.revisions[0].id);
      expect(request_.steps[0].decision).not.toBe('PENDING');
    });
  });
});

describe('the list of steps waiting for me', () => {
  const stepIds = async (token: string, query: Record<string, number> = {}) =>
    ((await pending(token, { pageSize: 100, ...query }).expect(200)).body as PaginatedDto<PendingApprovalDto>).items.map((item) => item.stepId);

  it('requires authentication and the right role', async () => {
    await request(app.getHttpServer()).get('/api/approvals/pending').expect(401);
    for (const who of ['reader', 'editorA'] as const) expect((await pending(users[who].token).expect(403)).body.code).toBe('FORBIDDEN');
    await pending(users.approverA.token, { page: 0 }).expect(400);
    await pending(users.approverA.token, { pageSize: 101 }).expect(400);
  });

  it('shows the first step to the approvers of the department and to the administrator, and to nobody else', async () => {
    const draft = await newDraft();
    const [first] = await submitted({ id: draft.revisions[0].id });

    for (const who of ['approverA', 'approverA2', 'admin'] as const) expect(await stepIds(users[who].token)).toContain(first.id);
    for (const who of ['approverB', 'qm', 'qm2'] as const) expect(await stepIds(users[who].token)).not.toContain(first.id);
  });

  it('shows the second step only once the first is approved, and then to quality managers and the administrator', async () => {
    const draft = await newDraft();
    const [first, second] = await submitted({ id: draft.revisions[0].id });
    for (const who of ['qm', 'admin'] as const) expect(await stepIds(users[who].token)).not.toContain(second.id);

    await approve(users.approverA.token, first.id).expect(200);

    for (const who of ['qm', 'qm2', 'admin'] as const) expect(await stepIds(users[who].token)).toContain(second.id);
    for (const who of ['approverA', 'approverA2', 'approverB'] as const) expect(await stepIds(users[who].token)).not.toContain(second.id);
    // and the first step is no longer anybody's
    expect(await stepIds(users.approverA2.token)).not.toContain(first.id);
  });

  it('does not show the steps of a revision to whoever prepared it', async () => {
    const draft = await newDraft({ preparedBy: 'approverA' });
    const [first] = await submitted({ id: draft.revisions[0].id }, users.approverA.token);

    expect(await stepIds(users.approverA.token)).not.toContain(first.id);
    expect(await stepIds(users.approverA2.token)).toContain(first.id);
  });

  it('drops a step when its request is rejected or taken back', async () => {
    const rejected = await newDraft();
    const [rejectedFirst] = await submitted({ id: rejected.revisions[0].id });
    const taken = await newDraft();
    const [takenFirst] = await submitted({ id: taken.revisions[0].id });
    expect(await stepIds(users.approverA.token)).toEqual(expect.arrayContaining([rejectedFirst.id, takenFirst.id]));

    await reject(users.approverA.token, rejectedFirst.id).expect(200);
    await cancelRequest(users.editorA.token, (await requestsOf(taken.revisions[0].id))[0].id).expect(200);

    const ids = await stepIds(users.approverA.token);
    expect(ids).not.toContain(rejectedFirst.id);
    expect(ids).not.toContain(takenFirst.id);
  });

  it('never shows the steps of another organization', async () => {
    for (const who of ['admin', 'qm', 'approverA'] as const) expect(await stepIds(users[who].token)).not.toContain(foreignStepId);
  });

  it('describes the document, the revision and who asked', async () => {
    const doc = await publishedWithDraft();
    const [first] = await submitted({ id: doc.revisions[1].id });

    const items = ((await pending(users.approverA.token, { pageSize: 100 }).expect(200)).body as PaginatedDto<PendingApprovalDto>).items;
    const item = items.find((candidate) => candidate.stepId === first.id)!;

    expect(item).toMatchObject({
      stepOrder: 1,
      approverRole: 'APPROVER',
      request: { type: 'REVISION', requestedBy: { id: users.editorA.id, fullName: 'Name editorA' } },
      document: { id: doc.id, code: doc.code, title: 'Onay denemesi', department: { code: 'AA' } },
      revision: { id: doc.revisions[1].id, revisionNo: 1, changeSummary: 'Madde 3 güncellendi' },
    });
    expect(item.request.createdAt).toEqual(expect.any(String));
  });

  it('lists the oldest request first and pages through the list', async () => {
    const drafts = [await newDraft(), await newDraft(), await newDraft()];
    const firsts: string[] = [];
    for (const draft of drafts) firsts.push((await submitted({ id: draft.revisions[0].id }))[0].id);

    const everything = ((await pending(users.approverA2.token, { pageSize: 100 }).expect(200)).body as PaginatedDto<PendingApprovalDto>);
    const mine = everything.items.map((item) => item.stepId).filter((id) => firsts.includes(id));
    expect(mine).toEqual(firsts);

    const secondPage = ((await pending(users.approverA2.token, { page: 2, pageSize: 2 }).expect(200)).body as PaginatedDto<PendingApprovalDto>);
    expect(secondPage).toMatchObject({ total: everything.total, page: 2, pageSize: 2 });
    expect(secondPage.items.map((item) => item.stepId)).toEqual(everything.items.slice(2, 4).map((item) => item.stepId));
  });
});

describe('taking a request back', () => {
  it('requires authentication, a valid id and a role that writes', async () => {
    const draft = await newDraft();
    await submitted({ id: draft.revisions[0].id });
    const [request_] = await requestsOf(draft.revisions[0].id);
    await request(app.getHttpServer()).post(`/api/approval-requests/${request_.id}/cancel`).expect(401);
    await cancelRequest(users.editorA.token, 'not-a-uuid').expect(400);
    expect((await cancelRequest(users.editorA.token, randomUUID()).expect(404)).body.code).toBe('REQUEST_NOT_FOUND');
    expect((await cancelRequest(users.reader.token, request_.id).expect(403)).body.code).toBe('FORBIDDEN');
    expect((await cancelRequest(users.admin.token, foreignRequestId).expect(404)).body.code).toBe('REQUEST_NOT_FOUND');
  });

  it('gives a new document back to its authors', async () => {
    const draft = await newDraft();
    await submitted({ id: draft.revisions[0].id });
    const [request_] = await requestsOf(draft.revisions[0].id);

    const response = await cancelRequest(users.editorA.token, request_.id).expect(200);

    expect(await revisionRow(draft.revisions[0].id)).toMatchObject({ status: 'DRAFT' });
    expect(await documentRow(draft.id)).toMatchObject({ status: 'DRAFT' });
    const [after] = await requestsOf(draft.revisions[0].id);
    expect(after.status).toBe('CANCELLED');
    expect(after.resolvedAt).toBeInstanceOf(Date);
    expect(response.body).toMatchObject({ status: 'DRAFT', canEdit: true, canSubmit: true, approval: { status: 'CANCELLED', canCancel: false } });
    const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisions[0].id, action: 'REQUEST_CANCELLED' } });
    expect(entry).toMatchObject({ userId: users.editorA.id });
    expect(entry.metadata).toMatchObject({ requestId: request_.id, revisionNo: 0 });
  });

  it('leaves a published document published', async () => {
    const doc = await publishedWithDraft();
    await submitted({ id: doc.revisions[1].id });
    const [request_] = await requestsOf(doc.revisions[1].id);

    await cancelRequest(users.editorA.token, request_.id).expect(200);

    expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', currentRevisionId: doc.revisions[0].id });
    expect(await revisionRow(doc.revisions[1].id)).toMatchObject({ status: 'DRAFT' });
  });

  it.each([
    ['whoever sent it', 'editorA', true],
    ['the administrator', 'admin', true],
    ['another editor of the department', 'editorB', false],
    ['an approver', 'approverA', false],
    ['a quality manager', 'qm', false],
  ] as const)('is allowed to %s: %s', async (_label, who, allowed) => {
    const draft = await newDraft();
    await submitted({ id: draft.revisions[0].id });
    const [request_] = await requestsOf(draft.revisions[0].id);

    const response = await cancelRequest(users[who].token, request_.id);

    if (allowed) expect(response.status).toBe(200);
    else {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CANCEL_NOT_ALLOWED');
      expect((await requestsOf(draft.revisions[0].id))[0].status).toBe('PENDING');
    }
  });

  it('is refused once somebody decided, and for requests that are closed', async () => {
    const draft = await newDraft();
    const [first] = await submitted({ id: draft.revisions[0].id });
    const [request_] = await requestsOf(draft.revisions[0].id);
    await approve(users.approverA.token, first.id).expect(200);

    expect((await cancelRequest(users.editorA.token, request_.id).expect(409)).body.code).toBe('REQUEST_NOT_CANCELLABLE');
    expect((await detail(users.editorA.token, draft.id)).approval).toMatchObject({ canCancel: false });

    const other = await newDraft();
    await submitted({ id: other.revisions[0].id });
    const [otherRequest] = await requestsOf(other.revisions[0].id);
    await cancelRequest(users.editorA.token, otherRequest.id).expect(200);
    expect((await cancelRequest(users.editorA.token, otherRequest.id).expect(409)).body.code).toBe('REQUEST_NOT_CANCELLABLE');
  });

  it('lets the draft be sent again', async () => {
    const draft = await newDraft();
    await submitted({ id: draft.revisions[0].id });
    await cancelRequest(users.editorA.token, (await requestsOf(draft.revisions[0].id))[0].id).expect(200);
    await prisma.revision.update({ where: { id: draft.revisions[0].id }, data: { editSessionStartedAt: null } });

    await submitted({ id: draft.revisions[0].id });

    expect((await requestsOf(draft.revisions[0].id)).map((item) => item.status)).toEqual(['CANCELLED', 'PENDING']);
  });
});

describe('what the document page is told', () => {
  it('tells who may send the open draft to review, and who may give up a started revision', async () => {
    const newDoc = await newDraft();
    const revision = await publishedWithDraft();

    for (const who of ['editorA', 'approverA', 'qm', 'admin'] as const) {
      expect(await detail(users[who].token, newDoc.id)).toMatchObject({ canSubmit: true, canCancelRevision: false });
      expect(await detail(users[who].token, revision.id)).toMatchObject({ canSubmit: true, canCancelRevision: true });
    }
    for (const who of ['approverB'] as const) {
      expect(await detail(users[who].token, newDoc.id)).toMatchObject({ canSubmit: false, canCancelRevision: false });
      expect(await detail(users[who].token, revision.id)).toMatchObject({ canSubmit: false, canCancelRevision: false });
    }
    expect(await detail(users.reader.token, revision.id)).toMatchObject({ canSubmit: false, canCancelRevision: false, approval: null });
  });

  it('shows nothing to approve on a draft that was never sent', async () => {
    const doc = await newDraft();
    expect((await detail(users.approverA.token, doc.id)).approval).toBeNull();
  });

  it('tells each user whether they may take the request back or decide a step', async () => {
    const draft = await newDraft();
    await submitted({ id: draft.revisions[0].id });

    const asAuthor = await detail(users.editorA.token, draft.id);
    const asApprover = await detail(users.approverA.token, draft.id);

    expect(asAuthor.approval).toMatchObject({ canCancel: true, steps: [{ canDecide: false }, { canDecide: false }] });
    expect(asApprover.approval).toMatchObject({ canCancel: false, steps: [{ canDecide: true }, { canDecide: false }] });
  });
});
