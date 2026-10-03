process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let app: INestApplication;
let token: string;
let organizationIds: string[] = [];

async function createOrganization(label: string) {
  const organization = await prisma.organization.create({
    data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  const department = await prisma.department.create({
    data: { organizationId: organization.id, name: 'Dept', code: 'DP' },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: organization.id,
      departmentId: department.id,
      email: `u@${label}.local`,
      fullName: 'Categories Test',
      passwordHash: 'x',
      role: 'READER',
    },
  });
  return { organization, department, user };
}

async function createCategory(
  organizationId: string,
  data: { name: string; slug: string; codePrefix: string; sortOrder: number; isActive?: boolean },
) {
  return prisma.category.create({ data: { organizationId, ...data } });
}

async function createDocument(
  ctx: Awaited<ReturnType<typeof createOrganization>>,
  categoryId: string,
  sequenceNo: number,
  status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'WITHDRAWN',
) {
  return prisma.document.create({
    data: {
      organizationId: ctx.organization.id,
      categoryId,
      departmentId: ctx.department.id,
      ownerId: ctx.user.id,
      code: `CT-${categoryId.slice(0, 6)}-${String(sequenceNo).padStart(3, '0')}-${suffix}`,
      sequenceNo,
      title: `Doc ${sequenceNo}`,
      fileType: 'DOCX',
      status,
    },
  });
}

async function tokenFor(ctx: Awaited<ReturnType<typeof createOrganization>>): Promise<string> {
  return app.get(JwtService).signAsync(
    {
      sub: ctx.user.id,
      organizationId: ctx.organization.id,
      role: ctx.user.role,
      departmentId: ctx.user.departmentId,
    },
    { secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 300 },
  );
}

beforeAll(async () => {
  app = await createTestApp();

  const own = await createOrganization('own');
  const other = await createOrganization('other');
  token = await tokenFor(own);

  // Deliberately created out of order to verify sorting
  const second = await createCategory(own.organization.id, { name: 'B Second', slug: 'second', codePrefix: 'BB', sortOrder: 2 });
  const first = await createCategory(own.organization.id, { name: 'A First', slug: 'first', codePrefix: 'AA', sortOrder: 1 });
  await createCategory(own.organization.id, { name: 'Inactive', slug: 'inactive', codePrefix: 'II', sortOrder: 3, isActive: false });
  const foreign = await createCategory(other.organization.id, { name: 'Foreign', slug: 'foreign', codePrefix: 'FF', sortOrder: 1 });

  await createDocument(own, first.id, 1, 'PUBLISHED');
  await createDocument(own, first.id, 2, 'PUBLISHED');
  await createDocument(own, first.id, 3, 'DRAFT');
  await createDocument(own, first.id, 4, 'IN_REVIEW');
  await createDocument(own, first.id, 5, 'WITHDRAWN');
  await createDocument(own, second.id, 1, 'PUBLISHED');
  await createDocument(other, foreign.id, 1, 'PUBLISHED');
});

afterAll(async () => {
  // Test cleanup only; the application never deletes documents physically.
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

describe('GET /api/categories', () => {
  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/categories').expect(401);
  });

  it('returns only active categories of the own organization, sorted by sortOrder', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.map((category: { slug: string }) => category.slug)).toEqual(['first', 'second']);
  });

  it('counts only published documents', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const counts = Object.fromEntries(
      response.body.map((category: { slug: string; documentCount: number }) => [category.slug, category.documentCount]),
    );
    expect(counts).toEqual({ first: 2, second: 1 });
  });

  it('exposes the fields the dashboard needs', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body[0]).toEqual({
      id: expect.any(String),
      name: 'A First',
      slug: 'first',
      codePrefix: 'AA',
      description: null,
      icon: null,
      sortOrder: 1,
      isExternal: false,
      externalUrl: null,
      documentCount: 2,
    });
  });
});

describe('GET /api/dashboard/stats', () => {
  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/stats').expect(401);
  });

  it('counts published documents of the own organization only', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/dashboard/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ totalDocuments: 3 });
  });
});
