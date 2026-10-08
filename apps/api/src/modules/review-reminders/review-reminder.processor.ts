import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { REVIEW_REMINDER_QUEUE } from './review-reminder.constants';
import { ReviewReminderService } from './review-reminder.service';

/** Runs the daily reminders when the schedule fires. */
@Processor(REVIEW_REMINDER_QUEUE, { concurrency: 1 })
export class ReviewReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewReminderProcessor.name);

  constructor(private readonly reminders: ReviewReminderService) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Review reminder worker: ${error.message}`);
  }

  async process(): Promise<void> {
    await this.reminders.run();
  }
}
