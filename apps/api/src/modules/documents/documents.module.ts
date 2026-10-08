import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentCodeService } from './document-code.service';
import { DocumentReviewService } from './document-review.service';
import { DocumentCreationService } from './document-creation.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentCodeService, DocumentCreationService, DocumentReviewService],
  exports: [DocumentsService, DocumentCodeService],
})
export class DocumentsModule {}
