import { Injectable } from '@nestjs/common';
import { DASHBOARD_PERIOD_DAYS, type DashboardStatsDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { publicationWhere, windowStart } from '../lists/publication-where';

/** Roles that hold approval steps (PROJECT.md 6.3). */
const APPROVAL_ROLES = ['APPROVER', 'QUALITY_MANAGER', 'ADMIN'];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * The counters of the dashboard (PROJECT.md 9, screen 2). Each one counts what the user may see, with the same
   * rules as the lists they lead to, so a number never promises more than the list shows. A counter the user's role
   * has no business with is null.
   */
  async getStats(user: AuthenticatedUser): Promise<DashboardStatsDto> {
    const since = windowStart(DASHBOARD_PERIOD_DAYS);
    const mayWithdrawn = user.role !== 'READER';
    const mayDecide = APPROVAL_ROLES.includes(user.role);

    const [totalDocuments, newlyPublished, revised, withdrawn, awaiting] = await Promise.all([
      // Published documents are visible to everybody
      this.prisma.document.count({ where: { organizationId: user.organizationId, status: 'PUBLISHED' } }),
      this.prisma.document.count({ where: publicationWhere(user, 'new', since) }),
      this.prisma.document.count({ where: publicationWhere(user, 'revised', since) }),
      mayWithdrawn ? this.prisma.document.count({ where: publicationWhere(user, 'withdrawn', since) }) : null,
      mayDecide ? this.approvals.listPending(user, { page: 1, pageSize: 1 }) : null,
    ]);

    return { totalDocuments, newlyPublished, revised, withdrawn, awaitingApproval: awaiting?.total ?? null };
  }
}
