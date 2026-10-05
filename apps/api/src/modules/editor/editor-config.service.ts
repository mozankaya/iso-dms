import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EditorMode, EditorSessionDto, FileType } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { canEditRevision, canViewRevision } from '../documents/document-access.policy';
import { FILE_TYPE_INFO } from '../storage/storage-keys';
import { FileTokenService } from './file-token.service';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';

const DOCUMENT_TYPE: Record<FileType, 'word' | 'cell'> = { DOCX: 'word', XLSX: 'cell' };

@Injectable()
export class EditorConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fileTokens: FileTokenService,
    private readonly onlyOfficeJwt: OnlyOfficeJwtService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Builds the signed editor configuration for a revision (PROJECT.md 7.1). Whether the user may edit is
   * decided here, on the server; the document server only follows the signed configuration.
   */
  async createSession(user: AuthenticatedUser, revisionId: string, ipAddress: string | null): Promise<EditorSessionDto> {
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

    const account = await this.prisma.user.findFirst({
      where: { id: user.id, organizationId: user.organizationId },
      select: { fullName: true },
    });

    const { document } = revision;
    let mode: EditorMode = canEditRevision(user, document, revision) ? 'edit' : 'view';
    if (mode === 'edit') {
      // The mark and the status check are one statement: either this session is recorded before a publication
      // can lock the revision (and the publication then waits for it), or the revision is no longer a draft
      // and the user gets a read only session.
      const marked = await this.prisma.revision.updateMany({
        where: { id: revision.id, status: 'DRAFT' },
        data: { editSessionStartedAt: new Date() },
      });
      if (marked.count === 0) mode = 'view';
    }
    const extension = FILE_TYPE_INFO[document.fileType].extension;
    const tokenClaims = { revisionId: revision.id, organizationId: user.organizationId };

    const editorConfig: Record<string, unknown> = {
      mode,
      lang: 'tr',
      user: { id: user.id, name: account?.fullName ?? user.id },
      customization: { forcesave: true, autosave: true },
    };
    if (mode === 'edit') {
      // Only an editable session may save: view sessions get no callback address at all
      const callbackToken = await this.fileTokens.sign({ purpose: 'callback', ...tokenClaims });
      editorConfig.callbackUrl = `${this.apiBase()}/api/editor/callback/${revision.id}?token=${callbackToken}`;
    }

    const downloadToken = await this.fileTokens.sign({ purpose: 'download', ...tokenClaims });
    const config: Record<string, unknown> = {
      documentType: DOCUMENT_TYPE[document.fileType],
      document: {
        fileType: extension,
        // Changes with every content change: the same key makes the document server reuse its cached copy
        key: revision.editorKey,
        title: `${document.code} ${document.title}.${extension}`,
        url: `${this.apiBase()}/api/editor/files/${revision.id}?token=${downloadToken}`,
        permissions: { edit: mode === 'edit', comment: mode === 'edit', download: true, print: true },
      },
      editorConfig,
    };
    config.token = await this.onlyOfficeJwt.sign(config);

    await this.auditLogs.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'DOCUMENT_OPENED',
      entityType: 'Document',
      entityId: document.id,
      metadata: { revisionId: revision.id, revisionNo: revision.revisionNo, mode },
      ipAddress,
    });

    return {
      mode,
      document: { id: document.id, code: document.code, title: document.title, status: document.status },
      revision: { id: revision.id, revisionNo: revision.revisionNo, status: revision.status },
      config,
    };
  }

  /** Address the document server uses to reach this API (a different network than the browser's). */
  private apiBase(): string {
    return this.config.get<string>('API_INTERNAL_URL', 'http://host.docker.internal:4000').replace(/\/+$/, '');
  }
}
