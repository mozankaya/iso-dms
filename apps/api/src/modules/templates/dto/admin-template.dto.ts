import { ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_NAME_MIN_LENGTH } from '@iso-dms/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Multipart fields arrive as text. */
const toBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
/** An empty field means "every category". */
const emptyToNull = ({ value }: { value: unknown }) => (value === '' || value === 'null' ? null : value);

/** Fields next to the uploaded file; the file type is taken from the file. */
export class CreateTemplateDto {
  @Transform(trim)
  @IsString()
  @MinLength(ORGANIZATION_NAME_MIN_LENGTH)
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isDefault?: boolean;
}

/** The file type is not here: it is the type of the file, and a file of another type is a different template. */
export class UpdateTemplateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(ORGANIZATION_NAME_MIN_LENGTH)
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
