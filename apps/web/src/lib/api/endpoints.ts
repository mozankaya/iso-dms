import type { AuthResponseDto, CategoryDto, DashboardStatsDto } from "@iso-dms/shared";
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
