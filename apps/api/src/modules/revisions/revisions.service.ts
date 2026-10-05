import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { RevisionHistoryItemDto } from '@iso-dms/shared';
import type { Readable } from 'node:stream';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  canEditRevision,
  canPublishRevision,
  canViewRevision,
  visibleDocumentWhere,
} from '../documents/document-access.policy';
import { FILE_TYPE_INFO } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { buildDownloadFileName } from './download-file-name';

export interface RevisionDownload {
  stream: Readable;
  fileName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class RevisionsService {
  private readonly logger = new Logger(RevisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Revision history of a document, newest first. A user only gets the revisions they may open
   * (PROJECT.md 6.4): readers see the one in force, the owning department sees all of them.
   */
  async listForDocument(user: AuthenticatedUser, documentId: string): Promise<RevisionHistoryItemDto[]> {
    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: {
        status: true,
        departmentId: true,
        currentRevisionId: true,
        revisions: {
          orderBy: { revisionNo: 'desc' },
          select: {
            id: true,
            revisionNo: true,
            status: true,
            approvedAt: true,
            publishedAt: true,
            createdAt: true,
            changeSummary: true,
            fileSize: true,
            preparedBy: { select: { id: true, fullName: true } },
            approvedBy: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!document) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    }

    return document.revisions
      .filter((revision) => canViewRevision(user, document, revision.id))
      .map((revision) => ({
        id: revision.id,
        revisionNo: revision.revisionNo,
        status: revision.status,
        // A withdrawn document keeps its last revision on record, but nothing is in force any more
        isCurrent: document.status === 'PUBLISHED' && revision.id === document.currentRevisionId,
        preparedBy: revision.preparedBy,
        approvedBy: revision.approvedBy,
        approvedAt: revision.approvedAt?.toISOString() ?? null,
        publishedAt: revision.publishedAt?.toISOString() ?? null,
        createdAt: revision.createdAt.toISOString(),
        changeSummary: revision.changeSummary,
        fileSize: revision.fileSize,
        canEdit: canEditRevision(user, document, revision),
        canPublish: canPublishRevision(user, document, revision),
      }));
  }

  /** The file of one revision the user may open. */
  async openDownload(user: AuthenticatedUser, revisionId: string, ipAddress: string | null): Promise<RevisionDownload> {
    const revision = await this.prisma.revision.findFirst({
      where: { id: revisionId, organizationId: user.organizationId },
      include: {
        document: {
          select: { id: true, code: true, title: true, fileType: true, status: true, departmentId: true, currentRevisionId: true },
        },
      },
    });
    // Revisions the user may not see are reported as missing, so their existence does not leak
    if (!revision || !canViewRevision(user, revision.document, revision.id)) {
      throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
    }

    const stream = await this.storage.tryGetStream(revision.storageKey);
    if (!stream) {
      this.logger.error(`The file of revision ${revision.id} is missing from storage (${revision.storageKey})`);
      throw new NotFoundException({ code: 'REVISION_FILE_MISSING', message: 'The revision file is missing' });
    }

    const { document } = revision;
    const fileType = FILE_TYPE_INFO[document.fileType];
    await this.auditLogs.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'REVISION_DOWNLOADED',
      entityType: 'Revision',
      entityId: revision.id,
      metadata: { documentId: document.id, code: document.code, revisionNo: revision.revisionNo, fileSize: revision.fileSize },
      ipAddress,
    });

    return {
      stream,
      mimeType: fileType.mimeType,
      size: revision.fileSize,
      fileName: buildDownloadFileName({
        code: document.code,
        title: document.title,
        revisionNo: revision.revisionNo,
        extension: fileType.extension,
      }),
    };
  }

  /** The file of the revision in force (PROJECT.md 8: GET /documents/:id/download). */
  async openCurrentDownload(user: AuthenticatedUser, documentId: string, ipAddress: string | null): Promise<RevisionDownload> {
    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: { currentRevisionId: true },
    });
    if (!document) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    }
    if (!document.currentRevisionId) {
      throw new NotFoundException({ code: 'NO_PUBLISHED_REVISION', message: 'The document has no revision in force' });
    }
    return this.openDownload(user, document.currentRevisionId, ipAddress);
  }
}
