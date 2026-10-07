import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto, PaginatedDto, PendingApprovalDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { ApprovalStepWhereInput } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { approvalDenial, canCancelRequest } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { APPROVAL_REQUEST_INCLUDE, isStepActive } from './approval-request.mapper';
import type { ListPendingApprovalsDto } from './dto/list-pending-approvals.dto';

const notCancellable = () =>
  new ConflictException({ code: 'REQUEST_NOT_CANCELLABLE', message: 'The request was already decided or closed' });

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * The steps waiting for the user: it is their step's turn, it is theirs to decide (role and department) and
   * they did not prepare the revision. Oldest request first.
   */
  async listPending(user: AuthenticatedUser, query: ListPendingApprovalsDto): Promise<PaginatedDto<PendingApprovalDto>> {
    const steps = await this.prisma.approvalStep.findMany({
      where: this.candidateWhere(user),
      include: {
        request: {
          include: {
            ...APPROVAL_REQUEST_INCLUDE,
            document: { select: { id: true, code: true, title: true, departmentId: true, department: { select: { id: true, name: true, code: true } } } },
          },
        },
      },
    });

    const waiting = steps
      .filter((step) => {
        const { request } = step;
        return (
          request.document !== null &&
          request.revision !== null &&
          isStepActive(request, step.stepOrder) &&
          approvalDenial(user, step, request.document, request.revision) === null
        );
      })
      .sort((a, b) => a.request.createdAt.getTime() - b.request.createdAt.getTime() || a.id.localeCompare(b.id));

    const items = waiting.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((step) => ({
      stepId: step.id,
      stepOrder: step.stepOrder,
      approverRole: step.approverRole,
      request: {
        id: step.request.id,
        type: step.request.type,
        createdAt: step.request.createdAt.toISOString(),
        requestedBy: step.request.requestedBy,
      },
      document: {
        id: step.request.document!.id,
        code: step.request.document!.code,
        title: step.request.document!.title,
        department: step.request.document!.department,
      },
      revision: { id: step.request.revision!.id, revisionNo: step.request.revision!.revisionNo, changeSummary: null as string | null },
    }));

    // The summary is not part of the request include: one more query for the page only
    const revisions = await this.prisma.revision.findMany({
      where: { organizationId: user.organizationId, id: { in: items.map((item) => item.revision.id) } },
      select: { id: true, changeSummary: true },
    });
    for (const item of items) item.revision.changeSummary = revisions.find((revision) => revision.id === item.revision.id)?.changeSummary ?? null;

    return { items, total: waiting.length, page: query.page, pageSize: query.pageSize };
  }

  /** Takes a request back before anybody decided: the draft is open for editing again. */
  async cancel(user: AuthenticatedUser, requestId: string, ipAddress: string | null): Promise<DocumentDetailDto> {
    const found = await this.prisma.documentRequest.findFirst({
      where: { id: requestId, organizationId: user.organizationId },
      select: { id: true, documentId: true, revisionId: true, requestedById: true },
    });
    if (!found || !found.documentId || !found.revisionId) {
      throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    }
    if (!canCancelRequest(user, found)) {
      throw new ForbiddenException({ code: 'CANCEL_NOT_ALLOWED', message: 'Only whoever sent it to review can take it back' });
    }

    const { documentId, revisionId } = found;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revisionId} FOR UPDATE`;

      const request = await tx.documentRequest.findUniqueOrThrow({ where: { id: found.id }, include: { steps: true } });
      if (request.status !== 'PENDING' || request.steps.some((step) => step.decision !== 'PENDING')) throw notCancellable();

      const document = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
      const revision = await tx.revision.findUniqueOrThrow({ where: { id: revisionId } });
      await tx.documentRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
      await tx.revision.update({ where: { id: revision.id }, data: { status: 'DRAFT' } });
      if (document.status === 'IN_REVIEW') await tx.document.update({ where: { id: document.id }, data: { status: 'DRAFT' } });

      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'REQUEST_CANCELLED',
          entityType: 'Revision',
          entityId: revision.id,
          metadata: { documentId, code: document.code, revisionNo: revision.revisionNo, requestId: request.id },
          ipAddress,
        },
        tx,
      );
    });

    return this.documents.findOne(user, documentId);
  }

  /** Narrows the steps to those that could be the user's; the exact rules are applied in memory (they are small). */
  private candidateWhere(user: AuthenticatedUser): ApprovalStepWhereInput {
    const base: ApprovalStepWhereInput = {
      organizationId: user.organizationId,
      decision: 'PENDING',
      request: { status: 'PENDING' },
    };
    if (user.role === 'ADMIN') return base;
    if (user.role === 'APPROVER') {
      // An approver without a department has no steps of their own
      if (!user.departmentId) return { ...base, id: { in: [] } };
      return { ...base, approverRole: 'APPROVER', request: { status: 'PENDING', document: { departmentId: user.departmentId } } };
    }
    if (user.role === 'QUALITY_MANAGER') return { ...base, approverRole: 'QUALITY_MANAGER' };
    return { ...base, id: { in: [] } };
  }
}
