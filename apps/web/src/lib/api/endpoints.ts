import type {
  AuthResponseDto,
  CategoryDto,
  CreateDocumentRequest,
  DashboardStatsDto,
  DepartmentDto,
  DocumentListItemDto,
  DocumentListQuery,
  FileType,
  PaginatedDto,
  TemplateDto,
} from "@iso-dms/shared";
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
