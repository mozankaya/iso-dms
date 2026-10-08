import { BullModule } from '@nestjs/bullmq';
import { Module, type Provider } from '@nestjs/common';
import { JOBS_ENABLED, JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { REVIEW_REMINDER_QUEUE } from './review-reminder.constants';
import { ReviewReminderProcessor } from './review-reminder.processor';
import { ReviewReminderScheduler } from './review-reminder-scheduler.service';
import { ReviewReminderService } from './review-reminder.service';

const queueImports = JOBS_ENABLED ? [JobsModule, BullModule.registerQueue({ name: REVIEW_REMINDER_QUEUE })] : [];
const workerProviders: Provider[] = JOBS_ENABLED ? [ReviewReminderProcessor] : [];

@Module({
  imports: [NotificationsModule, ...queueImports],
  providers: [ReviewReminderService, ReviewReminderScheduler, ...workerProviders],
  exports: [ReviewReminderService],
})
export class ReviewRemindersModule {}
