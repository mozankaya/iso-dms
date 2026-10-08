import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { buildRevisionKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { fillDocumentFields, InvalidDocxError, type DocumentFieldValues } from './docx-fields';

export type FieldsReason = 'CREATED' | 'REVISION_STARTED' | 'SUBMITTED';
export type FieldsOutcome = 'UPDATED' | 'UNCHANGED' | 'SKIPPED';

/**
 * Writes the data of a document into the fields of the Word file of a draft revision (PROJECT.md 6.14): code, title,
 * department, revision number and who prepared it. It runs when a document is made, when a revision is started and
 * when a draft is sent to review, so what the approvers read is what is published: the file does not change after
 * the review starts. Date of publication and approver are not written (they only exist at publication).
 */
@Injectable()
export class DocumentFieldsService {
  private readonly logger = new Logger(DocumentFieldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** For the moments when the document is already made: a failure is logged, the document stays as it was. */
  async applyBestEffort(revisionId: string, reason: FieldsReason): Promise<FieldsOutcome> {
    try {
      return await this.apply(revisionId, reason);
    } catch (error) {
      this.logger.error(`The fields of revision ${revisionId} could not be filled in (${reason}): ${(error as Error).message}`);
      return 'SKIPPED';
    }
  }

  /**
   * Fills in the fields of a draft. Anything that is not a Word draft with fields, or is being edited at this
   * moment, is left alone (SKIPPED). Storage and database failures are thrown.
   */
  async apply(revisionId: string, reason: FieldsReason, audit: { userId: string; ipAddress: string | null } | null = null): Promise<FieldsOutcome> {
    const revision = await this.prisma.revision.findUnique({
      where: { id: revisionId },
      select: {
        id: true,
        organizationId: true,
        documentId: true,
        revisionNo: true,
        status: true,
        storageKey: true,
        checksum: true,
        editSessionStartedAt: true,
        preparedBy: { select: { fullName: true } },
        document: { select: { code: true, title: true, fileType: true, department: { select: { name: true } } } },
      },
    });
    if (!revision || revision.document.fileType !== 'DOCX' || revision.status !== 'DRAFT' || revision.editSessionStartedAt) return 'SKIPPED';

    const values: DocumentFieldValues = {
      DOC_CODE: revision.document.code,
      DOC_TITLE: revision.document.title,
      DOC_DEPARTMENT: revision.document.department.name,
      DOC_REVISION_NO: String(revision.revisionNo),
      DOC_PREPARED_BY: revision.preparedBy.fullName,
    };

    const original = await this.storage.getBuffer(revision.storageKey);
    let filled;
    try {
      filled = await fillDocumentFields(original, values);
    } catch (error) {
      if (error instanceof InvalidDocxError) {
        this.logger.warn(`Revision ${revisionId}: the file is not a readable .docx, its fields are left alone`);
        return 'SKIPPED';
      }
      throw error;
    }
    if (filled.buffer === original) return 'UNCHANGED';

    // The new content goes to a new object, like every save: nothing points to a half written file
    const storageKey = buildRevisionKey({ organizationId: revision.organizationId, documentId: revision.documentId, revisionNo: revision.revisionNo, fileType: 'DOCX' });
    await this.storage.put(storageKey, filled.buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    let replaced = false;
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revisionId} FOR UPDATE`;
        const current = await tx.revision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true, storageKey: true, editSessionStartedAt: true } });
        // Somebody saved the file, or opened it, or the draft moved on, while this was being prepared
        if (current.status !== 'DRAFT' || current.storageKey !== revision.storageKey || current.editSessionStartedAt) return false;

        await tx.revision.update({
          where: { id: revisionId },
          data: {
            storageKey,
            fileSize: filled.buffer.length,
            checksum: createHash('sha256').update(filled.buffer).digest('hex'),
            // The content is new: the document server must not serve what it has cached under the old key
            editorKey: randomUUID(),
          },
        });
        // Making the file or starting the revision is recorded by their own entries; correcting a draft that goes to
        // review is what an auditor wants to see
        if (reason === 'SUBMITTED') {
          await this.auditLogs.log(
            {
              organizationId: revision.organizationId,
              userId: audit?.userId ?? null,
              action: 'REVISION_FIELDS_UPDATED',
              entityType: 'Revision',
              entityId: revisionId,
              metadata: { documentId: revision.documentId, code: revision.document.code, revisionNo: revision.revisionNo, reason, changes: filled.changes as unknown as Prisma.InputJsonObject },
              ipAddress: audit?.ipAddress ?? null,
            },
            tx,
          );
        }
        return true;
      });
    } catch (error) {
      await this.discard(storageKey);
      throw error;
    }

    if (!replaced) {
      await this.discard(storageKey);
      return 'SKIPPED';
    }
    // The previous content of a draft is not a record (PROJECT.md 7.4)
    await this.discard(revision.storageKey);
    return 'UPDATED';
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Object ${key} could not be removed: ${(error as Error).message}`);
    }
  }
}
