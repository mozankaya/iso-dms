import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentFieldsModule } from '../documents/document-fields/document-fields.module';
import { DocumentsModule } from '../documents/documents.module';
import { EditorModule } from '../editor/editor.module';
import { RevisionCancellationService } from './revision-cancellation.service';
import { RevisionPublicationService } from './revision-publication.service';
import { RevisionStartingService } from './revision-starting.service';
import { RevisionsController } from './revisions.controller';
import { RevisionsService } from './revisions.service';

@Module({
  imports: [AuditLogsModule, DocumentFieldsModule, DocumentsModule, EditorModule],
  controllers: [RevisionsController],
  providers: [RevisionsService, RevisionPublicationService, RevisionStartingService, RevisionCancellationService],
  exports: [RevisionPublicationService],
})
export class RevisionsModule {}
