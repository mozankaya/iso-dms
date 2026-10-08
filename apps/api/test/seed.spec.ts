import { execSync } from 'node:child_process';
import path from 'node:path';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { SEED_CATEGORIES, SEED_TEMPLATES } from '../prisma/seed-data';

const prisma = createPrismaClient();
const apiRoot = path.resolve(__dirname, '..');

async function counts() {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { slug: process.env.SEED_ORGANIZATION_SLUG },
  });
  const where = { organizationId: organization.id };
  return {
    organizations: await prisma.organization.count({ where: { id: organization.id } }),
    departments: await prisma.department.count({ where }),
    users: await prisma.user.count({ where }),
    categories: await prisma.category.count({ where }),
    templates: await prisma.template.count({ where }),
  };
}

afterAll(() => prisma.$disconnect());

describe('seed', () => {
  it('is idempotent: running twice does not duplicate records', async () => {
    execSync('pnpm exec tsx prisma/seed.ts', { cwd: apiRoot, stdio: 'pipe' });
    const first = await counts();
    execSync('pnpm exec tsx prisma/seed.ts', { cwd: apiRoot, stdio: 'pipe' });
    const second = await counts();

    expect(second).toEqual(first);
    expect(first.categories).toBe(SEED_CATEGORIES.length);
    expect(first.users).toBeGreaterThanOrEqual(1);
    expect(first.templates).toBe(SEED_TEMPLATES.length);
  });

  it('creates the admin user with a hashed password', async () => {
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: process.env.SEED_ADMIN_EMAIL!.toLowerCase(), role: 'ADMIN' },
    });
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
