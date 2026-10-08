import type { PrismaClient } from '../../src/generated/prisma/client';
import type { AuditLogWhereInput, FeedbackWhereInput } from '../../src/generated/prisma/models';

/**
 * Test cleanup only. The database refuses to delete audit entries (migration audit_log_append_only) and feedback
 * (add_feedback_resolution) unless the transaction announces maintenance; the application itself never does that.
 */
export async function deleteAuditLogs(prisma: PrismaClient, where: AuditLogWhereInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_log_maintenance', 'on', true)`;
    await tx.auditLog.deleteMany({ where });
  });
}

export async function deleteFeedback(prisma: PrismaClient, where: FeedbackWhereInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_log_maintenance', 'on', true)`;
    await tx.feedback.deleteMany({ where });
  });
}

/** Moves feedback back in time (the rate limit looks at the last minute); a maintenance transaction like the above. */
export async function ageFeedback(prisma: PrismaClient, where: FeedbackWhereInput, minutes: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_log_maintenance', 'on', true)`;
    const rows = await tx.feedback.findMany({ where, select: { id: true, createdAt: true } });
    for (const row of rows) {
      await tx.feedback.update({ where: { id: row.id }, data: { createdAt: new Date(row.createdAt.getTime() - minutes * 60_000) } });
    }
  });
}
