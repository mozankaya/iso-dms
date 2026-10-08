import { DEPARTMENT_CODE_PATTERN, ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_NAME_MIN_LENGTH } from '@iso-dms/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upperCase = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class CreateDepartmentDto {
  @Transform(trim)
  @IsString()
  @MinLength(ORGANIZATION_NAME_MIN_LENGTH)
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH)
  name!: string;

  /** Becomes part of every document code of the department and is never changed afterwards. */
  @Transform(upperCase)
  @IsString()
  @Matches(DEPARTMENT_CODE_PATTERN)
  code!: string;
}

/** No code here: whoever sends one is told so (unknown fields are refused). */
export class UpdateDepartmentDto {
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
