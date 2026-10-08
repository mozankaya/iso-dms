process.env.LOGIN_RATE_LIMIT = '1000';
// The queue (it needs Redis) exists only when this is not 'false'; read when the modules are loaded
process.env.JOBS_ENABLED = 'true';

import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { REVIEW_REMINDER_QUEUE, REVIEW_REMINDER_SCHEDULER_ID, REVIEW_REMINDER_SCHEDULE } from '../src/modules/review-reminders/review-reminder.constants';
import { ReviewReminderScheduler } from '../src/modules/review-reminders/review-reminder-scheduler.service';
import { createTestApp } from './helpers/create-test-app';

let app: INestApplication;
let queue: Queue;

beforeAll(async () => {
  app = await createTestApp();
  queue = app.get<Queue>(getQueueToken(REVIEW_REMINDER_QUEUE));
});

afterAll(async () => {
  await queue.removeJobScheduler(REVIEW_REMINDER_SCHEDULER_ID).catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await app.close();
});

describe('the schedule of the reminders (needs Redis)', () => {
  it('is registered when the application starts: every day at 08:00 Istanbul time', async () => {
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.filter((scheduler) => scheduler.key === REVIEW_REMINDER_SCHEDULER_ID);

    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ pattern: REVIEW_REMINDER_SCHEDULE.pattern, tz: 'Europe/Istanbul', name: 'send-reminders' });
    expect(REVIEW_REMINDER_SCHEDULE.pattern).toBe('0 8 * * *');
    // The next run is in the future, at eight o'clock there (05:00 UTC; Turkey has no summer time)
    expect(ours[0].next).toBeGreaterThan(Date.now());
    expect(new Date(ours[0].next!).getUTCHours()).toBe(5);
  });

  it('is replaced, not doubled, when the application starts again', async () => {
    await app.get(ReviewReminderScheduler).onApplicationBootstrap();
    await app.get(ReviewReminderScheduler).onApplicationBootstrap();

    const ours = (await queue.getJobSchedulers()).filter((scheduler) => scheduler.key === REVIEW_REMINDER_SCHEDULER_ID);
    expect(ours).toHaveLength(1);
  });
});
