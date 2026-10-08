process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DashboardStatsDto, PaginatedDto, PublicationListItemDto } from '@iso-dms/shared';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

let app: INestApplication;
const org = {} as { id: string; deptA: string; deptB: string; category: string };
type Label = 'admin' | 'qm' | 'reader' | 'editorA' | 'editorB' | 'editorNoDept' | 'approverA' | 'approverB';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
let codeCounter = 0;

async function createDocument(options: {
  status?: DocumentStatus;
  departmentId?: string;
  title?: string;
  firstPublishedAt?: Date | null;
  revisedAt?: Date | null;
  withdrawnAt?: Date | null;
  withdrawalReason?: string;
  organizationId?: string;
  categoryId?: string;
  ownerId?: string;
}) {
  const sequenceNo = 600 + codeCounter++;
  return prisma.document.create({
    data: {
      organizationId: options.organizationId ?? org.id,
      categoryId: options.categoryId ?? org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: options.ownerId ?? users.editorA.id,
      code: `LL-AA-${sequenceNo}`,
      sequenceNo,
      title: options.title ?? `Liste denemesi ${sequenceNo}`,
      fileType: 'DOCX',
      status: options.status ?? 'PUBLISHED',
      firstPublishedAt: options.firstPublishedAt,
      revisedAt: options.revisedAt,
      withdrawnAt: options.withdrawnAt,
      withdrawalReason: options.withdrawalReason,
    },
  });
}

const get = (token: string, path: string, query: Record<string, string | number> = {}) =>
  request(app.getHttpServer()).get(path).query(query).set(auth(token));
const list = async (token: string, kind: 'new' | 'revised' | 'withdrawn', query: Record<string, string | number> = {}) =>
  (await get(token, `/api/lists/${kind}`, { pageSize: 100, ...query }).expect(200)).body as PaginatedDto<PublicationListItemDto>;
/** The codes of the list, restricted to the documents this suite created for the check. */
const codesOf = (page: PaginatedDto<PublicationListItemDto>, own: string[]) => page.items.map((item) => item.code).filter((code) => own.includes(code));
const stats = async (token: string) => (await get(token, '/api/dashboard/stats').expect(200)).body as DashboardStatsDto;

beforeAll(async () => {
  app = await createTestApp();

  const organization = await prisma.organization.create({ data: { name: `Lists ${suffix}`, slug: `lists-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `lists-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'LL' } })).id;

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@lists.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('editorNoDept', 'EDITOR', null);
  await makeUser('approverA', 'APPROVER', org.deptA);
  await makeUser('approverB', 'APPROVER', org.deptB);

  // A published document of another organization, new in every list
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@lists.local', fullName: 'F', passwordHash: 'x' } });
  await prisma.document.create({
    data: {
      organizationId: foreign.id,
      categoryId: foreignCategory.id,
      departmentId: foreignDept.id,
      ownerId: foreignUser.id,
      code: 'FC-FF-001',
      sequenceNo: 1,
      title: 'Foreign',
      fileType: 'DOCX',
      status: 'PUBLISHED',
      firstPublishedAt: daysAgo(1),
      revisedAt: daysAgo(1),
    },
  });
});

afterAll(async () => {
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
});

describe('access and validation', () => {
  it.each(['new', 'revised', 'withdrawn'])('requires authentication for /lists/%s', async (kind) => {
    await request(app.getHttpServer()).get(`/api/lists/${kind}`).expect(401);
  });

  it('keeps the withdrawn list from readers, who never see withdrawn documents', async () => {
    const response = await get(users.reader.token, '/api/lists/withdrawn').expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
    await get(users.reader.token, '/api/lists/new').expect(200);
    await get(users.reader.token, '/api/lists/revised').expect(200);
  });

  it.each([
    ['an unknown period', { period: '365' }],
    ['page 0', { page: 0 }],
    ['a page size above the maximum', { pageSize: 101 }],
    ['a department that is not a uuid', { departmentId: 'abc' }],
    ['a search text that is too long', { search: 'x'.repeat(101) }],
    ['an unknown parameter', { sortBy: 'code' }],
  ])('rejects %s', async (_label, query) => {
    await get(users.qm.token, '/api/lists/new', query as Record<string, string | number>).expect(400);
  });
});

