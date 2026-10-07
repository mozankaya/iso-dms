import { Injectable } from '@nestjs/common';
import type { InputJsonValue } from '@prisma/client/runtime/client';
import type { AuditAction } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditLogEntry {
  organizationId: string;
  userId?: string | null;
  /** Every action is listed in AUDIT_ACTIONS (packages/shared), which the audit screens rely on */
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata?: InputJsonValue;
  ipAddress?: string | null;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to make the entry part of the caller's transaction. */
  async log(entry: AuditLogEntry, client: Pick<PrismaService, 'auditLog'> = this.prisma): Promise<void> {
    await client.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }
}
