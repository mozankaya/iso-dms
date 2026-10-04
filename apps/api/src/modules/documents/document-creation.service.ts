import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DocumentListItemDto, FileType } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Template } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { buildRevisionKey, FILE_TYPE_INFO } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { canWriteInDepartment } from './document-access.policy';
import { DocumentCodeService } from './document-code.service';
import { DOCUMENT_LIST_SELECT, toDocumentListItem } from './document-list-item';
import type { CreateDocumentDto, UploadDocumentDto } from './dto/create-document.dto';
import { validateOfficeFile } from './office-file.validator';

interface UploadedOfficeFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

interface NewDocumentInput {
  categoryId: string;
  departmentId: string;
  title: string;
  fileType: FileType;
  content: Buffer;
  source: 'TEMPLATE' | 'UPLOAD';
  auditMetadata: Record<string, string | number>;
}

@Injectable()
export class DocumentCreationService {
  private readonly logger = new Logger(DocumentCreationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly codes: DocumentCodeService,
    private readonly auditLogs: AuditLogsService,
    private readonly config: ConfigService,
  ) {}

  /** New document from a template (PROJECT.md 6.2 rule 1). */
  async createFromTemplate(
    user: AuthenticatedUser,
    dto: CreateDocumentDto,
    ipAddress: string | null,
  ): Promise<DocumentListItemDto> {
    this.assertCanCreateIn(user, dto.departmentId);
    const template = await this.resolveTemplate(user.organizationId, dto);

    let content: Buffer;
    try {
      content = await this.storage.getBuffer(template.storageKey);
    } catch (error) {
      this.logger.error(`Template file ${template.storageKey} could not be read: ${(error as Error).message}`);
      throw new InternalServerErrorException({
        code: 'TEMPLATE_FILE_MISSING',
        message: 'The template file is not available',
      });
    }

    return this.create(
      user,
      {
        categoryId: dto.categoryId,
        departmentId: dto.departmentId,
        title: dto.title,
        fileType: dto.fileType,
        content,
        source: 'TEMPLATE',
        auditMetadata: { templateId: template.id },
      },
      ipAddress,
    );
  }

  /** New document from an existing .docx/.xlsx file. */
  async createFromUpload(
    user: AuthenticatedUser,
    dto: UploadDocumentDto,
    file: UploadedOfficeFile | undefined,
    ipAddress: string | null,
  ): Promise<DocumentListItemDto> {
    this.assertCanCreateIn(user, dto.departmentId);
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'A file is required' });
    }

    const fileType = await validateOfficeFile(file, this.maxUploadBytes());
    const title = dto.title ?? file.originalname.replace(/\.[^.]+$/, '').trim().slice(0, 200);
    if (title.length < 3) {
      throw new BadRequestException({
        code: 'TITLE_REQUIRED',
        message: 'A title of at least 3 characters is required',
      });
    }

    return this.create(
      user,
      {
        categoryId: dto.categoryId,
        departmentId: dto.departmentId,
        title,
        fileType,
        content: file.buffer,
        source: 'UPLOAD',
        auditMetadata: { fileName: file.originalname },
      },
      ipAddress,
    );
  }

  maxUploadBytes(): number {
    return Number(this.config.get('MAX_UPLOAD_MB', 25)) * 1024 * 1024;
  }

  private assertCanCreateIn(user: AuthenticatedUser, departmentId: string): void {
    if (!canWriteInDepartment(user, departmentId)) {
      throw new ForbiddenException({
        code: 'DEPARTMENT_NOT_ALLOWED',
        message: 'Documents can only be created in your own department',
      });
    }
  }

  private async resolveTemplate(organizationId: string, dto: CreateDocumentDto): Promise<Template> {
    if (dto.templateId) {
      const template = await this.prisma.template.findFirst({
        where: { id: dto.templateId, organizationId },
      });
      const usable =
        template &&
        template.fileType === dto.fileType &&
        (template.categoryId === null || template.categoryId === dto.categoryId);
      if (!usable) {
        throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
      }
      return template;
    }

    // Prefer a template of the category, then the global one; the default template wins within each group
    const candidates = await this.prisma.template.findMany({
      where: {
        organizationId,
        fileType: dto.fileType,
        OR: [{ categoryId: dto.categoryId }, { categoryId: null }],
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const template =
      candidates.find((candidate) => candidate.categoryId === dto.categoryId && candidate.isDefault) ??
      candidates.find((candidate) => candidate.categoryId === null && candidate.isDefault) ??
      candidates.find((candidate) => candidate.categoryId === dto.categoryId) ??
      candidates[0];
    if (!template) {
      throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'No template available' });
    }
    return template;
  }

  private async create(
    user: AuthenticatedUser,
    input: NewDocumentInput,
    ipAddress: string | null,
  ): Promise<DocumentListItemDto> {
    const [category, department] = await Promise.all([
      this.prisma.category.findFirst({
        where: { id: input.categoryId, organizationId: user.organizationId, isActive: true },
      }),
      this.prisma.department.findFirst({
        where: { id: input.departmentId, organizationId: user.organizationId, isActive: true },
      }),
    ]);
    if (!category) {
      throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
    }
    if (!department) {
      throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });
    }

    const documentId = randomUUID();
    const storageKey = buildRevisionKey({
      organizationId: user.organizationId,
      documentId,
      revisionNo: 0,
      fileType: input.fileType,
    });

    // The file goes to storage first: a database row that points to a missing file would be worse than
    // an orphaned object, and the orphan is removed below if the transaction fails.
    await this.storage.put(storageKey, input.content, FILE_TYPE_INFO[input.fileType].mimeType);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const { sequenceNo, code } = await this.codes.allocate(tx, {
          organizationId: user.organizationId,
          categoryId: category.id,
          categoryPrefix: category.codePrefix,
          departmentId: department.id,
          departmentCode: department.code,
        });

        const document = await tx.document.create({
          data: {
            id: documentId,
            organizationId: user.organizationId,
            categoryId: category.id,
            departmentId: department.id,
            code,
            sequenceNo,
            title: input.title,
            fileType: input.fileType,
            status: 'DRAFT',
            ownerId: user.id,
          },
          select: DOCUMENT_LIST_SELECT,
        });

        await tx.revision.create({
          data: {
            organizationId: user.organizationId,
            documentId,
            revisionNo: 0,
            status: 'DRAFT',
            storageKey,
            fileSize: input.content.length,
            checksum: createHash('sha256').update(input.content).digest('hex'),
            editorKey: randomUUID(),
            preparedById: user.id,
          },
        });

        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'DOCUMENT_CREATED',
            entityType: 'Document',
            entityId: documentId,
            metadata: { code, source: input.source, fileSize: input.content.length, ...input.auditMetadata },
            ipAddress,
          },
          tx,
        );

        return toDocumentListItem(document, true);
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch((cleanupError: Error) => {
        this.logger.error(`Orphaned object ${storageKey} could not be removed: ${cleanupError.message}`);
      });
      throw error;
    }
  }
}
