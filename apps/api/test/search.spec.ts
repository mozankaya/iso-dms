process.env.LOGIN_RATE_LIMIT = '1000';

import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PaginatedDto, SearchResultDto } from '@iso-dms/shared';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { SearchIndexService } from '../src/modules/search/search-index.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { publishThroughApproval } from './helpers/approval-flow';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { startFakeCommandServer, type FakeCommandServer } from './helpers/fake-command-server';
import { buildDocx, buildXlsx, paragraph } from './helpers/office-builders';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let storage: StorageService;
let index: SearchIndexService;
let commandServer: FakeCommandServer;

const org = {} as { id: string; deptA: string; deptB: string; category: string; otherCategory: string };
type Label = 'admin' | 'qm' | 'approverA' | 'editorA' | 'editorB' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;
type Revision = { id: string; revisionNo: number };
type Doc = { id: string; code: string; revisions: Revision[] };
const docs = {} as Record<string, Doc>;
let sequence = 0;

const find = (token: string, query: string) =>
  request(app.getHttpServer()).get(`/api/search?${query}`).set({ Authorization: `Bearer ${token}` });
const found = async (token: string, q: string, extra = '') =>
  ((await find(token, `q=${encodeURIComponent(q)}${extra}`).expect(200)).body as PaginatedDto<SearchResultDto>);
const codes = (page: PaginatedDto<SearchResultDto>) => page.items.map((item) => item.code);

async function createDocument(options: {
  title: string;
  departmentId?: string;
  categoryId?: string;
  organizationId?: string;
  status?: DocumentStatus;
  fileType?: 'DOCX' | 'XLSX';
  revisions: { status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'; content: Buffer | null; current?: boolean }[];
}): Promise<Doc> {
  const organizationId = options.organizationId ?? org.id;
  const fileType = options.fileType ?? 'DOCX';
  sequence += 1;
  const code = `MM-AA-${String(sequence).padStart(3, '0')}`;
  const document = await prisma.document.create({
    data: {
      organizationId,
      categoryId: options.categoryId ?? org.category,
      departmentId: options.departmentId ?? org.deptA,
      ownerId: users.editorA.id,
      code,
      sequenceNo: sequence,
      title: options.title,
      fileType,
      status: options.status ?? 'PUBLISHED',
    },
  });
  const revisions: Revision[] = [];
  for (const [revisionNo, spec] of options.revisions.entries()) {
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo, fileType });
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
        publishedAt: spec.status === 'DRAFT' ? null : new Date(),
      },
    });
    revisions.push({ id: revision.id, revisionNo });
    if (spec.current) await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
  }
  return { id: document.id, code, revisions };
}

/** A published Word document whose current revision has been indexed. */
async function publishedDoc(title: string, ...paragraphs: string[]) {
  const doc = await createDocument({
    title,
    revisions: [{ status: 'APPROVED', content: await buildDocx(paragraphs.map((text) => paragraph(text)).join('')), current: true }],
  });
  await index.index(doc.revisions[0].id);
  return doc;
}

