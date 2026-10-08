process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AdminCategoryDto, AdminDepartmentDto } from '@iso-dms/shared';
import type { UserRole } from '../src/generated/prisma/enums';
import { slugify } from '../src/modules/categories/slugify';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
const org = {} as { id: string; deptA: string; category: string };
const foreign = {} as { departmentId: string; categoryId: string };
type Label = 'admin' | 'qm' | 'approver' | 'editor' | 'reader';
const users = {} as Record<Label, { id: string; token: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());

/** Short, unique codes: two uppercase letters from a counter, so suites never meet each other's codes. */
let counter = 0;
const nextLetters = () => {
  counter += 1;
  return `${String.fromCharCode(65 + Math.floor(counter / 26) % 26)}${String.fromCharCode(65 + (counter % 26))}`;
};
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

beforeAll(async () => {
  app = await createTestApp();

  const organization = await prisma.organization.create({ data: { name: `Admin ${suffix}`, slug: `admin-${suffix}` } });
  const other = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `admin-f-${suffix}` } });
  organizationIds.push(organization.id, other.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Mevcut Birim', code: 'ZZ' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Mevcut Kategori', slug: 'mevcut-kategori', codePrefix: 'ZZ', sortOrder: 5 } })).id;
  foreign.departmentId = (await prisma.department.create({ data: { organizationId: other.id, name: 'Yabancı Birim', code: 'YB' } })).id;
  foreign.categoryId = (await prisma.category.create({ data: { organizationId: other.id, name: 'Yabancı Kategori', slug: 'yabanci-kategori', codePrefix: 'YK' } })).id;

  const makeUser = async (label: Label, role: UserRole) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId: org.deptA, email: `${label}@admin.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId: org.deptA }) };
  };
  await makeUser('admin', 'ADMIN');
  await makeUser('qm', 'QUALITY_MANAGER');
  await makeUser('approver', 'APPROVER');
  await makeUser('editor', 'EDITOR');
  await makeUser('reader', 'READER');
});

afterAll(async () => {
  await deleteAuditLogs(prisma, { organizationId: { in: organizationIds } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

describe('slugify', () => {
  it.each([
    ['Prosedürler', 'prosedurler'],
    ['İş Akışları', 'is-akislari'],
    ['Dış Kaynaklı Dokümanlar', 'dis-kaynakli-dokumanlar'],
    ['  Çok   Özel  Şablonlar!  ', 'cok-ozel-sablonlar'],
    ['ISO 9001:2015', 'iso-9001-2015'],
    ['***', ''],
    ['A'.repeat(80), 'a'.repeat(60)],
  ])('turns %j into %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe('departments', () => {
  const list = (token: string) => api().get('/api/departments/overview').set(auth(token));
  const create = (token: string, body: Record<string, unknown>) => api().post('/api/departments').set(auth(token)).send(body);
  const patch = (token: string, id: string, body: Record<string, unknown>) => api().patch(`/api/departments/${id}`).set(auth(token)).send(body);
  const newDepartment = async (name = `Birim ${randomUUID().slice(0, 6)}`) => (await create(users.admin.token, { name, code: nextLetters() }).expect(201)).body as AdminDepartmentDto;

  describe('who may', () => {
    it('requires authentication', async () => {
      await api().get('/api/departments/overview').expect(401);
      await api().post('/api/departments').send({ name: 'Birim', code: 'AB' }).expect(401);
      await api().patch(`/api/departments/${org.deptA}`).send({ name: 'Birim' }).expect(401);
    });

    it.each(['qm', 'approver', 'editor', 'reader'] as const)('refuses %s with 403 on every administration endpoint', async (who) => {
      expect((await list(users[who].token).expect(403)).body.code).toBe('FORBIDDEN');
      await create(users[who].token, { name: 'Yeni Birim', code: 'YN' }).expect(403);
      await patch(users[who].token, org.deptA, { name: 'Başka Ad' }).expect(403);
      expect(await prisma.department.count({ where: { organizationId: org.id, code: 'YN' } })).toBe(0);
      expect((await prisma.department.findUniqueOrThrow({ where: { id: org.deptA } })).name).toBe('Mevcut Birim');
    });

    it('keeps the picker open to everybody, and only active departments in it', async () => {
      const gone = await newDepartment('Kapanan Birim');
      await patch(users.admin.token, gone.id, { isActive: false }).expect(200);

      for (const who of ['admin', 'qm', 'editor', 'reader'] as const) {
        const names = ((await api().get('/api/departments').set(auth(users[who].token)).expect(200)).body as { name: string }[]).map((department) => department.name);
        expect(names).toContain('Mevcut Birim');
        expect(names).not.toContain('Kapanan Birim');
      }
    });
  });

  describe('the overview', () => {
    it('lists every department of the organization with what depends on it, active first', async () => {
      const gone = await newDepartment('Zzz Pasif Birim');
      await patch(users.admin.token, gone.id, { isActive: false }).expect(200);

      const rows = (await list(users.admin.token).expect(200)).body as AdminDepartmentDto[];

      const mine = rows.find((row) => row.id === org.deptA)!;
      expect(mine).toEqual({
        id: org.deptA,
        name: 'Mevcut Birim',
        code: 'ZZ',
        isActive: true,
        userCount: 5,
        documentCount: 0,
        createdAt: expect.any(String),
      });
      expect(rows.find((row) => row.id === gone.id)).toMatchObject({ isActive: false });
      const firstInactive = rows.findIndex((row) => !row.isActive);
      expect(rows.slice(firstInactive).every((row) => !row.isActive)).toBe(true);
    });

    it('counts the documents of the department in any state', async () => {
      const department = await newDepartment();
      for (const [index, status] of (['DRAFT', 'PUBLISHED', 'WITHDRAWN'] as const).entries()) {
        await prisma.document.create({
          data: { organizationId: org.id, categoryId: org.category, departmentId: department.id, ownerId: users.admin.id, code: `CNT-${department.code}-${index}`, sequenceNo: index + 1, title: 'Sayım', fileType: 'DOCX', status },
        });
      }

      const row = ((await list(users.admin.token).expect(200)).body as AdminDepartmentDto[]).find((candidate) => candidate.id === department.id)!;

      expect(row.documentCount).toBe(3);
    });

    it('never shows the departments of another organization', async () => {
      const ids = ((await list(users.admin.token).expect(200)).body as AdminDepartmentDto[]).map((row) => row.id);
      expect(ids).not.toContain(foreign.departmentId);
    });
  });

  describe('creating', () => {
    it('adds an active department without users or documents, and answers with it', async () => {
      const response = await create(users.admin.token, { name: '  Yeni Birim  ', code: nextLetters() }).expect(201);

      expect(response.body).toEqual({ id: expect.any(String), name: 'Yeni Birim', code: expect.stringMatching(/^[A-Z]{2}$/), isActive: true, userCount: 0, documentCount: 0, createdAt: expect.any(String) });
      expect(await prisma.department.findUniqueOrThrow({ where: { id: response.body.id } })).toMatchObject({ organizationId: org.id, name: 'Yeni Birim', parentId: null });
    });

    it('writes the code in capitals', async () => {
      const letters = nextLetters();
      const response = await create(users.admin.token, { name: 'Küçük Harfli Kod', code: `  ${letters.toLowerCase()} ` }).expect(201);
      expect(response.body.code).toBe(letters);
    });

    it.each([
      ['no name', { code: 'AB' }],
      ['a name of one character', { name: 'A', code: 'AB' }],
      ['a name that is too long', { name: 'A'.repeat(101), code: 'AB' }],
      ['a name of spaces', { name: '    ', code: 'AB' }],
      ['no code', { name: 'Birim' }],
      ['a code of one character', { name: 'Birim', code: 'A' }],
      ['a code of five characters', { name: 'Birim', code: 'ABCDE' }],
      ['a code with a hyphen', { name: 'Birim', code: 'A-B' }],
      ['a code with a Turkish letter', { name: 'Birim', code: 'KÖ' }],
      ['an unknown field', { name: 'Birim', code: 'AB', isActive: false }],
      ['an organization of its own', { name: 'Birim', code: 'AB', organizationId: randomUUID() }],
    ])('refuses %s', async (_label, body) => {
      const before = await prisma.department.count({ where: { organizationId: org.id } });
      await create(users.admin.token, body).expect(400);
      expect(await prisma.department.count({ where: { organizationId: org.id } })).toBe(before);
    });

    it('refuses a code that is in use, even by a department that is not active any more', async () => {
      const department = await newDepartment();
      await patch(users.admin.token, department.id, { isActive: false }).expect(200);

      const response = await create(users.admin.token, { name: 'Başka Ad', code: department.code }).expect(409);

      expect(response.body.code).toBe('DEPARTMENT_CODE_TAKEN');
    });

    it.each([
      ['the same', 'Aynı Ad Birimi', 'Aynı Ad Birimi'],
      ['in other letter case', 'Bilgi İşlem Dairesi', 'BİLGİ İŞLEM DAİRESİ'],
      ['with the dotless i', 'Kalite Işık Birimi', 'kalite ışık birimi'],
    ])('refuses a name that is %s as one in use', async (_label, first, second) => {
      await create(users.admin.token, { name: first, code: nextLetters() }).expect(201);

      const response = await create(users.admin.token, { name: second, code: nextLetters() }).expect(409);

      expect(response.body.code).toBe('DEPARTMENT_NAME_TAKEN');
    });

    it('lets another organization use the same code and name', async () => {
      // The foreign department of the fixture is "Yabancı Birim" / YB
      await create(users.admin.token, { name: 'Yabancı Birim', code: 'YB' }).expect(201);
    });

    it('lets exactly one of two simultaneous requests for the same code win', async () => {
      const code = nextLetters();

      const [one, two] = await Promise.all([create(users.admin.token, { name: 'Paralel Bir', code }), create(users.admin.token, { name: 'Paralel İki', code })]);

      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect(await prisma.department.count({ where: { organizationId: org.id, code } })).toBe(1);
    });

    it('is audited with the code and the name', async () => {
      const department = await newDepartment('Denetlenen Birim');

      const [entry] = await auditOf(department.id);

      expect(entry).toMatchObject({ action: 'DEPARTMENT_CREATED', entityType: 'Department', userId: users.admin.id, organizationId: org.id });
      expect(entry.metadata).toEqual({ code: department.code, name: 'Denetlenen Birim' });
    });
  });

  describe('changing', () => {
    it('renames a department, and keeps its code', async () => {
      const department = await newDepartment();

      const response = await patch(users.admin.token, department.id, { name: '  Yeni Adı  ' }).expect(200);

      expect(response.body).toMatchObject({ id: department.id, name: 'Yeni Adı', code: department.code });
    });

    it('takes a department out of use and back, which the pickers follow', async () => {
      const department = await newDepartment();
      const inPicker = async () => ((await api().get('/api/departments').set(auth(users.reader.token)).expect(200)).body as { id: string }[]).some((row) => row.id === department.id);
      expect(await inPicker()).toBe(true);

      expect((await patch(users.admin.token, department.id, { isActive: false }).expect(200)).body.isActive).toBe(false);
      expect(await inPicker()).toBe(false);
      expect((await patch(users.admin.token, department.id, { isActive: true }).expect(200)).body.isActive).toBe(true);
      expect(await inPicker()).toBe(true);
    });

    it('leaves the users and documents of a department that is taken out of use as they are', async () => {
      const department = await newDepartment();
      const user = await prisma.user.create({ data: { organizationId: org.id, departmentId: department.id, email: `u-${department.code}@admin.local`, fullName: 'Birimli', passwordHash: 'x' } });

      const response = await patch(users.admin.token, department.id, { isActive: false }).expect(200);

      expect(response.body.userCount).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).departmentId).toBe(department.id);
    });

    it.each([
      ['a code', { code: 'XX' }],
      ['an organization', { organizationId: randomUUID() }],
      ['a parent', { parentId: randomUUID() }],
      ['a name that is too short', { name: 'A' }],
      ['a flag that is not a boolean', { isActive: 'no' }],
    ])('refuses %s', async (_label, body) => {
      const department = await newDepartment();
      await patch(users.admin.token, department.id, body).expect(400);
      expect(await prisma.department.findUniqueOrThrow({ where: { id: department.id } })).toMatchObject({ name: department.name, code: department.code, isActive: true });
    });

    it('answers 404 for unknown departments and for those of another organization', async () => {
      expect((await patch(users.admin.token, randomUUID(), { name: 'Birim' }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');
      expect((await patch(users.admin.token, foreign.departmentId, { name: 'Ele Geçirilen' }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');
      expect((await prisma.department.findUniqueOrThrow({ where: { id: foreign.departmentId } })).name).toBe('Yabancı Birim');
      await patch(users.admin.token, 'not-a-uuid', { name: 'Birim' }).expect(400);
    });

    it('refuses a name another department has, but lets a department keep its own', async () => {
      const first = await newDepartment('Ad Birim Bir');
      const second = await newDepartment('Ad Birim İki');

      expect((await patch(users.admin.token, second.id, { name: 'AD BİRİM BİR' }).expect(409)).body.code).toBe('DEPARTMENT_NAME_TAKEN');
      await patch(users.admin.token, first.id, { name: 'AD BİRİM BİR' }).expect(200);
    });

    it('is audited with what changed, and a request that changes nothing is not', async () => {
      const department = await newDepartment('Eski Ad');
      await patch(users.admin.token, department.id, { name: 'Yeni Ad', isActive: false }).expect(200);
      await patch(users.admin.token, department.id, { name: 'Yeni Ad', isActive: false }).expect(200);
      await patch(users.admin.token, department.id, {}).expect(200);

      const entries = await auditOf(department.id);

      expect(entries.map((entry) => entry.action)).toEqual(['DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED']);
      expect(entries[1]).toMatchObject({ userId: users.admin.id, entityType: 'Department' });
      expect(entries[1].metadata).toEqual({ code: department.code, changes: { name: { from: 'Eski Ad', to: 'Yeni Ad' }, isActive: { from: true, to: false } } });
    });
  });
});

describe('categories', () => {
  const list = (token: string) => api().get('/api/categories/overview').set(auth(token));
  const create = (token: string, body: Record<string, unknown>) => api().post('/api/categories').set(auth(token)).send(body);
  const patch = (token: string, id: string, body: Record<string, unknown>) => api().patch(`/api/categories/${id}`).set(auth(token)).send(body);
  const newCategory = async (name = `Kategori ${randomUUID().slice(0, 6)}`, extra: Record<string, unknown> = {}) =>
    (await create(users.admin.token, { name, codePrefix: nextLetters(), ...extra }).expect(201)).body as AdminCategoryDto;

  describe('who may', () => {
    it('requires authentication', async () => {
      await api().get('/api/categories/overview').expect(401);
      await api().post('/api/categories').send({ name: 'Kategori', codePrefix: 'AB' }).expect(401);
      await api().patch(`/api/categories/${org.category}`).send({ name: 'Kategori' }).expect(401);
    });

    it.each(['qm', 'approver', 'editor', 'reader'] as const)('refuses %s with 403 on every administration endpoint', async (who) => {
      expect((await list(users[who].token).expect(403)).body.code).toBe('FORBIDDEN');
      await create(users[who].token, { name: 'Yeni Kategori', codePrefix: 'YN' }).expect(403);
      await patch(users[who].token, org.category, { name: 'Başka Ad' }).expect(403);
      expect((await prisma.category.findUniqueOrThrow({ where: { id: org.category } })).name).toBe('Mevcut Kategori');
    });

    it('keeps the list of the menu open to everybody, and only active categories in it', async () => {
      const gone = await newCategory('Kapanan Kategori');
      await patch(users.admin.token, gone.id, { isActive: false }).expect(200);

      for (const who of ['admin', 'qm', 'editor', 'reader'] as const) {
        const names = ((await api().get('/api/categories').set(auth(users[who].token)).expect(200)).body as { name: string }[]).map((category) => category.name);
        expect(names).toContain('Mevcut Kategori');
        expect(names).not.toContain('Kapanan Kategori');
      }
    });
  });

  describe('the overview', () => {
    it('lists every category with the documents it holds in any state, active first', async () => {
      const gone = await newCategory('Zzz Pasif Kategori');
      await patch(users.admin.token, gone.id, { isActive: false }).expect(200);

      const rows = (await list(users.admin.token).expect(200)).body as AdminCategoryDto[];

      expect(rows.find((row) => row.id === org.category)).toEqual({
        id: org.category,
        name: 'Mevcut Kategori',
        slug: 'mevcut-kategori',
        codePrefix: 'ZZ',
        description: null,
        icon: null,
        sortOrder: 5,
        isExternal: false,
        externalUrl: null,
        isActive: true,
        documentCount: expect.any(Number),
        createdAt: expect.any(String),
      });
      expect(rows.find((row) => row.id === gone.id)).toMatchObject({ isActive: false });
      const firstInactive = rows.findIndex((row) => !row.isActive);
      expect(rows.slice(firstInactive).every((row) => !row.isActive)).toBe(true);
    });

    it('counts drafts and withdrawn documents too, and never shows another organization', async () => {
      const category = await newCategory();
      for (const [index, status] of (['DRAFT', 'PUBLISHED', 'WITHDRAWN'] as const).entries()) {
        await prisma.document.create({
          data: { organizationId: org.id, categoryId: category.id, departmentId: org.deptA, ownerId: users.admin.id, code: `${category.codePrefix}-ZZ-00${index}`, sequenceNo: index + 1, title: 'Sayım', fileType: 'DOCX', status },
        });
      }

      const rows = (await list(users.admin.token).expect(200)).body as AdminCategoryDto[];

      expect(rows.find((row) => row.id === category.id)!.documentCount).toBe(3);
      expect(rows.map((row) => row.id)).not.toContain(foreign.categoryId);
    });
  });

  describe('creating', () => {
    it('adds an active category with an address of its own, and answers with it', async () => {
      const prefix = nextLetters();
      const response = await create(users.admin.token, { name: '  İş Akışları  ', codePrefix: prefix.toLowerCase(), description: '  Süreç şemaları  ', icon: 'workflow', sortOrder: 40 }).expect(201);

      expect(response.body).toEqual({
        id: expect.any(String),
        name: 'İş Akışları',
        slug: 'is-akislari',
        codePrefix: prefix,
        description: 'Süreç şemaları',
        icon: 'workflow',
        sortOrder: 40,
        isExternal: false,
        externalUrl: null,
        isActive: true,
        documentCount: 0,
        createdAt: expect.any(String),
      });
    });

    it('numbers the address when another category has it already', async () => {
      const first = await newCategory('Ortak Adres Kategorisi');
      const second = await newCategory('Ortak Adres Kategorisî');
      const third = await newCategory('ORTAK ADRES KATEGORİSİ'.replace('İ', 'i') + '!');

      expect(first.slug).toBe('ortak-adres-kategorisi');
      expect(second.slug).toBe('ortak-adres-kategorisi-2');
      expect(third.slug).toBe('ortak-adres-kategorisi-3');
    });

    it('puts a category without a place after the last one', async () => {
      const before = Math.max(...((await list(users.admin.token).expect(200)).body as AdminCategoryDto[]).map((row) => row.sortOrder));
      const created = await newCategory();
      expect(created.sortOrder).toBe(before + 1);
    });

    it('makes an external category with its link, and refuses a link for any other', async () => {
      const external = await newCategory('Dış Kaynaklı Denemesi', { isExternal: true, externalUrl: 'https://mevzuat.example.org/liste' });
      expect(external).toMatchObject({ isExternal: true, externalUrl: 'https://mevzuat.example.org/liste' });

      const response = await create(users.admin.token, { name: 'Bağlantılı Ama Dış Değil', codePrefix: nextLetters(), externalUrl: 'https://example.org' }).expect(400);
      expect(response.body.code).toBe('EXTERNAL_URL_NOT_ALLOWED');
    });

    it('turns empty texts into none', async () => {
      const created = await newCategory('Boş Metinli', { description: '   ', externalUrl: '', icon: null });
      expect(created).toMatchObject({ description: null, externalUrl: null, icon: null });
    });

    it.each([
      ['no name', { codePrefix: 'AB' }],
      ['a name of one character', { name: 'A', codePrefix: 'AB' }],
      ['a name that is too long', { name: 'A'.repeat(101), codePrefix: 'AB' }],
      ['no prefix', { name: 'Kategori' }],
      ['a prefix of one character', { name: 'Kategori', codePrefix: 'A' }],
      ['a prefix of four characters', { name: 'Kategori', codePrefix: 'ABCD' }],
      ['a prefix with a digit', { name: 'Kategori', codePrefix: 'A1' }],
      ['a description that is too long', { name: 'Kategori', codePrefix: 'AB', description: 'x'.repeat(501) }],
      ['an icon nobody draws', { name: 'Kategori', codePrefix: 'AB', icon: 'rocket' }],
      ['a place below zero', { name: 'Kategori', codePrefix: 'AB', sortOrder: -1 }],
      ['a place above the limit', { name: 'Kategori', codePrefix: 'AB', sortOrder: 10000 }],
      ['a link that is not http(s)', { name: 'Kategori', codePrefix: 'AB', isExternal: true, externalUrl: 'ftp://example.org' }],
      ['a link that is not a link', { name: 'Kategori', codePrefix: 'AB', isExternal: true, externalUrl: 'mevzuat' }],
      ['a slug of its own', { name: 'Kategori', codePrefix: 'AB', slug: 'benim' }],
      ['a flag that is not a boolean', { name: 'Kategori', codePrefix: 'AB', isExternal: 'evet' }],
    ])('refuses %s', async (_label, body) => {
      const before = await prisma.category.count({ where: { organizationId: org.id } });
      await create(users.admin.token, body).expect(400);
      expect(await prisma.category.count({ where: { organizationId: org.id } })).toBe(before);
    });

    it('refuses a prefix that is in use, even by a category that is not active any more', async () => {
      const category = await newCategory();
      await patch(users.admin.token, category.id, { isActive: false }).expect(200);

      const response = await create(users.admin.token, { name: 'Başka Ad Kategorisi', codePrefix: category.codePrefix }).expect(409);

      expect(response.body.code).toBe('CATEGORY_PREFIX_TAKEN');
    });

    it('refuses a name that is in use, in any letter case', async () => {
      await newCategory('Aynı Ad Kategorisi');
      const response = await create(users.admin.token, { name: 'AYNI AD KATEGORİSİ', codePrefix: nextLetters() }).expect(409);
      expect(response.body.code).toBe('CATEGORY_NAME_TAKEN');
    });

    it('lets another organization use the same prefix and name', async () => {
      await create(users.admin.token, { name: 'Yabancı Kategori', codePrefix: 'YK' }).expect(201);
    });

    it('lets exactly one of two simultaneous requests for the same prefix win', async () => {
      const codePrefix = nextLetters();

      const [one, two] = await Promise.all([create(users.admin.token, { name: 'Paralel Bir Kategori', codePrefix }), create(users.admin.token, { name: 'Paralel İki Kategori', codePrefix })]);

      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect(await prisma.category.count({ where: { organizationId: org.id, codePrefix } })).toBe(1);
    });

    it('is audited with the prefix, the name and the address', async () => {
      const category = await newCategory('Denetlenen Kategori');

      const [entry] = await auditOf(category.id);

      expect(entry).toMatchObject({ action: 'CATEGORY_CREATED', entityType: 'Category', userId: users.admin.id, organizationId: org.id });
      expect(entry.metadata).toEqual({ codePrefix: category.codePrefix, name: 'Denetlenen Kategori', slug: 'denetlenen-kategori' });
    });
  });

  describe('changing', () => {
    it('changes name, description, icon, place and the link of an external one, and keeps the rest', async () => {
      const category = await newCategory('Eski Kategori Adı', { isExternal: true });

      const response = await patch(users.admin.token, category.id, {
        name: '  Yeni Kategori Adı  ',
        description: 'Yeni açıklama',
        icon: 'globe',
        sortOrder: 77,
        externalUrl: 'https://example.org/yeni',
      }).expect(200);

      expect(response.body).toMatchObject({
        id: category.id,
        name: 'Yeni Kategori Adı',
        description: 'Yeni açıklama',
        icon: 'globe',
        sortOrder: 77,
        externalUrl: 'https://example.org/yeni',
        // These never change
        slug: category.slug,
        codePrefix: category.codePrefix,
        isExternal: true,
      });
    });

    it('clears the optional fields', async () => {
      const category = await newCategory('Temizlenecek', { description: 'Var', icon: 'globe', isExternal: true, externalUrl: 'https://example.org' });

      const response = await patch(users.admin.token, category.id, { description: null, icon: null, externalUrl: '' }).expect(200);

      expect(response.body).toMatchObject({ description: null, icon: null, externalUrl: null });
    });

    it('takes a category out of use and back, which the menu follows, and leaves its documents alone', async () => {
      const category = await newCategory();
      await prisma.document.create({
        data: { organizationId: org.id, categoryId: category.id, departmentId: org.deptA, ownerId: users.admin.id, code: `${category.codePrefix}-ZZ-001`, sequenceNo: 1, title: 'Kalır', fileType: 'DOCX', status: 'PUBLISHED' },
      });
      const inMenu = async () => ((await api().get('/api/categories').set(auth(users.reader.token)).expect(200)).body as { id: string }[]).some((row) => row.id === category.id);
      expect(await inMenu()).toBe(true);

      const off = await patch(users.admin.token, category.id, { isActive: false }).expect(200);
      expect(off.body).toMatchObject({ isActive: false, documentCount: 1 });
      expect(await inMenu()).toBe(false);
      expect((await prisma.document.findFirstOrThrow({ where: { categoryId: category.id } })).status).toBe('PUBLISHED');

      await patch(users.admin.token, category.id, { isActive: true }).expect(200);
      expect(await inMenu()).toBe(true);
    });

    it.each([
      ['a prefix', { codePrefix: 'XX' }],
      ['a slug', { slug: 'baska-adres' }],
      ['an external flag', { isExternal: true }],
      ['an organization', { organizationId: randomUUID() }],
      ['an icon nobody draws', { icon: 'rocket' }],
      ['a place below zero', { sortOrder: -3 }],
      ['a link that is not a link', { externalUrl: 'mevzuat' }],
    ])('refuses %s', async (_label, body) => {
      const category = await newCategory(undefined, { isExternal: true });
      await patch(users.admin.token, category.id, body).expect(400);
      expect(await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).toMatchObject({ slug: category.slug, codePrefix: category.codePrefix, isExternal: true, icon: null });
    });

    it('refuses a link for a category that is not external', async () => {
      const category = await newCategory();
      const response = await patch(users.admin.token, category.id, { externalUrl: 'https://example.org' }).expect(400);
      expect(response.body.code).toBe('EXTERNAL_URL_NOT_ALLOWED');
    });

    it('answers 404 for unknown categories and for those of another organization', async () => {
      expect((await patch(users.admin.token, randomUUID(), { name: 'Kategori' }).expect(404)).body.code).toBe('CATEGORY_NOT_FOUND');
      expect((await patch(users.admin.token, foreign.categoryId, { name: 'Ele Geçirilen' }).expect(404)).body.code).toBe('CATEGORY_NOT_FOUND');
      expect((await prisma.category.findUniqueOrThrow({ where: { id: foreign.categoryId } })).name).toBe('Yabancı Kategori');
      await patch(users.admin.token, 'not-a-uuid', { name: 'Kategori' }).expect(400);
    });

    it('refuses a name another category has, but lets a category keep its own', async () => {
      const first = await newCategory('Ad Kategori Bir');
      const second = await newCategory('Ad Kategori İki');

      expect((await patch(users.admin.token, second.id, { name: 'AD KATEGORİ BİR' }).expect(409)).body.code).toBe('CATEGORY_NAME_TAKEN');
      await patch(users.admin.token, first.id, { name: 'AD KATEGORİ BİR' }).expect(200);
    });

    it('is audited with what changed, and a request that changes nothing is not', async () => {
      const category = await newCategory('Eski Ad Kategorisi', { sortOrder: 3 });
      await patch(users.admin.token, category.id, { name: 'Yeni Ad Kategorisi', sortOrder: 9, isActive: false }).expect(200);
      await patch(users.admin.token, category.id, { name: 'Yeni Ad Kategorisi', sortOrder: 9 }).expect(200);
      await patch(users.admin.token, category.id, {}).expect(200);

      const entries = await auditOf(category.id);

      expect(entries.map((entry) => entry.action)).toEqual(['CATEGORY_CREATED', 'CATEGORY_UPDATED']);
      expect(entries[1]).toMatchObject({ userId: users.admin.id, entityType: 'Category' });
      expect(entries[1].metadata).toEqual({
        codePrefix: category.codePrefix,
        changes: { name: { from: 'Eski Ad Kategorisi', to: 'Yeni Ad Kategorisi' }, sortOrder: { from: 3, to: 9 }, isActive: { from: true, to: false } },
      });
    });
  });
});
