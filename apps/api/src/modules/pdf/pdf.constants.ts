import type { JobsOptions } from 'bullmq';

export const PDF_QUEUE = 'pdf-copies';
export const PDF_JOB_NAME = 'convert-revision';

/** Three attempts, each after a longer pause: the document server may be busy or restarting. */
export const PDF_JOB_ATTEMPTS = 3;

export const PDF_JOB_OPTIONS: JobsOptions = {
  attempts: PDF_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};

export interface PdfJobData {
  revisionId: string;
}
