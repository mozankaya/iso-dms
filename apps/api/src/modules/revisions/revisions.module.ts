import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentsModule } from '../documents/documents.module';
import { EditorModule } from '../editor/editor.module';
import { RevisionPublishingService } from './revision-publishing.service';
import { RevisionStartingService } from './revision-starting.service';
import { RevisionsController } from './revisions.controller';
import { RevisionsService } from './revisions.service';

@Module({
  imports: [AuditLogsModule, DocumentsModule, EditorModule],
  controllers: [RevisionsController],
  providers: [RevisionsService, RevisionPublishingService, RevisionStartingService],
})
export class RevisionsModule {}
