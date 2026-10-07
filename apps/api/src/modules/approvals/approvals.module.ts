import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentsModule } from '../documents/documents.module';
import { EditorModule } from '../editor/editor.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuditLogsModule, DocumentsModule, EditorModule, RevisionsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalSubmissionService, ApprovalDecisionService, ApprovalsService],
})
export class ApprovalsModule {}
