process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { RevisionComparisonDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { buildDocx, buildXlsx, field, paragraph } from './helpers/office-builders';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;

const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'approverA' | 'editorA' | 'editorB' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;
type Revision = { id: string; revisionNo: number };
const docs = {} as Record<'word' | 'sheet' | 'broken' | 'foreign', { id: string; revisions: Revision[] }>;

const get = (token: string, documentId: string, from: string, to: string) =>
  request(app.getHttpServer())
    .get(`/api/documents/${documentId}/revisions/compare?from=${from}&to=${to}`)
    .set({ Authorization: `Bearer ${token}` });

async function createDocument(options: {
  code: string;
  organizationId?: string;
  departmentId: string;
  status: DocumentStatus;
  fileType: 'DOCX' | 'XLSX';
  revisions: { status: RevisionStatus; content: Buffer | null; current?: boolean }[];
}) {
  const organizationId = options.organizationId ?? org.id;
  const document = await prisma.document.create({
    data: {
      organizationId,
      categoryId: org.category,
      departmentId: options.departmentId,
      ownerId: users.editorA.id,
      code: options.code,
      sequenceNo: Number(options.code.split('-').at(-1)),
      title: `Doküman ${options.code}`,
      fileType: options.fileType,
      status: options.status,
    },
  });
  const revisions: Revision[] = [];
  for (const [revisionNo, spec] of options.revisions.entries()) {
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo, fileType: options.fileType });
    const content = spec.content ?? Buffer.from('x');
    if (spec.content) await storage.put(storageKey, content, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId,
        documentId: document.id,
        revisionNo,
        status: spec.status,
        storageKey,
        fileSize: content.length,
        checksum: createHash('sha256').update(content).digest('hex'),
        editorKey: randomUUID(),
        preparedById: users.editorA.id,
      },
    });
    revisions.push({ id: revision.id, revisionNo });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, revisions };
}

beforeAll(async () => {
  app = await createTestApp();
  storage = app.get(StorageService);

  const organization = await prisma.organization.create({ data: { name: `Compare ${suffix}`, slug: `compare-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `compare-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha Birimi', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta Birimi', code: 'BB' } })).id;
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'Dış Birim', code: 'DD' } });
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Prosedürler', slug: 'procedures', codePrefix: 'MM' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@compare.local`, fullName: label, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('approverA', 'APPROVER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('reader', 'READER', org.deptA);

  const rev0 = await buildDocx(`${field('DOC_REVISION_NO', '0')}${paragraph('1. Amaç')}${paragraph('Kayıtlar beş yıl süreyle saklanır.')}${paragraph('Eski madde')}`);
  const rev1 = await buildDocx(`${field('DOC_REVISION_NO', '1')}${paragraph('1. Amaç')}${paragraph('Kayıtlar on yıl süreyle saklanır.')}${paragraph('Tamamen başka bir bölüm')}`);
  const rev2 = await buildDocx(`${paragraph('1. Amaç')}${paragraph('Taslakta değişti.')}`);
  docs.word = await createDocument({
    code: 'MM-AA-001',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    fileType: 'DOCX',
    revisions: [
      { status: 'SUPERSEDED', content: rev0 },
      { status: 'APPROVED', content: rev1, current: true },
      { status: 'DRAFT', content: rev2 },
    ],
  });
  docs.sheet = await createDocument({
    code: 'MM-AA-002',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    fileType: 'XLSX',
    revisions: [
      { status: 'SUPERSEDED', content: await buildXlsx({ Sayfa1: { A1: 'Ürün', B1: 10, A2: 'Çay' } }) },
      { status: 'APPROVED', content: await buildXlsx({ Sayfa1: { A1: 'Ürün', B1: 12, A3: 'Kahve' } }), current: true },
    ],
  });
  docs.broken = await createDocument({
    code: 'MM-AA-003',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    fileType: 'DOCX',
    revisions: [
      { status: 'SUPERSEDED', content: Buffer.from('this is not a zip package') },
      { status: 'APPROVED', content: rev1, current: true },
      { status: 'DRAFT', content: null },
    ],
  });
  docs.foreign = await createDocument({
    code: 'MM-DD-001',
    organizationId: foreign.id,
    departmentId: foreignDept.id,
    status: 'PUBLISHED',
    fileType: 'DOCX',
    revisions: [
      { status: 'SUPERSEDED', content: rev0 },
      { status: 'APPROVED', content: rev1, current: true },
    ],
  });
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

const auditCount = (documentId: string) => prisma.auditLog.count({ where: { action: 'REVISIONS_COMPARED', entityId: documentId } });

