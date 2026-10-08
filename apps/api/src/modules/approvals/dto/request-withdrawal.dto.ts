import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestWithdrawalDto {
  /** Required (PROJECT.md 6.2 rule 7); the service answers REASON_REQUIRED when it is empty. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
