import { Injectable } from '@nestjs/common';
import type { InputJsonValue } from '@prisma/client/runtime/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditLogEntry {
  organizationId: string;
  userId?: string | null;
  action: string;
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
