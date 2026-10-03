import { Body, Controller, Get, HttpCode, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CreateDocumentDto, UploadDocumentDto } from './dto/create-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { DocumentCreationService } from './document-creation.service';
import { DocumentsService } from './documents.service';

const CREATOR_ROLES = ['EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN'] as const;

// Evaluated at import time (like the login rate limit); the service validates the same limit again
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly creationService: DocumentCreationService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsDto) {
    return this.documentsService.list(user, query);
  }

  @Post()
  @Roles(...CREATOR_ROLES)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDocumentDto, @Req() req: Request) {
    return this.creationService.createFromTemplate(user, dto, req.ip ?? null);
  }

  @Post('upload')
  @HttpCode(201)
  @Roles(...CREATOR_ROLES)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      // Browsers send file names as UTF-8; without this Turkish characters are decoded as latin1
      defParamCharset: 'utf8',
    } as MulterOptions),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.creationService.createFromUpload(user, dto, file, req.ip ?? null);
  }
}
