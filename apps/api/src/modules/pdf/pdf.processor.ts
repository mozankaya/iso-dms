import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { failureReason, RevisionPdfService } from './revision-pdf.service';
import { PDF_JOB_ATTEMPTS, PDF_QUEUE, type PdfJobData } from './pdf.constants';

/** Makes the PDF copies, one at a time: the document server converts for everybody and has limited capacity. */
@Processor(PDF_QUEUE, { concurrency: 1 })
export class PdfProcessor extends WorkerHost {
  private readonly logger = new Logger(PdfProcessor.name);

  constructor(private readonly pdfs: RevisionPdfService) {
    super();
  }

  /** Connection trouble and the like; without a listener the worker would throw them as unhandled errors. */
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`PDF worker: ${error.message}`);
  }

  async process(job: Job<PdfJobData>): Promise<void> {
    const { revisionId } = job.data;
    try {
      await this.pdfs.generate(revisionId);
    } catch (error) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? PDF_JOB_ATTEMPTS);
      this.logger.warn(`PDF of revision ${revisionId}, attempt ${job.attemptsMade + 1}: ${(error as Error).message}`);
      // Only the last failure is shown; the earlier ones are retried quietly
      if (lastAttempt) await this.pdfs.markFailed(revisionId, failureReason(error));
      throw error;
    }
  }
}
