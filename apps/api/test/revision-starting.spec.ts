process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DocumentDetailDto, DocumentListItemDto, RevisionHistoryItemDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
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
let foreignDocumentId: string;

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'editorA' | 'editorB' | 'approverA' | 'approverB';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let codeCounter = 0;

interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
  content?: Buffer;
}

async function createDocument(options: { status?: DocumentStatus; departmentId?: string; revisions: RevisionSpec[]; missingFile?: boolean }) {
  const sequenceNo = 200 + codeCounter++;
  const departmentId = options.departmentId ?? org.deptA;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id,
      categoryId: org.category,
      departmentId,
      ownerId: users.editorA.id,
      code: `MM-AA-${sequenceNo}`,
      sequenceNo,
      title: 'Revizyon denemesi',
      fileType: 'DOCX',
      status: options.status ?? 'PUBLISHED',
      firstPublishedAt: new Date('2025-01-10T09:00:00Z'),
    },
  });

  const revisions: { id: string; revisionNo: number; storageKey: string; editorKey: string; content: Buffer }[] = [];
  for (const spec of options.revisions) {
    const content = spec.content ?? blankDocx;
    const storageKey = buildRevisionKey({ organizationId: org.id, documentId: document.id, revisionNo: spec.revisionNo, fileType: 'DOCX' });
    if (!options.missingFile) await storage.put(storageKey, content, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id,
        documentId: document.id,
        revisionNo: spec.revisionNo,
        status: spec.status,
        storageKey,
        fileSize: content.length,
        checksum: createHash('sha256').update(content).digest('hex'),
        editorKey: randomUUID(),
        preparedById: users.editorA.id,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo, storageKey, editorKey: revision.editorKey, content });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code: document.code, revisions };
}

/** A published document with one revision in force: the normal starting point. */
const published = (options: { departmentId?: string; content?: Buffer } = {}) =>
  createDocument({ departmentId: options.departmentId, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, content: options.content }] });

const start = (token: string, documentId: string, body: Record<string, unknown> = { changeSummary: 'Madde 4 eklendi' }) =>
  request(app.getHttpServer()).post(`/api/documents/${documentId}/revisions`).set(auth(token)).send(body);

const revisionRows = (documentId: string) => prisma.revision.findMany({ where: { documentId }, orderBy: { revisionNo: 'asc' } });
const documentRow = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
const auditActions = async (entityIds: string[]) =>
  (await prisma.auditLog.findMany({ where: { entityId: { in: entityIds } }, orderBy: { createdAt: 'asc' } })).map((entry) => entry.action);
const detail = async (token: string, documentId: string) =>
  (await request(app.getHttpServer()).get(`/api/documents/${documentId}`).set(auth(token)).expect(200)).body as DocumentDetailDto;

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  app = await createTestApp();
  storage = app.get(StorageService);

  const organization = await prisma.organization.create({ data: { name: `Start ${suffix}`, slug: `start-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `start-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@start.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
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
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@start.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'APPROVED', storageKey: 'foreign/none', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
  });
  foreignDocumentId = foreignDoc.id;
});

afterAll(async () => {
  // Test cleanup only: the application never deletes revisions or their files
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
});

