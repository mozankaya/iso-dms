/**
 * Development-only sample data (NOT part of the normal seed): extra departments, one user per role
 * and a few dozen documents so lists, filters and pagination can be tried by hand.
 * Files do not exist in object storage, so opening or downloading these documents does not work.
 * Run with: pnpm --filter @iso-dms/api seed:demo
 */
import path from 'node:path';
import dotenv from 'dotenv';
import * as argon2 from 'argon2';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import type { DocumentStatus, FileType, UserRole } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/create-prisma-client';

const DEMO_DEPARTMENTS = [
  { name: 'İnsan Kaynakları', code: 'IK' },
  { name: 'Bilgi İşlem', code: 'BI' },
];

const DEMO_USERS: { email: string; fullName: string; role: UserRole; departmentCode: string }[] = [
  { email: 'reader@example.com', fullName: 'Demo Okuyucu', role: 'READER', departmentCode: 'IK' },
  { email: 'editor@example.com', fullName: 'Demo Editör (İK)', role: 'EDITOR', departmentCode: 'IK' },
  { email: 'approver@example.com', fullName: 'Demo Onaylayıcı', role: 'APPROVER', departmentCode: 'KK' },
  { email: 'quality@example.com', fullName: 'Demo Kalite Yöneticisi', role: 'QUALITY_MANAGER', departmentCode: 'KK' },
];

const TITLES: Record<string, string[]> = {
  procedures: [
    'Doküman Kontrol Prosedürü',
    'Kayıt Kontrol Prosedürü',
    'İç Tetkik Prosedürü',
    'Düzeltici ve Önleyici Faaliyet Prosedürü',
    'Uygunsuzluk Yönetimi Prosedürü',
    'Yönetimin Gözden Geçirmesi Prosedürü',
    'Eğitim Prosedürü',
    'Satın Alma Prosedürü',
    'Tedarikçi Değerlendirme Prosedürü',
    'Risk ve Fırsat Yönetimi Prosedürü',
    'Müşteri Memnuniyeti Prosedürü',
    'Şikayet Yönetimi Prosedürü',
  ],
  forms: [
    'İç Tetkik Planı Formu',
    'Uygunsuzluk Bildirim Formu',
    'Eğitim Katılım Formu',
    'Tedarikçi Değerlendirme Formu',
    'Doküman Değişiklik Talep Formu',
    'Müşteri Şikayet Formu',
    'Toplantı Tutanağı Formu',
    'Düzeltici Faaliyet Formu',
  ],
  instructions: [
    'Cihaz Kalibrasyon Talimatı',
    'Yedekleme Talimatı',
    'Acil Durum Talimatı',
    'Temizlik Talimatı',
    'Arşiv Kullanım Talimatı',
  ],
};

const FILE_TYPE_BY_SLUG: Record<string, FileType> = { procedures: 'DOCX', forms: 'XLSX', instructions: 'DOCX' };

function statusFor(index: number): DocumentStatus {
  if (index % 11 === 5) return 'DRAFT';
  if (index % 13 === 7) return 'IN_REVIEW';
  if (index % 9 === 8) return 'WITHDRAWN';
  return 'PUBLISHED';
}

async function main() {
  const prisma = createPrismaClient();
  try {
    const organization = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const organizationId = organization.id;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!password) throw new Error('SEED_ADMIN_PASSWORD is not set');

    for (const department of DEMO_DEPARTMENTS) {
      await prisma.department.upsert({
        where: { organizationId_code: { organizationId, code: department.code } },
        update: {},
        create: { organizationId, ...department },
      });
    }
    const departments = await prisma.department.findMany({ where: { organizationId, isActive: true } });
    const departmentByCode = new Map(departments.map((department) => [department.code, department]));

    const passwordHash = await argon2.hash(password);
    for (const user of DEMO_USERS) {
      await prisma.user.upsert({
        where: { organizationId_email: { organizationId, email: user.email } },
        update: {},
        create: {
          organizationId,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          passwordHash,
          departmentId: departmentByCode.get(user.departmentCode)?.id,
        },
      });
    }

    const admin = await prisma.user.findFirstOrThrow({ where: { organizationId, role: 'ADMIN' } });
    const departmentCodes = departments.map((department) => department.code).sort();
    let created = 0;

    for (const [slug, titles] of Object.entries(TITLES)) {
      const category = await prisma.category.findUniqueOrThrow({
        where: { organizationId_slug: { organizationId, slug } },
      });
      const sequenceByDepartment = new Map<string, number>();

      for (const [index, title] of titles.entries()) {
        const department = departmentByCode.get(departmentCodes[index % departmentCodes.length])!;
        const sequenceNo = (sequenceByDepartment.get(department.id) ?? 0) + 1;
        sequenceByDepartment.set(department.id, sequenceNo);
        const code = `${category.codePrefix}-${department.code}-${String(sequenceNo).padStart(3, '0')}`;

        const exists = await prisma.document.findUnique({
          where: { organizationId_code: { organizationId, code } },
        });
        if (exists) continue;

        const status = statusFor(index + slug.length);
        const published = status === 'PUBLISHED' || status === 'WITHDRAWN';
        const revisionNo = published ? index % 4 : null;
        const firstPublishedAt = published ? new Date(Date.UTC(2025, index % 12, 1 + (index % 27), 9)) : null;
        const revisedAt = revisionNo ? new Date(Date.UTC(2026, index % 9, 1 + (index % 27), 9)) : null;

        const document = await prisma.document.create({
          data: {
            organizationId,
            categoryId: category.id,
            departmentId: department.id,
            ownerId: admin.id,
            code,
            sequenceNo,
            title,
            fileType: FILE_TYPE_BY_SLUG[slug],
            status,
            firstPublishedAt,
            revisedAt,
            withdrawnAt: status === 'WITHDRAWN' ? new Date() : null,
            withdrawalReason: status === 'WITHDRAWN' ? 'Demo veri' : null,
          },
        });

        const revision = await prisma.revision.create({
          data: {
            organizationId,
            documentId: document.id,
            revisionNo: revisionNo ?? 0,
            status: published ? 'APPROVED' : status === 'IN_REVIEW' ? 'IN_REVIEW' : 'DRAFT',
            storageKey: `${organizationId}/${document.id}/demo-placeholder`,
            fileSize: 0,
            checksum: 'demo',
            editorKey: `demo-${document.id}`,
            preparedById: admin.id,
            approvedById: published ? admin.id : null,
            approvedAt: firstPublishedAt,
            publishedAt: firstPublishedAt,
          },
        });
        if (published) {
          await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
        }
        created++;
      }
    }

    console.log(`Demo seed completed (${created} new documents)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
