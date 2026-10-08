/** Messages to a user (PROJECT.md 6.13). */
export const NOTIFICATION_TYPES = ['APPROVAL_STEP_WAITING', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'REVIEW_DUE'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUS_FILTERS = ['all', 'unread'] as const;
export type NotificationStatusFilter = (typeof NOTIFICATION_STATUS_FILTERS)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  /** Turkish, written by the server (the same text goes into the e-mail) */
  title: string;
  body: string;
  /** Path in the web application */
  link: string;
  isRead: boolean;
  /** ISO 8601 */
  createdAt: string;
}

export interface NotificationListQuery {
  status?: NotificationStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface UnreadCountDto {
  count: number;
}
