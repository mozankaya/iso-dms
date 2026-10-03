import { FILE_TYPES, type FileType } from '@iso-dms/shared';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class ListTemplatesDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(FILE_TYPES)
  fileType?: FileType;
}
