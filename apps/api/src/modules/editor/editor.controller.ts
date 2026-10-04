import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
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
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { FILE_TYPE_INFO } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { EditorCallbackService } from './editor-callback.service';
import { EditorConfigService } from './editor-config.service';
import { FileTokenService } from './file-token.service';

@Controller('editor')
export class EditorController {
  private readonly logger = new Logger(EditorController.name);

  constructor(
    private readonly configService: EditorConfigService,
    private readonly callbackService: EditorCallbackService,
    private readonly fileTokens: FileTokenService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Called by the web app with the user's JWT. */
  @Get('config/:revisionId')
  config(
    @CurrentUser() user: AuthenticatedUser,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Req() req: Request,
  ) {
    return this.configService.createSession(user, revisionId, req.ip ?? null);
  }

  /** Called by the document server, protected by the signed token in the URL instead of a user JWT. */
  @Public()
  @Get('files/:revisionId')
  async file(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const claims = await this.fileTokens.verify(token, 'download', revisionId);
    const revision = await this.prisma.revision.findFirst({
      where: { id: revisionId, organizationId: claims.organizationId },
      select: { storageKey: true, fileSize: true, document: { select: { fileType: true } } },
    });
    if (!revision) {
      throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: 'Revision not found' });
    }

    const stream = await this.storage.tryGetStream(revision.storageKey);
    if (!stream) {
      this.logger.error(`The file of revision ${revisionId} is missing from storage (${revision.storageKey})`);
      throw new NotFoundException({ code: 'REVISION_FILE_MISSING', message: 'The revision file is missing' });
    }

    res.set({
      'Content-Type': FILE_TYPE_INFO[revision.document.fileType].mimeType,
      'Content-Length': String(revision.fileSize),
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(stream);
  }

  /** Called by the document server when the document is saved; see EditorCallbackService. */
  @Public()
  @HttpCode(200)
  @Post('callback/:revisionId')
  callback(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query('token') token: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    return this.callbackService.handle({
      revisionId,
      urlToken: token,
      authorization,
      body: body ?? {},
      ipAddress: req.ip ?? null,
    });
  }
}
