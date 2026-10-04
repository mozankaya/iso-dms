import type { DocumentDetailDto, DocumentListItemDto, RevisionHistoryItemDto } from "@iso-dms/shared";

export function documentListItem(overrides: Partial<DocumentListItemDto> = {}): DocumentListItemDto {
  return {
    id: "doc-1",
    code: "PR-KK-001",
    title: "Doküman Kontrol Prosedürü",
    fileType: "DOCX",
    status: "PUBLISHED",
    categoryId: "cat-pr",
    department: { id: "dep-kk", name: "Kalite Koordinatörlüğü", code: "KK" },
    firstPublishedAt: "2025-01-10T09:00:00.000Z",
    revisedAt: "2025-06-01T09:00:00.000Z",
    revisionNo: 2,
    canEdit: false,
    ...overrides,
  };
}

export function documentDetail(overrides: Partial<DocumentDetailDto> = {}): DocumentDetailDto {
  return {
    ...documentListItem(),
    openRevision: { id: "rev-2", revisionNo: 2, status: "APPROVED" },
    category: { id: "cat-pr", name: "Prosedürler", slug: "procedures" },
    owner: { id: "user-1", fullName: "Ece Editör" },
    currentRevisionId: "rev-2",
    reviewIntervalMonths: 12,
    nextReviewAt: "2026-06-01T09:00:00.000Z",
    retentionYears: 5,
    withdrawnAt: null,
    withdrawalReason: null,
    createdAt: "2024-12-01T09:00:00.000Z",
    ...overrides,
  };
}

export function revisionRow(overrides: Partial<RevisionHistoryItemDto> = {}): RevisionHistoryItemDto {
  return {
    id: "rev-2",
    revisionNo: 2,
    status: "APPROVED",
    isCurrent: true,
    preparedBy: { id: "user-1", fullName: "Ece Editör" },
    approvedBy: { id: "user-2", fullName: "Onur Onaylayıcı" },
    approvedAt: "2025-05-30T09:00:00.000Z",
    publishedAt: "2025-06-01T09:00:00.000Z",
    createdAt: "2025-05-20T09:00:00.000Z",
    changeSummary: "Madde 3 güncellendi",
    fileSize: 24576,
    canEdit: false,
    ...overrides,
  };
}
