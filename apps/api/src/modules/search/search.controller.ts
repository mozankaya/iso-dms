import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { SearchDto } from './dto/search.dto';
import { SearchService } from './search.service';

/** Open to every role: what a user finds is limited to what they may see anyway (PROJECT.md 6.16). */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(@CurrentUser() user: AuthenticatedUser, @Query() query: SearchDto) {
    return this.search.search(user, query);
  }
}
