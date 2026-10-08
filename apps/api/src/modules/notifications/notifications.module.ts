import { BullModule } from '@nestjs/bullmq';
import { Module, type Provider } from '@nestjs/common';
import { JOBS_ENABLED, JobsModule } from '../jobs/jobs.module';
import { MailService } from './mail.service';
import { NotificationMailer } from './notification-mailer.service';
import { NOTIFICATION_QUEUE } from './notifications.constants';
import { NotificationsController } from './notifications.controller';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';

const queueImports = JOBS_ENABLED ? [JobsModule, BullModule.registerQueue({ name: NOTIFICATION_QUEUE })] : [];
const workerProviders: Provider[] = JOBS_ENABLED ? [NotificationsProcessor] : [];

@Module({
  imports: queueImports,
  controllers: [NotificationsController],
  providers: [MailService, NotificationMailer, NotificationsService, ...workerProviders],
  exports: [NotificationsService, MailService],
})
export class NotificationsModule {}
