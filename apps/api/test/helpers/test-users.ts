import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { PrismaClient, User } from '../../src/generated/prisma/client';
import type { UserRole } from '../../src/generated/prisma/enums';
import { deleteAuditLogs } from './audit-cleanup';

export const TEST_PASSWORD = 'Test-Password-1';

export interface TestUser extends User {
  plainPassword: string;
}

/** Creates users inside the seeded organization (login resolves the first organization). */
export async function createTestUser(
  prisma: PrismaClient,
  options: { role: UserRole; isActive?: boolean },
): Promise<TestUser> {
  const organization = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: `test-${randomUUID().slice(0, 8)}@auth-test.local`,
      fullName: 'Auth Test User',
      passwordHash: await argon2.hash(TEST_PASSWORD),
      role: options.role,
      isActive: options.isActive ?? true,
    },
  });
  return { ...user, plainPassword: TEST_PASSWORD };
}

/** Test cleanup only; the application never deletes users or audit records. */
export async function deleteTestUsers(prisma: PrismaClient, users: User[]): Promise<void> {
  const ids = users.map((user) => user.id);
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await deleteAuditLogs(prisma, { userId: { in: ids } });
  await deleteAuditLogs(prisma, {
    action: 'USER_LOGIN_FAILED',
    entityId: 'unknown',
    metadata: { path: ['email'], string_contains: '@auth-test.local' },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
