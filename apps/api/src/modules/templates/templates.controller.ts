import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { contentDisposition } from '../revisions/download-file-name';
import { AdminTemplatesService } from './admin-templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/admin-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
import { TemplatesService } from './templates.service';

// Evaluated at import time (like the login rate limit); the service validates the same limit again
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

const uploadInterceptor = () =>
  FileInterceptor('file', {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    // Browsers send file names as UTF-8; without this Turkish characters are decoded as latin1
    defParamCharset: 'utf8',
  } as MulterOptions);

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly adminTemplates: AdminTemplatesService,
  ) {}

  @Get()
  @Roles('EDITOR', 'APPROVER', 'QUALITY_MANAGER', 'ADMIN')
  findAll(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTemplatesDto) {
    return this.templatesService.findAll(user.organizationId, query);
  }

  /** PROJECT.md 6.4, 6.11: the templates are the administrator's. */
  @Get('overview')
  @Roles('ADMIN')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.adminTemplates.overview(user.organizationId);
  }

  @Post()
  @Roles('ADMIN')
  @UseInterceptors(uploadInterceptor())
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTemplateDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.adminTemplates.create(user, dto, file, req.ip ?? null);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto, @Req() req: Request) {
    return this.adminTemplates.update(user, id, dto, req.ip ?? null);
  }

  @Put(':id/file')
  @Roles('ADMIN')
  @UseInterceptors(uploadInterceptor())
  replaceFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.adminTemplates.replaceFile(user, id, file, req.ip ?? null);
  }

  @Get(':id/download')
  @Roles('ADMIN')
  async download(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const download = await this.adminTemplates.download(user.organizationId, id);
    res.set({
      'Content-Type': download.mimeType,
      'Content-Length': String(download.buffer.length),
      'Content-Disposition': contentDisposition(download.fileName),
    });
    return new StreamableFile(download.buffer);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles('ADMIN')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request): Promise<void> {
    await this.adminTemplates.remove(user, id, req.ip ?? null);
  }
}
