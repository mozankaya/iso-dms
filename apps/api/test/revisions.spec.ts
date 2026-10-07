process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DocumentDetailDto, RevisionHistoryItemDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
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
let blankXlsx: Buffer;

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'editorA' | 'editorB' | 'approverA';
const users = {} as Record<Label, { id: string; token: string; fullName: string }>;
type DocName = 'published' | 'draftOnly' | 'inReview' | 'withdrawn' | 'sheet' | 'noFile' | 'foreign';
const docs = {} as Record<DocName, { id: string; revisions: { id: string; revisionNo: number }[] }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (token: string, url: string) => request(app.getHttpServer()).get(url).set(auth(token));

interface RevisionSpec {
  revisionNo: number;
  status: RevisionStatus;
  current?: boolean;
  changeSummary?: string;
  preparedBy?: Label;
  approvedBy?: Label;
  approvedAt?: Date;
  publishedAt?: Date;
  storeFile?: boolean;
}

async function createDocument(options: {
  code: string;
  title: string;
  departmentId: string;
  organizationId?: string;
  status: DocumentStatus;
  fileType?: 'DOCX' | 'XLSX';
  extra?: Record<string, unknown>;
  revisions: RevisionSpec[];
}) {
  const organizationId = options.organizationId ?? org.id;
  const fileType = options.fileType ?? 'DOCX';
  const content = fileType === 'DOCX' ? blankDocx : blankXlsx;

  const document = await prisma.document.create({
    data: {
      organizationId,
      categoryId: org.category,
      departmentId: options.departmentId,
      ownerId: users.editorA.id,
      code: options.code,
      sequenceNo: Number(options.code.split('-').at(-1)),
      title: options.title,
      fileType,
      status: options.status,
      ...options.extra,
    },
  });

  const revisions: { id: string; revisionNo: number }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: spec.revisionNo, fileType });
    if (spec.storeFile !== false) await storage.put(storageKey, content, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId,
        documentId: document.id,
        revisionNo: spec.revisionNo,
        status: spec.status,
        storageKey,
        fileSize: content.length,
        checksum: createHash('sha256').update(content).digest('hex'),
        editorKey: randomUUID(),
        changeSummary: spec.changeSummary,
        preparedById: users[spec.preparedBy ?? 'editorA'].id,
        approvedById: spec.approvedBy ? users[spec.approvedBy].id : null,
        approvedAt: spec.approvedAt,
        publishedAt: spec.publishedAt,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo });
    if (spec.current) {
      await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
    }
  }
  return { id: document.id, revisions };
}

beforeAll(async () => {
  app = await createTestApp();
  storage = app.get(StorageService);
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));

  const organization = await prisma.organization.create({ data: { name: `Revisions ${suffix}`, slug: `revisions-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `revisions-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha Birimi', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta Birimi', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Prosedürler', slug: 'procedures', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null, fullName: string) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@revisions.local`, fullName, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, fullName, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null, 'Ali Yönetici');
  await makeUser('qm', 'QUALITY_MANAGER', null, 'Kader Kalite');
  await makeUser('reader', 'READER', org.deptA, 'Reha Okuyucu');
  await makeUser('editorA', 'EDITOR', org.deptA, 'Ece Editör');
  await makeUser('editorB', 'EDITOR', org.deptB, 'Berk Editör');
  await makeUser('approverA', 'APPROVER', org.deptA, 'Onur Onaylayıcı');

  const approved = new Date('2026-02-03T09:00:00Z');
  const published = new Date('2026-02-04T09:00:00Z');
  docs.published = await createDocument({
    code: 'MM-AA-001',
    title: 'Eğitim Prosedürü',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    extra: {
      firstPublishedAt: new Date('2025-01-10T09:00:00Z'),
      revisedAt: published,
      reviewIntervalMonths: 12,
      nextReviewAt: new Date('2027-02-04T09:00:00Z'),
      retentionYears: 5,
    },
    revisions: [
      { revisionNo: 0, status: 'SUPERSEDED', approvedBy: 'qm', approvedAt: new Date('2025-01-09T09:00:00Z'), publishedAt: new Date('2025-01-10T09:00:00Z') },
      { revisionNo: 1, status: 'APPROVED', current: true, changeSummary: 'Madde 3 güncellendi', approvedBy: 'approverA', approvedAt: approved, publishedAt: published },
      { revisionNo: 2, status: 'DRAFT', preparedBy: 'approverA' },
    ],
  });
  docs.draftOnly = await createDocument({ code: 'MM-AA-002', title: 'Henüz yayınlanmadı', departmentId: org.deptA, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
  docs.inReview = await createDocument({ code: 'MM-BB-001', title: 'İncelemede', departmentId: org.deptB, status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] });
  docs.withdrawn = await createDocument({
    code: 'MM-AA-003',
    title: 'Kaldırılan doküman',
    departmentId: org.deptA,
    status: 'WITHDRAWN',
    extra: { withdrawnAt: new Date('2026-03-01T09:00:00Z'), withdrawalReason: 'Artık kullanılmıyor' },
    revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, approvedBy: 'qm', approvedAt: approved, publishedAt: published }],
  });
  docs.sheet = await createDocument({
    code: 'MM-AA-004',
    title: 'Form listesi',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    fileType: 'XLSX',
    revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }],
  });
  docs.noFile = await createDocument({
    code: 'MM-AA-005',
    title: 'Dosyası kayıp',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    revisions: [{ revisionNo: 0, status: 'APPROVED', current: true, storeFile: false }],
  });

  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@revisions.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  const foreignRevision = await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'APPROVED', storageKey: 'foreign/none', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
  });
  await prisma.document.update({ where: { id: foreignDoc.id }, data: { currentRevisionId: foreignRevision.id } });
  docs.foreign = { id: foreignDoc.id, revisions: [{ id: foreignRevision.id, revisionNo: 0 }] };
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

