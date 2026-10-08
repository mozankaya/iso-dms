import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ListFeedbackDto, ResolveFeedbackDto, SendFeedbackDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** PROJECT.md 6.4: every role may send feedback (about what it can see). */
  @Post('documents/:documentId/feedback')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: SendFeedbackDto,
    @Req() req: Request,
  ) {
    return this.feedback.send(user, documentId, dto, req.ip ?? null);
  }

  @Get('feedback')
  @Roles('QUALITY_MANAGER', 'ADMIN')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListFeedbackDto) {
    return this.feedback.list(user, query);
  }

  @Post('feedback/:id/resolve')
  @HttpCode(200)
  @Roles('QUALITY_MANAGER', 'ADMIN')
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveFeedbackDto,
    @Req() req: Request,
  ) {
    return this.feedback.resolve(user, id, dto, req.ip ?? null);
  }

  @Post('feedback/:id/reopen')
  @HttpCode(200)
  @Roles('QUALITY_MANAGER', 'ADMIN')
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.feedback.reopen(user, id, req.ip ?? null);
  }
}
