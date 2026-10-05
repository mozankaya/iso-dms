import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PublishRevisionDto {
  /** Required from the second revision on (PROJECT.md 6.2 rule 6); checked by the service. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  changeSummary?: string;
}
