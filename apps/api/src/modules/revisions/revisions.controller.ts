import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PublishRevisionDto } from './dto/publish-revision.dto';
import { contentDisposition } from './download-file-name';
import { RevisionPublishingService } from './revision-publishing.service';
import { RevisionDownload, RevisionsService } from './revisions.service';

function toResponse(download: RevisionDownload, res: Response): StreamableFile {
  res.set({
    'Content-Type': download.mimeType,
    'Content-Length': String(download.size),
    'Content-Disposition': contentDisposition(download.fileName),
    'Cache-Control': 'no-store',
  });
  return new StreamableFile(download.stream);
}

@Controller()
export class RevisionsController {
  constructor(
    private readonly revisionsService: RevisionsService,
    private readonly publishingService: RevisionPublishingService,
  ) {}

  @Get('documents/:documentId/revisions')
  list(@CurrentUser() user: AuthenticatedUser, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.revisionsService.listForDocument(user, documentId);
  }

  @Get('documents/:documentId/download')
  async downloadCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return toResponse(await this.revisionsService.openCurrentDownload(user, documentId, req.ip ?? null), res);
  }

  /** Simple publication without the approval steps (PROJECT.md 6.4: final approval and publication). */
  @Post('revisions/:id/publish')
  @HttpCode(200)
  @Roles('QUALITY_MANAGER', 'ADMIN')
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishRevisionDto,
    @Req() req: Request,
  ) {
    return this.publishingService.publish(user, id, dto, req.ip ?? null);
  }

  @Get('revisions/:id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return toResponse(await this.revisionsService.openDownload(user, id, req.ip ?? null), res);
  }
}
