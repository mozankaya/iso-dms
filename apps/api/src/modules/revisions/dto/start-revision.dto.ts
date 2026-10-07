import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StartRevisionDto {
  /** Required (PROJECT.md 6.2 rule 6); the service answers CHANGE_SUMMARY_REQUIRED when it is empty. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  changeSummary?: string;
}
