import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import type { NotificationDto, PaginatedDto } from '@iso-dms/shared';
import type { Queue } from 'bullmq';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListNotificationsDto } from './dto/list-notifications.dto';
import { MailService } from './mail.service';
import { NotificationMailer } from './notification-mailer.service';
import type { NotificationContent } from './notification-texts';
import { NOTIFICATION_JOB_NAME, NOTIFICATION_JOB_OPTIONS, NOTIFICATION_QUEUE } from './notifications.constants';

export interface NotificationDraft extends NotificationContent {
  organizationId: string;
  userId: string;
  /** A second draft with the same key for the same user is dropped */
  dedupeKey?: string;
}

const SELECT = { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true } satisfies Prisma.NotificationSelect;

function toDto(row: Prisma.NotificationGetPayload<{ select: typeof SELECT }>): NotificationDto {
  return { id: row.id, type: row.type, title: row.title, body: row.body, link: row.link, isRead: row.readAt !== null, createdAt: row.createdAt.toISOString() };
}

/** Mails that were created but never handed to the queue are looked for at this interval. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_AFTER_MS = 2 * 60 * 1000;

/**
 * Messages to users (PROJECT.md 6.13). A message is written together with the thing it is about (in the same
 * transaction), so it cannot be lost; the e-mail follows after the commit and is best effort: the queue retries it,
 * and a sweep adds the ones whose job got lost. Without the queue (JOBS_ENABLED=false) the mail is sent at once.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly mailer: NotificationMailer,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly queue?: Queue,
  ) {}

  /** Writes the messages; returns the ids of the new ones, to hand to `dispatch` after the transaction commits. */
  async create(client: Prisma.TransactionClient | PrismaService, drafts: NotificationDraft[]): Promise<string[]> {
    if (drafts.length === 0) return [];
    const rows = await client.notification.createManyAndReturn({
      data: drafts.map((draft) => ({
        organizationId: draft.organizationId,
        userId: draft.userId,
        type: draft.type,
        title: draft.title,
        body: draft.body,
        link: draft.link,
        dedupeKey: draft.dedupeKey ?? null,
        emailStatus: this.mail.enabled ? ('PENDING' as const) : ('SKIPPED' as const),
      })),
      skipDuplicates: true,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Sends the mails of the given messages. Never throws: the caller has committed something more important. */
  async dispatch(ids: string[]): Promise<void> {
    if (!this.mail.enabled) return;
    for (const id of ids) {
      try {
        if (this.queue) {
          await this.queue.add(NOTIFICATION_JOB_NAME, { notificationId: id }, { ...NOTIFICATION_JOB_OPTIONS, jobId: `mail-${id}` });
        } else {
          await this.mailer.send(id, true);
        }
      } catch (error) {
        this.logger.error(`The mail of notification ${id} could not be sent or queued: ${(error as Error).message}`);
      }
    }
  }

  async list(user: AuthenticatedUser, query: ListNotificationsDto): Promise<PaginatedDto<NotificationDto>> {
    const where: Prisma.NotificationWhereInput = { userId: user.id, organizationId: user.organizationId, ...(query.status === 'unread' && { readAt: null }) };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: SELECT,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
  }

  async unreadCount(user: AuthenticatedUser): Promise<number> {
    return this.prisma.notification.count({ where: { userId: user.id, organizationId: user.organizationId, readAt: null } });
  }

  /** Marking a message as read again does nothing; somebody else's message is as good as missing. */
  async markRead(user: AuthenticatedUser, id: string): Promise<NotificationDto> {
    const own = { id, userId: user.id, organizationId: user.organizationId };
    const found = await this.prisma.notification.findFirst({ where: own, select: { id: true } });
    if (!found) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' });
    await this.prisma.notification.updateMany({ where: { ...own, readAt: null }, data: { readAt: new Date() } });
    return toDto(await this.prisma.notification.findUniqueOrThrow({ where: { id }, select: SELECT }));
  }

  async markAllRead(user: AuthenticatedUser): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: user.id, organizationId: user.organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }

  /** Mails whose job never made it to the queue (Redis was down for a moment) are queued again. */
  async sweep(): Promise<number> {
    if (!this.queue || !this.mail.enabled) return 0;
    const lost = await this.prisma.notification.findMany({
      where: { emailStatus: 'PENDING', createdAt: { lt: new Date(Date.now() - SWEEP_AFTER_MS) } },
      select: { id: true },
      take: 500,
    });
    await this.dispatch(lost.map((row) => row.id));
    return lost.length;
  }

  onApplicationBootstrap(): void {
    if (!this.queue) return;
    const run = () => this.sweep().catch((error: Error) => this.logger.error(`Notification sweep failed: ${error.message}`));
    void run();
    this.timer = setInterval(run, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
