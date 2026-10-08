import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { PDF_JOB_NAME, PDF_JOB_OPTIONS, PDF_QUEUE } from './pdf.constants';

/** The queue is looked at again now and then, in case a job was lost between the database and Redis. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Puts PDF jobs on the queue. The database is the source of truth: a published revision whose `pdfStatus` is
 * PENDING still needs its copy, whatever happened to the job. So adding a job is best effort and a sweep
 * (at start-up and every few minutes) re-adds the ones that are missing; the job id is the revision id, which
 * makes adding the same revision twice harmless.
 *
 * Without the queue (JOBS_ENABLED=false) every method does nothing.
 */
@Injectable()
export class PdfQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PdfQueueService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @InjectQueue(PDF_QUEUE) private readonly queue?: Queue,
  ) {}

  get enabled(): boolean {
    return this.queue !== undefined;
  }

  /** Never throws: the caller has just committed something more important than the PDF. */
  async enqueue(revisionId: string): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.add(PDF_JOB_NAME, { revisionId }, { ...PDF_JOB_OPTIONS, jobId: revisionId });
    } catch (error) {
      this.logger.error(`The PDF job of revision ${revisionId} could not be queued: ${(error as Error).message}`);
    }
  }

  /** Adds a job for every revision that is waiting for its copy; returns how many were looked at. */
  async sweep(): Promise<number> {
    if (!this.queue) return 0;
    const waiting = await this.prisma.revision.findMany({ where: { pdfStatus: 'PENDING', publishedAt: { not: null } }, select: { id: true } });
    for (const revision of waiting) await this.enqueue(revision.id);
    return waiting.length;
  }

  onApplicationBootstrap(): void {
    if (!this.queue) return;
    const run = () => this.sweep().catch((error: Error) => this.logger.error(`PDF sweep failed: ${error.message}`));
    void run();
    this.timer = setInterval(run, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
