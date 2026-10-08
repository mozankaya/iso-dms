import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_ICONS,
  CATEGORY_PREFIX_PATTERN,
  CATEGORY_SORT_ORDER_MAX,
  CATEGORY_URL_MAX_LENGTH,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
} from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upperCase = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
/** An empty text means "none": the field is cleared. */
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

/** The fields a category can be given or changed to; each is optional, null clears the optional ones. */
class CategoryFieldsDto {
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(CATEGORY_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsIn(CATEGORY_ICONS)
  icon?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(CATEGORY_SORT_ORDER_MAX)
  sortOrder?: number;

  @IsOptional()
  @Transform(emptyToNull)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(CATEGORY_URL_MAX_LENGTH)
  externalUrl?: string | null;
}

export class CreateCategoryDto extends CategoryFieldsDto {
  @Transform(trim)
  @IsString()
  @MinLength(ORGANIZATION_NAME_MIN_LENGTH)
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  name!: string;

  /** Becomes part of every document code of the category and is never changed afterwards. */
  @Transform(upperCase)
  @IsString()
  @Matches(CATEGORY_PREFIX_PATTERN)
  codePrefix!: string;

  @IsOptional()
  @IsBoolean()
  isExternal?: boolean;
}

/** No prefix, no slug, no external flag: whoever sends one is told so (unknown fields are refused). */
export class UpdateCategoryDto extends CategoryFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(ORGANIZATION_NAME_MIN_LENGTH)
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
