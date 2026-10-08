process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type {
  ApprovalStepDto,
  DocumentDetailDto,
  DocumentListItemDto,
  PaginatedDto,
  PendingApprovalDto,
  RevisionHistoryItemDto,
} from '@iso-dms/shared';
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
let foreignDocumentId: string;

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
}

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; revisions: RevisionSpec[] }) {
  const sequenceNo = 500 + codeCounter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: users.editorA.id,
      code: `MM-AA-${sequenceNo}`,
      sequenceNo,
      title: 'Kaldırma denemesi',
      fileType: 'DOCX',
      status: options.status ?? 'PUBLISHED',
      firstPublishedAt: options.status === 'DRAFT' || options.status === 'IN_REVIEW' ? undefined : new Date('2025-01-10T09:00:00Z'),
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
        preparedById: users[spec.preparedBy ?? 'editorA'].id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo, storageKey });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

/** A document in force: the starting point of a withdrawal. */
const published = (options: { departmentId?: string; preparedBy?: Label } = {}) =>
  createDocument({ departmentId: options.departmentId, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, preparedBy: options.preparedBy }] });

const ask = (token: string, documentId: string, body: Record<string, unknown> = { reason: 'Süreç artık kullanılmıyor' }) =>
  request(app.getHttpServer()).post(`/api/documents/${documentId}/withdrawal-requests`).set(auth(token)).send(body);
const approve = (token: string, stepId: string, body: Record<string, unknown> = {}) =>
  request(app.getHttpServer()).post(`/api/approvals/${stepId}/approve`).set(auth(token)).send(body);
const reject = (token: string, stepId: string, body: Record<string, unknown> = { comment: 'Hâlâ kullanılıyor' }) =>
  request(app.getHttpServer()).post(`/api/approvals/${stepId}/reject`).set(auth(token)).send(body);
const cancelRequest = (token: string, requestId: string) => request(app.getHttpServer()).post(`/api/approval-requests/${requestId}/cancel`).set(auth(token));
const pending = (token: string) => request(app.getHttpServer()).get('/api/approvals/pending').query({ pageSize: 100 }).set(auth(token));
const detail = (token: string, documentId: string) => request(app.getHttpServer()).get(`/api/documents/${documentId}`).set(auth(token));
const detailBody = async (token: string, documentId: string) => (await detail(token, documentId).expect(200)).body as DocumentDetailDto;

const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const revisionRow = (id: string) => prisma.revision.findUniqueOrThrow({ where: { id } });
const requestsOf = (documentId: string) =>
  prisma.documentRequest.findMany({ where: { documentId }, include: { steps: { orderBy: { stepOrder: 'asc' } } }, orderBy: { createdAt: 'asc' } });
