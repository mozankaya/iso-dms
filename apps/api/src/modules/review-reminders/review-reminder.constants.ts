import type { JobsOptions } from 'bullmq';

export const REVIEW_REMINDER_QUEUE = 'review-reminders';
export const REVIEW_REMINDER_JOB_NAME = 'send-reminders';
export const REVIEW_REMINDER_SCHEDULER_ID = 'daily-review-reminders';

/** Every morning at 08:00 in the time zone of the organization (PROJECT.md 9). */
export const REVIEW_REMINDER_SCHEDULE = { pattern: '0 8 * * *', tz: 'Europe/Istanbul' } as const;

/** A day the job could not run is not made up for: the next run sends what is current. Retry once for a hiccup. */
export const REVIEW_REMINDER_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 5 * 60 * 1000 },
  removeOnComplete: 30,
  removeOnFail: 30,
};