beforeAll(async () => {
  // Sending a document to review asks the document server whether anybody has it open: a stand-in answers
  commandServer = await startFakeCommandServer(process.env.ONLYOFFICE_JWT_SECRET!);
  process.env.ONLYOFFICE_INTERNAL_URL = commandServer.origin;
  app = await createTestApp();
  storage = app.get(StorageService);
  index = app.get(SearchIndexService);

  const organization = await prisma.organization.create({ data: { name: `Search ${suffix}`, slug: `search-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `search-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha Birimi', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta Birimi', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Prosedürler', slug: 'procedures', codePrefix: 'MM' } })).id;
  org.otherCategory = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Talimatlar', slug: 'instructions', codePrefix: 'TL' } })).id;
  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'Dış Birim', code: 'DD' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'Dış', slug: 'outside', codePrefix: 'DS' } });

  const makeUser = async (label: Label, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@search.local`, fullName: label, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('approverA', 'APPROVER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('reader', 'READER', org.deptA);

  docs.complaints = await publishedDoc('Müşteri Memnuniyeti Prosedürü', 'Müşteri şikâyetleri yazılı olarak alınır.', 'Şikâyet kayıtları on yıl süreyle saklanır.');
  docs.retention = await publishedDoc('Kayıt Kontrolü', 'Kayıtların saklama süresi dolduğunda imha edilir.', 'Saklama süresi bu prosedürde tanımlanır.');
  docs.order = await publishedDoc('Sıralama Denemesi', 'Önce kontrol sonra kayıt yapılır.');
  docs.sheet = await createDocument({
    title: 'Tedarikçi Listesi',
    fileType: 'XLSX',
    categoryId: org.otherCategory,
    departmentId: org.deptB,
    revisions: [{ status: 'APPROVED', content: await buildXlsx({ Sayfa1: { A1: 'Tedarikçi', B1: 'Çelik Dökümhanesi', A2: 'Nakliye Ltd.' } }), current: true }],
  });
  await index.index(docs.sheet.revisions[0].id);

  docs.draft = await createDocument({
    title: 'Taslak Doküman',
    status: 'DRAFT',
    revisions: [{ status: 'DRAFT', content: await buildDocx(paragraph('Gizli taslak içeriği yalnızca yazarlar içindir.')) }],
  });
  docs.withdrawn = await createDocument({
    title: 'Kaldırılmış Doküman',
    status: 'WITHDRAWN',
    revisions: [{ status: 'APPROVED', content: await buildDocx(paragraph('Kaldırılmış doküman içeriği artık geçersizdir.')), current: true }],
  });
  await index.index(docs.withdrawn.revisions[0].id);

  docs.foreign = await createDocument({
    title: 'Dış Kurum Dokümanı',
    organizationId: foreign.id,
    departmentId: foreignDept.id,
    categoryId: foreignCategory.id,
    revisions: [{ status: 'APPROVED', content: await buildDocx(paragraph('Müşteri şikâyetleri başka kurumda da alınır.')), current: true }],
  });
  await index.index(docs.foreign.revisions[0].id);
});

afterAll(async () => {
  // Test cleanup only: the application never deletes revisions or their files
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
  await Promise.all(revisions.map((revision) => storage.delete(revision.storageKey).catch(() => undefined)));
  await prisma.approvalStep.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.documentRequest.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.notification.deleteMany({ where: { organizationId: { in: organizationIds } } });
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

describe('GET /api/search: finding words', () => {
  it('finds a document by a word in its content and shows where, with the hit marked', async () => {
    const page = await found(users.reader.token, 'saklama');
    expect(codes(page)).toEqual([docs.retention.code]);
    const [snippet] = page.items[0].snippets;
    expect(snippet.filter((part) => part.match).map((part) => part.text)).toEqual(expect.arrayContaining(['saklama', 'Saklama']));
    expect(snippet.map((part) => part.text).join('')).toContain('saklama süresi dolduğunda');
  });

  it('ignores Turkish letters and case in the query and in the text', async () => {
    expect(codes(await found(users.reader.token, 'SIKAYET'))).toEqual([docs.complaints.code]);
    expect(codes(await found(users.reader.token, 'şikâyetleri'))).toEqual([docs.complaints.code]);
    expect(codes(await found(users.reader.token, 'musteri'))).toEqual([docs.complaints.code]);
    expect(codes(await found(users.reader.token, 'IMHA'))).toEqual([docs.retention.code]);
  });

  it('matches the start of words (Turkish words take endings)', async () => {
    expect(codes(await found(users.reader.token, 'prosedur'))).toEqual(expect.arrayContaining([docs.complaints.code, docs.retention.code]));
    expect(codes(await found(users.reader.token, 'yazil'))).toEqual([docs.complaints.code]);
    expect(codes(await found(users.reader.token, 'edur'))).toEqual([]);
  });

  it('wants every word, in any order, and finds a phrase only as it was written', async () => {
    expect(codes(await found(users.reader.token, 'saklama imha'))).toEqual([docs.retention.code]);
    expect(codes(await found(users.reader.token, 'imha saklama'))).toEqual([docs.retention.code]);
    expect(codes(await found(users.reader.token, 'saklama musteri'))).toEqual([]);
    expect(codes(await found(users.reader.token, '"saklama süresi"'))).toEqual([docs.retention.code]);
    expect(codes(await found(users.reader.token, '"süresi saklama"'))).toEqual([]);
    // "kontrol" and "kayıt" are both in the text of 'order', but not next to each other
    expect(codes(await found(users.reader.token, 'kontrol kayıt'))).toEqual(expect.arrayContaining([docs.order.code]));
    expect(codes(await found(users.reader.token, '"kontrol kayıt"'))).toEqual([]);
  });

  it('finds a document by its code and its title', async () => {
    expect(codes(await found(users.reader.token, docs.retention.code))).toEqual([docs.retention.code]);
    expect(codes(await found(users.reader.token, 'memnuniyeti'))).toEqual([docs.complaints.code]);
    const byTitle = await found(users.reader.token, 'Kayıt Kontrolü');
    expect(byTitle.items[0].code).toBe(docs.retention.code);
    // A phrase is found by the title as well, as the title is not part of the indexed text positions
    expect(codes(await found(users.reader.token, '"Kayıt Kontrolü"'))).toEqual([docs.retention.code]);
  });

  it('puts the document whose title has the words before the ones that only mention them', async () => {
    const page = await found(users.reader.token, 'kayıt');
    expect(codes(page)[0]).toBe(docs.retention.code);
    expect(codes(page)).toEqual(expect.arrayContaining([docs.complaints.code, docs.order.code]));
  });

  it('finds the cells of an Excel document', async () => {
    const page = await found(users.admin.token, 'celik');
    expect(codes(page)).toEqual([docs.sheet.code]);
    expect(page.items[0]).toMatchObject({ fileType: 'XLSX', status: 'PUBLISHED' });
    expect(page.items[0].snippets[0].some((part) => part.match && part.text === 'Çelik')).toBe(true);
  });

  it('returns the same fields as a document list entry', async () => {
    const [item] = (await found(users.reader.token, 'imha')).items;
    expect(item).toMatchObject({
      id: docs.retention.id,
      code: docs.retention.code,
      title: 'Kayıt Kontrolü',
      status: 'PUBLISHED',
      department: { code: 'AA' },
      revisionNo: 0,
      canEdit: false,
    });
  });

  it('is not fooled by characters that mean something to the database', async () => {
    for (const q of ["a' | !b & (c):*", "'; DROP TABLE \"Document\"; --", '<-> & |', '\\%_']) {
      const response = await find(users.reader.token, `q=${encodeURIComponent(q)}`);
      expect([200, 400]).toContain(response.status);
    }
    expect(await prisma.document.count({ where: { organizationId: org.id } })).toBeGreaterThan(0);
  });
});

describe('GET /api/search: what each user may find', () => {
  it('shows only documents in force, never a draft or a withdrawn one, whoever asks', async () => {
    for (const label of ['reader', 'editorA', 'approverA', 'qm', 'admin'] as const) {
      expect(await found(users[label].token, 'gizli')).toMatchObject({ total: 0 });
      expect(await found(users[label].token, 'kaldırılmış')).toMatchObject({ total: 0 });
      expect(await found(users[label].token, docs.draft.code)).toMatchObject({ total: 0 });
    }
  });

  it('shows documents in force of every department to every role', async () => {
    for (const label of ['reader', 'editorB', 'editorA', 'approverA', 'qm', 'admin'] as const) {
      expect(codes(await found(users[label].token, 'tedarikçi'))).toEqual([docs.sheet.code]);
    }
  });

  it('never shows another organization', async () => {
    const page = await found(users.admin.token, 'şikâyetleri');
    expect(codes(page)).toEqual([docs.complaints.code]);
    expect(await found(users.admin.token, docs.foreign.code)).toMatchObject({ total: 0 });
    expect(await found(users.admin.token, 'Dış Kurum')).toMatchObject({ total: 0 });
  });

  it('needs a login', async () => {
    await request(app.getHttpServer()).get('/api/search?q=saklama').expect(401);
  });
});

describe('GET /api/search: filters, paging and validation', () => {
  it('narrows by department and category', async () => {
    expect(codes(await found(users.admin.token, 'tedarikçi', `&departmentId=${org.deptA}`))).toEqual([]);
    expect(codes(await found(users.admin.token, 'tedarikçi', `&departmentId=${org.deptB}`))).toEqual([docs.sheet.code]);
    expect(codes(await found(users.admin.token, 'tedarikçi', `&categoryId=${org.category}`))).toEqual([]);
    expect(codes(await found(users.admin.token, 'tedarikçi', `&categoryId=${org.otherCategory}`))).toEqual([docs.sheet.code]);
  });

  it('pages the ranked results and counts them all', async () => {
    const all = await found(users.reader.token, 'kayıt');
    expect(all.total).toBeGreaterThanOrEqual(3);
    const first = await found(users.reader.token, 'kayıt', '&pageSize=1&page=1');
    const second = await found(users.reader.token, 'kayıt', '&pageSize=1&page=2');
    expect(first).toMatchObject({ total: all.total, page: 1, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect([first.items[0].code, second.items[0].code]).toEqual(codes(all).slice(0, 2));
    expect((await found(users.reader.token, 'kayıt', '&page=99')).items).toEqual([]);
  });

  it('refuses a query that is too short, too long, has no words or a bad filter', async () => {
    await find(users.reader.token, 'q=a').expect(400);
    await find(users.reader.token, 'q=').expect(400);
    await find(users.reader.token, '').expect(400);
    await find(users.reader.token, `q=${'a'.repeat(101)}`).expect(400);
    await find(users.reader.token, 'q=saklama&pageSize=101').expect(400);
    await find(users.reader.token, 'q=saklama&departmentId=nope').expect(400);
    const noWords = await find(users.reader.token, `q=${encodeURIComponent('-- ()')}`).expect(400);
    expect(noWords.body.code).toBe('SEARCH_QUERY_INVALID');
  });
});

describe('the index', () => {
  it('keeps a row only for the revision in force, and the text of an older one is no longer found', async () => {
    const doc = await createDocument({
      title: 'Sürüm Denemesi',
      revisions: [
        { status: 'SUPERSEDED', content: await buildDocx(paragraph('Eski sürümde zürafa yazıyordu.')) },
        { status: 'APPROVED', content: await buildDocx(paragraph('Yeni sürümde kelebek yazıyor.')), current: true },
      ],
    });
    const [old, current] = doc.revisions;

    expect(await index.index(old.id)).toBe('NOT_CURRENT');
    expect(await found(users.reader.token, 'zurafa')).toMatchObject({ total: 0 });

    // The old one was indexed while it was in force: now a newer one replaces it
    await prisma.revisionText.create({ data: { revisionId: old.id, organizationId: org.id, documentId: doc.id, status: 'INDEXED', content: 'zürafa' } });
    expect(await index.index(current.id)).toBe('INDEXED');
    expect(await prisma.revisionText.findMany({ where: { documentId: doc.id }, select: { revisionId: true } })).toEqual([{ revisionId: current.id }]);
    expect(codes(await found(users.reader.token, 'kelebek'))).toEqual([doc.code]);
    expect(await found(users.reader.token, 'zurafa')).toMatchObject({ total: 0 });
  });

  it('does not index a draft, and leaves the row of the revision in force alone when a draft is asked for', async () => {
    const doc = await createDocument({
      title: 'Taslaklı Doküman',
      revisions: [
        { status: 'APPROVED', content: await buildDocx(paragraph('Yürürlükteki metin papatya içerir.')), current: true },
        { status: 'DRAFT', content: await buildDocx(paragraph('Taslak metin karanfil içerir.')) },
      ],
    });
    await index.index(doc.revisions[0].id);

    expect(await index.index(doc.revisions[1].id)).toBe('NOT_CURRENT');
    expect(codes(await found(users.reader.token, 'papatya'))).toEqual([doc.code]);
    expect(await found(users.admin.token, 'karanfil')).toMatchObject({ total: 0 });
  });

  it('marks a missing, unreadable or empty file as skipped and still finds the document by code and title', async () => {
    const missing = await createDocument({ title: 'Dosyası Yok Belgesi', revisions: [{ status: 'APPROVED', content: null, current: true }] });
    const broken = await createDocument({ title: 'Bozuk Dosya Belgesi', revisions: [{ status: 'APPROVED', content: Buffer.from('not a package'), current: true }] });

    expect(await index.index(missing.revisions[0].id)).toBe('SKIPPED');
    expect(await index.index(broken.revisions[0].id)).toBe('SKIPPED');
    expect(await prisma.revisionText.findMany({ where: { documentId: { in: [missing.id, broken.id] } }, select: { status: true } })).toEqual([
      { status: 'SKIPPED' },
      { status: 'SKIPPED' },
    ]);
    expect(codes(await found(users.reader.token, 'Dosyası Yok'))).toEqual([missing.code]);
    expect(codes(await found(users.reader.token, 'Bozuk Dosya'))).toEqual([broken.code]);
  });

  it('finds a document that is not indexed yet by its code and title', async () => {
    const fresh = await createDocument({
      title: 'Yeni Yayınlanan Talimat',
      revisions: [{ status: 'APPROVED', content: await buildDocx(paragraph('Henüz dizinlenmedi.')), current: true }],
    });
    const page = await found(users.reader.token, 'yayınlanan talimat');
    expect(codes(page)).toEqual([fresh.code]);
    expect(await found(users.reader.token, 'dizinlenmedi')).toMatchObject({ total: 0 });
  });

  it('indexes by itself what the sweep finds missing, once, and leaves what has a row alone', async () => {
    const waiting = await createDocument({
      title: 'Süpürme Denemesi',
      revisions: [{ status: 'APPROVED', content: await buildDocx(paragraph('Dizin eksik olan metin menekşe içerir.')), current: true }],
    });
    expect(await found(users.reader.token, 'menekşe')).toMatchObject({ total: 0 });

    await index.sweep();

    expect(codes(await found(users.reader.token, 'menekşe'))).toEqual([waiting.code]);
    const row = await prisma.revisionText.findUniqueOrThrow({ where: { revisionId: waiting.revisions[0].id } });
    await index.sweep();
    expect((await prisma.revisionText.findUniqueOrThrow({ where: { revisionId: waiting.revisions[0].id } })).indexedAt).toEqual(row.indexedAt);
  });

  it('is rebuilt without changing what is found when the same revision is indexed again', async () => {
    const [revision] = docs.retention.revisions;
    await index.index(revision.id);
    await index.index(revision.id);
    expect(await prisma.revisionText.count({ where: { documentId: docs.retention.id } })).toBe(1);
    expect(codes(await found(users.reader.token, 'imha'))).toEqual([docs.retention.code]);
  });

  it('is written when a revision is published through the approval flow, and replaces the older text', async () => {
    const draft = await createDocument({
      title: 'Onaydan Geçen Doküman',
      status: 'DRAFT',
      revisions: [{ status: 'DRAFT', content: await buildDocx(paragraph('Onaydan sonra aranabilir olan metin lavanta içerir.')) }],
    });
    expect(await found(users.reader.token, 'lavanta')).toMatchObject({ total: 0 });

    await publishThroughApproval(app, {
      revisionId: draft.revisions[0].id,
      submitToken: users.editorA.token,
      approverToken: users.approverA.token,
      qualityToken: users.qm.token,
    });

    const page = await found(users.reader.token, 'lavanta');
    expect(codes(page)).toEqual([draft.code]);
    expect(page.items[0].snippets[0].some((part) => part.match)).toBe(true);
    expect((await prisma.revisionText.findUniqueOrThrow({ where: { revisionId: draft.revisions[0].id } })).status).toBe('INDEXED');
  });

  it('is gone from the results when a document is withdrawn, although its row stays', async () => {
    const doc = await publishedDoc('Kaldırılacak Doküman', 'Bu metin sümbül içerir.');
    expect(codes(await found(users.reader.token, 'sümbül'))).toEqual([doc.code]);

    await prisma.document.update({ where: { id: doc.id }, data: { status: 'WITHDRAWN' } });

    expect(await found(users.reader.token, 'sümbül')).toMatchObject({ total: 0 });
    expect(await found(users.admin.token, 'sümbül')).toMatchObject({ total: 0 });
  });
});
