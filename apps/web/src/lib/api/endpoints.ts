import type {
  AuthResponseDto,
  CategoryDto,
  DashboardStatsDto,
  DepartmentDto,
  DocumentListItemDto,
  DocumentListQuery,
  PaginatedDto,
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