describe('what each list holds', () => {
  const dated = {} as Record<string, string>;

  beforeAll(async () => {
    const made = {
      newOnly: await createDocument({ firstPublishedAt: daysAgo(3) }),
      revisedOnly: await createDocument({ firstPublishedAt: daysAgo(200), revisedAt: daysAgo(3) }),
      both: await createDocument({ firstPublishedAt: daysAgo(10), revisedAt: daysAgo(2) }),
      old: await createDocument({ firstPublishedAt: daysAgo(200), revisedAt: daysAgo(150) }),
      draft: await createDocument({ status: 'DRAFT', firstPublishedAt: null }),
      inReview: await createDocument({ status: 'IN_REVIEW', firstPublishedAt: null }),
      // Published, revised, and withdrawn since: no longer news
      goneAfterNews: await createDocument({ status: 'WITHDRAWN', firstPublishedAt: daysAgo(5), revisedAt: daysAgo(4), withdrawnAt: daysAgo(1), withdrawalReason: 'Süreç kalktı' }),
      withdrawnA: await createDocument({ status: 'WITHDRAWN', firstPublishedAt: daysAgo(100), withdrawnAt: daysAgo(2), withdrawalReason: 'A birimi süreci kalktı' }),
      withdrawnB: await createDocument({ status: 'WITHDRAWN', departmentId: org.deptB, firstPublishedAt: daysAgo(100), withdrawnAt: daysAgo(2), withdrawalReason: 'B birimi süreci kalktı' }),
      withdrawnOld: await createDocument({ status: 'WITHDRAWN', firstPublishedAt: daysAgo(300), withdrawnAt: daysAgo(100), withdrawalReason: 'Eskiden kalktı' }),
    };
    for (const [name, document] of Object.entries(made)) dated[name] = document.code;
  });

  const code = (...names: string[]) => names.map((name) => dated[name]);
  const own = () => Object.values(dated);

  it('lists new documents: first published lately and in force, for everybody', async () => {
    for (const who of ['reader', 'editorA', 'approverA', 'qm', 'admin'] as const) {
      const page = await list(users[who].token, 'new');
      expect(codesOf(page, own()).sort()).toEqual(code('newOnly', 'both').sort());
    }
  });

  it('lists revised documents: the revision in force is recent, and the document is in force', async () => {
    for (const who of ['reader', 'editorB', 'qm'] as const) {
      const page = await list(users[who].token, 'revised');
      expect(codesOf(page, own()).sort()).toEqual(code('revisedOnly', 'both').sort());
    }
  });

  it('shows a document that is both new and revised in both lists', async () => {
    expect(codesOf(await list(users.reader.token, 'new'), own())).toContain(dated.both);
    expect(codesOf(await list(users.reader.token, 'revised'), own())).toContain(dated.both);
  });

  it('never lists drafts, documents in review, or documents withdrawn since, as news', async () => {
    for (const kind of ['new', 'revised'] as const) {
      const page = await list(users.admin.token, kind, { period: 'all' });
      const codes = codesOf(page, own());
      for (const name of ['draft', 'inReview', 'goneAfterNews']) expect(codes).not.toContain(dated[name]);
    }
  });

  describe('the withdrawn list', () => {
    it('shows editors the withdrawn documents of their own department only', async () => {
      expect(codesOf(await list(users.editorA.token, 'withdrawn'), own()).sort()).toEqual(code('withdrawnA', 'goneAfterNews').sort());
      expect(codesOf(await list(users.editorB.token, 'withdrawn'), own())).toEqual(code('withdrawnB'));
    });

    it('shows an editor without a department nothing', async () => {
      expect(codesOf(await list(users.editorNoDept.token, 'withdrawn'), own())).toEqual([]);
    });

    it('shows approvers, quality managers and administrators all of them', async () => {
      for (const who of ['approverA', 'approverB', 'qm', 'admin'] as const) {
        expect(codesOf(await list(users[who].token, 'withdrawn'), own()).sort()).toEqual(code('withdrawnA', 'withdrawnB', 'goneAfterNews').sort());
      }
    });

    it('carries when and why', async () => {
      const page = await list(users.qm.token, 'withdrawn');
      const item = page.items.find((candidate) => candidate.code === dated.withdrawnA)!;

      expect(item).toMatchObject({
        status: 'WITHDRAWN',
        withdrawalReason: 'A birimi süreci kalktı',
        department: { code: 'AA' },
        revisionNo: null,
        canEdit: false,
      });
      expect(Math.abs(new Date(item.withdrawnAt!).getTime() - daysAgo(2).getTime())).toBeLessThan(5 * 60 * 1000);
    });
  });

  it('never shows documents of another organization', async () => {
    for (const kind of ['new', 'revised'] as const) {
      expect((await list(users.admin.token, kind, { period: 'all' })).items.map((item) => item.code)).not.toContain('FC-FF-001');
    }
  });
});

