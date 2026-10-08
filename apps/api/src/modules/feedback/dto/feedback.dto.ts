import {
  DEFAULT_PAGE_SIZE,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
  FEEDBACK_STATUS_FILTERS,
  LIST_PERIODS,
  MAX_PAGE_SIZE,
  type FeedbackStatusFilter,
  type ListPeriod,
} from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SendFeedbackDto {
  @Transform(trim)
  @IsString()
  @MinLength(FEEDBACK_MIN_LENGTH)
  @MaxLength(FEEDBACK_MAX_LENGTH)
  message!: string;
}

export class ResolveFeedbackDto {
  /** How the feedback was handled; optional. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(FEEDBACK_MAX_LENGTH)
  note?: string;
}

export class ListFeedbackDto {
  @IsOptional()
  @IsIn(FEEDBACK_STATUS_FILTERS)
  status: FeedbackStatusFilter = 'open';

  @IsOptional()
  @IsIn(LIST_PERIODS)
  period: ListPeriod = 'all';

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}