const auditEntries = (entityIds: string[]) => prisma.auditLog.findMany({ where: { entityId: { in: entityIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

/** Asks for the withdrawal as `who` and returns the steps. */
async function asked(documentId: string, who: Label = 'editorA'): Promise<ApprovalStepDto[]> {
  const body = (await ask(users[who].token, documentId).expect(200)).body as DocumentDetailDto;
  return body.approval!.steps;
}

/** A document whose withdrawal went through both approvals. */
async function withdrawn() {
  const doc = await published();
  const [first, second] = await asked(doc.id);
  await approve(users.approverA.token, first.id).expect(200);
  await approve(users.qm.token, second.id).expect(200);
  return doc;
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;

  app = await createTestApp();
  storage = app.get(StorageService);

  const organization = await prisma.organization.create({ data: { name: `Withdraw ${suffix}`, slug: `withdraw-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `withdraw-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@withdraw.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
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

  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@withdraw.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  foreignDocumentId = foreignDoc.id;
});

beforeEach(() => {
  commandServer.reset();
});

afterAll(async () => {
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

describe('asking for a withdrawal', () => {
  describe('who may', () => {
    it('requires authentication and a valid id', async () => {
      const doc = await published();
      await request(app.getHttpServer()).post(`/api/documents/${doc.id}/withdrawal-requests`).send({ reason: 'x' }).expect(401);
      await ask(users.qm.token, 'not-a-uuid').expect(400);
      expect((await ask(users.qm.token, randomUUID()).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
      expect((await ask(users.admin.token, foreignDocumentId).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('refuses readers with 403', async () => {
      const doc = await published();
      expect((await ask(users.reader.token, doc.id).expect(403)).body.code).toBe('FORBIDDEN');
      expect(await requestsOf(doc.id)).toEqual([]);
    });

    it.each(['editorB', 'approverB'] as const)('refuses %s in another department, with a code of its own', async (who) => {
      const doc = await published();

      const response = await ask(users[who].token, doc.id).expect(403);

      expect(response.body.code).toBe('WITHDRAWAL_NOT_ALLOWED');
      expect(await requestsOf(doc.id)).toEqual([]);
    });

    it.each(['editorA', 'approverA', 'qm', 'admin'] as const)('lets %s ask in department A', async (who) => {
      const doc = await published();
      await ask(users[who].token, doc.id).expect(200);
      expect(await requestsOf(doc.id)).toHaveLength(1);
    });

    it.each(['qm', 'admin'] as const)('lets %s ask in any department', async (who) => {
      const doc = await published({ departmentId: org.deptB });
      await ask(users[who].token, doc.id).expect(200);
    });
  });

  describe('the reason', () => {
    it.each([
      ['missing', {}],
      ['empty', { reason: '' }],
      ['only spaces', { reason: '    ' }],
    ])('is required (%s)', async (_label, body) => {
      const doc = await published();

      const response = await ask(users.editorA.token, doc.id, body).expect(400);

      expect(response.body.code).toBe('REASON_REQUIRED');
      expect(await requestsOf(doc.id)).toEqual([]);
    });

    it('is limited to 2000 characters, and unknown fields are rejected', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id, { reason: 'x'.repeat(2001) }).expect(400);
      await ask(users.editorA.token, doc.id, { reason: 'ok', status: 'WITHDRAWN' }).expect(400);
      expect(await requestsOf(doc.id)).toEqual([]);
    });
  });

  describe('what asking does', () => {
    it('opens a request with both steps and leaves the document, its revision and its readers alone', async () => {
      const doc = await published();
      const before = { document: await documentRow(doc.id), revision: await revisionRow(doc.revisions[0].id) };

      const response = await ask(users.editorA.token, doc.id, { reason: '  Süreç artık kullanılmıyor  ' }).expect(200);

      const [request_] = await requestsOf(doc.id);
      expect(request_).toMatchObject({
        type: 'WITHDRAWAL',
        status: 'PENDING',
        documentId: doc.id,
        revisionId: doc.revisions[0].id,
        requestedById: users.editorA.id,
        reason: 'Süreç artık kullanılmıyor',
        resolvedAt: null,
      });
      expect(request_.steps.map((step) => [step.stepOrder, step.approverRole, step.decision])).toEqual([[1, 'APPROVER', 'PENDING'], [2, 'QUALITY_MANAGER', 'PENDING']]);
      expect(await documentRow(doc.id)).toEqual(before.document);
      expect(await revisionRow(doc.revisions[0].id)).toEqual(before.revision);
      expect(response.body).toMatchObject({
        status: 'PUBLISHED',
        canRequestWithdrawal: false,
        canStartRevision: false,
        approval: {
          id: request_.id,
          type: 'WITHDRAWAL',
          status: 'PENDING',
          reason: 'Süreç artık kullanılmıyor',
          revision: { id: doc.revisions[0].id, revisionNo: 0 },
          requestedBy: { id: users.editorA.id },
          canCancel: true,
        },
      });
    });

    it('audits the request with its reason', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id).expect(200);
      const [request_] = await requestsOf(doc.id);

      const entries = await prisma.auditLog.findMany({ where: { entityId: doc.id, action: 'WITHDRAWAL_REQUESTED' } });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ userId: users.editorA.id, entityType: 'Document', organizationId: org.id });
      expect(entries[0].metadata).toMatchObject({ code: doc.code, revisionNo: 0, requestId: request_.id, reason: 'Süreç artık kullanılmıyor' });
    });

    it('does not take the document away from its readers while it waits', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id).expect(200);

      const items = (await request(app.getHttpServer()).get('/api/documents').query({ search: doc.code }).set(auth(users.reader.token)).expect(200)).body.items as DocumentListItemDto[];
      expect(items).toMatchObject([{ code: doc.code, status: 'PUBLISHED' }]);
      await request(app.getHttpServer()).get(`/api/documents/${doc.id}/download`).set(auth(users.reader.token)).expect(200);
      // How the document is doing in the approval flow is for the people who work with it
      expect((await detailBody(users.reader.token, doc.id)).approval).toBeNull();
      expect((await detailBody(users.editorB.token, doc.id)).approval).toBeNull();
      expect((await detailBody(users.editorA.token, doc.id)).approval).toMatchObject({ type: 'WITHDRAWAL', status: 'PENDING' });
    });
  });

  describe('when it cannot be asked for', () => {
    it.each([
      ['a document that was never published', async () => (await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] })).id],
      ['a document in review', async () => (await createDocument({ status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] })).id],
      ['a document that was withdrawn already', async () => (await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] })).id],
    ])('refuses %s (DOCUMENT_NOT_WITHDRAWABLE)', async (_label, makeDocumentId) => {
      const documentId = await makeDocumentId();

      const response = await ask(users.qm.token, documentId).expect(409);

      expect(response.body.code).toBe('DOCUMENT_NOT_WITHDRAWABLE');
      expect(await requestsOf(documentId)).toEqual([]);
    });

    it.each([
      ['an open draft', 'DRAFT' as const],
      ['a revision in review', 'IN_REVIEW' as const],
    ])('refuses a document that has %s (WITHDRAWAL_BLOCKED_BY_REVISION)', async (_label, status) => {
      const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status }] });

      const response = await ask(users.qm.token, doc.id).expect(409);

      expect(response.body.code).toBe('WITHDRAWAL_BLOCKED_BY_REVISION');
      expect(await requestsOf(doc.id)).toEqual([]);
      expect((await detailBody(users.qm.token, doc.id)).canRequestWithdrawal).toBe(false);
    });

    it('allows it once a started revision was given up', async () => {
      const doc = await createDocument({ revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }, { revisionNo: 1, status: 'REJECTED' }] });
      await ask(users.qm.token, doc.id).expect(200);
    });

    it('refuses a second request while the first waits, and lets exactly one of two simultaneous requests win', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id).expect(200);
      expect((await ask(users.qm.token, doc.id).expect(409)).body.code).toBe('WITHDRAWAL_ALREADY_REQUESTED');

      const other = await published();
      const [one, two] = await Promise.all([ask(users.editorA.token, other.id), ask(users.qm.token, other.id)]);

      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(await requestsOf(other.id)).toHaveLength(1);
    });
  });

  describe('meanwhile', () => {
    it('refuses to start a revision, and does not copy anything for it', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id).expect(200);
      const copy = jest.spyOn(storage, 'copy');

      const response = await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).set(auth(users.editorA.token)).send({ changeSummary: 'Yeni madde' }).expect(409);

      expect(response.body.code).toBe('WITHDRAWAL_PENDING');
      expect(copy).not.toHaveBeenCalled();
      copy.mockRestore();
      expect(await prisma.revision.count({ where: { documentId: doc.id } })).toBe(1);
      expect((await detailBody(users.editorA.token, doc.id)).canStartRevision).toBe(false);
    });

    it('lets revisions be started again once the request is taken back', async () => {
      const doc = await published();
      await ask(users.editorA.token, doc.id).expect(200);
      await cancelRequest(users.editorA.token, (await requestsOf(doc.id))[0].id).expect(200);

      await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).set(auth(users.editorA.token)).send({ changeSummary: 'Yeni madde' }).expect(201);
    });
  });
});

