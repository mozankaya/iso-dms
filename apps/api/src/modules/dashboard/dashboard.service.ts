import { Injectable } from '@nestjs/common';
import type { DashboardStatsDto } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(organizationId: string): Promise<DashboardStatsDto> {
    const totalDocuments = await this.prisma.document.count({
      where: { organizationId, status: 'PUBLISHED' },
    });
    return { totalDocuments };
  }
}
