import { BadRequestException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CompareSideDto, RevisionComparisonDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canViewRevision, visibleDocumentWhere } from '../documents/document-access.policy';
import { extractDocxParagraphs } from '../documents/document-text/docx-text';
import { diffCells, diffParagraphs, summarize } from '../documents/document-text/text-diff';
import { UnreadableDocumentError } from '../documents/document-text/text-limits';
import { extractXlsxCells } from '../documents/document-text/xlsx-text';
import { StorageService } from '../storage/storage.service';

/** Comparison of two revisions of one document (PROJECT.md 6.15). */
@Injectable()
export class RevisionComparisonService {
  private readonly logger = new Logger(RevisionComparisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async compare(
    user: AuthenticatedUser,
    documentId: string,
    fromId: string,
    toId: string,
    ipAddress: string | null,
  ): Promise<RevisionComparisonDto> {
    if (fromId === toId) {
      throw new BadRequestException({ code: 'SAME_REVISION', message: 'A revision cannot be compared with itself' });
    }

    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: {
        id: true,
        code: true,
        fileType: true,
        status: true,
        departmentId: true,
        currentRevisionId: true,
        revisions: {
          where: { id: { in: [fromId, toId] } },
          select: { id: true, revisionNo: true, status: true, storageKey: true },
        },
      },
    });
    if (!document) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    }
    const from = document.revisions.find((revision) => revision.id === fromId);
    const to = document.revisions.find((revision) => revision.id === toId);
    // A revision the user may not open is reported as missing, like everywhere else
    if (!from || !to || !canViewRevision(user, document, from.id) || !canViewRevision(user, document, to.id)) {
      throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
    }

    const [fromFile, toFile] = await Promise.all([this.read(from), this.read(to)]);
    const side = (revision: typeof from): CompareSideDto => ({
      id: revision.id,
      revisionNo: revision.revisionNo,
      status: revision.status,
    });

    let comparison: Pick<RevisionComparisonDto, 'summary' | 'blocks' | 'cells'>;
    try {
      if (document.fileType === 'DOCX') {
        const [before, after] = await Promise.all([extractDocxParagraphs(fromFile), extractDocxParagraphs(toFile)]);
        const blocks = diffParagraphs(before, after);
        comparison = { summary: summarize(blocks), blocks, cells: [] };
      } else {
        const [before, after] = await Promise.all([extractXlsxCells(fromFile), extractXlsxCells(toFile)]);
        const cells = diffCells(before, after);
        comparison = { summary: summarize(cells), blocks: [], cells };
      }
    } catch (error) {
      if (!(error instanceof UnreadableDocumentError)) throw error;
      this.logger.warn(`A revision of document ${document.id} cannot be read for a comparison: ${error.message}`);
      throw new UnprocessableEntityException({ code: 'REVISION_FILE_UNREADABLE', message: 'The revision file cannot be read' });
    }

    await this.auditLogs.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'REVISIONS_COMPARED',
      entityType: 'Document',
      entityId: document.id,
      metadata: {
        code: document.code,
        from: { id: from.id, revisionNo: from.revisionNo },
        to: { id: to.id, revisionNo: to.revisionNo },
      },
      ipAddress,
    });

    return { fileType: document.fileType, from: side(from), to: side(to), ...comparison };
  }

  private async read(revision: { id: string; storageKey: string }): Promise<Buffer> {
    if (!(await this.storage.exists(revision.storageKey))) {
      this.logger.error(`The file of revision ${revision.id} is missing from storage (${revision.storageKey})`);
      throw new NotFoundException({ code: 'REVISION_FILE_MISSING', message: 'The revision file is missing' });
    }
    return this.storage.getBuffer(revision.storageKey);
  }
}
