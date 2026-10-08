import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationMailer } from './notification-mailer.service';
import { NOTIFICATION_JOB_ATTEMPTS, NOTIFICATION_QUEUE, type NotificationJobData } from './notifications.constants';

/** Sends the e-mails, a few at a time; a failed mail is tried again later by the queue. */
@Processor(NOTIFICATION_QUEUE, { concurrency: 3 })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly mailer: NotificationMailer) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Notification worker: ${error.message}`);
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? NOTIFICATION_JOB_ATTEMPTS);
    await this.mailer.send(job.data.notificationId, final);
  }
}
