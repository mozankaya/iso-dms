process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { AdminUserDto, PaginatedDto, UserWithPasswordDto } from '@iso-dms/shared';
import type { UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { deleteAuditLogs } from './helpers/audit-cleanup';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

// Sign-in resolves the first organization, so these users live there; the domain marks them for cleanup.
const DOMAIN = '@users-admin.local';
const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let app: INestApplication;
let organizationId: string;
let departmentId: string;
let foreignDepartmentId: string;
let foreignOrganizationId: string;
const staff = {} as Record<'admin' | 'admin2' | 'qm' | 'approver' | 'editor' | 'reader', { id: string; token: string; email: string }>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = () => request(app.getHttpServer());
const email = (name: string) => `${name}-${randomUUID().slice(0, 6)}${DOMAIN}`;
const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const login = (address: string, password: string) => api().post('/api/auth/login').send({ email: address, password });
const cookieOf = (response: request.Response) => ((response.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('refresh_token=')) ?? '').split(';')[0];

async function makeStaff(label: keyof typeof staff, role: UserRole) {
  const address = email(label);
  const user = await prisma.user.create({
    data: { organizationId, departmentId, email: address, fullName: `Staff ${label}`, passwordHash: await argon2.hash('Unused-Password-1'), role },
  });
  staff[label] = { id: user.id, email: address, token: await signToken(app, { userId: user.id, organizationId, role, departmentId }) };
}

const create = (token: string, body: Record<string, unknown>) => api().post('/api/users').set(auth(token)).send(body);
const patch = (token: string, id: string, body: Record<string, unknown>) => api().patch(`/api/users/${id}`).set(auth(token)).send(body);
const reset = (token: string, id: string, body: Record<string, unknown> = {}) => api().post(`/api/users/${id}/reset-password`).set(auth(token)).send(body);
const newUser = async (overrides: Record<string, unknown> = {}) =>
  (await create(staff.admin.token, { fullName: 'Yeni Kullanıcı', email: email('new'), role: 'READER', ...overrides }).expect(201)).body as UserWithPasswordDto;

beforeAll(async () => {
  app = await createTestApp();
  organizationId = (await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  departmentId = (await prisma.department.create({ data: { organizationId, name: `Users Admin ${suffix}`, code: `U${suffix.slice(0, 2).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'X') } })).id;
  const other = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `users-f-${suffix}` } });
  foreignOrganizationId = other.id;
  foreignDepartmentId = (await prisma.department.create({ data: { organizationId: other.id, name: 'Yabancı', code: 'YB' } })).id;

  await makeStaff('admin', 'ADMIN');
  await makeStaff('admin2', 'ADMIN');
  await makeStaff('qm', 'QUALITY_MANAGER');
  await makeStaff('approver', 'APPROVER');
  await makeStaff('editor', 'EDITOR');
  await makeStaff('reader', 'READER');
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { OR: [{ email: { endsWith: DOMAIN } }, { organizationId: foreignOrganizationId }] }, select: { id: true } });
  const ids = users.map((user) => user.id);
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await deleteAuditLogs(prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }, { organizationId: foreignOrganizationId }] });
  await deleteAuditLogs(prisma, { action: 'USER_LOGIN_FAILED', metadata: { path: ['email'], string_contains: DOMAIN } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.department.deleteMany({ where: { id: { in: [departmentId, foreignDepartmentId] } } });
  await prisma.organization.deleteMany({ where: { id: foreignOrganizationId } });
  await prisma.$disconnect();
  await app.close();
});

describe('who may', () => {
  it('requires authentication', async () => {
    await api().get('/api/users').expect(401);
    await api().post('/api/users').send({}).expect(401);
    await api().patch(`/api/users/${staff.reader.id}`).send({}).expect(401);
    await api().post(`/api/users/${staff.reader.id}/reset-password`).send({}).expect(401);
  });

  it.each(['qm', 'approver', 'editor', 'reader'] as const)('refuses %s with 403 on every administration endpoint', async (who) => {
    const token = staff[who].token;
    expect((await api().get('/api/users').set(auth(token)).expect(403)).body.code).toBe('FORBIDDEN');
    await create(token, { fullName: 'Kaçak Kullanıcı', email: email('sneak'), role: 'ADMIN' }).expect(403);
    await patch(token, staff.reader.id, { role: 'ADMIN' }).expect(403);
    await reset(token, staff.reader.id).expect(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.reader.id } })).role).toBe('READER');
  });
});

describe('listing', () => {
  it('pages through the users with their department, never with a password', async () => {
    const created = await newUser({ fullName: 'Listede Görünen', role: 'EDITOR', departmentId });

    const page = (await api().get('/api/users').query({ search: created.user.email }).set(auth(staff.admin.token)).expect(200)).body as PaginatedDto<AdminUserDto>;

    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(page.items[0]).toEqual({
      id: created.user.id,
      fullName: 'Listede Görünen',
      email: created.user.email,
      role: 'EDITOR',
      department: { id: departmentId, name: expect.any(String), code: expect.any(String) },
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(page)).not.toMatch(/passwordHash|argon2/);
  });

  it('filters by role, department, status and a search over name and email, case-insensitively', async () => {
    const off = await newUser({ fullName: 'Pasif Süzgeç', role: 'READER' });
    await patch(staff.admin.token, off.user.id, { isActive: false }).expect(200);
    const get = async (query: Record<string, string>) =>
      ((await api().get('/api/users').query({ pageSize: '100', ...query }).set(auth(staff.admin.token)).expect(200)).body as PaginatedDto<AdminUserDto>).items.map((item) => item.id);

    expect(await get({ search: 'PASİF SÜZGEÇ'.toLocaleLowerCase('tr-TR') })).toEqual([off.user.id]);
    expect(await get({ search: off.user.email.toUpperCase() })).toEqual([off.user.id]);
    expect(await get({ search: 'Pasif Süzgeç', status: 'active' })).toEqual([]);
    expect(await get({ search: 'Pasif Süzgeç', status: 'inactive' })).toEqual([off.user.id]);
    expect(await get({ search: 'Pasif Süzgeç', role: 'ADMIN' })).toEqual([]);
    const inDepartment = await get({ departmentId });
    expect(inDepartment).toContain(staff.editor.id);
    expect(inDepartment).not.toContain(off.user.id);
  });

  it('treats % and _ in the search as plain characters', async () => {
    const response = await api().get('/api/users').query({ search: '%' }).set(auth(staff.admin.token)).expect(200);
    expect(response.body.total).toBe(0);
  });

  it('puts active users first and pages stably', async () => {
    const rows = ((await api().get('/api/users').query({ pageSize: '100' }).set(auth(staff.admin.token)).expect(200)).body as PaginatedDto<AdminUserDto>).items;
    const firstInactive = rows.findIndex((row) => !row.isActive);
    if (firstInactive >= 0) expect(rows.slice(firstInactive).every((row) => !row.isActive)).toBe(true);
  });

  it.each([['role', 'GOD'], ['status', 'maybe'], ['page', '0'], ['pageSize', '101'], ['departmentId', 'x']])('refuses a bad %s', async (key, value) => {
    await api().get('/api/users').query({ [key]: value }).set(auth(staff.admin.token)).expect(400);
  });

  it('never shows the users of another organization', async () => {
    const foreign = await prisma.user.create({
      data: { organizationId: foreignOrganizationId, email: `someone${DOMAIN}`, fullName: 'Başka Kurum', passwordHash: 'x', role: 'READER' },
    });
    const ids = ((await api().get('/api/users').query({ pageSize: '100', search: 'Başka Kurum' }).set(auth(staff.admin.token)).expect(200)).body as PaginatedDto<AdminUserDto>).items.map((item) => item.id);
    expect(ids).not.toContain(foreign.id);
    expect((await patch(staff.admin.token, foreign.id, { fullName: 'Ele Geçirilen' }).expect(404)).body.code).toBe('USER_NOT_FOUND');
    expect((await reset(staff.admin.token, foreign.id).expect(404)).body.code).toBe('USER_NOT_FOUND');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: foreign.id } })).fullName).toBe('Başka Kurum');
  });
});

describe('creating', () => {
  it('generates a temporary password, shows it once, and the user must change it at the first sign-in', async () => {
    const { user, temporaryPassword } = await newUser({ fullName: '  Ayşe Yılmaz  ', role: 'READER' });

    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(user).toMatchObject({ fullName: 'Ayşe Yılmaz', role: 'READER', department: null, isActive: true, mustChangePassword: true });
    const response = await login(user.email, temporaryPassword!).expect(200);
    expect(response.body.user).toMatchObject({ id: user.id, mustChangePassword: true });
    // The stored value is a hash of it, not the text
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toMatch(/^\$argon2/);
  });

  it('takes a password of the administrator\'s choice and does not echo it', async () => {
    const result = await newUser({ password: 'Choosen-Pass-77' });

    expect(result.temporaryPassword).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Choosen-Pass-77');
    const response = await login(result.user.email, 'Choosen-Pass-77').expect(200);
    expect(response.body.user.mustChangePassword).toBe(true);
  });

  it('writes the email in lower case and refuses it again, in any letter case, even for a user who is not active', async () => {
    const address = email('Mixed');
    const first = await newUser({ email: address.toUpperCase() });
    expect(first.user.email).toBe(address.toLowerCase());
    await patch(staff.admin.token, first.user.id, { isActive: false }).expect(200);

    const response = await create(staff.admin.token, { fullName: 'Aynı Adres', email: address, role: 'READER' }).expect(409);

    expect(response.body.code).toBe('EMAIL_TAKEN');
  });

  it('lets exactly one of two simultaneous requests for the same email win', async () => {
    const address = email('race');
    const body = { fullName: 'Yarış', email: address, role: 'READER' };

    const [one, two] = await Promise.all([create(staff.admin.token, body), create(staff.admin.token, body)]);

    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { organizationId, email: address } })).toBe(1);
  });

  it('puts editors and approvers in a department of the organization that is in use', async () => {
    for (const role of ['EDITOR', 'APPROVER']) {
      expect((await create(staff.admin.token, { fullName: 'Birimsiz', email: email('nodept'), role }).expect(400)).body.code).toBe('DEPARTMENT_REQUIRED');
      expect((await create(staff.admin.token, { fullName: 'Birimsiz', email: email('nodept'), role, departmentId: null }).expect(400)).body.code).toBe('DEPARTMENT_REQUIRED');
    }
    for (const role of ['QUALITY_MANAGER', 'ADMIN', 'READER']) {
      await newUser({ role });
    }
    expect((await create(staff.admin.token, { fullName: 'Yabancı Birim', email: email('foreign'), role: 'EDITOR', departmentId: foreignDepartmentId }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');
    expect((await create(staff.admin.token, { fullName: 'Olmayan Birim', email: email('ghost'), role: 'EDITOR', departmentId: randomUUID() }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');

    const closed = await prisma.department.create({ data: { organizationId, name: `Kapalı ${suffix}`, code: 'ZK', isActive: false } });
    try {
      expect((await create(staff.admin.token, { fullName: 'Kapalı Birim', email: email('closed'), role: 'EDITOR', departmentId: closed.id }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');
    } finally {
      await prisma.department.delete({ where: { id: closed.id } });
    }
  });

  it.each([
    ['no name', { email: 'a@b.co', role: 'READER' }],
    ['a name of one character', { fullName: 'A', email: 'a@b.co', role: 'READER' }],
    ['a name that is too long', { fullName: 'A'.repeat(101), email: 'a@b.co', role: 'READER' }],
    ['no email', { fullName: 'Kişi', role: 'READER' }],
    ['an email that is not one', { fullName: 'Kişi', email: 'not-an-email', role: 'READER' }],
    ['an email that is too long', { fullName: 'Kişi', email: `${'a'.repeat(250)}@b.co`, role: 'READER' }],
    ['no role', { fullName: 'Kişi', email: 'a@b.co' }],
    ['a role nobody has', { fullName: 'Kişi', email: 'a@b.co', role: 'GOD' }],
    ['a password of nine characters', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', password: '123456789' }],
    ['a password that is too long', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', password: 'x'.repeat(201) }],
    ['a department that is not an id', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', departmentId: 'abc' }],
    ['an unknown field', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', isActive: false }],
    ['an organization of its own', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', organizationId: randomUUID() }],
    ['a hash of its own', { fullName: 'Kişi', email: 'a@b.co', role: 'READER', passwordHash: 'x' }],
  ])('refuses %s', async (_label, body) => {
    const before = await prisma.user.count({ where: { organizationId } });
    await create(staff.admin.token, body).expect(400);
    expect(await prisma.user.count({ where: { organizationId } })).toBe(before);
  });

  it('is audited without the password', async () => {
    const { user, temporaryPassword } = await newUser({ fullName: 'Denetlenen', role: 'EDITOR', departmentId });

    const entries = await auditOf(user.id);

    expect(entries.map((entry) => entry.action)).toEqual(['USER_CREATED']);
    expect(entries[0]).toMatchObject({ userId: staff.admin.id, entityType: 'User', organizationId });
    expect(entries[0].metadata).toEqual({ email: user.email, fullName: 'Denetlenen', role: 'EDITOR', departmentCode: expect.any(String), passwordGenerated: true });
    expect(JSON.stringify(entries)).not.toContain(temporaryPassword!);
  });
});

describe('changing', () => {
  it('changes name, role and department, and keeps the email', async () => {
    const { user } = await newUser({ fullName: 'Eski Ad', role: 'READER' });

    const response = await patch(staff.admin.token, user.id, { fullName: '  Yeni Ad ', role: 'APPROVER', departmentId }).expect(200);

    expect(response.body).toMatchObject({ id: user.id, fullName: 'Yeni Ad', role: 'APPROVER', email: user.email, department: { id: departmentId } });
  });

  it('refuses a role that needs a department when the user has none, and a department that is not usable', async () => {
    const { user } = await newUser({ role: 'READER' });

    expect((await patch(staff.admin.token, user.id, { role: 'EDITOR' }).expect(400)).body.code).toBe('DEPARTMENT_REQUIRED');
    expect((await patch(staff.admin.token, user.id, { role: 'EDITOR', departmentId: foreignDepartmentId }).expect(404)).body.code).toBe('DEPARTMENT_NOT_FOUND');
    const editor = await newUser({ role: 'EDITOR', departmentId });
    expect((await patch(staff.admin.token, editor.user.id, { departmentId: null }).expect(400)).body.code).toBe('DEPARTMENT_REQUIRED');
    await patch(staff.admin.token, editor.user.id, { role: 'READER', departmentId: null }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('READER');
  });

  it.each([
    ['an email', { email: 'x@y.co' }],
    ['a password', { password: 'Another-Pass-12' }],
    ['a hash', { passwordHash: 'x' }],
    ['an organization', { organizationId: randomUUID() }],
    ['a role nobody has', { role: 'GOD' }],
    ['a name of one character', { fullName: 'A' }],
    ['a flag that is not a boolean', { isActive: 'no' }],
  ])('refuses %s', async (_label, body) => {
    const { user } = await newUser();
    await patch(staff.admin.token, user.id, body).expect(400);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ email: user.email, role: 'READER', fullName: 'Yeni Kullanıcı' });
  });

  it('answers 404 for unknown users and 400 for ids that are none', async () => {
    expect((await patch(staff.admin.token, randomUUID(), { fullName: 'Kişi' }).expect(404)).body.code).toBe('USER_NOT_FOUND');
    await patch(staff.admin.token, 'not-a-uuid', { fullName: 'Kişi' }).expect(400);
  });

  it('protects the account of the administrator who is acting, but not the name', async () => {
    await patch(staff.admin.token, staff.admin.id, { role: 'READER' }).expect(409).expect((res) => expect(res.body.code).toBe('OWN_ACCOUNT_PROTECTED'));
    await patch(staff.admin.token, staff.admin.id, { isActive: false }).expect(409);
    await patch(staff.admin.token, staff.admin.id, { fullName: 'Yönetici Yeni Ad' }).expect(200);
    await patch(staff.admin.token, staff.admin.id, { fullName: 'Staff admin' }).expect(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: staff.admin.id } })).toMatchObject({ role: 'ADMIN', isActive: true });
  });

  it('keeps an administrator when two of them remove each other at the same moment', async () => {
    const a = await newUser({ role: 'ADMIN' });
    const b = await newUser({ role: 'ADMIN' });
    const tokenOf = (id: string) => signToken(app, { userId: id, organizationId, role: 'ADMIN', departmentId: null });
    const [tokenA, tokenB] = [await tokenOf(a.user.id), await tokenOf(b.user.id)];
    // Everyone else who is an administrator in the organization is out of the way for this test
    await prisma.user.updateMany({ where: { organizationId, role: 'ADMIN', id: { notIn: [a.user.id, b.user.id] }, isActive: true }, data: { isActive: false } });
    const others = await prisma.user.findMany({ where: { organizationId, role: 'ADMIN', isActive: false }, select: { id: true } });

    try {
      const results = await Promise.all([patch(tokenA, b.user.id, { isActive: false }), patch(tokenB, a.user.id, { isActive: false })]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe('LAST_ADMIN_PROTECTED');
      expect(await prisma.user.count({ where: { organizationId, role: 'ADMIN', isActive: true } })).toBe(1);
    } finally {
      // Seeded administrators are active again, as they were
      await prisma.user.updateMany({ where: { id: { in: others.map((other) => other.id).filter((id) => ![a.user.id, b.user.id].includes(id)) }, email: { not: { endsWith: DOMAIN } } }, data: { isActive: true } });
      await prisma.user.updateMany({ where: { id: { in: [staff.admin.id, staff.admin2.id] } }, data: { isActive: true } });
    }
  });

  it('closes the sessions of a user who is taken out of use, who then cannot sign in or refresh', async () => {
    const { user, temporaryPassword } = await newUser();
    const session = await login(user.email, temporaryPassword!).expect(200);

    await patch(staff.admin.token, user.id, { isActive: false }).expect(200);

    await api().post('/api/auth/refresh').set('Cookie', cookieOf(session)).expect(401);
    await login(user.email, temporaryPassword!).expect(401);
    await patch(staff.admin.token, user.id, { isActive: true }).expect(200);
    await login(user.email, temporaryPassword!).expect(200);
  });

  it('is audited with what changed, and a request that changes nothing is not', async () => {
    const { user } = await newUser({ fullName: 'Eski Ad', role: 'READER' });
    await patch(staff.admin.token, user.id, { fullName: 'Yeni Ad', role: 'QUALITY_MANAGER', isActive: false }).expect(200);
    await patch(staff.admin.token, user.id, { fullName: 'Yeni Ad' }).expect(200);
    await patch(staff.admin.token, user.id, {}).expect(200);

    const entries = await auditOf(user.id);

    expect(entries.map((entry) => entry.action)).toEqual(['USER_CREATED', 'USER_UPDATED']);
    expect(entries[1]).toMatchObject({ userId: staff.admin.id, entityType: 'User' });
    expect(entries[1].metadata).toEqual({
      email: user.email,
      changes: { fullName: { from: 'Eski Ad', to: 'Yeni Ad' }, role: { from: 'READER', to: 'QUALITY_MANAGER' }, isActive: { from: true, to: false } },
    });
  });
});

describe('resetting a password', () => {
  it('sets a temporary one that must be changed, closes the sessions, and the old one stops working', async () => {
    const { user } = await newUser({ password: 'Original-Pass-1' });
    const session = await login(user.email, 'Original-Pass-1').expect(200);

    const result = (await reset(staff.admin.token, user.id).expect(200)).body as UserWithPasswordDto;

    expect(result.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(result.user).toMatchObject({ id: user.id, mustChangePassword: true });
    await api().post('/api/auth/refresh').set('Cookie', cookieOf(session)).expect(401);
    await login(user.email, 'Original-Pass-1').expect(401);
    expect((await login(user.email, result.temporaryPassword!).expect(200)).body.user.mustChangePassword).toBe(true);
  });

  it('takes a password of the administrator\'s choice and does not echo it', async () => {
    const { user } = await newUser();
    const result = (await reset(staff.admin.token, user.id, { password: 'Admin-Chose-This-9' }).expect(200)).body as UserWithPasswordDto;
    expect(result.temporaryPassword).toBeNull();
    await login(user.email, 'Admin-Chose-This-9').expect(200);
  });

  it('refuses a short password, the own account and unknown users', async () => {
    const { user } = await newUser();
    await reset(staff.admin.token, user.id, { password: 'short' }).expect(400);
    await reset(staff.admin.token, user.id, { surprise: true }).expect(400);
    expect((await reset(staff.admin.token, staff.admin.id).expect(409)).body.code).toBe('OWN_ACCOUNT_PROTECTED');
    expect((await reset(staff.admin.token, randomUUID()).expect(404)).body.code).toBe('USER_NOT_FOUND');
  });

  it('is audited without the password', async () => {
    const { user } = await newUser();
    const result = (await reset(staff.admin.token, user.id).expect(200)).body as UserWithPasswordDto;

    const entries = (await auditOf(user.id)).filter((entry) => entry.action === 'USER_PASSWORD_RESET');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: staff.admin.id });
    expect(entries[0].metadata).toEqual({ email: user.email, passwordGenerated: true });
    expect(JSON.stringify(entries)).not.toContain(result.temporaryPassword!);
  });
});

describe('choosing a password of one\'s own', () => {
  const change = (token: string, body: Record<string, unknown>) => api().patch('/api/auth/password').set(auth(token)).send(body);

  it('keeps a user with a temporary password away from everything but who they are and the change itself', async () => {
    const { user, temporaryPassword } = await newUser({ role: 'ADMIN' });
    const { accessToken } = (await login(user.email, temporaryPassword!).expect(200)).body;

    for (const path of ['/api/documents', '/api/users', '/api/categories', '/api/departments', '/api/dashboard/stats']) {
      const response = await api().get(path).set(auth(accessToken)).expect(403);
      expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    await api().post('/api/users').set(auth(accessToken)).send({}).expect(403);
    expect((await api().get('/api/auth/me').set(auth(accessToken)).expect(200)).body).toMatchObject({ id: user.id, mustChangePassword: true });
  });

  it('replaces the temporary password, opens a fresh session, closes every other, and then everything works', async () => {
    const { user, temporaryPassword } = await newUser({ role: 'ADMIN' });
    const first = (await login(user.email, temporaryPassword!).expect(200));
    const other = (await login(user.email, temporaryPassword!).expect(200));

    const response = await change(first.body.accessToken, { currentPassword: temporaryPassword, newPassword: 'My-Own-Password-1' }).expect(200);

    expect(response.body.user).toMatchObject({ id: user.id, mustChangePassword: false });
    expect(cookieOf(response)).not.toBe('');
    await api().get('/api/documents').set(auth(response.body.accessToken)).expect(200);
    // The sessions that were open are closed, the one just opened works
    await api().post('/api/auth/refresh').set('Cookie', cookieOf(other)).expect(401);
    await api().post('/api/auth/refresh').set('Cookie', cookieOf(first)).expect(401);
    await login(user.email, temporaryPassword!).expect(401);
    expect((await login(user.email, 'My-Own-Password-1').expect(200)).body.user.mustChangePassword).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(false);
  });

  it('works for a user who is not forced to, too (the flag is cleared and stays so)', async () => {
    const token = staff.reader.token;
    await prisma.user.update({ where: { id: staff.reader.id }, data: { passwordHash: await argon2.hash('Reader-Pass-12') } });

    await change(token, { currentPassword: 'Reader-Pass-12', newPassword: 'Reader-Pass-34' }).expect(200);
    await login(staff.reader.email, 'Reader-Pass-34').expect(200);
  });

  it('refuses a wrong current password, an unchanged one and a short one, and changes nothing', async () => {
    const { user, temporaryPassword } = await newUser();
    const { accessToken } = (await login(user.email, temporaryPassword!).expect(200)).body;

    expect((await change(accessToken, { currentPassword: 'Wrong-Password-1', newPassword: 'Brand-New-Pass-1' }).expect(400)).body.code).toBe('CURRENT_PASSWORD_INCORRECT');
    expect((await change(accessToken, { currentPassword: temporaryPassword, newPassword: temporaryPassword }).expect(400)).body.code).toBe('PASSWORD_UNCHANGED');
    await change(accessToken, { currentPassword: temporaryPassword, newPassword: 'short' }).expect(400);
    await change(accessToken, { currentPassword: temporaryPassword }).expect(400);
    await change(accessToken, { currentPassword: temporaryPassword, newPassword: 'Brand-New-Pass-1', email: 'x@y.co' }).expect(400);
    await login(user.email, temporaryPassword!).expect(200);
  });

  it('requires a session', async () => {
    await api().patch('/api/auth/password').send({ currentPassword: 'a', newPassword: 'b'.repeat(10) }).expect(401);
  });

  it('is audited, without either password', async () => {
    const { user, temporaryPassword } = await newUser();
    const { accessToken } = (await login(user.email, temporaryPassword!).expect(200)).body;
    await change(accessToken, { currentPassword: temporaryPassword, newPassword: 'Audited-Change-1' }).expect(200);

    const entries = (await auditOf(user.id)).filter((entry) => entry.action === 'USER_PASSWORD_CHANGED');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: user.id });
    expect(entries[0].metadata).toEqual({ wasTemporary: true });
    expect(JSON.stringify(entries)).not.toMatch(new RegExp(`${temporaryPassword}|Audited-Change-1`));
  });
});