describe('deciding on a withdrawal', () => {
  it('follows the same steps: the department approver first, then a quality manager, and the administrator either', async () => {
    const doc = await published();
    const [first, second] = await asked(doc.id);

    expect((await approve(users.qm.token, second.id).expect(409)).body.code).toBe('APPROVAL_STEP_NOT_ACTIVE');
    expect((await approve(users.qm.token, first.id).expect(403)).body.code).toBe('APPROVAL_NOT_ALLOWED');
    expect((await approve(users.approverB.token, first.id).expect(403)).body.code).toBe('APPROVAL_NOT_ALLOWED');
    await approve(users.approverA2.token, first.id).expect(200);
    expect((await approve(users.approverA.token, second.id).expect(403)).body.code).toBe('APPROVAL_NOT_ALLOWED');
    await approve(users.admin.token, second.id).expect(200);
    expect(await documentRow(doc.id)).toMatchObject({ status: 'WITHDRAWN' });
  });

  describe('whoever asked decides nothing', () => {
    it('refuses an approver on their own request, and somebody else can', async () => {
      const doc = await published();
      const [first] = await asked(doc.id, 'approverA');

      expect((await approve(users.approverA.token, first.id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      expect((await reject(users.approverA.token, first.id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      await approve(users.approverA2.token, first.id).expect(200);
    });

    it('refuses the quality manager on their own request on the second step, and another one can', async () => {
      const doc = await published();
      const [first, second] = await asked(doc.id, 'qm');
      await approve(users.approverA.token, first.id).expect(200);

      expect((await approve(users.qm.token, second.id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
      await approve(users.qm2.token, second.id).expect(200);
    });

    it('refuses the administrator on their own request', async () => {
      const doc = await published();
      const [first] = await asked(doc.id, 'admin');
      expect((await approve(users.admin.token, first.id).expect(403)).body.code).toBe('OWN_REVISION_NOT_APPROVABLE');
    });

    it('does not hold the preparer of the revision in force back: the rule is about whoever asked', async () => {
      const doc = await published({ preparedBy: 'approverA' });
      const [first] = await asked(doc.id, 'qm');

      await approve(users.approverA.token, first.id).expect(200);
    });
  });

  describe('the last approval', () => {
    it('withdraws the document, keeping everything on record', async () => {
      const doc = await published();
      const [first, second] = await asked(doc.id);
      await approve(users.approverA.token, first.id).expect(200);
      expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', withdrawnAt: null });

      const response = await approve(users.qm.token, second.id, { comment: 'Uygundur' }).expect(200);

      const document = await documentRow(doc.id);
      expect(document).toMatchObject({ status: 'WITHDRAWN', withdrawalReason: 'Süreç artık kullanılmıyor', currentRevisionId: doc.revisions[0].id });
      expect(document.withdrawnAt).toBeInstanceOf(Date);
      // The revision keeps its state and its file: it is the record of what was in force
      expect(await revisionRow(doc.revisions[0].id)).toMatchObject({ status: 'APPROVED', storageKey: doc.revisions[0].storageKey });
      expect(await storage.exists(doc.revisions[0].storageKey)).toBe(true);
      const [request_] = await requestsOf(doc.id);
      expect(request_.status).toBe('APPROVED');
      expect(request_.resolvedAt).toBeInstanceOf(Date);
      expect(request_.steps.map((step) => step.decision)).toEqual(['APPROVED', 'APPROVED']);
      expect(response.body).toMatchObject({
        status: 'WITHDRAWN',
        withdrawalReason: 'Süreç artık kullanılmıyor',
        approval: null,
        canEdit: false,
        canRequestWithdrawal: false,
        canStartRevision: false,
        canSubmit: false,
        canCancelRevision: false,
      });
      expect(response.body.withdrawnAt).toEqual(expect.any(String));
    });

    it('audits the approvals and the withdrawal', async () => {
      const doc = await published();
      const [first, second] = await asked(doc.id);
      await approve(users.approverA.token, first.id).expect(200);
      await approve(users.qm.token, second.id).expect(200);

      const entries = await auditEntries([doc.id, doc.revisions[0].id]);

      // The last approval and the withdrawal are written in one transaction: their order is not defined
      expect(entries.map((entry) => entry.action).sort()).toEqual(['APPROVAL_APPROVED', 'APPROVAL_APPROVED', 'DOCUMENT_WITHDRAWN', 'WITHDRAWAL_REQUESTED']);
      const final = entries.find((entry) => entry.action === 'APPROVAL_APPROVED' && (entry.metadata as { final: boolean }).final);
      expect(final!.metadata).toMatchObject({ stepOrder: 2, type: 'WITHDRAWAL', final: true });
      const done = entries.find((entry) => entry.action === 'DOCUMENT_WITHDRAWN');
      expect(done).toMatchObject({ userId: users.qm.id, entityType: 'Document' });
      expect(done!.metadata).toMatchObject({ code: doc.code, revisionNo: 0, reason: 'Süreç artık kullanılmıyor' });
    });

    it('takes the document away from readers, and the file in force from everybody', async () => {
      const doc = await withdrawn();

      expect((await detail(users.reader.token, doc.id).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
      const readerList = (await request(app.getHttpServer()).get('/api/documents').query({ search: doc.code }).set(auth(users.reader.token)).expect(200)).body.items as DocumentListItemDto[];
      expect(readerList).toEqual([]);
      await request(app.getHttpServer()).get(`/api/documents/${doc.id}/download`).set(auth(users.reader.token)).expect(404);

      // Those who may see withdrawn documents still do, marked as such, but nothing is in force
      const editorList = (await request(app.getHttpServer()).get('/api/documents').query({ search: doc.code }).set(auth(users.editorA.token)).expect(200)).body.items as DocumentListItemDto[];
      expect(editorList).toMatchObject([{ code: doc.code, status: 'WITHDRAWN', canEdit: false }]);
      for (const who of ['editorA', 'approverA', 'qm', 'admin'] as const) {
        expect((await request(app.getHttpServer()).get(`/api/documents/${doc.id}/download`).set(auth(users[who].token)).expect(404)).body.code).toBe('NO_PUBLISHED_REVISION');
      }
    });

    it('shows the last revision as no longer in force, and keeps it available as a record', async () => {
      const doc = await withdrawn();

      const history = (await request(app.getHttpServer()).get(`/api/documents/${doc.id}/revisions`).set(auth(users.approverA.token)).expect(200)).body as RevisionHistoryItemDto[];
      expect(history).toMatchObject([{ revisionNo: 0, status: 'APPROVED', isCurrent: false, canEdit: false }]);
      await request(app.getHttpServer()).get(`/api/revisions/${doc.revisions[0].id}/download`).set(auth(users.approverA.token)).expect(200);
      const session = (await request(app.getHttpServer()).get(`/api/editor/config/${doc.revisions[0].id}`).set(auth(users.approverA.token)).expect(200)).body;
      expect(session.mode).toBe('view');
    });

    it('is final: nothing can be started, asked or sent for the document any more', async () => {
      const doc = await withdrawn();

      expect((await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).set(auth(users.qm.token)).send({ changeSummary: 'Yeni' }).expect(409)).body.code).toBe('DOCUMENT_NOT_REVISABLE');
      expect((await ask(users.qm.token, doc.id).expect(409)).body.code).toBe('DOCUMENT_NOT_WITHDRAWABLE');
      expect((await request(app.getHttpServer()).post(`/api/revisions/${doc.revisions[0].id}/submit`).set(auth(users.qm.token)).expect(409)).body.code).toBe('REVISION_NOT_SUBMITTABLE');
    });

    it('rolls everything back when the audit entry cannot be written', async () => {
      const doc = await published();
      const [first, second] = await asked(doc.id);
      await approve(users.approverA.token, first.id).expect(200);
      const before = { document: await documentRow(doc.id), revision: await revisionRow(doc.revisions[0].id), request: (await requestsOf(doc.id))[0] };
      jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

      await approve(users.qm.token, second.id).expect(500);

      expect(await documentRow(doc.id)).toEqual(before.document);
      expect(await revisionRow(doc.revisions[0].id)).toEqual(before.revision);
      expect((await requestsOf(doc.id))[0]).toEqual(before.request);
    });
  });

  describe('a refusal', () => {
    it('needs a reason, and leaves the document in force', async () => {
      const doc = await published();
      const [first] = await asked(doc.id);
      expect((await reject(users.approverA.token, first.id, {}).expect(400)).body.code).toBe('COMMENT_REQUIRED');

      const response = await reject(users.approverA.token, first.id, { comment: '  Hâlâ kullanılıyor  ' }).expect(200);

      const [request_] = await requestsOf(doc.id);
      expect(request_.status).toBe('REJECTED');
      expect(request_.resolvedAt).toBeInstanceOf(Date);
      expect(request_.steps[0]).toMatchObject({ decision: 'REJECTED', approverId: users.approverA.id, comment: 'Hâlâ kullanılıyor' });
      expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', withdrawnAt: null, withdrawalReason: null, currentRevisionId: doc.revisions[0].id });
      expect(await revisionRow(doc.revisions[0].id)).toMatchObject({ status: 'APPROVED' });
      expect(response.body).toMatchObject({ status: 'PUBLISHED', approval: null, canRequestWithdrawal: true, canStartRevision: true });
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: doc.revisions[0].id, action: 'APPROVAL_REJECTED' } });
      expect(entry.metadata).toMatchObject({ type: 'WITHDRAWAL', comment: 'Hâlâ kullanılıyor', stepOrder: 1 });
    });

    it('also works on the second step, and a new request can follow', async () => {
      const doc = await published();
      const [first, second] = await asked(doc.id);
      await approve(users.approverA.token, first.id).expect(200);
      await reject(users.qm.token, second.id).expect(200);

      expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED' });
      await ask(users.editorA.token, doc.id).expect(200);
      expect((await requestsOf(doc.id)).map((item) => item.status)).toEqual(['REJECTED', 'PENDING']);
    });

    it('lets the document go on: revisions can be started again', async () => {
      const doc = await published();
      const [first] = await asked(doc.id);
      await reject(users.approverA.token, first.id).expect(200);

      await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).set(auth(users.editorA.token)).send({ changeSummary: 'Yeni madde' }).expect(201);
    });
  });

  it('lets exactly one of two simultaneous decisions on the same step win', async () => {
    const doc = await published();
    const [first] = await asked(doc.id);

    const [one, two] = await Promise.all([approve(users.approverA.token, first.id), reject(users.approverA2.token, first.id)]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
  });
});

describe('taking the request back', () => {
  it('leaves the document and its revision exactly as they were', async () => {
    const doc = await published();
    await asked(doc.id);
    const before = { document: await documentRow(doc.id), revision: await revisionRow(doc.revisions[0].id) };
    const [request_] = await requestsOf(doc.id);

    const response = await cancelRequest(users.editorA.token, request_.id).expect(200);

    expect((await requestsOf(doc.id))[0]).toMatchObject({ status: 'CANCELLED' });
    expect(await documentRow(doc.id)).toEqual(before.document);
    // A revision under review would go back to a draft; this one was never touched
    expect(await revisionRow(doc.revisions[0].id)).toEqual(before.revision);
    expect(response.body).toMatchObject({ status: 'PUBLISHED', approval: null, canRequestWithdrawal: true });
    const [entry] = await prisma.auditLog.findMany({ where: { entityId: doc.revisions[0].id, action: 'REQUEST_CANCELLED' } });
    expect(entry).toMatchObject({ userId: users.editorA.id });
    expect(entry.metadata).toMatchObject({ requestId: request_.id, type: 'WITHDRAWAL' });
  });

  it.each([
    ['whoever asked', 'editorA', 200],
    ['the administrator', 'admin', 200],
    ['an approver', 'approverA', 403],
    ['a quality manager', 'qm', 403],
  ] as const)('is allowed to %s: %s', async (_label, who, status) => {
    const doc = await published();
    await asked(doc.id);
    const [request_] = await requestsOf(doc.id);

    const response = await cancelRequest(users[who].token, request_.id);

    expect(response.status).toBe(status);
    if (status === 403) expect(response.body.code).toBe('CANCEL_NOT_ALLOWED');
  });

  it('is refused once somebody decided', async () => {
    const doc = await published();
    const [first] = await asked(doc.id);
    const [request_] = await requestsOf(doc.id);
    await approve(users.approverA.token, first.id).expect(200);

    expect((await cancelRequest(users.editorA.token, request_.id).expect(409)).body.code).toBe('REQUEST_NOT_CANCELLABLE');
    expect((await detailBody(users.editorA.token, doc.id)).approval).toMatchObject({ canCancel: false });
  });
});

describe('what the approvers see', () => {
  const items = async (who: Label) => ((await pending(users[who].token).expect(200)).body as PaginatedDto<PendingApprovalDto>).items;

  it('lists the request with its type and reason, to those whose turn it is', async () => {
    const doc = await published();
    const [first, second] = await asked(doc.id);

    for (const who of ['approverA', 'approverA2', 'admin'] as const) {
      const item = (await items(who)).find((candidate) => candidate.stepId === first.id);
      expect(item).toMatchObject({
        stepOrder: 1,
        request: { type: 'WITHDRAWAL', reason: 'Süreç artık kullanılmıyor', requestedBy: { id: users.editorA.id } },
        document: { id: doc.id, code: doc.code },
        revision: { id: doc.revisions[0].id, revisionNo: 0 },
      });
    }
    for (const who of ['approverB', 'qm'] as const) expect((await items(who)).map((item) => item.stepId)).not.toContain(first.id);

    await approve(users.approverA.token, first.id).expect(200);
    expect((await items('qm')).map((item) => item.stepId)).toContain(second.id);
  });

  it('does not list a request to the one who asked', async () => {
    const doc = await published();
    const [first] = await asked(doc.id, 'approverA');

    expect((await items('approverA')).map((item) => item.stepId)).not.toContain(first.id);
    expect((await items('approverA2')).map((item) => item.stepId)).toContain(first.id);
  });

  it('tells each user what they may do with the request', async () => {
    const doc = await published();
    await asked(doc.id);

    expect((await detailBody(users.editorA.token, doc.id)).approval).toMatchObject({ canCancel: true, steps: [{ canDecide: false }, { canDecide: false }] });
    expect((await detailBody(users.approverA.token, doc.id)).approval).toMatchObject({ canCancel: false, steps: [{ canDecide: true }, { canDecide: false }] });
  });
});

describe('the canRequestWithdrawal flag', () => {
  it('is true for those who may ask, on a document in force with nothing going on', async () => {
    const doc = await published();
    for (const who of ['editorA', 'approverA', 'qm', 'admin'] as const) expect((await detailBody(users[who].token, doc.id)).canRequestWithdrawal).toBe(true);
    for (const who of ['reader', 'editorB', 'approverB'] as const) expect((await detailBody(users[who].token, doc.id)).canRequestWithdrawal).toBe(false);
  });

  it('is false for documents that are not in force', async () => {
    const draft = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    expect((await detailBody(users.qm.token, draft.id)).canRequestWithdrawal).toBe(false);
  });
});
