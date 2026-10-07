import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AuditLogsQueryService } from './audit-logs-query.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/** PROJECT.md 6.4: the audit trail is for quality managers and administrators. */
@Controller()
@Roles('QUALITY_MANAGER', 'ADMIN')
export class AuditLogsController {
  constructor(private readonly queries: AuditLogsQueryService) {}

  @Get('audit-logs')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAuditLogsDto) {
    return this.queries.list(user, query);
  }

  @Get('documents/:documentId/audit-logs')
  listForDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.queries.listForDocument(user, documentId, query);
  }
}
