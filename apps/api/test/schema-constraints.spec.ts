import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '../src/prisma/create-prisma-client';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);

let organizationId: string;
let categoryId: string;
let departmentId: string;
let userId: string;

function newDocument(sequenceNo: number, code: string) {
  return prisma.document.create({
    data: {
      organizationId,
      categoryId,
      departmentId,
      ownerId: userId,
      code,
      sequenceNo,
      title: `Test document ${code}`,
      fileType: 'DOCX',
    },
  });
}

function newRevision(documentId: string, revisionNo: number, status: 'DRAFT' | 'SUPERSEDED') {
  return prisma.revision.create({
    data: {
      organizationId,
      documentId,
      revisionNo,
      status,
      storageKey: `test/${documentId}/${revisionNo}.docx`,
      fileSize: 1,
      checksum: 'x',
      editorKey: randomUUID(),
      preparedById: userId,
    },
  });
}

beforeAll(async () => {
  const organization = await prisma.organization.create({
    data: { name: `Test ${suffix}`, slug: `test-${suffix}` },
  });
  organizationId = organization.id;
  categoryId = (
    await prisma.category.create({
      data: { organizationId, name: 'Test', slug: 'test', codePrefix: 'TT' },
    })
  ).id;
  departmentId = (
    await prisma.department.create({ data: { organizationId, name: 'Test', code: 'TD' } })
  ).id;
  userId = (
    await prisma.user.create({
      data: { organizationId, email: 'u@test.local', fullName: 'Test', passwordHash: 'x' },
    })
  ).id;
});

afterAll(async () => {
  // Test cleanup only; the application never deletes documents or revisions physically.
  await prisma.document.updateMany({ where: { organizationId }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId } });
  await prisma.document.deleteMany({ where: { organizationId } });
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.department.deleteMany({ where: { organizationId } });
  await prisma.category.deleteMany({ where: { organizationId } });
  await prisma.organization.delete({ where: { id: organizationId } });
  await prisma.$disconnect();
});

describe('document code uniqueness', () => {
  it('rejects a duplicate sequence number for the same category and department', async () => {
    await newDocument(1, 'TT-TD-001');
    await expect(newDocument(1, 'TT-TD-999')).rejects.toThrow();
  });

  it('rejects a duplicate document code within an organization', async () => {
    await newDocument(2, 'TT-TD-002');
    await expect(newDocument(3, 'TT-TD-002')).rejects.toThrow();
  });
});

describe('open revision rule', () => {
  it('allows only one open draft revision per document', async () => {
    const document = await newDocument(10, 'TT-TD-010');
    await newRevision(document.id, 0, 'SUPERSEDED');
    await newRevision(document.id, 1, 'DRAFT');
    await expect(newRevision(document.id, 2, 'DRAFT')).rejects.toThrow();
  });
});

describe('physical deletion protection', () => {
  it('blocks deleting a document that has revisions', async () => {
    const document = await newDocument(20, 'TT-TD-020');
    await newRevision(document.id, 0, 'SUPERSEDED');
    await expect(prisma.document.delete({ where: { id: document.id } })).rejects.toThrow();
  });
});