describe('the period', () => {
  const periodCodes = {} as Record<string, string>;

  beforeAll(async () => {
    for (const days of [3, 20, 60, 200]) periodCodes[`d${days}`] = (await createDocument({ title: 'Dönem denemesi', firstPublishedAt: daysAgo(days) })).code;
    // Published, but not through the approval flow of today: it has no first publication date at all
    periodCodes.undated = (await createDocument({ title: 'Dönem denemesi', firstPublishedAt: null })).code;
  });

  const inPeriod = async (period?: string) =>
    codesOf(await list(users.reader.token, 'new', { search: 'Dönem denemesi', ...(period ? { period } : {}) }), Object.values(periodCodes)).sort();
  const names = (...days: number[]) => days.map((day) => periodCodes[`d${day}`]).sort();

  it('looks back 30 days unless told otherwise', async () => {
    expect(await inPeriod()).toEqual(names(3, 20));
  });

  it.each([
    ['7', [3]],
    ['30', [3, 20]],
    ['90', [3, 20, 60]],
    ['all', [3, 20, 60, 200]],
  ])('looks back %s days', async (period, days) => {
    expect(await inPeriod(period)).toEqual(names(...days));
  });

  it('leaves documents without the date out, even when everything is asked for', async () => {
    expect(await inPeriod('all')).not.toContain(periodCodes.undated);
  });
});

