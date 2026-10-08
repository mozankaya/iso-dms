import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, UnprocessableEntityException } from '@nestjs/common';
import { SEARCH_MAX_TEXT_CHARS } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { extractDocxParagraphs } from '../documents/document-text/docx-text';
import { UnreadableDocumentError } from '../documents/document-text/text-limits';
import { extractXlsxCells } from '../documents/document-text/xlsx-text';
import { JOBS_ENABLED } from '../jobs/jobs.module';
import { StorageService } from '../storage/storage.service';
import { toIndexText } from './search-text';

/** The index is looked at again now and then, in case a revision was published while indexing failed. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 50;

export type IndexOutcome = 'INDEXED' | 'SKIPPED' | 'NOT_CURRENT';

/**
 * Keeps the text of the revision in force of every document searchable (PROJECT.md 6.16). The index is derived
 * data: it can always be rebuilt from the files, so it is not a record and only the revision in force keeps a row.
 * The database is the source of truth, there is no queue: publishing indexes the revision after the commit (best
 * effort) and a sweep at start-up and every few minutes indexes whatever is still missing.
 */
@Injectable()
export class SearchIndexService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Never throws: the caller has just committed something more important than the index. */
  async indexSafely(revisionId: string): Promise<void> {
    try {
      await this.index(revisionId);
    } catch (error) {
      this.logger.error(`Revision ${revisionId} could not be indexed: ${(error as Error).message}`);
    }
  }

  /**
   * Reads the file of the revision and (re)writes its row; the rows of the document's other revisions go.
   * A revision that is not the one in force is left alone (a late job must not remove the row of a newer one).
   * A file that is missing, unreadable or too large gets a SKIPPED row, so it is not tried again for ever;
   * trouble with the storage itself throws and leaves no row, so the sweep tries again.
   */
  async index(revisionId: string): Promise<IndexOutcome> {
    const revision = await this.prisma.revision.findUnique({
      where: { id: revisionId },
      select: {
        id: true,
        organizationId: true,
        documentId: true,
        storageKey: true,
        document: { select: { code: true, title: true, fileType: true, status: true, currentRevisionId: true } },
      },
    });
    if (!revision || revision.document.status !== 'PUBLISHED' || revision.document.currentRevisionId !== revision.id) {
      return 'NOT_CURRENT';
    }

    const content = await this.readText(revision.storageKey, revision.document.fileType);
    const status = content === null ? 'SKIPPED' : 'INDEXED';
    const text = content ?? '';
    // Code and title are in the vector too (and weigh more), so one query finds a document by any of them. Their
    // positions are stripped: otherwise the last word of the title would sit right next to the first of the content
    // and a quoted phrase could be found across the two.
    const nameText = toIndexText(revision.document.code, revision.document.title);
    const contentText = toIndexText(text);

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO "RevisionText" ("revisionId", "organizationId", "documentId", "status", "content", "searchVector", "indexedAt")
        VALUES (${revision.id}, ${revision.organizationId}, ${revision.documentId}, ${status}::"SearchIndexStatus", ${text},
          setweight(strip(to_tsvector('simple', ${nameText})), 'A') || setweight(to_tsvector('simple', ${contentText}), 'D'), now())
        ON CONFLICT ("revisionId") DO UPDATE SET
          "status" = EXCLUDED."status", "content" = EXCLUDED."content",
          "searchVector" = EXCLUDED."searchVector", "indexedAt" = EXCLUDED."indexedAt"`,
      this.prisma.revisionText.deleteMany({ where: { documentId: revision.documentId, revisionId: { not: revision.id } } }),
    ]);
    return status;
  }

  /** The text as people read it, or null when the file cannot be searched. */
  private async readText(storageKey: string, fileType: 'DOCX' | 'XLSX'): Promise<string | null> {
    if (!(await this.storage.exists(storageKey))) return null;
    const buffer = await this.storage.getBuffer(storageKey);
    try {
      const text =
        fileType === 'DOCX'
          ? (await extractDocxParagraphs(buffer)).join('\n')
          : (await extractXlsxCells(buffer)).map((cell) => cell.value).join('\n');
      return text.length > SEARCH_MAX_TEXT_CHARS ? null : text.normalize('NFC');
    } catch (error) {
      if (error instanceof UnreadableDocumentError || error instanceof UnprocessableEntityException) return null;
      throw error;
    }
  }

  /** Indexes the revisions in force that have no row yet, a batch at a time; returns how many were looked at. */
  async sweep(): Promise<number> {
    let cursor = '';
    let looked = 0;
    for (;;) {
      const missing = await this.prisma.document.findMany({
        where: { id: { gt: cursor }, status: 'PUBLISHED', currentRevisionId: { not: null }, currentRevision: { is: { text: { is: null } } } },
        select: { id: true, currentRevisionId: true },
        take: SWEEP_BATCH,
        orderBy: { id: 'asc' },
      });
      for (const document of missing) await this.indexSafely(document.currentRevisionId!);
      looked += missing.length;
      if (missing.length < SWEEP_BATCH) return looked;
      cursor = missing[missing.length - 1].id;
    }
  }

  onApplicationBootstrap(): void {
    // Background work follows the one switch for it (tests turn it off and call sweep() themselves)
    if (!JOBS_ENABLED) return;
    const run = async () => {
      try {
        await this.sweep();
      } catch (error) {
        this.logger.error(`Search index sweep failed: ${(error as Error).message}`);
      }
    };
    void run();
    this.timer = setInterval(() => void run(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
