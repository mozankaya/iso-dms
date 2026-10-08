import type { DepartmentDto, PersonDto } from './documents';
import type { ListPeriod } from './lists';

/** Which feedback a list shows. */
export const FEEDBACK_STATUS_FILTERS = ['open', 'resolved', 'all'] as const;
export type FeedbackStatusFilter = (typeof FEEDBACK_STATUS_FILTERS)[number];

export const FEEDBACK_MIN_LENGTH = 3;
export const FEEDBACK_MAX_LENGTH = 2000;

/** One user may send this many feedbacks per minute (PROJECT.md 6.8). */
export const FEEDBACK_RATE_LIMIT_PER_MINUTE = 5;

export interface FeedbackDto {
  id: string;
  message: string;
  /** ISO 8601 */
  createdAt: string;
  user: PersonDto & { department: DepartmentDto | null };
  document: { id: string; code: string; title: string };
  /** The revision in force when it was sent, null when none was */
  revisionNo: number | null;
  isResolved: boolean;
  /** Set while the feedback is closed; empty again once it is reopened */
  resolvedAt: string | null;
  resolvedBy: PersonDto | null;
  resolutionNote: string | null;
}

export interface FeedbackQuery {
  status?: FeedbackStatusFilter;
  departmentId?: string;
  search?: string;
  period?: ListPeriod;
  page?: number;
  pageSize?: number;
}

export interface SendFeedbackRequest {
  message: string;
}

/** What the sender gets back: the feedback itself is for the quality managers. */
export interface SentFeedbackDto {
  id: string;
  createdAt: string;
}

export interface ResolveFeedbackRequest {
  /** How it was handled; optional */
  note?: string;
}