function binaryParser(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('GET /api/documents/:id (detail)', () => {
  it('returns everything the detail page shows', async () => {
    const body = (await get(users.admin.token, `/api/documents/${docs.published.id}`).expect(200)).body as DocumentDetailDto;

    expect(body).toMatchObject({
      id: docs.published.id,
      code: 'MM-AA-001',
      title: 'Eğitim Prosedürü',
      fileType: 'DOCX',
      status: 'PUBLISHED',
      category: { id: org.category, name: 'Prosedürler', slug: 'procedures' },
      department: { id: org.deptA, name: 'Alpha Birimi', code: 'AA' },
      owner: { id: users.editorA.id, fullName: 'Ece Editör' },
      currentRevisionId: docs.published.revisions[1].id,
      revisionNo: 1,
      firstPublishedAt: '2025-01-10T09:00:00.000Z',
      revisedAt: '2026-02-04T09:00:00.000Z',
      reviewIntervalMonths: 12,
      nextReviewAt: '2027-02-04T09:00:00.000Z',
      retentionYears: 5,
      withdrawnAt: null,
      withdrawalReason: null,
    });
    expect(body.createdAt).toEqual(expect.any(String));
  });

  it('leaves the optional fields empty for a fresh draft', async () => {
    const body = (await get(users.editorA.token, `/api/documents/${docs.draftOnly.id}`).expect(200)).body as DocumentDetailDto;

    expect(body).toMatchObject({
      currentRevisionId: null,
      firstPublishedAt: null,
      reviewIntervalMonths: null,
      nextReviewAt: null,
      retentionYears: null,
    });
  });

  it('shows why a document was withdrawn to those who may see it', async () => {
    const body = (await get(users.qm.token, `/api/documents/${docs.withdrawn.id}`).expect(200)).body as DocumentDetailDto;

    expect(body).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: '2026-03-01T09:00:00.000Z', withdrawalReason: 'Artık kullanılmıyor' });
  });

  it('does not show a withdrawn document to readers', async () => {
    await get(users.reader.token, `/api/documents/${docs.withdrawn.id}`).expect(404);
  });
});

