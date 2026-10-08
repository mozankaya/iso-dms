import { Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PdfRequestService } from './pdf-request.service';

@Controller('revisions')
export class PdfController {
  constructor(private readonly requests: PdfRequestService) {}

  /** PROJECT.md 6.12: the copies are looked after by the quality management. */
  @Post(':id/pdf')
  @HttpCode(200)
  @Roles('QUALITY_MANAGER', 'ADMIN')
  request(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.requests.request(user, id, req.ip ?? null);
  }
}
