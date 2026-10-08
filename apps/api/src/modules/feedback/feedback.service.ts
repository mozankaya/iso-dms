import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { FEEDBACK_RATE_LIMIT_PER_MINUTE, type FeedbackDto, type PaginatedDto, type SentFeedbackDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { FeedbackWhereInput } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { visibleDocumentWhere } from '../documents/document-access.policy';
import { windowStart } from '../lists/publication-where';
import type { ListFeedbackDto, ResolveFeedbackDto, SendFeedbackDto } from './dto/feedback.dto';

const MINUTE_MS = 60_000;

/** Prisma passes "contains" to ILIKE unescaped: neutralise the LIKE wildcards. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const FEEDBACK_INCLUDE = {
  user: { select: { id: true, fullName: true, department: { select: { id: true, name: true, code: true } } } },
  document: { select: { id: true, code: true, title: true } },
  revision: { select: { revisionNo: true } },
  resolvedBy: { select: { id: true, fullName: true } },
} as const;

/**
 * Feedback on documents in force (PROJECT.md 6.8): anybody who sees a document may say something about it, the
 * quality managers and administrators read it, close it with a note of how it was handled, and reopen it. What was
 * sent is a record: it is never edited or deleted (the database refuses both).
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async send(user: AuthenticatedUser, documentId: string, dto: SendFeedbackDto, ipAddress: string | null): Promise<SentFeedbackDto> {
    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: { id: true, code: true, status: true, currentRevisionId: true, currentRevision: { select: { revisionNo: true } } },
    });
    if (!document) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    // Only what is in force is worth a comment: a draft is still being written, a withdrawn document is gone
    if (document.status !== 'PUBLISHED') {
      throw new ConflictException({ code: 'FEEDBACK_NOT_ACCEPTED', message: 'Feedback can only be sent about a document in force' });
    }

    const feedback = await this.prisma.$transaction(async (tx) => {
      // One sender at a time, so the limit below cannot be beaten by sending in parallel
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback:${user.id}`}, 0))`;
      const recent = await tx.feedback.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - MINUTE_MS) } } });
      if (recent >= FEEDBACK_RATE_LIMIT_PER_MINUTE) {
        throw new HttpException({ code: 'FEEDBACK_RATE_LIMITED', message: 'Too many feedbacks in a minute' }, HttpStatus.TOO_MANY_REQUESTS);
      }

      const created = await tx.feedback.create({
        data: {
          organizationId: user.organizationId,
          documentId: document.id,
          revisionId: document.currentRevisionId,
          userId: user.id,
          message: dto.message,
        },
        select: { id: true, createdAt: true },
      });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'FEEDBACK_SENT',
          entityType: 'Document',
          entityId: document.id,
          metadata: { feedbackId: created.id, code: document.code, revisionNo: document.currentRevision?.revisionNo ?? null },
          ipAddress,
        },
        tx,
      );
      return created;
    });

    return { id: feedback.id, createdAt: feedback.createdAt.toISOString() };
  }

  async list(user: AuthenticatedUser, query: ListFeedbackDto): Promise<PaginatedDto<FeedbackDto>> {
    const where = this.openWhere(user, query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.findMany({
        where,
        // The id breaks ties, so pages stay stable when several feedbacks share a moment
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: FEEDBACK_INCLUDE,
      }),
    ]);
    return { items: rows.map(toFeedbackDto), total, page: query.page, pageSize: query.pageSize };
  }

  async resolve(user: AuthenticatedUser, id: string, dto: ResolveFeedbackDto, ipAddress: string | null): Promise<FeedbackDto> {
    return this.change(user, id, ipAddress, 'FEEDBACK_RESOLVED', async (tx) => {
      const current = await tx.feedback.findUniqueOrThrow({ where: { id }, select: { isResolved: true } });
      if (current.isResolved) throw new ConflictException({ code: 'FEEDBACK_ALREADY_RESOLVED', message: 'The feedback is closed already' });
      const note = dto.note?.trim() || null;
      await tx.feedback.update({ where: { id }, data: { isResolved: true, resolvedAt: new Date(), resolvedById: user.id, resolutionNote: note } });
      return { note };
    });
  }

  async reopen(user: AuthenticatedUser, id: string, ipAddress: string | null): Promise<FeedbackDto> {
    return this.change(user, id, ipAddress, 'FEEDBACK_REOPENED', async (tx) => {
      const current = await tx.feedback.findUniqueOrThrow({ where: { id }, select: { isResolved: true } });
      if (!current.isResolved) throw new ConflictException({ code: 'FEEDBACK_NOT_RESOLVED', message: 'The feedback is open' });
      // Who closed it and how stays in the audit trail; the row itself is open again and shows nothing of it
      await tx.feedback.update({ where: { id }, data: { isResolved: false, resolvedAt: null, resolvedById: null, resolutionNote: null } });
      return {};
    });
  }

  /** Closing and reopening: the row is locked, the change and its audit entry are one transaction. */
  private async change(
    user: AuthenticatedUser,
    id: string,
    ipAddress: string | null,
    action: 'FEEDBACK_RESOLVED' | 'FEEDBACK_REOPENED',
    apply: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<Record<string, unknown>>,
  ): Promise<FeedbackDto> {
    const found = await this.prisma.feedback.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, documentId: true, document: { select: { code: true } } },
    });
    if (!found) throw new NotFoundException({ code: 'FEEDBACK_NOT_FOUND', message: 'Feedback not found' });

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Feedback" WHERE id = ${id} FOR UPDATE`;
      const details = await apply(tx);
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action,
          entityType: 'Document',
          entityId: found.documentId,
          metadata: { feedbackId: id, code: found.document.code, ...details },
          ipAddress,
        },
        tx,
      );
    });

    const row = await this.prisma.feedback.findUniqueOrThrow({ where: { id }, include: FEEDBACK_INCLUDE });
    return toFeedbackDto(row);
  }

  private openWhere(user: AuthenticatedUser, query: ListFeedbackDto): FeedbackWhereInput {
    const and: FeedbackWhereInput[] = [{ organizationId: user.organizationId }];
    if (query.status !== 'all') and.push({ isResolved: query.status === 'resolved' });
    if (query.departmentId) and.push({ document: { departmentId: query.departmentId } });
    if (query.period !== 'all') and.push({ createdAt: { gte: windowStart(Number(query.period)) } });
    if (query.search) {
      const term = escapeLike(query.search);
      and.push({
        OR: [
          { message: { contains: term, mode: 'insensitive' } },
          { document: { code: { contains: term, mode: 'insensitive' } } },
          { document: { title: { contains: term, mode: 'insensitive' } } },
          { user: { fullName: { contains: term, mode: 'insensitive' } } },
        ],
      });
    }
    return { AND: and };
  }
}

function toFeedbackDto(row: {
  id: string;
  message: string;
  createdAt: Date;
  isResolved: boolean;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  user: { id: string; fullName: string; department: { id: string; name: string; code: string } | null };
  document: { id: string; code: string; title: string };
  revision: { revisionNo: number } | null;
  resolvedBy: { id: string; fullName: string } | null;
}): FeedbackDto {
  return {
    id: row.id,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    user: row.user,
    document: row.document,
    revisionNo: row.revision?.revisionNo ?? null,
    isResolved: row.isResolved,
    resolvedAt: row.isResolved ? (row.resolvedAt?.toISOString() ?? null) : null,
    resolvedBy: row.isResolved ? row.resolvedBy : null,
    resolutionNote: row.isResolved ? row.resolutionNote : null,
  };
}
