export const USER_ROLES = ['ADMIN', 'QUALITY_MANAGER', 'APPROVER', 'EDITOR', 'READER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface SessionUserDto {
  id: string;
  organizationId: string;
  departmentId: string | null;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface AuthResponseDto {
  accessToken: string;
  user: SessionUserDto;
}

/** Shape of every API error body. `code` is a machine-readable English code. */
export interface ApiErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
}
