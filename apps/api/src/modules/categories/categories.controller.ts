import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.categoriesService.findAll(user.organizationId);
  }

  /** PROJECT.md 6.4: the structure of the organization is the administrator's. */
  @Get('overview')
  @Roles('ADMIN')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.categoriesService.overview(user.organizationId);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCategoryDto, @Req() req: Request) {
    return this.categoriesService.create(user, dto, req.ip ?? null);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: Request,
  ) {
    return this.categoriesService.update(user, id, dto, req.ip ?? null);
  }
}