describe('who may start a revision', () => {
  it('requires authentication and a valid id', async () => {
    const doc = await published();
    await request(app.getHttpServer()).post(`/api/documents/${doc.id}/revisions`).send({ changeSummary: 'x' }).expect(401);
    await start(users.qm.token, 'not-a-uuid').expect(400);
    expect((await start(users.qm.token, randomUUID()).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('refuses readers with 403, whatever the document', async () => {
    const doc = await published();

    const response = await start(users.reader.token, doc.id).expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect(await revisionRows(doc.id)).toHaveLength(1);
  });

  it.each(['editorA', 'approverA', 'qm', 'admin'] as const)('lets %s start a revision in department A', async (who) => {
    const doc = await published();
    const response = await start(users[who].token, doc.id).expect(201);
    expect(response.body).toMatchObject({ id: doc.id, openRevision: { revisionNo: 1, status: 'DRAFT' } });
  });

  it.each(['qm', 'admin'] as const)('lets %s start a revision in any department', async (who) => {
    const doc = await published({ departmentId: org.deptB });
    await start(users[who].token, doc.id).expect(201);
  });

  it.each(['editorB', 'approverB'] as const)('refuses %s in a department that is not theirs, with a code of its own', async (who) => {
    const doc = await published();

    const response = await start(users[who].token, doc.id).expect(403);

    expect(response.body.code).toBe('REVISION_START_NOT_ALLOWED');
    expect(await revisionRows(doc.id)).toHaveLength(1);
  });

  it('does not reveal documents of another organization', async () => {
    expect((await start(users.admin.token, foreignDocumentId).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('does not reveal unpublished documents of other departments to editors', async () => {
    const draft = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    expect((await start(users.editorB.token, draft.id).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('the change summary', () => {
  it.each([
    ['missing', {}],
    ['empty', { changeSummary: '' }],
    ['only spaces', { changeSummary: '    ' }],
  ])('is required (%s), and nothing is copied or written without it', async (_label, body) => {
    const doc = await published();
    const copy = jest.spyOn(storage, 'copy');

    const response = await start(users.qm.token, doc.id, body).expect(400);

    expect(response.body.code).toBe('CHANGE_SUMMARY_REQUIRED');
    expect(copy).not.toHaveBeenCalled();
    expect(await revisionRows(doc.id)).toHaveLength(1);
    copy.mockRestore();
  });

  it('is trimmed and stored on the new revision', async () => {
    const doc = await published();
    await start(users.qm.token, doc.id, { changeSummary: '  Madde 4 eklendi  ' }).expect(201);
    expect((await revisionRows(doc.id))[1].changeSummary).toBe('Madde 4 eklendi');
  });

  it('is limited to 2000 characters, and unknown fields are rejected', async () => {
    const doc = await published();
    await start(users.qm.token, doc.id, { changeSummary: 'x'.repeat(2001) }).expect(400);
    await start(users.qm.token, doc.id, { changeSummary: 'ok', status: 'PUBLISHED' }).expect(400);
    expect(await revisionRows(doc.id)).toHaveLength(1);
  });
});

describe('what starting does', () => {
  it('creates the next draft from a copy of the file in force, and leaves everything else alone', async () => {
    const content = Buffer.concat([blankDocx, Buffer.from('in force')]);
    const doc = await published({ content });
    const [source] = doc.revisions;

    const response = await start(users.editorA.token, doc.id).expect(201);

    const rows = await revisionRows(doc.id);
    expect(rows).toHaveLength(2);
    const [oldRow, newRow] = rows;
    expect(newRow).toMatchObject({
      revisionNo: 1,
      status: 'DRAFT',
      preparedById: users.editorA.id,
      approvedById: null,
      publishedAt: null,
      changeSummary: 'Madde 4 eklendi',
      fileSize: content.length,
      checksum: createHash('sha256').update(content).digest('hex'),
      editSessionStartedAt: null,
    });
    // Its own object and key: editing the draft must never touch the file in force
    expect(newRow.storageKey).not.toBe(source.storageKey);
    expect(newRow.editorKey).not.toBe(source.editorKey);
    expect((await storage.getBuffer(newRow.storageKey)).equals(content)).toBe(true);
    expect((await storage.getBuffer(source.storageKey)).equals(content)).toBe(true);

    expect(oldRow).toMatchObject({ status: 'APPROVED', storageKey: source.storageKey, editorKey: source.editorKey });
    expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED', currentRevisionId: source.id });
    expect(response.body).toMatchObject({
      status: 'PUBLISHED',
      currentRevisionId: source.id,
      revisionNo: 0,
      openRevision: { id: newRow.id, revisionNo: 1, status: 'DRAFT', changeSummary: 'Madde 4 eklendi' },
      canEdit: true,
      canStartRevision: false,
    });
  });

  it('never reuses a number: the next one follows the highest, gaps included', async () => {
    const doc = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'SUPERSEDED' },
        { revisionNo: 1, status: 'APPROVED', current: true },
        { revisionNo: 3, status: 'REJECTED' },
      ],
    });

    const response = await start(users.qm.token, doc.id).expect(201);

    expect(response.body.openRevision.revisionNo).toBe(4);
  });

  it('writes one audit entry that names the revision it was started from', async () => {
    const doc = await published();
    await start(users.qm.token, doc.id).expect(201);
    const [, created] = await revisionRows(doc.id);

    const [entry] = await prisma.auditLog.findMany({ where: { entityId: created.id, action: 'REVISION_STARTED' } });

    expect(entry).toMatchObject({ userId: users.qm.id, entityType: 'Revision', organizationId: org.id });
    expect(entry.metadata).toMatchObject({ documentId: doc.id, code: doc.code, revisionNo: 1, sourceRevisionNo: 0, changeSummary: 'Madde 4 eklendi' });
  });

  it('answers 404 with a clear code when the file in force is missing from storage, and creates nothing', async () => {
    const doc = await createDocument({ missingFile: true, revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] });

    const response = await start(users.qm.token, doc.id).expect(404);

    expect(response.body.code).toBe('REVISION_FILE_MISSING');
    expect(await revisionRows(doc.id)).toHaveLength(1);
  });
});

describe('when a revision cannot be started', () => {
  it.each([
    ['a document that was never published', async () => (await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] })).id],
    ['a document in review', async () => (await createDocument({ status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] })).id],
    [
      'a withdrawn document',
      async () => (await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] })).id,
    ],
  ])('refuses %s (DOCUMENT_NOT_REVISABLE)', async (_label, makeDocumentId) => {
    const documentId = await makeDocumentId();
    const before = await revisionRows(documentId);

    const response = await start(users.qm.token, documentId).expect(409);

    expect(response.body.code).toBe('DOCUMENT_NOT_REVISABLE');
    expect(await revisionRows(documentId)).toEqual(before);
  });

  it.each([
    ['an open draft', 'DRAFT' as const],
    ['a revision in review', 'IN_REVIEW' as const],
  ])('refuses a document that already has %s (REVISION_ALREADY_OPEN)', async (_label, status) => {
    const doc = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'APPROVED', current: true },
        { revisionNo: 1, status },
      ],
    });

    const response = await start(users.qm.token, doc.id).expect(409);

    expect(response.body.code).toBe('REVISION_ALREADY_OPEN');
    expect(await revisionRows(doc.id)).toHaveLength(2);
  });

  it('refuses a second start right after the first', async () => {
    const doc = await published();
    await start(users.qm.token, doc.id).expect(201);

    expect((await start(users.qm.token, doc.id).expect(409)).body.code).toBe('REVISION_ALREADY_OPEN');
    expect(await revisionRows(doc.id)).toHaveLength(2);
  });

  it('allows a new one once the draft is published', async () => {
    const doc = await published();
    await start(users.qm.token, doc.id).expect(201);
    const [, draft] = await revisionRows(doc.id);
    await request(app.getHttpServer()).post(`/api/revisions/${draft.id}/publish`).set(auth(users.qm.token)).send({}).expect(200);

    const response = await start(users.qm.token, doc.id).expect(201);

    expect(response.body.openRevision.revisionNo).toBe(2);
  });
});

