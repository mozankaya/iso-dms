import path from 'node:path';
import dotenv from 'dotenv';
import * as argon2 from 'argon2';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { ensureBlankTemplateFiles } from './blank-templates';
import { SEED_CATEGORIES, SEED_DEPARTMENTS, SEED_TEMPLATES } from './seed-data';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const prisma = createPrismaClient();

  try {
    const organization = await prisma.organization.upsert({
      where: { slug: requireEnv('SEED_ORGANIZATION_SLUG') },
      update: {},
      create: {
        name: requireEnv('SEED_ORGANIZATION_NAME'),
        slug: requireEnv('SEED_ORGANIZATION_SLUG'),
      },
    });
    const organizationId = organization.id;

    const departments = [];
    for (const department of SEED_DEPARTMENTS) {
      departments.push(
        await prisma.department.upsert({
          where: { organizationId_code: { organizationId, code: department.code } },
          update: {},
          create: { organizationId, ...department },
        }),
      );
    }

    const adminEmail = requireEnv('SEED_ADMIN_EMAIL').toLowerCase();
    const existingAdmin = await prisma.user.findUnique({
      where: { organizationId_email: { organizationId, email: adminEmail } },
    });
    if (!existingAdmin) {
      await prisma.user.create({
        data: {
          organizationId,
          departmentId: departments[0].id,
          email: adminEmail,
          fullName: requireEnv('SEED_ADMIN_FULL_NAME'),
          passwordHash: await argon2.hash(requireEnv('SEED_ADMIN_PASSWORD')),
          role: 'ADMIN',
        },
      });
    }

    for (const category of SEED_CATEGORIES) {
      await prisma.category.upsert({
        where: { organizationId_slug: { organizationId, slug: category.slug } },
        update: {},
        create: { organizationId, ...category },
      });
    }

    await ensureBlankTemplateFiles();
    for (const template of SEED_TEMPLATES) {
      const existing = await prisma.template.findFirst({
        where: { organizationId, name: template.name, fileType: template.fileType },
      });
      if (!existing) {
        await prisma.template.create({
          data: {
            organizationId,
            name: template.name,
            fileType: template.fileType,
            // Placeholder key: the file is uploaded to object storage once modules/storage exists.
            storageKey: `${organizationId}/templates/${template.fileName}`,
            isDefault: true,
          },
        });
      }
    }

    console.log('Seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
