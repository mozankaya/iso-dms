import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from './mail.service';

/** Sends the e-mail of one notification and records how it went. */
@Injectable()
export class NotificationMailer {
  private readonly logger = new Logger(NotificationMailer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends the mail of a notification that is still waiting for it. A failure throws, so the queue can try again;
   * `final` says no more attempts follow, which is when the failure is written down.
   */
  async send(notificationId: string, final: boolean): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, title: true, body: true, link: true, emailStatus: true, user: { select: { email: true, isActive: true } } },
    });
    if (!notification || notification.emailStatus !== 'PENDING') return;

    // Nobody to write to any more, or mail is not set up in this environment
    if (!notification.user.isActive || !this.mail.enabled) {
      await this.prisma.notification.update({ where: { id: notification.id }, data: { emailStatus: 'SKIPPED' } });
      return;
    }

    const webUrl = this.config.get<string>('WEB_URL', 'http://localhost:3000').replace(/\/+$/, '');
    try {
      await this.mail.send({
        to: notification.user.email,
        subject: notification.title,
        text: `${notification.body}\n\n${webUrl}${notification.link}\n`,
      });
    } catch (error) {
      this.logger.warn(`Mail for notification ${notification.id} failed: ${(error as Error).message}`);
      if (final) await this.prisma.notification.update({ where: { id: notification.id }, data: { emailStatus: 'FAILED' } });
      throw error;
    }
    await this.prisma.notification.update({ where: { id: notification.id }, data: { emailStatus: 'SENT', emailedAt: new Date() } });
  }
}
