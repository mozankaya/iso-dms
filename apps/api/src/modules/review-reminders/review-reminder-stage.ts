import type { ReviewReminderStage } from '../notifications/notification-texts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReminderMoment {
  stage: ReviewReminderStage;
  /** Tells the reminders of one due date apart: each one is sent once per recipient */
  key: string;
  /** Whole days past the due date; 0 before it */
  overdueDays: number;
}

/**
 * Which reminder a document is at on a given day (PROJECT.md 6.5): 30 days before the due date, 7 days before, on the
 * due day (and the following days of that week), then once a week for as long as it is overdue. A reminder of a stage
 * is sent once, so a job that runs every day does not repeat itself, and one that missed days sends what is current.
 * Null when the review is more than 30 days away.
 */
export function reminderMoment(nextReviewAt: Date, now: Date): ReminderMoment | null {
  const remainingMs = nextReviewAt.getTime() - now.getTime();
  if (remainingMs > 30 * DAY_MS) return null;
  if (remainingMs > 7 * DAY_MS) return { stage: 'IN_30_DAYS', key: 'D30', overdueDays: 0 };
  if (remainingMs > 0) return { stage: 'IN_7_DAYS', key: 'D7', overdueDays: 0 };

  const overdueDays = Math.max(0, Math.floor(-remainingMs / DAY_MS));
  const week = Math.floor(overdueDays / 7);
  return { stage: week === 0 ? 'DUE' : 'OVERDUE', key: `W${week}`, overdueDays };
}

/** Past this many days overdue the quality management and the approvers of the department are told too. */
export const ESCALATION_AFTER_DAYS = 7;
