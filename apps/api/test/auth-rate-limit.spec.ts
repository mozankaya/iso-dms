// Uses the default limit (5 login attempts per minute per IP) on purpose
delete process.env.LOGIN_RATE_LIMIT;

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';

const prisma = createPrismaClient();
let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  // Test cleanup only: remove the failed-login audit entries this test produced
  await prisma.auditLog.deleteMany({
    where: { action: 'USER_LOGIN_FAILED', metadata: { path: ['email'], equals: 'nobody@rate-limit.local' } },
  });
  await prisma.$disconnect();
  await app.close();
});

describe('login rate limit', () => {
  it('blocks the sixth attempt within a minute', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nobody@rate-limit.local', password: 'wrong' });

    for (let i = 0; i < 5; i++) {
      await attempt().expect(401);
    }
    await attempt().expect(429);
  });
});