describe('ordering, filters and pages', () => {
  const codes: string[] = [];

  beforeAll(async () => {
    const same = daysAgo(4);
    const makes = [
      { title: 'Sıra Alfa', firstPublishedAt: daysAgo(9) },
      { title: 'Sıra Beta', firstPublishedAt: same },
      { title: 'Sıra Gama', firstPublishedAt: same },
      { title: 'Sıra Delta', firstPublishedAt: daysAgo(1), departmentId: org.deptB },
      { title: 'Yüzde % ve _ işaretli', firstPublishedAt: daysAgo(2) },
    ];
    for (const make of makes) codes.push((await createDocument(make)).code);
  });

  const search = async (query: Record<string, string | number>) => list(users.reader.token, 'new', { search: 'Sıra', ...query });

  it('lists the newest first and breaks ties by code', async () => {
    const page = await search({});
    // delta (1 day), then the two of 4 days by code, then alfa (9 days)
    expect(page.items.map((item) => item.code)).toEqual([codes[3], codes[1], codes[2], codes[0]]);
  });

  it('filters by department', async () => {
    const page = await search({ departmentId: org.deptB });
    expect(page.items.map((item) => item.code)).toEqual([codes[3]]);
  });

  it('searches code and title, in any letter case', async () => {
    expect((await list(users.reader.token, 'new', { search: 'sıra beta' })).items.map((item) => item.code)).toEqual([codes[1]]);
    expect((await list(users.reader.token, 'new', { search: codes[0].toLowerCase() })).items.map((item) => item.code)).toEqual([codes[0]]);
  });

  it('treats % and _ as plain characters', async () => {
    expect((await list(users.reader.token, 'new', { search: '%' })).items.map((item) => item.code)).toEqual([codes[4]]);
    expect((await list(users.reader.token, 'new', { search: 'Sıra_' })).items).toEqual([]);
  });

  it('combines the filters and the period', async () => {
    expect((await search({ period: '7' })).items.map((item) => item.code)).toEqual([codes[3], codes[1], codes[2]]);
    expect((await search({ period: '7', departmentId: org.deptA })).items.map((item) => item.code)).toEqual([codes[1], codes[2]]);
  });

  it('pages through the result with a stable total', async () => {
    const first = await search({ pageSize: 3, page: 1 });
    const second = await search({ pageSize: 3, page: 2 });

    expect(first).toMatchObject({ total: 4, page: 1, pageSize: 3 });
    expect(first.items.map((item) => item.code)).toEqual([codes[3], codes[1], codes[2]]);
    expect(second.items.map((item) => item.code)).toEqual([codes[0]]);
    expect((await search({ pageSize: 3, page: 9 })).items).toEqual([]);
  });

  it('describes each document like the document list does', async () => {
    const [item] = (await search({ departmentId: org.deptB })).items;
    expect(item).toEqual({
      id: expect.any(String),
      code: codes[3],
      title: 'Sıra Delta',
      fileType: 'DOCX',
      status: 'PUBLISHED',
      categoryId: org.category,
      department: { id: org.deptB, name: 'Beta', code: 'BB' },
      firstPublishedAt: expect.any(String),
      revisedAt: null,
      pdfStatus: null,
      revisionNo: null,
      canEdit: false,
      withdrawnAt: null,
      withdrawalReason: null,
    });
  });
});

