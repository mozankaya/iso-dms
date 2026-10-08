import type { JobsOptions } from 'bullmq';

export const NOTIFICATION_QUEUE = 'notification-mails';
export const NOTIFICATION_JOB_NAME = 'send-mail';

export const NOTIFICATION_JOB_ATTEMPTS = 5;

/** A mail server that is down for a while is no reason to lose the message: five attempts over about half an hour. */
export const NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: NOTIFICATION_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};

export interface NotificationJobData {
  notificationId: string;
}
