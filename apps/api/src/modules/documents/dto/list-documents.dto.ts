import {
  DEFAULT_PAGE_SIZE,
  DOCUMENT_SORT_FIELDS,
  DOCUMENT_STATUSES,
  MAX_PAGE_SIZE,
  SORT_ORDERS,
  type DocumentSortField,
  type DocumentStatus,
  type SortOrder,
} from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class ListDocumentsDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: DocumentStatus;

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

  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS)
  sortBy: DocumentSortField = 'code';

  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder: SortOrder = 'asc';
}
