import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends e-mail. Three modes, chosen by the environment: SMTP when SMTP_HOST is set; `MAIL_MODE=memory`, which
 * only keeps the messages in `outbox` (tests); otherwise mail is off, and notifications stay in the application.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;
  /** Messages "sent" in memory mode, newest last */
  readonly outbox: OutgoingMail[] = [];
  readonly mode: 'smtp' | 'memory' | 'off';

  constructor(config: ConfigService) {
    this.from = config.get<string>('MAIL_FROM', 'Kalite Doküman Yönetim Sistemi <noreply@localhost>');
    const host = config.get<string>('SMTP_HOST');
    if (config.get<string>('MAIL_MODE') === 'memory') {
      this.mode = 'memory';
      this.transport = null;
    } else if (host) {
      this.mode = 'smtp';
      const user = config.get<string>('SMTP_USER');
      this.transport = createTransport({
        host,
        port: Number(config.get('SMTP_PORT', 587)),
        secure: config.get<string>('SMTP_SECURE') === 'true',
        ...(user && { auth: { user, pass: config.get<string>('SMTP_PASSWORD', '') } }),
        // A mail server that does not answer must not hold a worker for long
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    } else {
      this.mode = 'off';
      this.transport = null;
      this.logger.log('SMTP_HOST is not set: notifications stay in the application, no e-mail is sent');
    }
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** Throws when the mail could not be handed over. */
  async send(mail: OutgoingMail): Promise<void> {
    if (this.mode === 'memory') {
      this.outbox.push(mail);
      if (this.outbox.length > 200) this.outbox.shift();
      return;
    }
    if (!this.transport) throw new Error('Mail is not set up');
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}