describe('consistency', () => {
  it('lets exactly one of two simultaneous starts win and leaves no stray file', async () => {
    const doc = await published();
    const copied: string[] = [];
    const original = storage.copy.bind(storage);
    const copy = jest.spyOn(storage, 'copy').mockImplementation(async (source, destination) => {
      copied.push(destination);
      await original(source, destination);
    });

    const [first, second] = await Promise.all([start(users.qm.token, doc.id), start(users.admin.token, doc.id)]);
    copy.mockRestore();

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const rows = await revisionRows(doc.id);
    expect(rows).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { entityId: rows[1].id, action: 'REVISION_STARTED' } })).toBe(1);
    // Both requests copied the file; only the winner's copy may remain
    expect(copied).toHaveLength(2);
    const surviving = await Promise.all(copied.map((key) => storage.exists(key)));
    expect(surviving.filter(Boolean)).toHaveLength(1);
    expect(copied.filter((_key, index) => surviving[index])).toEqual([rows[1].storageKey]);
  });

  it('rolls everything back and removes the copy when the audit entry cannot be written', async () => {
    const doc = await published();
    const copied: string[] = [];
    const original = storage.copy.bind(storage);
    const copy = jest.spyOn(storage, 'copy').mockImplementation(async (source, destination) => {
      copied.push(destination);
      await original(source, destination);
    });
    jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

    await start(users.qm.token, doc.id).expect(500);
    copy.mockRestore();

    expect(await revisionRows(doc.id)).toHaveLength(1);
    expect(copied).toHaveLength(1);
    expect(await storage.exists(copied[0])).toBe(false);
    expect(await documentRow(doc.id)).toMatchObject({ status: 'PUBLISHED' });
  });
});

