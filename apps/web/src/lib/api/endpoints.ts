import type {
  AuditLogPage,
  AuditLogQuery,
  AuthResponseDto,
  CategoryDto,
  CreateDocumentRequest,
  DashboardStatsDto,
  DepartmentDto,
  DocumentDetailDto,
  DocumentListItemDto,
  DocumentListQuery,
  EditorSessionDto,
  FeedbackDto,
  FeedbackQuery,
  FileType,
  PaginatedDto,
  PendingApprovalDto,
  PublicationListItemDto,
  PublicationListKind,
  PublicationListQuery,
  RevisionHistoryItemDto,
  SentFeedbackDto,
  TemplateDto,
} from "@iso-dms/shared";
import { DEFAULT_PAGE_SIZE } from "@iso-dms/shared";
import { apiFetch, apiFetchPublic } from "./client";

export function login(email: string, password: string): Promise<AuthResponseDto> {
  return apiFetchPublic<AuthResponseDto>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return apiFetchPublic<void>("/auth/logout", { method: "POST" });
}

export function getCategories(): Promise<CategoryDto[]> {
  return apiFetch<CategoryDto[]>("/categories");
}

export function getDashboardStats(): Promise<DashboardStatsDto> {
  return apiFetch<DashboardStatsDto>("/dashboard/stats");
}

export function getDepartments(): Promise<DepartmentDto[]> {
  return apiFetch<DepartmentDto[]>("/departments");
}

export function getDocuments(query: DocumentListQuery): Promise<PaginatedDto<DocumentListItemDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return apiFetch<PaginatedDto<DocumentListItemDto>>(`/documents?${search.toString()}`);
}

export function getTemplates(query: { categoryId?: string; fileType?: FileType }): Promise<TemplateDto[]> {
  const search = new URLSearchParams();
  if (query.categoryId) search.set("categoryId", query.categoryId);
  if (query.fileType) search.set("fileType", query.fileType);
  return apiFetch<TemplateDto[]>(`/templates?${search.toString()}`);
}

export function createDocument(request: CreateDocumentRequest): Promise<DocumentListItemDto> {
  return apiFetch<DocumentListItemDto>("/documents", { method: "POST", body: JSON.stringify(request) });
}

export function uploadDocument(request: {
  categoryId: string;
  departmentId: string;
  title: string;
  file: File;
}): Promise<DocumentListItemDto> {
  const body = new FormData();
  body.set("categoryId", request.categoryId);
  body.set("departmentId", request.departmentId);
  body.set("title", request.title);
  body.set("file", request.file);
  return apiFetch<DocumentListItemDto>("/documents/upload", { method: "POST", body });
}

export function getPublicationList(kind: PublicationListKind, query: PublicationListQuery): Promise<PaginatedDto<PublicationListItemDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return apiFetch<PaginatedDto<PublicationListItemDto>>(`/lists/${kind}${text ? `?${text}` : ""}`);
}

export function getDocument(id: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/documents/${encodeURIComponent(id)}`);
}

export function getEditorSession(revisionId: string): Promise<EditorSessionDto> {
  return apiFetch<EditorSessionDto>(`/editor/config/${encodeURIComponent(revisionId)}`);
}

export function getRevisions(documentId: string): Promise<RevisionHistoryItemDto[]> {
  return apiFetch<RevisionHistoryItemDto[]>(`/documents/${encodeURIComponent(documentId)}/revisions`);
}

/** API paths of the two download endpoints (see lib/download.ts for saving the result). */
export const downloadPath = {
  revision: (revisionId: string) => `/revisions/${encodeURIComponent(revisionId)}/download`,
  current: (documentId: string) => `/documents/${encodeURIComponent(documentId)}/download`,
};

function auditQueryString(query: AuditLogQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function getAuditLogs(query: AuditLogQuery): Promise<AuditLogPage> {
  return apiFetch<AuditLogPage>(`/audit-logs${auditQueryString(query)}`);
}

export function getDocumentAuditLogs(documentId: string, query: AuditLogQuery): Promise<AuditLogPage> {
  return apiFetch<AuditLogPage>(`/documents/${encodeURIComponent(documentId)}/audit-logs${auditQueryString(query)}`);
}

export function startRevision(documentId: string, changeSummary: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/documents/${encodeURIComponent(documentId)}/revisions`, {
    method: "POST",
    body: JSON.stringify({ changeSummary }),
  });
}

export function submitRevision(revisionId: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/revisions/${encodeURIComponent(revisionId)}/submit`, { method: "POST" });
}

export function decideApproval(stepId: string, decision: "approve" | "reject", comment?: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/approvals/${encodeURIComponent(stepId)}/${decision}`, {
    method: "POST",
    body: JSON.stringify(comment ? { comment } : {}),
  });
}

export function sendFeedback(documentId: string, message: string): Promise<SentFeedbackDto> {
  return apiFetch<SentFeedbackDto>(`/documents/${encodeURIComponent(documentId)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function getFeedback(query: FeedbackQuery): Promise<PaginatedDto<FeedbackDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return apiFetch<PaginatedDto<FeedbackDto>>(`/feedback${text ? `?${text}` : ""}`);
}

export function resolveFeedback(id: string, note?: string): Promise<FeedbackDto> {
  return apiFetch<FeedbackDto>(`/feedback/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}

export function reopenFeedback(id: string): Promise<FeedbackDto> {
  return apiFetch<FeedbackDto>(`/feedback/${encodeURIComponent(id)}/reopen`, { method: "POST" });
}

export function requestWithdrawal(documentId: string, reason: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/documents/${encodeURIComponent(documentId)}/withdrawal-requests`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function cancelApprovalRequest(requestId: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/approval-requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST" });
}

export function cancelRevision(revisionId: string, reason: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/revisions/${encodeURIComponent(revisionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function getPendingApprovals(page = 1): Promise<PaginatedDto<PendingApprovalDto>> {
  return apiFetch<PaginatedDto<PendingApprovalDto>>(`/approvals/pending?page=${page}&pageSize=${DEFAULT_PAGE_SIZE}`);
}
