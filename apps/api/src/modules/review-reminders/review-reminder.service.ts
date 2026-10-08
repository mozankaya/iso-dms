import { Injectable, Logger } from '@nestjs/common';
import { REVIEW_DUE_WINDOW_DAYS } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { reviewDue } from '../notifications/notification-texts';
import { NotificationsService, type NotificationDraft } from '../notifications/notifications.service';
import { ESCALATION_AFTER_DAYS, reminderMoment } from './review-reminder-stage';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

const dateFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' });

export interface ReminderSummary {
  /** Documents whose review is due within the window or overdue */
  documents: number;
  /** Messages written (the ones sent before are not counted) */
  notifications: number;
}

/**
 * The daily reminders about reviews that are near or overdue (PROJECT.md 6.5, 6.13). It is safe to run as often as
 * wanted: every reminder carries a key made of the document, its due date and the stage, and a message with a key
 * the user has already received is dropped. A document that is reviewed gets a new due date, so its reminders start
 * again for the next period.
 */
@Injectable()
export class ReviewReminderService {
  private readonly logger = new Logger(ReviewReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(now = new Date()): Promise<ReminderSummary> {
    const until = new Date(now.getTime() + REVIEW_DUE_WINDOW_DAYS * DAY_MS);
    const summary: ReminderSummary = { documents: 0, notifications: 0 };
    let cursor: string | undefined;

    for (;;) {
      const documents = await this.prisma.document.findMany({
        where: { status: 'PUBLISHED', nextReviewAt: { not: null, lte: until } },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          organizationId: true,
          departmentId: true,
          code: true,
          title: true,
          nextReviewAt: true,
          owner: { select: { id: true, fullName: true, isActive: true } },
        },
      });
      if (documents.length === 0) break;
      cursor = documents[documents.length - 1].id;

      const ids: string[] = [];
      for (const document of documents) {
        summary.documents += 1;
        const nextReviewAt = document.nextReviewAt!;
        const moment = reminderMoment(nextReviewAt, now);
        if (!moment) continue;

        // The owner first; further up when it has been overdue for long, or when the owner cannot be told any more
        const escalate = moment.overdueDays > ESCALATION_AFTER_DAYS || !document.owner.isActive;
        const recipientIds = new Set<string>();
        if (document.owner.isActive) recipientIds.add(document.owner.id);
        if (escalate) {
          const responsible = await this.prisma.user.findMany({
            where: {
              organizationId: document.organizationId,
              isActive: true,
              OR: [{ role: 'QUALITY_MANAGER' }, { role: 'APPROVER', departmentId: document.departmentId }],
            },
            select: { id: true },
          });
          for (const user of responsible) recipientIds.add(user.id);
        }

        const content = reviewDue({
          documentId: document.id,
          code: document.code,
          title: document.title,
          stage: moment.stage,
          date: dateFormat.format(nextReviewAt),
          overdueDays: moment.overdueDays,
          ownerName: document.owner.fullName,
        });
        const dedupeKey = `review:${document.id}:${nextReviewAt.toISOString().slice(0, 10)}:${moment.key}`;
        const drafts: NotificationDraft[] = [...recipientIds].map((userId) => ({ ...content, organizationId: document.organizationId, userId, dedupeKey }));
        ids.push(...(await this.notifications.create(this.prisma, drafts)));
      }

      summary.notifications += ids.length;
      await this.notifications.dispatch(ids);
    }

    this.logger.log(`Review reminders: ${summary.notifications} message(s) for ${summary.documents} document(s) due`);
    return summary;
  }
}
