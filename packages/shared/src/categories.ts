export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  codePrefix: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  isExternal: boolean;
  externalUrl: string | null;
  /** Number of published documents in the category */
  documentCount: number;
}

/** Counters of the dashboard. A counter is null when the user's role has no business with it. */
export interface DashboardStatsDto {
  /** Published documents */
  totalDocuments: number;
  /** Documents first published in the last 30 days (still in force) */
  newlyPublished: number;
  /** Documents whose revision in force was published in the last 30 days */
  revised: number;
  /** Documents withdrawn in the last 30 days; null for readers, who never see withdrawn documents */
  withdrawn: number | null;
  /** Approval steps waiting for the user; null unless the role holds approval steps */
  awaitingApproval: number | null;
  /** Feedback nobody has closed yet; null unless the role reads feedback (quality managers, administrators) */
  openFeedback: number | null;
}
