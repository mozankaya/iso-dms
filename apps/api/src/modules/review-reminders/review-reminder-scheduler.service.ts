import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  REVIEW_REMINDER_JOB_NAME,
  REVIEW_REMINDER_JOB_OPTIONS,
  REVIEW_REMINDER_QUEUE,
  REVIEW_REMINDER_SCHEDULER_ID,
  REVIEW_REMINDER_SCHEDULE,
} from './review-reminder.constants';

/**
 * Registers the daily schedule with the queue when the application starts. The scheduler is keyed, so starting
 * the application again (or several instances) replaces it instead of adding a second one. Without the queue
 * (JOBS_ENABLED=false) nothing is scheduled.
 */
@Injectable()
export class ReviewReminderScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReviewReminderScheduler.name);

  constructor(@Optional() @InjectQueue(REVIEW_REMINDER_QUEUE) private readonly queue?: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.upsertJobScheduler(REVIEW_REMINDER_SCHEDULER_ID, REVIEW_REMINDER_SCHEDULE, {
        name: REVIEW_REMINDER_JOB_NAME,
        opts: REVIEW_REMINDER_JOB_OPTIONS,
      });
    } catch (error) {
      this.logger.error(`The review reminders could not be scheduled: ${(error as Error).message}`);
    }
  }
}
