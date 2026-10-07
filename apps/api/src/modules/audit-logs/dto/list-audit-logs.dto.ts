import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AuditAction,
  type AuditEntityType,
} from '@iso-dms/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ListAuditLogsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: AuditAction;

  @IsOptional()
  @IsIn(AUDIT_ENTITY_TYPES)
  entityType?: AuditEntityType;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Matches(CALENDAR_DAY)
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @Matches(CALENDAR_DAY)
  @IsISO8601({ strict: true })
  to?: string;

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
