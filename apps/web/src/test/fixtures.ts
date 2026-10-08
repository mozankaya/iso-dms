import type { AuditLogDto, DocumentDetailDto, DocumentListItemDto, RevisionHistoryItemDto } from "@iso-dms/shared";

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
    pdfStatus: "READY",
    canEdit: false,
    ...overrides,
  };
}

export function documentDetail(overrides: Partial<DocumentDetailDto> = {}): DocumentDetailDto {
  return {
    ...documentListItem(),
    openRevision: { id: "rev-2", revisionNo: 2, status: "APPROVED", changeSummary: "Madde 3 güncellendi" },
    category: { id: "cat-pr", name: "Prosedürler", slug: "procedures" },
    owner: { id: "user-1", fullName: "Ece Editör" },
    currentRevisionId: "rev-2",
    reviewIntervalMonths: 12,
    lastReviewedAt: "2025-06-01T09:00:00.000Z",
    nextReviewAt: "2026-06-01T09:00:00.000Z",
    retentionYears: 5,
    withdrawnAt: null,
    withdrawalReason: null,
    createdAt: "2024-12-01T09:00:00.000Z",
    canSubmit: false,
    canCancelRevision: false,
    approval: null,
    canStartRevision: false,
    canRequestWithdrawal: false,
    canSendFeedback: true,
    canMarkReviewed: false,
    canSetReviewInterval: false,
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
    pdfStatus: "READY",
    canEdit: false,
    ...overrides,
  };
}

export function auditLogEntry(overrides: Partial<AuditLogDto> = {}): AuditLogDto {
  return {
    id: "audit-1",
    action: "DOCUMENT_OPENED",
    entityType: "Document",
    entityId: "doc-1",
    createdAt: "2025-06-01T09:30:00.000Z",
    user: { id: "user-1", fullName: "Ece Editör", email: "ece@example.com" },
    document: { id: "doc-1", code: "PR-KK-001", title: "Doküman Kontrol Prosedürü", revisionNo: null },
    metadata: { mode: "edit", revisionNo: 2 },
    ipAddress: null,
    ...overrides,
  };
}