describe('the dashboard counters', () => {
  const counted = {} as Record<string, string>;

  beforeAll(async () => {
    // The counters look back 30 days exactly: one day inside, one day outside
    counted.newIn = (await createDocument({ title: 'Sayaç', firstPublishedAt: daysAgo(29) })).code;
    counted.newOut = (await createDocument({ title: 'Sayaç', firstPublishedAt: daysAgo(31) })).code;
    counted.revisedIn = (await createDocument({ title: 'Sayaç', firstPublishedAt: daysAgo(300), revisedAt: daysAgo(29) })).code;
    counted.revisedOut = (await createDocument({ title: 'Sayaç', firstPublishedAt: daysAgo(300), revisedAt: daysAgo(31) })).code;
    counted.withdrawnA = (await createDocument({ title: 'Sayaç', status: 'WITHDRAWN', firstPublishedAt: daysAgo(300), withdrawnAt: daysAgo(29), withdrawalReason: 'x' })).code;
    counted.withdrawnB = (await createDocument({ title: 'Sayaç', status: 'WITHDRAWN', departmentId: org.deptB, firstPublishedAt: daysAgo(300), withdrawnAt: daysAgo(29), withdrawalReason: 'x' })).code;
    counted.withdrawnOut = (await createDocument({ title: 'Sayaç', status: 'WITHDRAWN', firstPublishedAt: daysAgo(300), withdrawnAt: daysAgo(31), withdrawalReason: 'x' })).code;
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/stats').expect(401);
  });

  it('counts the published documents, and what is new, revised or withdrawn in the last 30 days', async () => {
    const before = await stats(users.admin.token);
    expect(before.totalDocuments).toBeGreaterThan(0);

    await createDocument({ title: 'Sayaç', firstPublishedAt: daysAgo(5) });
    const after = await stats(users.admin.token);

    expect(after).toMatchObject({
      totalDocuments: before.totalDocuments + 1,
      newlyPublished: before.newlyPublished + 1,
      revised: before.revised,
      withdrawn: before.withdrawn,
    });
  });

  it('agrees with the lists it leads to, for every role', async () => {
    for (const who of ['reader', 'editorA', 'editorB', 'editorNoDept', 'approverA', 'qm', 'admin'] as const) {
      const token = users[who].token;
      const numbers = await stats(token);

      expect(numbers.newlyPublished).toBe((await list(token, 'new', { pageSize: 1 })).total);
      expect(numbers.revised).toBe((await list(token, 'revised', { pageSize: 1 })).total);
      if (who === 'reader') expect(numbers.withdrawn).toBeNull();
      else expect(numbers.withdrawn).toBe((await list(token, 'withdrawn', { pageSize: 1 })).total);
    }
  });

  it('counts only the withdrawn documents the user may see', async () => {
    const asAdmin = await stats(users.admin.token);
    const asEditorA = await stats(users.editorA.token);
    const asEditorB = await stats(users.editorB.token);
    const asNoDept = await stats(users.editorNoDept.token);

    // A and B each hold one counted withdrawal here, and the administrator sees both
    expect(asEditorA.withdrawn).toBeGreaterThanOrEqual(1);
    expect(asEditorB.withdrawn).toBeGreaterThanOrEqual(1);
    expect(asAdmin.withdrawn).toBe(asEditorA.withdrawn! + asEditorB.withdrawn!);
    expect(asNoDept.withdrawn).toBe(0);
  });

  it('hides what the role has no business with', async () => {
    expect(await stats(users.reader.token)).toMatchObject({ withdrawn: null, awaitingApproval: null });
    expect(await stats(users.editorA.token)).toMatchObject({ awaitingApproval: null });
    for (const who of ['approverA', 'qm', 'admin'] as const) {
      const numbers = await stats(users[who].token);
      expect(numbers.withdrawn).not.toBeNull();
      expect(numbers.awaitingApproval).not.toBeNull();
    }
  });

  it('counts the approval steps that wait for the user, like the approvals list does', async () => {
    const document = await createDocument({ status: 'IN_REVIEW', firstPublishedAt: null, title: 'Onay bekleyen' });
    const revision = await prisma.revision.create({
      data: {
        organizationId: org.id,
        documentId: document.id,
        revisionNo: 0,
        status: 'IN_REVIEW',
        storageKey: 'lists/none',
        fileSize: 1,
        checksum: 'x',
        editorKey: randomUUID(),
        preparedById: users.editorA.id,
      },
    });
    const before = { approverA: await stats(users.approverA.token), approverB: await stats(users.approverB.token), qm: await stats(users.qm.token), admin: await stats(users.admin.token) };
    await prisma.documentRequest.create({
      data: {
        organizationId: org.id,
        type: 'NEW',
        documentId: document.id,
        revisionId: revision.id,
        requestedById: users.editorA.id,
        reason: '',
        steps: { create: [{ organizationId: org.id, stepOrder: 1, approverRole: 'APPROVER' }, { organizationId: org.id, stepOrder: 2, approverRole: 'QUALITY_MANAGER' }] },
      },
    });

    // The first step is the turn of the approvers of department A and of the administrator
    expect((await stats(users.approverA.token)).awaitingApproval).toBe(before.approverA.awaitingApproval! + 1);
    expect((await stats(users.admin.token)).awaitingApproval).toBe(before.admin.awaitingApproval! + 1);
    // not of another department, and not of the quality manager before the first step is approved
    expect((await stats(users.approverB.token)).awaitingApproval).toBe(before.approverB.awaitingApproval);
    expect((await stats(users.qm.token)).awaitingApproval).toBe(before.qm.awaitingApproval);
    const pending = (await get(users.approverA.token, '/api/approvals/pending', { pageSize: 1 }).expect(200)).body.total;
    expect((await stats(users.approverA.token)).awaitingApproval).toBe(pending);
  });
});
