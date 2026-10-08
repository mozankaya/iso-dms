import type { UserRole } from './auth';

/**
 * Administration of users (PROJECT.md 6.10). The password rules live here so the API and the forms of the
 * web app apply exactly the same ones.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const USER_NAME_MIN_LENGTH = 2;
export const USER_NAME_MAX_LENGTH = 100;
export const USER_EMAIL_MAX_LENGTH = 254;

export const USER_STATUS_FILTERS = ['all', 'active', 'inactive'] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

/** Roles that only make sense inside a department: they write and approve for their own unit. */
export const DEPARTMENT_REQUIRED_ROLES: readonly UserRole[] = ['EDITOR', 'APPROVER'];

export interface AdminUserDto {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  department: { id: string; name: string; code: string } | null;
  isActive: boolean;
  /** The user has to choose a password of their own at the next sign-in */
  mustChangePassword: boolean;
  /** ISO 8601, null before the first sign-in */
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserListQuery {
  search?: string;
  role?: UserRole;
  departmentId?: string;
  status?: UserStatusFilter;
  page?: number;
  pageSize?: number;
}

/** The email is the sign-in name and is not changed afterwards. */
export interface CreateUserRequest {
  fullName: string;
  email: string;
  role: UserRole;
  departmentId?: string | null;
  /** A password of the administrator's choice; one is generated when missing */
  password?: string;
}

export interface UpdateUserRequest {
  fullName?: string;
  role?: UserRole;
  departmentId?: string | null;
  isActive?: boolean;
}

/** The temporary password is shown once, to the administrator; it is only returned when the server generated it. */
export interface UserWithPasswordDto {
  user: AdminUserDto;
  temporaryPassword: string | null;
}

export interface ResetPasswordRequest {
  password?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