describe('what everybody else sees meanwhile', () => {
  it('keeps the revision in force for readers, who cannot open the new draft', async () => {
    const doc = await published();
    await start(users.editorA.token, doc.id).expect(201);
    const [inForce, draft] = await revisionRows(doc.id);

    const asReader = await detail(users.reader.token, doc.id);
    expect(asReader).toMatchObject({ status: 'PUBLISHED', currentRevisionId: inForce.id, openRevision: { id: inForce.id }, canStartRevision: false, canEdit: false });

    const history = (await request(app.getHttpServer()).get(`/api/documents/${doc.id}/revisions`).set(auth(users.reader.token)).expect(200)).body as RevisionHistoryItemDto[];
    expect(history.map((row) => row.id)).toEqual([inForce.id]);
    await request(app.getHttpServer()).get(`/api/revisions/${draft.id}/download`).set(auth(users.reader.token)).expect(404);
    await request(app.getHttpServer()).get(`/api/editor/config/${draft.id}`).set(auth(users.reader.token)).expect(404);
    await request(app.getHttpServer()).get(`/api/documents/${doc.id}/download`).set(auth(users.reader.token)).expect(200);

    const list = (await request(app.getHttpServer()).get('/api/documents').query({ search: doc.code }).set(auth(users.reader.token)).expect(200)).body.items as DocumentListItemDto[];
    expect(list).toMatchObject([{ code: doc.code, status: 'PUBLISHED', revisionNo: 0 }]);
  });

  it('lets the department edit the new draft and the publisher publish it', async () => {
    const doc = await published();
    await start(users.editorA.token, doc.id, { changeSummary: 'Yeni madde' }).expect(201);
    const [, draft] = await revisionRows(doc.id);

    const session = (await request(app.getHttpServer()).get(`/api/editor/config/${draft.id}`).set(auth(users.editorA.token)).expect(200)).body;
    expect(session).toMatchObject({ mode: 'edit', revision: { id: draft.id, revisionNo: 1 } });
    // Drafts are invisible to other departments
    await request(app.getHttpServer()).get(`/api/editor/config/${draft.id}`).set(auth(users.editorB.token)).expect(404);

    const asQualityManager = await detail(users.qm.token, doc.id);
    expect(asQualityManager).toMatchObject({ canPublish: true, openRevision: { changeSummary: 'Yeni madde' } });
  });

  it('publishes without asking for the summary again, because it was given when the revision started', async () => {
    const doc = await published();
    await start(users.editorA.token, doc.id, { changeSummary: 'Yeni madde' }).expect(201);
    const [inForce, draft] = await revisionRows(doc.id);
    // The editor session of the draft ended without a save
    await prisma.revision.update({ where: { id: draft.id }, data: { editSessionStartedAt: null } });

    const response = await request(app.getHttpServer()).post(`/api/revisions/${draft.id}/publish`).set(auth(users.qm.token)).send({}).expect(200);

    expect(response.body).toMatchObject({ currentRevisionId: draft.id, revisionNo: 1 });
    expect((await prisma.revision.findUniqueOrThrow({ where: { id: inForce.id } })).status).toBe('SUPERSEDED');
    expect((await prisma.revision.findUniqueOrThrow({ where: { id: draft.id } })).changeSummary).toBe('Yeni madde');
    expect((await documentRow(doc.id)).revisedAt).toBeInstanceOf(Date);
    expect(await auditActions([doc.id, draft.id])).toEqual(expect.arrayContaining(['REVISION_STARTED', 'DOCUMENT_PUBLISHED']));
  });

  it('lets the publisher replace the summary when publishing', async () => {
    const doc = await published();
    await start(users.editorA.token, doc.id, { changeSummary: 'Yeni madde' }).expect(201);
    const [, draft] = await revisionRows(doc.id);

    await request(app.getHttpServer()).post(`/api/revisions/${draft.id}/publish`).set(auth(users.qm.token)).send({ changeSummary: 'Düzeltilmiş açıklama' }).expect(200);

    expect((await prisma.revision.findUniqueOrThrow({ where: { id: draft.id } })).changeSummary).toBe('Düzeltilmiş açıklama');
  });
});

describe('the canStartRevision flag', () => {
  it('is true for those who may start one, on a published document with nothing open', async () => {
    const doc = await published();
    for (const who of ['editorA', 'approverA', 'qm', 'admin'] as const) {
      expect((await detail(users[who].token, doc.id)).canStartRevision).toBe(true);
    }
    for (const who of ['reader', 'editorB', 'approverB'] as const) {
      expect((await detail(users[who].token, doc.id)).canStartRevision).toBe(false);
    }
  });

  it('is false while a revision is open and for documents that are not in force', async () => {
    const withDraft = await createDocument({
      revisions: [
        { revisionNo: 0, status: 'APPROVED', current: true },
        { revisionNo: 1, status: 'DRAFT' },
      ],
    });
    const neverPublished = await createDocument({ status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    const withdrawn = await createDocument({ status: 'WITHDRAWN', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] });

    for (const doc of [withDraft, neverPublished, withdrawn]) {
      expect((await detail(users.qm.token, doc.id)).canStartRevision).toBe(false);
    }
  });
});
