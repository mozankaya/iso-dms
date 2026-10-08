import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.departmentsService.findAll(user.organizationId);
  }

  /** PROJECT.md 6.4: the structure of the organization is the administrator's. */
  @Get('overview')
  @Roles('ADMIN')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.departmentsService.overview(user.organizationId);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDepartmentDto, @Req() req: Request) {
    return this.departmentsService.create(user, dto, req.ip ?? null);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
    @Req() req: Request,
  ) {
    return this.departmentsService.update(user, id, dto, req.ip ?? null);
  }
}
