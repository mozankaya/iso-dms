import { Injectable } from '@nestjs/common';
import type { FileType, TemplateDto } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Templates usable in a category: the category's own plus the ones available everywhere. */
  findAll(
    organizationId: string,
    filters: { categoryId?: string; fileType?: FileType },
  ): Promise<TemplateDto[]> {
    return this.prisma.template.findMany({
      where: {
        organizationId,
        ...(filters.fileType && { fileType: filters.fileType }),
        ...(filters.categoryId && { OR: [{ categoryId: null }, { categoryId: filters.categoryId }] }),
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, fileType: true, categoryId: true, isDefault: true },
    });
  }
}
