import { REVIEW_INTERVAL_MAX_MONTHS, REVIEW_INTERVAL_MIN_MONTHS, REVIEW_NOTE_MAX_LENGTH } from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class UpdateReviewSettingsDto {
  /** Months between reviews; null removes the periodic review. Must be sent: a missing value is a mistake. */
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(REVIEW_INTERVAL_MIN_MONTHS)
  @Max(REVIEW_INTERVAL_MAX_MONTHS)
  intervalMonths!: number | null;
}

export class MarkReviewedDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(REVIEW_NOTE_MAX_LENGTH)
  note?: string;
}
