import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { ListPendingApprovalsDto } from './dto/list-pending-approvals.dto';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';
import { WithdrawalRequestService } from './withdrawal-request.service';

const WRITER_ROLES = ['EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN'] as const;
const APPROVER_ROLES = ['APPROVER', 'QUALITY_MANAGER', 'ADMIN'] as const;

@Controller()
export class ApprovalsController {
  constructor(
    private readonly submissions: ApprovalSubmissionService,
    private readonly decisions: ApprovalDecisionService,
    private readonly approvals: ApprovalsService,
    private readonly withdrawals: WithdrawalRequestService,
  ) {}

  /** PROJECT.md 6.2 rule 3: the draft is locked and the approval steps are opened. */
  @Post('revisions/:revisionId/submit')
  @HttpCode(200)
  @Roles(...WRITER_ROLES)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Req() req: Request,
  ) {
    return this.submissions.submit(user, revisionId, req.ip ?? null);
  }

  /** PROJECT.md 6.2 rule 7 and 6.4: a reasoned request to take a document in force out of use. */
  @Post('documents/:documentId/withdrawal-requests')
  @HttpCode(200)
  @Roles(...WRITER_ROLES)
  requestWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: RequestWithdrawalDto,
    @Req() req: Request,
  ) {
    return this.withdrawals.request(user, documentId, dto, req.ip ?? null);
  }

  @Get('approvals/pending')
  @Roles(...APPROVER_ROLES)
  pending(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPendingApprovalsDto) {
    return this.approvals.listPending(user, query);
  }

  @Post('approvals/:stepId/approve')
  @HttpCode(200)
  @Roles(...APPROVER_ROLES)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: DecideApprovalDto,
    @Req() req: Request,
  ) {
    return this.decisions.approve(user, stepId, dto, req.ip ?? null);
  }

  @Post('approvals/:stepId/reject')
  @HttpCode(200)
  @Roles(...APPROVER_ROLES)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: DecideApprovalDto,
    @Req() req: Request,
  ) {
    return this.decisions.reject(user, stepId, dto, req.ip ?? null);
  }

  @Post('approval-requests/:requestId/cancel')
  @HttpCode(200)
  @Roles(...WRITER_ROLES)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: Request,
  ) {
    return this.approvals.cancel(user, requestId, req.ip ?? null);
  }
}
