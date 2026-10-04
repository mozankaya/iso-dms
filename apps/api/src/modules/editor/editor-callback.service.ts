import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FileType } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { assertOfficePackage } from '../documents/office-file.validator';
import { buildRevisionKey, FILE_TYPE_INFO } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { FileTokenService } from './file-token.service';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';

/** The answer the document server expects: error 0 means "handled", 1 asks it to treat the save as failed. */
export interface CallbackResponse {
  error: 0 | 1;
}

/** Callback statuses of the document server (PROJECT.md 7.2). */
const STATUS = {
  READY_FOR_SAVING: 2,
  SAVING_ERROR: 3,
  FORCE_SAVE: 6,
  FORCE_SAVE_ERROR: 7,
} as const;

type RejectReason = 'NOT_EDITABLE' | 'STALE_KEY' | 'UNTRUSTED_URL' | 'DOWNLOAD_FAILED' | 'INVALID_CONTENT';

/** Reasons that are final: retrying would not change the outcome, so the server is told "handled". */
const FINAL_REASONS: RejectReason[] = ['NOT_EDITABLE', 'STALE_KEY'];

const DOWNLOAD_TIMEOUT_MS = 60_000;

@Injectable()
export class EditorCallbackService {
  private readonly logger = new Logger(EditorCallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly fileTokens: FileTokenService,
    private readonly onlyOfficeJwt: OnlyOfficeJwtService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Handles a callback of the document server. Both the URL token and the ONLYOFFICE JWT must be valid
   * (a failure answers 403); everything after that answers with {error} as the server requires.
   */
  async handle(params: {
    revisionId: string;
    urlToken: string | undefined;
    authorization: string | undefined;
    body: Record<string, unknown>;
    ipAddress: string | null;
  }): Promise<CallbackResponse> {
    const claims = await this.fileTokens.verify(params.urlToken, 'callback', params.revisionId);
    const payload = await this.onlyOfficeJwt.verifyCallback(params.authorization, params.body);
    const status = Number(payload.status);

    if (status === STATUS.SAVING_ERROR || status === STATUS.FORCE_SAVE_ERROR) {
      this.logger.error(`The document server could not save revision ${params.revisionId} (status ${status})`);
      return { error: 0 };
    }
    if (status !== STATUS.READY_FOR_SAVING && status !== STATUS.FORCE_SAVE) {
      return { error: 0 }; // editing (1) or closed without changes (4): nothing to store
    }

    try {
      return await this.save({
        revisionId: params.revisionId,
        organizationId: claims.organizationId,
        status,
        key: typeof payload.key === 'string' ? payload.key : '',
        url: typeof payload.url === 'string' ? payload.url : '',
        userIds: Array.isArray(payload.users) ? payload.users.filter((id): id is string => typeof id === 'string') : [],
        ipAddress: params.ipAddress,
      });
    } catch (error) {
      this.logger.error(`Saving revision ${params.revisionId} failed: ${(error as Error).message}`);
      return { error: 1 };
    }
  }

  private async save(input: {
    revisionId: string;
    organizationId: string;
    status: number;
    key: string;
    url: string;
    userIds: string[];
    ipAddress: string | null;
  }): Promise<CallbackResponse> {
    const revision = await this.prisma.revision.findFirst({
      where: { id: input.revisionId, organizationId: input.organizationId },
      include: { document: { select: { fileType: true } } },
    });
    if (!revision) return { error: 1 };

    const savedBy = await this.resolveUser(input.organizationId, input.userIds);
    const reject = async (reason: RejectReason): Promise<CallbackResponse> => {
      this.logger.warn(`Save of revision ${revision.id} rejected: ${reason}`);
      await this.auditLogs.log({
        organizationId: input.organizationId,
        userId: savedBy,
        action: 'REVISION_SAVE_REJECTED',
        entityType: 'Revision',
        entityId: revision.id,
        metadata: { reason, callbackStatus: input.status },
        ipAddress: input.ipAddress,
      });
      return { error: FINAL_REASONS.includes(reason) ? 0 : 1 };
    };

    // A revision that is no longer a draft is locked (PROJECT.md 6.2 rule 3); a stale key belongs to a
    // session that was already saved and closed.
    if (revision.status !== 'DRAFT') return reject('NOT_EDITABLE');
    if (revision.editorKey !== input.key) return reject('STALE_KEY');

    const downloadUrl = this.toInternalUrl(input.url);
    if (!downloadUrl) return reject('UNTRUSTED_URL');

    const fileType: FileType = revision.document.fileType;
    let content: Buffer;
    try {
      content = await this.download(downloadUrl);
    } catch (error) {
      this.logger.error(`Downloading the edited file failed: ${(error as Error).message}`);
      return reject('DOWNLOAD_FAILED');
    }
    try {
      await assertOfficePackage(content, fileType);
    } catch {
      return reject('INVALID_CONTENT');
    }

    // The new content goes to a new object and the row switches over atomically: a failure at any point
    // leaves the previous content, checksum and size consistent with each other.
    const newKey = buildRevisionKey({
      organizationId: input.organizationId,
      documentId: revision.documentId,
      revisionNo: revision.revisionNo,
      fileType,
    });
    await this.storage.put(newKey, content, FILE_TYPE_INFO[fileType].mimeType);

    const checksum = createHash('sha256').update(content).digest('hex');
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Revision" WHERE id = ${revision.id} FOR UPDATE`;
        const current = await tx.revision.findUnique({ where: { id: revision.id } });
        if (!current || current.status !== 'DRAFT' || current.editorKey !== input.key) {
          return { saved: false as const };
        }

        await tx.revision.update({
          where: { id: revision.id },
          data: {
            storageKey: newKey,
            fileSize: content.length,
            checksum,
            // The key changes only when the session ends (status 2). During a forced save others may still
            // be editing, and a new key would make the document server open a second, separate session.
            ...(input.status === STATUS.READY_FOR_SAVING && { editorKey: randomUUID() }),
          },
        });
        await this.auditLogs.log(
          {
            organizationId: input.organizationId,
            userId: savedBy,
            action: 'REVISION_SAVED',
            entityType: 'Revision',
            entityId: revision.id,
            metadata: {
              documentId: revision.documentId,
              revisionNo: revision.revisionNo,
              forceSave: input.status === STATUS.FORCE_SAVE,
              fileSize: content.length,
              checksum,
              previousChecksum: current.checksum,
            },
            ipAddress: input.ipAddress,
          },
          tx,
        );
        return { saved: true as const, previousKey: current.storageKey };
      });

