import type { DocumentListItemDto } from './documents';

/** The three publication lists (PROJECT.md 8: GET /lists/new, /lists/revised, /lists/withdrawn). */
export const PUBLICATION_LIST_KINDS = ['new', 'revised', 'withdrawn'] as const;
export type PublicationListKind = (typeof PUBLICATION_LIST_KINDS)[number];

/** How far back a list looks, in days; "all" has no limit. */
export const LIST_PERIODS = ['7', '30', '90', 'all'] as const;
export type ListPeriod = (typeof LIST_PERIODS)[number];

export const DEFAULT_LIST_PERIOD: ListPeriod = '30';

/** The dashboard counters always look this many days back. */
export const DASHBOARD_PERIOD_DAYS = 30;

export interface PublicationListItemDto extends DocumentListItemDto {
  /** ISO 8601; only set for withdrawn documents */
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

export interface PublicationListQuery {
  period?: ListPeriod;
  departmentId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}
