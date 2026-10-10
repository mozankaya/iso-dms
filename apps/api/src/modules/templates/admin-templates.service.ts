import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminTemplateDto, DocumentFieldTag, FileType } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { findDocumentFields } from '../documents/document-fields/docx-fields';
import { findXlsxFields } from '../documents/document-fields/xlsx-fields';
import { validateOfficeFile } from '../documents/office-file.validator';
import { FILE_TYPE_INFO } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import type { CreateTemplateDto, UpdateTemplateDto } from './dto/admin-template.dto';

const SELECT = {
  id: true,
  name: true,
  fileType: true,
  isDefault: true,
  fieldTags: true,
  createdAt: true,
  categoryId: true,
  category: { select: { id: true, name: true } },
} satisfies Prisma.TemplateSelect;

type Row = Prisma.TemplateGetPayload<{ select: typeof SELECT }>;

function toDto(row: Row): AdminTemplateDto {
  return {
    id: row.id,
    name: row.name,
    fileType: row.fileType,
    category: row.category,
    isDefault: row.isDefault,
    fields: row.fieldTags as DocumentFieldTag[],
    createdAt: row.createdAt.toISOString(),
  };
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';
const sameName = (a: string, b: string) => a.toLocaleLowerCase('tr-TR') === b.toLocaleLowerCase('tr-TR');
const nameTaken = () => new ConflictException({ code: 'TEMPLATE_NAME_TAKEN', message: 'A template of this file type has this name' });

export interface TemplateDownload {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

/** Administration of the templates new documents start from (PROJECT.md 6.11). */
@Injectable()
export class AdminTemplatesService {
  private readonly logger = new Logger(AdminTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
    private readonly config: ConfigService,
  ) {}

  async overview(organizationId: string): Promise<AdminTemplateDto[]> {
    const rows = await this.prisma.template.findMany({
      where: { organizationId },
      orderBy: [{ fileType: 'asc' }, { name: 'asc' }],
      select: SELECT,
    });
    return rows.map(toDto);
  }

  async create(
    user: AuthenticatedUser,
    dto: CreateTemplateDto,
    file: Express.Multer.File | undefined,
    ipAddress: string | null,
  ): Promise<AdminTemplateDto> {
    const { fileType } = await this.validate(file);
    const categoryId = dto.categoryId ?? null;
    const storageKey = this.newKey(user.organizationId, fileType);
    const fieldTags = await this.fieldsOf(file!.buffer, fileType);
    // The file goes first; if the record cannot be written the orphan is removed again
    await this.storage.put(storageKey, file!.buffer, FILE_TYPE_INFO[fileType].mimeType);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, user.organizationId);
        if (categoryId) await this.assertCategory(tx, user.organizationId, categoryId);
        await this.assertNameFree(tx, user.organizationId, dto.name, fileType, null);

        const row = await tx.template.create({
          data: { organizationId: user.organizationId, categoryId, name: dto.name, fileType, storageKey, isDefault: dto.isDefault ?? false, fieldTags },
          select: SELECT,
        });
        if (row.isDefault) await this.unsetOtherDefaults(tx, user.organizationId, categoryId, fileType, row.id);
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'TEMPLATE_CREATED',
            entityType: 'Template',
            entityId: row.id,
            metadata: { name: row.name, fileType, categoryId, isDefault: row.isDefault },
            ipAddress,
          },
          tx,
        );
        return row;
      });
      return toDto(created);
    } catch (error) {
      await this.discard(storageKey);
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateTemplateDto, ipAddress: string | null): Promise<AdminTemplateDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, user.organizationId);
        const current = await tx.template.findFirst({ where: { id, organizationId: user.organizationId }, select: SELECT });
        if (!current) throw this.notFound();

        const nextCategoryId = dto.categoryId === undefined ? current.categoryId : dto.categoryId;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (dto.name !== undefined && dto.name !== current.name) changes.name = { from: current.name, to: dto.name };
        if (nextCategoryId !== current.categoryId) changes.categoryId = { from: current.categoryId, to: nextCategoryId };
        if (dto.isDefault !== undefined && dto.isDefault !== current.isDefault) changes.isDefault = { from: current.isDefault, to: dto.isDefault };
        // Nothing to change is not an error, and not worth a record
        if (Object.keys(changes).length === 0) return toDto(current);

        if (changes.categoryId && nextCategoryId) await this.assertCategory(tx, user.organizationId, nextCategoryId);
        if (changes.name) await this.assertNameFree(tx, user.organizationId, dto.name!, current.fileType, id);

        const row = await tx.template.update({
          where: { id },
          data: { name: dto.name, categoryId: nextCategoryId, isDefault: dto.isDefault },
          select: SELECT,
        });
        // Moving into a category (or being made the default) takes the place of the default there
        if (row.isDefault && (changes.isDefault || changes.categoryId)) {
          await this.unsetOtherDefaults(tx, user.organizationId, row.categoryId, row.fileType, id);
        }
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'TEMPLATE_UPDATED',
            entityType: 'Template',
            entityId: id,
            metadata: { name: current.name, changes: changes as unknown as Prisma.InputJsonObject },
            ipAddress,
          },
          tx,
        );
        return toDto(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** New content for an existing template; documents made from it earlier keep their own copy. */
  async replaceFile(user: AuthenticatedUser, id: string, file: Express.Multer.File | undefined, ipAddress: string | null): Promise<AdminTemplateDto> {
    const { fileType } = await this.validate(file);
    const storageKey = this.newKey(user.organizationId, fileType);
    const fieldTags = await this.fieldsOf(file!.buffer, fileType);
    await this.storage.put(storageKey, file!.buffer, FILE_TYPE_INFO[fileType].mimeType);

    let oldKey: string;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, user.organizationId);
        const current = await tx.template.findFirst({ where: { id, organizationId: user.organizationId }, select: { ...SELECT, storageKey: true } });
        if (!current) throw this.notFound();
        if (current.fileType !== fileType) {
          throw new BadRequestException({ code: 'TEMPLATE_FILE_TYPE_MISMATCH', message: 'The file has to be of the same type as the template' });
        }

        const row = await tx.template.update({ where: { id }, data: { storageKey, fieldTags }, select: SELECT });
        await this.auditLogs.log(
          {
            organizationId: user.organizationId,
            userId: user.id,
            action: 'TEMPLATE_FILE_REPLACED',
            entityType: 'Template',
            entityId: id,
            metadata: { name: row.name, fileType, fileSize: file!.buffer.length, fields: fieldTags },
            ipAddress,
          },
          tx,
        );
        return { row, oldKey: current.storageKey };
      });
      oldKey = result.oldKey;
      // The previous file is not a record (nothing refers to it) and is removed only after the new one is in place
      await this.discard(oldKey);
      return toDto(result.row);
    } catch (error) {
      await this.discard(storageKey);
      throw error;
    }
  }

  async download(organizationId: string, id: string): Promise<TemplateDownload> {
    const template = await this.prisma.template.findFirst({ where: { id, organizationId }, select: { name: true, fileType: true, storageKey: true } });
    if (!template) throw this.notFound();
    const stream = await this.storage.tryGetStream(template.storageKey);
    if (!stream) throw new NotFoundException({ code: 'TEMPLATE_FILE_MISSING', message: 'The template file is not available' });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const { extension, mimeType } = FILE_TYPE_INFO[template.fileType];
    const safeName = template.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'template';
    return { buffer: Buffer.concat(chunks), mimeType, fileName: `${safeName}.${extension}` };
  }

  async remove(user: AuthenticatedUser, id: string, ipAddress: string | null): Promise<void> {
    const storageKey = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.organizationId);
      const current = await tx.template.findFirst({ where: { id, organizationId: user.organizationId }, select: { ...SELECT, storageKey: true } });
      if (!current) throw this.notFound();

      // New documents need a template of each file type
      const sameType = await tx.template.count({ where: { organizationId: user.organizationId, fileType: current.fileType } });
      if (sameType <= 1) {
        throw new ConflictException({ code: 'LAST_TEMPLATE_PROTECTED', message: 'The last template of a file type cannot be deleted' });
      }

      await tx.template.delete({ where: { id } });
      await this.auditLogs.log(
        {
          organizationId: user.organizationId,
          userId: user.id,
          action: 'TEMPLATE_DELETED',
          entityType: 'Template',
          entityId: id,
          metadata: { name: current.name, fileType: current.fileType, categoryId: current.categoryId, wasDefault: current.isDefault },
          ipAddress,
        },
        tx,
      );
      return current.storageKey;
    });
    await this.discard(storageKey);
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
  }

  private async validate(file: Express.Multer.File | undefined): Promise<{ fileType: FileType }> {
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'A file is required' });
    const maxBytes = Number(this.config.get('MAX_UPLOAD_MB', 25)) * 1024 * 1024;
    return { fileType: await validateOfficeFile(file, maxBytes) };
  }

  /** The document fields a template has (PROJECT.md 6.14): content controls in Word, named cells in Excel. */
  private async fieldsOf(buffer: Buffer, fileType: FileType): Promise<DocumentFieldTag[]> {
    return fileType === 'DOCX' ? findDocumentFields(buffer) : findXlsxFields(buffer);
  }

  private newKey(organizationId: string, fileType: FileType): string {
    return `${organizationId}/templates/${randomUUID()}.${FILE_TYPE_INFO[fileType].extension}`;
  }

  private async lock(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`templates:${organizationId}`}, 0))`;
  }

  private async assertCategory(tx: Prisma.TransactionClient, organizationId: string, categoryId: string): Promise<void> {
    const category = await tx.category.findFirst({ where: { id: categoryId, organizationId }, select: { id: true } });
    if (!category) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
  }

  private async assertNameFree(tx: Prisma.TransactionClient, organizationId: string, name: string, fileType: FileType, exceptId: string | null): Promise<void> {
    const others = await tx.template.findMany({ where: { organizationId, fileType, ...(exceptId && { id: { not: exceptId } }) }, select: { name: true } });
    if (others.some((other) => sameName(other.name, name))) throw nameTaken();
  }

  /** One default per category (or for the global ones) and file type. */
  private async unsetOtherDefaults(tx: Prisma.TransactionClient, organizationId: string, categoryId: string | null, fileType: FileType, exceptId: string): Promise<void> {
    await tx.template.updateMany({
      where: { organizationId, categoryId, fileType, isDefault: true, id: { not: exceptId } },
      data: { isDefault: false },
    });
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Template file ${key} could not be removed: ${(error as Error).message}`);
    }
  }
}