describe('GET /api/documents/:id/revisions', () => {
  const history = async (token: string, id: string) =>
    (await get(token, `/api/documents/${id}/revisions`).expect(200)).body as RevisionHistoryItemDto[];

  it('requires authentication and a valid id', async () => {
    await request(app.getHttpServer()).get(`/api/documents/${docs.published.id}/revisions`).expect(401);
    await get(users.admin.token, '/api/documents/nope/revisions').expect(400);
    await get(users.admin.token, `/api/documents/${randomUUID()}/revisions`).expect(404);
  });

  it('lists every revision, newest first, with who prepared and approved it', async () => {
    const rows = await history(users.admin.token, docs.published.id);

    expect(rows.map((row) => row.revisionNo)).toEqual([2, 1, 0]);
    expect(rows[1]).toEqual({
      id: docs.published.revisions[1].id,
      revisionNo: 1,
      status: 'APPROVED',
      isCurrent: true,
      preparedBy: { id: users.editorA.id, fullName: 'Ece Editör' },
      approvedBy: { id: users.approverA.id, fullName: 'Onur Onaylayıcı' },
      approvedAt: '2026-02-03T09:00:00.000Z',
      publishedAt: '2026-02-04T09:00:00.000Z',
      createdAt: expect.any(String),
      changeSummary: 'Madde 3 güncellendi',
      fileSize: blankDocx.length,
      canEdit: false, // already in force
    });
    expect(rows[2]).toMatchObject({ revisionNo: 0, status: 'SUPERSEDED', isCurrent: false, approvedBy: { fullName: 'Kader Kalite' } });
    expect(rows[0]).toMatchObject({
      revisionNo: 2,
      status: 'DRAFT',
      isCurrent: false,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      changeSummary: null,
      preparedBy: { fullName: 'Onur Onaylayıcı' },
    });
  });

  it('marks exactly one revision as the one in force', async () => {
    const rows = await history(users.admin.token, docs.published.id);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.revisionNo)).toEqual([1]);
  });

  it('flags the open draft as editable for people who may edit it only', async () => {
    const editable = async (who: Label) => (await history(users[who].token, docs.published.id)).filter((row) => row.canEdit).map((row) => row.revisionNo);

    expect(await editable('admin')).toEqual([2]);
    expect(await editable('qm')).toEqual([2]);
    expect(await editable('editorA')).toEqual([2]);
    expect(await editable('approverA')).toEqual([2]);
  });

  it('lets readers see only the revision in force', async () => {
    const rows = await history(users.reader.token, docs.published.id);
    expect(rows.map((row) => [row.revisionNo, row.isCurrent, row.canEdit])).toEqual([[1, true, false]]);
  });

  it('lets an editor of another department see only the revision in force', async () => {
    const rows = await history(users.editorB.token, docs.published.id);
    expect(rows.map((row) => row.revisionNo)).toEqual([1]);
  });

  it('shows the whole history to the editor of the owning department and to approvers', async () => {
    expect((await history(users.editorA.token, docs.published.id)).map((row) => row.revisionNo)).toEqual([2, 1, 0]);
    expect((await history(users.approverA.token, docs.published.id)).map((row) => row.revisionNo)).toEqual([2, 1, 0]);
  });

  it('has no revision in force for a withdrawn document', async () => {
    const rows = await history(users.qm.token, docs.withdrawn.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revisionNo: 0, status: 'APPROVED', isCurrent: false });
  });

  it('locks a revision in review', async () => {
    const rows = await history(users.admin.token, docs.inReview.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'IN_REVIEW', canEdit: false });
  });

  it.each([
    ['a reader cannot see the history of a draft', 'reader', () => docs.draftOnly.id],
    ['an editor of another department cannot see the history of a draft', 'editorB', () => docs.draftOnly.id],
    ['a reader cannot see a withdrawn document', 'reader', () => docs.withdrawn.id],
    ['nobody sees the history of another organization', 'admin', () => docs.foreign.id],
  ] as const)('%s', async (_label, who, id) => {
    const response = await get(users[who].token, `/api/documents/${id()}/revisions`).expect(404);
    expect(response.body.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('downloads', () => {
  const current = (name: DocName) => docs[name].revisions.find((revision) => revision.revisionNo === (name === 'published' ? 1 : 0))!;

  it('sends the stored file of a revision with the right headers and a readable Turkish name', async () => {
    const response = await get(users.reader.token, `/api/revisions/${current('published').id}/download`).buffer(true).parse(binaryParser).expect(200);

    expect((response.body as Buffer).equals(blankDocx)).toBe(true);
    expect(response.headers['content-type']).toContain('wordprocessingml.document');
    expect(response.headers['content-length']).toBe(String(blankDocx.length));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="MM-AA-001 Egitim Proseduru (Rev 1).docx"; ` +
        `filename*=UTF-8''MM-AA-001%20E%C4%9Fitim%20Prosed%C3%BCr%C3%BC%20%28Rev%201%29.docx`,
    );
  });

  it('names spreadsheets with their own type', async () => {
    const response = await get(users.reader.token, `/api/revisions/${current('sheet').id}/download`).buffer(true).parse(binaryParser).expect(200);

    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toContain('MM-AA-004 Form listesi (Rev 0).xlsx');
    expect((response.body as Buffer).equals(blankXlsx)).toBe(true);
  });

  it('records every download in the audit log', async () => {
    const revisionId = current('published').id;
    await get(users.editorA.token, `/api/revisions/${revisionId}/download`).buffer(true).parse(binaryParser).expect(200);

    const entries = await prisma.auditLog.findMany({ where: { entityId: revisionId, action: 'REVISION_DOWNLOADED', userId: users.editorA.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: 'Revision', organizationId: org.id });
    expect(entries[0].metadata).toMatchObject({ documentId: docs.published.id, code: 'MM-AA-001', revisionNo: 1, fileSize: blankDocx.length });
  });

  it('requires authentication and a valid id', async () => {
    await request(app.getHttpServer()).get(`/api/revisions/${current('published').id}/download`).expect(401);
    await get(users.admin.token, '/api/revisions/nope/download').expect(400);
    await get(users.admin.token, `/api/revisions/${randomUUID()}/download`).expect(404);
  });

  describe('who may download which revision', () => {
    const revision = (no: number) => docs.published.revisions[no].id;

    it.each([
      ['a reader gets the revision in force', 'reader', 1, 200],
      ['a reader does not get a superseded revision', 'reader', 0, 404],
      ['a reader does not get a draft', 'reader', 2, 404],
      ['an editor of another department gets the revision in force', 'editorB', 1, 200],
      ['an editor of another department does not get the draft', 'editorB', 2, 404],
      ['an editor of the owning department gets every revision', 'editorA', 2, 200],
      ['an editor of the owning department gets a superseded revision', 'editorA', 0, 200],
      ['an approver gets a superseded revision', 'approverA', 0, 200],
      ['a quality manager gets every revision', 'qm', 2, 200],
      ['an admin gets every revision', 'admin', 0, 200],
    ] as const)('%s', async (_label, who, no, status) => {
      const response = await get(users[who].token, `/api/revisions/${revision(no)}/download`).buffer(true).parse(binaryParser);
      expect(response.status).toBe(status);
    });

    it('does not hand out the file of a withdrawn document to readers, but does to the owning department', async () => {
      const id = docs.withdrawn.revisions[0].id;
      await get(users.reader.token, `/api/revisions/${id}/download`).expect(404);
      await get(users.editorA.token, `/api/revisions/${id}/download`).buffer(true).parse(binaryParser).expect(200);
    });

    it('does not hand out a revision of another organization', async () => {
      await get(users.admin.token, `/api/revisions/${docs.foreign.revisions[0].id}/download`).expect(404);
    });

    it('does not write an audit entry for a refused download', async () => {
      const id = docs.draftOnly.revisions[0].id;
      await get(users.reader.token, `/api/revisions/${id}/download`).expect(404);
      expect(await prisma.auditLog.count({ where: { entityId: id, action: 'REVISION_DOWNLOADED' } })).toBe(0);
    });
  });

  describe('a revision whose file is missing from storage', () => {
    it('answers 404 with a clear code and records nothing', async () => {
      const id = docs.noFile.revisions[0].id;

      const response = await get(users.admin.token, `/api/revisions/${id}/download`).expect(404);

      expect(response.body.code).toBe('REVISION_FILE_MISSING');
      expect(await prisma.auditLog.count({ where: { entityId: id, action: 'REVISION_DOWNLOADED' } })).toBe(0);
    });
  });

  describe('GET /api/documents/:id/download (revision in force)', () => {
    it('sends the revision in force', async () => {
      const where = { entityId: docs.published.revisions[1].id, action: 'REVISION_DOWNLOADED', userId: users.reader.id };
      const before = await prisma.auditLog.count({ where });
      const response = await get(users.reader.token, `/api/documents/${docs.published.id}/download`).buffer(true).parse(binaryParser).expect(200);

      expect((response.body as Buffer).equals(blankDocx)).toBe(true);
      expect(response.headers['content-disposition']).toContain('(Rev 1).docx');
      expect(await prisma.auditLog.count({ where })).toBe(before + 1);
    });

    it('says so when nothing is in force yet', async () => {
      const response = await get(users.admin.token, `/api/documents/${docs.draftOnly.id}/download`).expect(404);
      expect(response.body.code).toBe('NO_PUBLISHED_REVISION');
    });

    it('does not reveal documents the user may not see', async () => {
      await get(users.reader.token, `/api/documents/${docs.draftOnly.id}/download`).expect(404);
      await get(users.admin.token, `/api/documents/${docs.foreign.id}/download`).expect(404);
      await get(users.admin.token, `/api/documents/${randomUUID()}/download`).expect(404);
    });

    it('requires authentication and a valid id', async () => {
      await request(app.getHttpServer()).get(`/api/documents/${docs.published.id}/download`).expect(401);
      await get(users.admin.token, '/api/documents/nope/download').expect(400);
    });
  });
});
