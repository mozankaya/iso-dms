import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import * as argon2 from 'argon2';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import { ObjectStorage, objectStorageOptionsFromEnv } from '../src/modules/storage/object-storage';
import { FILE_TYPE_INFO } from '../src/modules/storage/storage-keys';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { findDocumentFields } from '../src/modules/documents/document-fields/docx-fields';
import { findXlsxFields } from '../src/modules/documents/document-fields/xlsx-fields';
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
      const production = process.env.NODE_ENV === 'production';
      const adminPassword = requireEnv('SEED_ADMIN_PASSWORD');
      // The example value is public: an installation that kept it would have a known administrator password
      if (production && (adminPassword === 'ChangeMe123!' || adminPassword.length < 12)) {
        throw new Error('SEED_ADMIN_PASSWORD must be changed (at least 12 characters, not the example) before seeding in production');
      }
      await prisma.user.create({
        data: {
          organizationId,
          departmentId: departments[0].id,
          email: adminEmail,
          fullName: requireEnv('SEED_ADMIN_FULL_NAME'),
          passwordHash: await argon2.hash(adminPassword),
          role: 'ADMIN',
          // In production the first login has to choose a password of the administrator's own
          mustChangePassword: production,
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
    // Template files are uploaded to object storage too, so the storage service must be running
    const storage = new ObjectStorage(objectStorageOptionsFromEnv());
    for (const template of SEED_TEMPLATES) {
      const storageKey = `${organizationId}/templates/${template.fileName}`;
      const existing = await prisma.template.findFirst({
        where: { organizationId, name: template.name, fileType: template.fileType },
      });
      const file = await readFile(path.resolve(__dirname, '../templates', template.fileName));
      if (!existing) {
        await prisma.template.create({
          data: {
            organizationId,
            name: template.name,
            fileType: template.fileType,
            storageKey,
            // Only one default per file type: an installation that has one keeps it
            isDefault: template.isDefault && !(await prisma.template.findFirst({ where: { organizationId, fileType: template.fileType, categoryId: null, isDefault: true } })),
            fieldTags: template.fileType === 'DOCX' ? await findDocumentFields(file) : await findXlsxFields(file),
          },
        });
      }

      if (!(await storage.exists(existing?.storageKey ?? storageKey))) {
        await storage.put(existing?.storageKey ?? storageKey, file, FILE_TYPE_INFO[template.fileType].mimeType);
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