describe('GET /api/documents/:id/revisions/compare (Word)', () => {
  it('compares the paragraphs, leaving out the document fields', async () => {
    const [r0, r1] = docs.word.revisions;
    const body = (await get(users.admin.token, docs.word.id, r0.id, r1.id).expect(200)).body as RevisionComparisonDto;

    expect(body).toMatchObject({
      fileType: 'DOCX',
      from: { id: r0.id, revisionNo: 0, status: 'SUPERSEDED' },
      to: { id: r1.id, revisionNo: 1, status: 'APPROVED' },
      summary: { added: 1, removed: 1, changed: 1 },
      cells: [],
    });
    expect(body.blocks.map((block) => block.kind)).toEqual(['equal', 'changed', 'removed', 'added']);
    expect(body.blocks[1].segments.filter((s) => s.type !== 'equal').map((s) => `${s.type}:${s.text}`)).toEqual(['removed:beş', 'added:on']);
  });

  it('compares in the other direction too', async () => {
    const [r0, r1] = docs.word.revisions;
    const body = (await get(users.qm.token, docs.word.id, r1.id, r0.id).expect(200)).body as RevisionComparisonDto;
    expect(body.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(body.from.revisionNo).toBe(1);
  });

  it('lets the owning department and the approving roles compare a draft with the revision in force', async () => {
    const [, r1, draft] = docs.word.revisions;
    for (const label of ['editorA', 'approverA', 'qm', 'admin'] as const) {
      const body = (await get(users[label].token, docs.word.id, r1.id, draft.id).expect(200)).body as RevisionComparisonDto;
      expect(body.to.status).toBe('DRAFT');
    }
  });

  it('reports a revision the user may not open as missing, so only people who can open both can compare', async () => {
    const [r0, r1, draft] = docs.word.revisions;
    // An editor of another department and a reader see the revision in force only
    for (const label of ['editorB', 'reader'] as const) {
      const response = await get(users[label].token, docs.word.id, r0.id, r1.id).expect(404);
      expect(response.body.code).toBe('REVISION_NOT_FOUND');
      await get(users[label].token, docs.word.id, r1.id, draft.id).expect(404);
    }
  });

  it('refuses to compare a revision with itself', async () => {
    const [r0] = docs.word.revisions;
    const response = await get(users.admin.token, docs.word.id, r0.id, r0.id).expect(400);
    expect(response.body.code).toBe('SAME_REVISION');
  });

  it('refuses a revision of another document, an unknown one and malformed ids', async () => {
    const [r0] = docs.word.revisions;
    const [sheet0] = docs.sheet.revisions;
    expect((await get(users.admin.token, docs.word.id, r0.id, sheet0.id).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    expect((await get(users.admin.token, docs.word.id, r0.id, randomUUID()).expect(404)).body.code).toBe('REVISION_NOT_FOUND');
    await get(users.admin.token, docs.word.id, r0.id, 'not-an-id').expect(400);
    await request(app.getHttpServer()).get(`/api/documents/${docs.word.id}/revisions/compare?from=${r0.id}`).set({ Authorization: `Bearer ${users.admin.token}` }).expect(400);
  });

  it('does not show a document of another organization or without a login', async () => {
    const [f0, f1] = docs.foreign.revisions;
    expect((await get(users.admin.token, docs.foreign.id, f0.id, f1.id).expect(404)).body.code).toBe('DOCUMENT_NOT_FOUND');
    await request(app.getHttpServer()).get(`/api/documents/${docs.word.id}/revisions/compare?from=${f0.id}&to=${f1.id}`).expect(401);
  });
});

describe('GET /api/documents/:id/revisions/compare (Excel)', () => {
  it('lists the cells that differ', async () => {
    const [r0, r1] = docs.sheet.revisions;
    const body = (await get(users.admin.token, docs.sheet.id, r0.id, r1.id).expect(200)).body as RevisionComparisonDto;

    expect(body.fileType).toBe('XLSX');
    expect(body.blocks).toEqual([]);
    expect(body.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(body.cells).toEqual([
      { kind: 'changed', sheet: 'Sayfa1', address: 'B1', from: '10', to: '12' },
      { kind: 'removed', sheet: 'Sayfa1', address: 'A2', from: 'Çay', to: null },
      { kind: 'added', sheet: 'Sayfa1', address: 'A3', from: null, to: 'Kahve' },
    ]);
  });
});

describe('unreadable and missing files', () => {
  it('answers 422 for a file that is not an Office package and 404 for one missing from storage', async () => {
    const [broken, current, missing] = docs.broken.revisions;
    const unreadable = await get(users.admin.token, docs.broken.id, broken.id, current.id).expect(422);
    expect(unreadable.body.code).toBe('REVISION_FILE_UNREADABLE');
    const gone = await get(users.admin.token, docs.broken.id, current.id, missing.id).expect(404);
    expect(gone.body.code).toBe('REVISION_FILE_MISSING');
  });
});

describe('audit trail', () => {
  it('records who compared which revisions, once per comparison and not for refused ones', async () => {
    const [r0, r1] = docs.word.revisions;
    const before = await auditCount(docs.word.id);

    await get(users.approverA.token, docs.word.id, r0.id, r1.id).expect(200);
    await get(users.editorB.token, docs.word.id, r0.id, r1.id).expect(404);
    await get(users.approverA.token, docs.word.id, r0.id, r0.id).expect(400);

    expect(await auditCount(docs.word.id)).toBe(before + 1);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'REVISIONS_COMPARED', entityId: docs.word.id, userId: users.approverA.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toMatchObject({
      entityType: 'Document',
      organizationId: org.id,
      metadata: { code: 'MM-AA-001', from: { id: r0.id, revisionNo: 0 }, to: { id: r1.id, revisionNo: 1 } },
    });
  });
});
