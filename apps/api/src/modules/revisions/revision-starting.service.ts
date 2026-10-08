import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DocumentDetailDto } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canStartRevision, canWriteInDepartment, visibleDocumentWhere } from '../documents/document-access.policy';
import { DocumentsService } from '../documents/documents.service';
import { buildRevisionKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import type { StartRevisionDto } from './dto/start-revision.dto';

const alreadyOpen = () =>
  new ConflictException({ code: 'REVISION_ALREADY_OPEN', message: 'The document already has an open revision' });
const withdrawalPending = () =>
  new ConflictException({ code: 'WITHDRAWAL_PENDING', message: 'A request to withdraw the document is waiting for a decision' });
const notRevisable = () =>
  new ConflictException({ code: 'DOCUMENT_NOT_REVISABLE', message: 'Only a published document can be revised' });

/**
 * Starts a new revision of a document in force (PROJECT.md 6.2 rule 6): the file of the revision in force is
 * copied, so the new draft begins with exactly what the readers see. The document stays published and the
 * readers keep the revision in force until the new one is published.
 */
@Injectable()
export class RevisionStartingService {
  private readonly logger = new Logger(RevisionStartingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
    private readonly documents: DocumentsService,
  ) {}

  async start(user: AuthenticatedUser, documentId: string, dto: StartRevisionDto, ipAddress: string | null): Promise<DocumentDetailDto> {
    const document = await this.prisma.document.findFirst({
      where: visibleDocumentWhere(user, documentId),
      select: {
        id: true,
        code: true,
        fileType: true,
        status: true,
        departmentId: true,
        currentRevisionId: true,
        revisions: { select: { revisionNo: true, status: true } },
      },
    });
    if (!document) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });

    // Readers never get here (the controller says so); this is the department rule of editors and approvers
    if (!canWriteInDepartment(user, document.departmentId)) {
      throw new ForbiddenException({ code: 'REVISION_START_NOT_ALLOWED', message: 'Revisions can only be started in your own department' });
    }

    const changeSummary = dto.changeSummary?.trim();
    if (!changeSummary) {
      throw new BadRequestException({ code: 'CHANGE_SUMMARY_REQUIRED', message: 'A change summary is required for a new revision' });
    }

    const pendingWithdrawal = await this.prisma.documentRequest.count({
      where: { organizationId: user.organizationId, documentId, type: 'WITHDRAWAL', status: 'PENDING' },
    });
    this.assertRevisable(user, document, document.revisions, pendingWithdrawal > 0);
    const source = await this.prisma.revision.findFirst({
      where: { id: document.currentRevisionId!, organizationId: user.organizationId },
      select: { id: true, revisionNo: true, storageKey: true, fileSize: true, checksum: true },
    });
    if (!source) throw notRevisable();

    // Numbers are never reused: a revision that was dropped later keeps its number
    const revisionNo = Math.max(...document.revisions.map((revision) => revision.revisionNo)) + 1;
    const storageKey = buildRevisionKey({ organizationId: user.organizationId, documentId, revisionNo, fileType: document.fileType });

    // The copy is made first, like every new file: a row pointing to a missing file would be worse than an
    // orphaned object, which is removed below if the transaction does not go through.
    try {
      await this.storage.copy(source.storageKey, storageKey);
    } catch (error) {
      this.logger.error(`Copying ${source.storageKey} failed: ${(error as Error).message}`);
      throw new NotFoundException({ code: 'REVISION_FILE_MISSING', message: 'The file of the revision in force is missing from storage' });
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
        const locked = await tx.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { status: true, departmentId: true, currentRevisionId: true, revisions: { select: { revisionNo: true, status: true } } },
        });
        // Somebody may have started a revision, or published or withdrawn, while this request was copying
        const waiting = await tx.documentRequest.count({ where: { documentId, type: 'WITHDRAWAL', status: 'PENDING' } });
        this.assertRevisable(user, locked, locked.revisions, waiting > 0);
        if (locked.currentRevisionId !== source.id || Math.max(...locked.revisions.map((revision) => revision.revisionNo)) + 1 !== revisionNo) {
          throw alreadyOpen();
        }

        const revision = await tx.revision.create({
          data: {
            organizationId: user.organizationId,
            documentId,
            revisionNo,
            status: 'DRAFT',
            storageKey,
            fileSize: source.fileSize,
            checksum: source.checksum,
            editorKey: randomUUID(),
            changeSummary,
            preparedById: user.id,
          },
        });
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'REVISION_STARTED',
            entityType: 'Revision',
            entityId: revision.id,
            metadata: { documentId, code: document.code, revisionNo, sourceRevisionNo: source.revisionNo, changeSummary },
            ipAddress,
          },
          tx,
        );
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch((cleanupError: Error) => {
        this.logger.error(`Orphaned object ${storageKey} could not be removed: ${cleanupError.message}`);
      });
      throw error;
    }

    return this.documents.findOne(user, documentId);
  }

  /** The rules of the policy, reported as the errors the caller can act on. */
  private assertRevisable(
    user: AuthenticatedUser,
    document: { status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'WITHDRAWN'; departmentId: string; currentRevisionId: string | null },
    revisions: { status: string }[],
    hasPendingWithdrawal: boolean,
  ): void {
    // A document that was never published (or no longer is) has no revision to start from, whatever is open
    if (!canStartRevision(user, document, false, false)) throw notRevisable();
    if (revisions.some((revision) => revision.status === 'DRAFT' || revision.status === 'IN_REVIEW')) throw alreadyOpen();
    // The document may be about to leave: a draft of it would be wasted work
    if (hasPendingWithdrawal) throw withdrawalPending();
  }
}
