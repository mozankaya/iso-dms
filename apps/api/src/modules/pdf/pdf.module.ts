import { BullModule } from '@nestjs/bullmq';
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { EditorModule } from '../editor/editor.module';
import { PDF_QUEUE } from './pdf.constants';
import { PdfController } from './pdf.controller';
import { PdfProcessor } from './pdf.processor';
import { PdfQueueService } from './pdf-queue.service';
import { PdfRequestService } from './pdf-request.service';
import { RevisionPdfService } from './revision-pdf.service';

// Evaluated at import time (like the login rate limit), so tests can switch the queue off before the app loads
const WORKER_ENABLED = process.env.PDF_WORKER_ENABLED !== 'false';

function redisConnection(config: ConfigService) {
  const url = new URL(config.get<string>('REDIS_URL', 'redis://localhost:6379'));
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password && { password: decodeURIComponent(url.password) }),
    ...(url.pathname.length > 1 && { db: Number(url.pathname.slice(1)) }),
  };
}

const queueImports = WORKER_ENABLED
  ? [
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: redisConnection(config),
          prefix: config.get<string>('REDIS_QUEUE_PREFIX', 'iso-dms'),
        }),
      }),
      BullModule.registerQueue({ name: PDF_QUEUE }),
    ]
  : [];

const workerProviders: Provider[] = WORKER_ENABLED ? [PdfProcessor] : [];

/**
 * PDF copies of published revisions (PROJECT.md 6.12). The queue and its worker need Redis; with
 * PDF_WORKER_ENABLED=false neither exists and nothing is queued, but the service that makes a copy
 * (and the `pdfStatus` bookkeeping) stays available.
 */
@Module({
  imports: [AuditLogsModule, EditorModule, ...queueImports],
  controllers: [PdfController],
  providers: [RevisionPdfService, PdfQueueService, PdfRequestService, ...workerProviders],
  exports: [RevisionPdfService, PdfQueueService],
})
export class PdfModule {}
