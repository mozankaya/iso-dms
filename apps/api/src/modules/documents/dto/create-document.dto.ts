import { FILE_TYPES, type FileType } from '@iso-dms/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateDocumentDto {
  @IsUUID()
  categoryId: string;

  @IsUUID()
  departmentId: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsIn(FILE_TYPES)
  fileType: FileType;

  /** Falls back to the category's (or the global) default template of the file type */
  @IsOptional()
  @IsUUID()
  templateId?: string;
}

/** Multipart fields of an upload; the file type comes from the uploaded file itself. */
export class UploadDocumentDto {
  @IsUUID()
  categoryId: string;

  @IsUUID()
  departmentId: string;

  /** Defaults to the file name without extension */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;
}
