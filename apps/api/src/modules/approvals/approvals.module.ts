import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentFieldsModule } from '../documents/document-fields/document-fields.module';
import { DocumentsModule } from '../documents/documents.module';
import { EditorModule } from '../editor/editor.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PdfModule } from '../pdf/pdf.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { SearchModule } from '../search/search.module';
import { ApprovalNotifier } from './approval-notifier.service';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { DocumentWithdrawalService } from './document-withdrawal.service';
import { WithdrawalRequestService } from './withdrawal-request.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuditLogsModule, DocumentFieldsModule, DocumentsModule, EditorModule, NotificationsModule, PdfModule, RevisionsModule, SearchModule],
  controllers: [ApprovalsController],
  providers: [ApprovalNotifier, ApprovalSubmissionService, ApprovalDecisionService, ApprovalsService, DocumentWithdrawalService, WithdrawalRequestService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
