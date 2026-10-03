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

  async log(entry: AuditLogEntry): Promise<void> {
    await this.prisma.auditLog.create({
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
