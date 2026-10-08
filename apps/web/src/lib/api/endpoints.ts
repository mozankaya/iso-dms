import type {
  AdminCategoryDto,
  AdminDepartmentDto,
  AdminTemplateDto,
  AdminUserDto,
  AuditLogPage,
  AuditLogQuery,
  AuthResponseDto,
  CategoryDto,
  CreateCategoryRequest,
  CreateDepartmentRequest,
  CreateDocumentRequest,
  CreateUserRequest,
  DashboardStatsDto,
  DepartmentDto,
  DocumentDetailDto,
  DocumentListItemDto,
  DocumentListQuery,
  EditorSessionDto,
  FeedbackDto,
  FeedbackQuery,
  FileType,
  NotificationDto,
  NotificationListQuery,
  PaginatedDto,
  PdfStatus,
  PendingApprovalDto,
  PublicationListItemDto,
  PublicationListKind,
  PublicationListQuery,
  RevisionHistoryItemDto,
  SentFeedbackDto,
  TemplateDto,
  UpdateCategoryRequest,
  UpdateDepartmentRequest,
  UpdateTemplateRequest,
  UpdateUserRequest,
  UserWithPasswordDto,
  AdminUserListQuery,
  ResetPasswordRequest,
  ReviewDueItemDto,
  ReviewDueQuery,
  ChangePasswordRequest,
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
  revisionPdf: (revisionId: string) => `/revisions/${encodeURIComponent(revisionId)}/download?format=pdf`,
  currentPdf: (documentId: string) => `/documents/${encodeURIComponent(documentId)}/download?format=pdf`,
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

export function getAdminDepartments(): Promise<AdminDepartmentDto[]> {
  return apiFetch<AdminDepartmentDto[]>("/departments/overview");
}

export function createDepartment(request: CreateDepartmentRequest): Promise<AdminDepartmentDto> {
  return apiFetch<AdminDepartmentDto>("/departments", { method: "POST", body: JSON.stringify(request) });
}

export function updateDepartment(id: string, request: UpdateDepartmentRequest): Promise<AdminDepartmentDto> {
  return apiFetch<AdminDepartmentDto>(`/departments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(request) });
}

export function getAdminCategories(): Promise<AdminCategoryDto[]> {
  return apiFetch<AdminCategoryDto[]>("/categories/overview");
}

export function createCategory(request: CreateCategoryRequest): Promise<AdminCategoryDto> {
  return apiFetch<AdminCategoryDto>("/categories", { method: "POST", body: JSON.stringify(request) });
}

export function updateCategory(id: string, request: UpdateCategoryRequest): Promise<AdminCategoryDto> {
  return apiFetch<AdminCategoryDto>(`/categories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(request) });
}

export function getAdminUsers(query: AdminUserListQuery): Promise<PaginatedDto<AdminUserDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return apiFetch<PaginatedDto<AdminUserDto>>(`/users${text ? `?${text}` : ""}`);
}

export function createUser(request: CreateUserRequest): Promise<UserWithPasswordDto> {
  return apiFetch<UserWithPasswordDto>("/users", { method: "POST", body: JSON.stringify(request) });
}

export function updateUser(id: string, request: UpdateUserRequest): Promise<AdminUserDto> {
  return apiFetch<AdminUserDto>(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(request) });
}

export function resetUserPassword(id: string, request: ResetPasswordRequest): Promise<UserWithPasswordDto> {
  return apiFetch<UserWithPasswordDto>(`/users/${encodeURIComponent(id)}/reset-password`, { method: "POST", body: JSON.stringify(request) });
}

export function changePassword(request: ChangePasswordRequest): Promise<AuthResponseDto> {
  return apiFetch<AuthResponseDto>("/auth/password", { method: "PATCH", body: JSON.stringify(request) });
}

export function getAdminTemplates(): Promise<AdminTemplateDto[]> {
  return apiFetch<AdminTemplateDto[]>("/templates/overview");
}

export function createTemplate(request: { name: string; categoryId: string | null; isDefault: boolean; file: File }): Promise<AdminTemplateDto> {
  const body = new FormData();
  body.set("name", request.name);
  body.set("categoryId", request.categoryId ?? "");
  body.set("isDefault", String(request.isDefault));
  body.set("file", request.file);
  return apiFetch<AdminTemplateDto>("/templates", { method: "POST", body });
}

export function updateTemplate(id: string, request: UpdateTemplateRequest): Promise<AdminTemplateDto> {
  return apiFetch<AdminTemplateDto>(`/templates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(request) });
}

export function replaceTemplateFile(id: string, file: File): Promise<AdminTemplateDto> {
  const body = new FormData();
  body.set("file", file);
  return apiFetch<AdminTemplateDto>(`/templates/${encodeURIComponent(id)}/file`, { method: "PUT", body });
}

export function deleteTemplate(id: string): Promise<true> {
  return apiFetch<void>(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => true as const);
}

export const templateDownloadPath = (id: string) => `/templates/${encodeURIComponent(id)}/download`;

/** Asks for the PDF copy of a published revision again (quality managers and administrators). */
export function requestRevisionPdf(revisionId: string): Promise<{ id: string; pdfStatus: PdfStatus }> {
  return apiFetch<{ id: string; pdfStatus: PdfStatus }>(`/revisions/${encodeURIComponent(revisionId)}/pdf`, { method: "POST" });
}

export function getNotifications(query: NotificationListQuery): Promise<PaginatedDto<NotificationDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return apiFetch<PaginatedDto<NotificationDto>>(`/notifications${text ? `?${text}` : ""}`);
}

export function getUnreadNotificationCount(): Promise<{ count: number }> {
  return apiFetch<{ count: number }>("/notifications/unread-count");
}

export function markNotificationRead(id: string): Promise<NotificationDto> {
  return apiFetch<NotificationDto>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
}

export function markAllNotificationsRead(): Promise<{ count: number }> {
  return apiFetch<{ count: number }>("/notifications/read-all", { method: "POST" });
}

export function getReviewDueList(query: ReviewDueQuery): Promise<PaginatedDto<ReviewDueItemDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return apiFetch<PaginatedDto<ReviewDueItemDto>>(`/lists/review-due${text ? `?${text}` : ""}`);
}

export function updateReviewSettings(documentId: string, intervalMonths: number | null): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/documents/${encodeURIComponent(documentId)}/review-settings`, {
    method: "PATCH",
    body: JSON.stringify({ intervalMonths }),
  });
}

export function markDocumentReviewed(documentId: string, note?: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/documents/${encodeURIComponent(documentId)}/review`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}
