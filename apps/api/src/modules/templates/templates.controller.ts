import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ListTemplatesDto } from './dto/list-templates.dto';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @Roles('EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN')
  findAll(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTemplatesDto) {
    return this.templatesService.findAll(user.organizationId, query);
  }
}
