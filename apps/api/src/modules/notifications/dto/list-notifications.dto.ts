import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, NOTIFICATION_STATUS_FILTERS, type NotificationStatusFilter } from '@iso-dms/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListNotificationsDto {
  @IsOptional()
  @IsIn(NOTIFICATION_STATUS_FILTERS)
  status: NotificationStatusFilter = 'all';

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
