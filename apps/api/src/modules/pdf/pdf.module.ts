import { BullModule } from '@nestjs/bullmq';
import { Module, type Provider } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { EditorModule } from '../editor/editor.module';
import { JOBS_ENABLED, JobsModule } from '../jobs/jobs.module';
import { PDF_QUEUE } from './pdf.constants';
import { PdfController } from './pdf.controller';
import { PdfProcessor } from './pdf.processor';
import { PdfQueueService } from './pdf-queue.service';
import { PdfRequestService } from './pdf-request.service';
import { RevisionPdfService } from './revision-pdf.service';

const queueImports = JOBS_ENABLED ? [JobsModule, BullModule.registerQueue({ name: PDF_QUEUE })] : [];

const workerProviders: Provider[] = JOBS_ENABLED ? [PdfProcessor] : [];

/**
 * PDF copies of published revisions (PROJECT.md 6.12). The queue and its worker need Redis; with
 * JOBS_ENABLED=false neither exists and nothing is queued, but the service that makes a copy
 * (and the `pdfStatus` bookkeeping) stays available.
 */
@Module({
  imports: [AuditLogsModule, EditorModule, ...queueImports],
  controllers: [PdfController],
  providers: [RevisionPdfService, PdfQueueService, PdfRequestService, ...workerProviders],
  exports: [RevisionPdfService, PdfQueueService],
})
export class PdfModule {}
