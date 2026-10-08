import { DEFAULT_PAGE_SIZE, USER_ROLES, USER_STATUS_FILTERS, type AdminUserListQuery, type UserRole, type UserStatusFilter } from "@iso-dms/shared";

/** User list state kept in the URL, so a view survives reloads and can be shared. */
export interface UserListParams {
  q: string;
  role: UserRole | "";
  department: string;
  status: UserStatusFilter;
  page: number;
}

export const DEFAULT_USER_PARAMS: UserListParams = { q: "", role: "", department: "", status: "all", page: 1 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the state from a query string. Invalid values fall back to the defaults. */
export function parseUserParams(searchParams: { get(name: string): string | null }): UserListParams {
  const page = Number(searchParams.get("page"));
  const role = searchParams.get("role") ?? "";
  const department = searchParams.get("department") ?? "";
  const status = searchParams.get("status");
  return {
    q: (searchParams.get("q") ?? "").trim(),
    role: USER_ROLES.includes(role as UserRole) ? (role as UserRole) : "",
    department: UUID_PATTERN.test(department) ? department : "",
    status: USER_STATUS_FILTERS.includes(status as UserStatusFilter) ? (status as UserStatusFilter) : DEFAULT_USER_PARAMS.status,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Builds the query string ("" or "?a=b") containing only values that differ from the defaults. */
export function toUserSearchString(params: UserListParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.role) search.set("role", params.role);
  if (params.department) search.set("department", params.department);
  if (params.status !== DEFAULT_USER_PARAMS.status) search.set("status", params.status);
  if (params.page > 1) search.set("page", String(params.page));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toUserQuery(params: UserListParams): AdminUserListQuery {
  return {
    search: params.q || undefined,
    role: params.role || undefined,
    departmentId: params.department || undefined,
    status: params.status,
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveUserFilters(params: UserListParams): boolean {
  return Boolean(params.q || params.role || params.department || params.status !== DEFAULT_USER_PARAMS.status);
}
