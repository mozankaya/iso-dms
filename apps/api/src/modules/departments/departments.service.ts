import { Injectable } from '@nestjs/common';
import type { DepartmentDto } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(organizationId: string): Promise<DepartmentDto[]> {
    return this.prisma.department.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
  }
}
