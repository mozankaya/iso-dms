process.env.LOGIN_RATE_LIMIT = '1000';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';
import { createTestUser, deleteTestUsers, TEST_PASSWORD, TestUser } from './helpers/test-users';

const prisma = createPrismaClient();
let app: INestApplication;
let admin: TestUser;
let reader: TestUser;
let inactive: TestUser;

function login(email: string, password: string) {
  return request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
}

function refreshCookie(response: request.Response): string {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((value) => value.startsWith('refresh_token='));
  if (!cookie) throw new Error('refresh_token cookie not set');
  return cookie;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await createTestUser(prisma, { role: 'ADMIN' });
  reader = await createTestUser(prisma, { role: 'READER' });
  inactive = await createTestUser(prisma, { role: 'EDITOR', isActive: false });
});

afterAll(async () => {
  await deleteTestUsers(prisma, [admin, reader, inactive]);
  await app.close();
  await prisma.$disconnect();
});

describe('login', () => {
  it('returns an access token and sets an httpOnly refresh cookie', async () => {
    const response = await login(admin.email, TEST_PASSWORD).expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ id: admin.id, role: 'ADMIN', email: admin.email });
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();

    const cookie = refreshCookie(response);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('accepts the email regardless of case and surrounding spaces', async () => {
    await login(`  ${admin.email.toUpperCase()} `, TEST_PASSWORD).expect(200);
  });

  it('updates lastLoginAt', async () => {
    await login(reader.email, TEST_PASSWORD).expect(200);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: reader.id } });
    expect(updated.lastLoginAt).not.toBeNull();
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrongPassword = await login(admin.email, 'wrong-password').expect(401);
    const unknownUser = await login('nobody@auth-test.local', TEST_PASSWORD).expect(401);

    expect(wrongPassword.body).toEqual(unknownUser.body);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an inactive user even with the correct password', async () => {
    const response = await login(inactive.email, TEST_PASSWORD).expect(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an invalid request body', async () => {
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
  });

  it('writes audit log entries for successful and failed logins', async () => {
    await login(admin.email, TEST_PASSWORD).expect(200);
    await login(admin.email, 'wrong-password').expect(401);

    const actions = (await prisma.auditLog.findMany({ where: { userId: admin.id } })).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['USER_LOGIN', 'USER_LOGIN_FAILED']));
  });
});

describe('protected routes', () => {
  it('rejects requests without a token', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('rejects an invalid token', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.token')
      .expect(401);
  });

  it('returns the current user for a valid token', async () => {
    const { body } = await login(admin.email, TEST_PASSWORD).expect(200);
    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
    expect(response.body).toMatchObject({ id: admin.id, email: admin.email });
  });
});

describe('roles', () => {
  async function tokenFor(user: TestUser): Promise<string> {
    const { body } = await login(user.email, TEST_PASSWORD).expect(200);
    return body.accessToken;
  }

  it('allows a listed role', async () => {
    const token = await tokenFor(admin);
    await request(app.getHttpServer())
      .get('/api/test/admin-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a role that is not listed', async () => {
    const token = await tokenFor(reader);
    const response = await request(app.getHttpServer())
      .get('/api/test/admin-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('lets any authenticated role through when no roles are required', async () => {
    const token = await tokenFor(reader);
    await request(app.getHttpServer())
      .get('/api/test/any-user')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

describe('refresh', () => {
  it('rotates the refresh token and returns a new access token', async () => {
    const first = await login(admin.email, TEST_PASSWORD).expect(200);
    const firstCookie = cookiePair(refreshCookie(first));

    const second = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(200);

    expect(second.body.accessToken).toEqual(expect.any(String));
    expect(cookiePair(refreshCookie(second))).not.toBe(firstCookie);
  });

  it('rejects a missing refresh cookie', async () => {
    await request(app.getHttpServer()).post('/api/auth/refresh').expect(401);
  });

  it('rejects reuse of a rotated token and revokes the whole chain', async () => {
    const first = await login(admin.email, TEST_PASSWORD).expect(200);
    const firstCookie = cookiePair(refreshCookie(first));

    const second = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(200);
    const secondCookie = cookiePair(refreshCookie(second));

    await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', firstCookie).expect(401);
    // The legitimate newer token is revoked too, because the old one may have leaked
    await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', secondCookie).expect(401);

    const actions = (await prisma.auditLog.findMany({ where: { userId: admin.id } })).map(
      (entry) => entry.action,
    );
    expect(actions).toContain('REFRESH_TOKEN_REUSE_DETECTED');
  });

  it('rejects a refresh token for a user that was deactivated', async () => {
    const user = await createTestUser(prisma, { role: 'EDITOR' });
    try {
      const response = await login(user.email, TEST_PASSWORD).expect(200);
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', cookiePair(refreshCookie(response)))
        .expect(401);
    } finally {
      await deleteTestUsers(prisma, [user]);
    }
  });
});

describe('logout', () => {
  it('revokes the refresh token, clears the cookie and writes an audit log', async () => {
    const response = await login(reader.email, TEST_PASSWORD).expect(200);
    const cookie = cookiePair(refreshCookie(response));

    const logout = await request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expect(refreshCookie(logout)).toMatch(/refresh_token=;/);

    await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', cookie).expect(401);

    const actions = (await prisma.auditLog.findMany({ where: { userId: reader.id } })).map(
      (entry) => entry.action,
    );
    expect(actions).toContain('USER_LOGOUT');
  });

  it('succeeds without a cookie', async () => {
    await request(app.getHttpServer()).post('/api/auth/logout').expect(204);
  });
});
