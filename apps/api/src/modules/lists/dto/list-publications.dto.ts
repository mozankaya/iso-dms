import { DEFAULT_LIST_PERIOD, DEFAULT_PAGE_SIZE, LIST_PERIODS, MAX_PAGE_SIZE, type ListPeriod } from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class ListPublicationsDto {
  @IsOptional()
  @IsIn(LIST_PERIODS)
  period: ListPeriod = DEFAULT_LIST_PERIOD;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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
