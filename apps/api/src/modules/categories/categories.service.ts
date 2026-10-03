import { Injectable } from '@nestjs/common';
import type { CategoryDto } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active categories with the number of published documents in each. */
  async findAll(organizationId: string): Promise<CategoryDto[]> {
    const categories = await this.prisma.category.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { documents: { where: { organizationId, status: 'PUBLISHED' } } } },
      },
    });

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      codePrefix: category.codePrefix,
      description: category.description,
      icon: category.icon,
      sortOrder: category.sortOrder,
      isExternal: category.isExternal,
      externalUrl: category.externalUrl,
      documentCount: category._count.documents,
    }));
  }
}
