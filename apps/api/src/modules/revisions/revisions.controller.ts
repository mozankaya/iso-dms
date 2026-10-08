import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CancelRevisionDto } from './dto/cancel-revision.dto';
import { StartRevisionDto } from './dto/start-revision.dto';
import { contentDisposition } from './download-file-name';
import { RevisionCancellationService } from './revision-cancellation.service';
import { RevisionStartingService } from './revision-starting.service';
import { DownloadFormat, RevisionDownload, RevisionsService } from './revisions.service';

/** `?format=pdf` asks for the PDF copy; nothing (or `original`) for the file as it was stored. */
function parseFormat(format: string | undefined): DownloadFormat {
  if (format === undefined || format === 'original') return 'original';
  if (format === 'pdf') return 'pdf';
  throw new BadRequestException({ code: 'UNSUPPORTED_FORMAT', message: 'The format has to be pdf' });
}

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
    private readonly startingService: RevisionStartingService,
    private readonly cancellationService: RevisionCancellationService,
  ) {}

  @Get('documents/:documentId/revisions')
  list(@CurrentUser() user: AuthenticatedUser, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.revisionsService.listForDocument(user, documentId);
  }

  /** PROJECT.md 6.4: "Revizyon / yayından kaldırma talebi" is for everybody who may write. */
  @Post('documents/:documentId/revisions')
  @Roles('EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN')
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: StartRevisionDto,
    @Req() req: Request,
  ) {
    return this.startingService.start(user, documentId, dto, req.ip ?? null);
  }

  /** Gives up a started revision of a document in force; the draft stays on record as rejected. */
  @Post('revisions/:id/cancel')
  @HttpCode(200)
  @Roles('EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelRevisionDto,
    @Req() req: Request,
  ) {
    return this.cancellationService.cancel(user, id, dto, req.ip ?? null);
  }

  @Get('documents/:documentId/download')
  async downloadCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return toResponse(await this.revisionsService.openCurrentDownload(user, documentId, req.ip ?? null, parseFormat(format)), res);
  }

  @Get('revisions/:id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return toResponse(await this.revisionsService.openDownload(user, id, req.ip ?? null, parseFormat(format)), res);
  }
}
