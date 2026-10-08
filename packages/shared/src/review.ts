/** Periodic review of documents in force (PROJECT.md 6.5). */
export const REVIEW_INTERVAL_MIN_MONTHS = 1;
export const REVIEW_INTERVAL_MAX_MONTHS = 120;
export const REVIEW_NOTE_MAX_LENGTH = 2000;

export interface UpdateReviewSettingsRequest {
  /** Months between reviews; null: the document has no periodic review */
  intervalMonths: number | null;
}

export interface MarkReviewedRequest {
  note?: string;
}