      if (!outcome.saved) {
        await this.removeQuietly(newKey);
        return reject('STALE_KEY');
      }
      // Intermediate draft content is not a record (PROJECT.md 6.2 rule 2): the replaced object is dropped
      await this.removeQuietly(outcome.previousKey);
      return { error: 0 };
    } catch (error) {
      await this.removeQuietly(newKey);
      throw error;
    }
  }

  /** The document server reports its own address; the API may only fetch from the configured origins. */
  private toInternalUrl(reported: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(reported);
    } catch {
      return null;
    }

    const internal = new URL(this.config.get<string>('ONLYOFFICE_INTERNAL_URL', 'http://localhost:8080'));
    const publicUrl = new URL(this.config.get<string>('ONLYOFFICE_PUBLIC_URL', 'http://localhost:8080'));
    if (parsed.origin !== internal.origin && parsed.origin !== publicUrl.origin) return null;

    return `${internal.origin}${parsed.pathname}${parsed.search}`;
  }

  private async download(url: string): Promise<Buffer> {
    const maxBytes = Number(this.config.get('MAX_UPLOAD_MB', 25)) * 1024 * 1024;
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      throw new Error('file too large');
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('file too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** ONLYOFFICE reports the ids we put in editorConfig.user; the first one that is a real user is credited. */
  private async resolveUser(organizationId: string, ids: string[]): Promise<string | null> {
    if (ids.length === 0) return null;
    const user = await this.prisma.user.findFirst({
      where: { organizationId, id: { in: ids } },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  private async removeQuietly(key: string): Promise<void> {
    await this.storage.delete(key).catch((error: Error) => {
      this.logger.error(`Object ${key} could not be removed: ${error.message}`);
    });
  }
}
