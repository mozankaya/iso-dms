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

export interface DashboardStatsDto {
  totalDocuments: number;
}
