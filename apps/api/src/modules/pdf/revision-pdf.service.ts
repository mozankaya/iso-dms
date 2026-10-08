import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PdfConversionError } from '../editor/pdf-conversion.error';
import { RevisionPdfConverter } from '../editor/revision-pdf-converter';
import { buildPdfKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';

export type PdfGenerationOutcome = 'GENERATED' | 'ALREADY_READY' | 'NOT_PUBLISHED';

/** The reason stored on the revision and in the audit trail when an attempt ends in failure. */
export function failureReason(error: unknown): string {
  return error instanceof PdfConversionError ? error.reason : 'CONVERSION_FAILED';
}

/**
 * The PDF copy of a published revision (PROJECT.md 6.12). The copy is made once, from the file in force when
 * the revision was published, and is a record like the file it comes from: it is never replaced or deleted.
 * Publishing does not depend on it; a revision whose conversion fails stays in force without a PDF.
 */
@Injectable()
export class RevisionPdfService {
  private readonly logger = new Logger(RevisionPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly converter: RevisionPdfConverter,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Converts and stores the PDF of a revision. Throws when the conversion fails, so the queue can retry. */
  async generate(revisionId: string): Promise<PdfGenerationOutcome> {
    const revision = await this.prisma.revision.findUnique({
      where: { id: revisionId },
      select: { id: true, status: true, publishedAt: true, pdfStatus: true },
    });
    // Only revisions that were put in force get a copy: drafts, reviews and cancelled ones do not
    if (!revision || !revision.publishedAt) return 'NOT_PUBLISHED';
    if (revision.pdfStatus === 'READY') return 'ALREADY_READY';

    const pdf = await this.converter.convert(revisionId);
    return this.store(revisionId, pdf);
  }

  /** Called when the last attempt failed: the revision shows the failure until somebody retries. */
  async markFailed(revisionId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revision = await tx.revision.findUnique({
        where: { id: revisionId },
        select: { id: true, organizationId: true, revisionNo: true, pdfStatus: true, document: { select: { id: true, code: true } } },
      });
      if (!revision || revision.pdfStatus === 'READY') return;

      await tx.revision.update({ where: { id: revisionId }, data: { pdfStatus: 'FAILED', pdfFailureReason: reason } });
      await this.auditLogs.log(
        {
          organizationId: revision.organizationId,
          action: 'REVISION_PDF_FAILED',
          entityType: 'Revision',
          entityId: revisionId,
          metadata: { documentId: revision.document.id, code: revision.document.code, revisionNo: revision.revisionNo, reason },
        },
        tx,
      );
    });
  }

  private async store(revisionId: string, pdf: Buffer): Promise<PdfGenerationOutcome> {
    const revision = await this.prisma.revision.findUniqueOrThrow({
      where: { id: revisionId },
      select: { organizationId: true, documentId: true, revisionNo: true, document: { select: { code: true } } },
    });
    const storageKey = buildPdfKey({ organizationId: revision.organizationId, documentId: revision.documentId, revisionNo: revision.revisionNo });
    // The file goes first; if the record cannot be written the orphan is removed again
    await this.storage.put(storageKey, pdf, 'application/pdf');

    try {
      const outcome = await this.prisma.$transaction(async (tx): Promise<PdfGenerationOutcome> => {
        await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revisionId} FOR UPDATE`;
        const current = await tx.revision.findUniqueOrThrow({ where: { id: revisionId }, select: { pdfStatus: true } });
        // A concurrent attempt was faster: its copy is the record, ours is dropped
        if (current.pdfStatus === 'READY') return 'ALREADY_READY';

        const checksum = createHash('sha256').update(pdf).digest('hex');
        await tx.revision.update({
          where: { id: revisionId },
          data: { pdfStorageKey: storageKey, pdfStatus: 'READY', pdfChecksum: checksum, pdfFileSize: pdf.length, pdfGeneratedAt: new Date(), pdfFailureReason: null },
        });
        await this.auditLogs.log(
          {
            organizationId: revision.organizationId,
            action: 'REVISION_PDF_GENERATED',
            entityType: 'Revision',
            entityId: revisionId,
            metadata: { documentId: revision.documentId, code: revision.document.code, revisionNo: revision.revisionNo, fileSize: pdf.length, checksum },
          },
          tx,
        );
        return 'GENERATED';
      });
      if (outcome !== 'GENERATED') await this.discard(storageKey);
      return outcome;
    } catch (error) {
      await this.discard(storageKey);
      throw error;
    }
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`PDF ${key} could not be removed: ${(error as Error).message}`);
    }
  }
}
