import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ListPublicationsDto } from './dto/list-publications.dto';
import { ListsService } from './lists.service';

@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get('new')
  listNew(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPublicationsDto) {
    return this.lists.list(user, 'new', query);
  }

  @Get('revised')
  listRevised(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPublicationsDto) {
    return this.lists.list(user, 'revised', query);
  }

  /** PROJECT.md 6.4: readers do not see withdrawn documents at all. */
  @Get('withdrawn')
  @Roles('EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN')
  listWithdrawn(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPublicationsDto) {
    return this.lists.list(user, 'withdrawn', query);
  }
}
