import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/enums';

/** Claims carried in the access token. */
export interface AccessTokenPayload {
  sub: string;
  organizationId: string;
  role: UserRole;
  departmentId: string | null;
  /** Only present while the user still has to replace a temporary password */
  mustChangePassword?: boolean;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  role: UserRole;
  departmentId: string | null;
  mustChangePassword?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
