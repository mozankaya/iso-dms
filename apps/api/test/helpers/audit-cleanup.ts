import type { PrismaClient } from '../../src/generated/prisma/client';
import type { AuditLogWhereInput } from '../../src/generated/prisma/models';

/**
 * Test cleanup only. The database refuses to delete audit entries (migration audit_log_append_only) unless the
 * transaction announces maintenance; the application itself never does that.
 */
export async function deleteAuditLogs(prisma: PrismaClient, where: AuditLogWhereInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_log_maintenance', 'on', true)`;
    await tx.auditLog.deleteMany({ where });
  });
}
