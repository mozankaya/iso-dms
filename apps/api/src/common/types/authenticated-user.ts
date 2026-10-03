import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/enums';

/** Claims carried in the access token. */
export interface AccessTokenPayload {
  sub: string;
  organizationId: string;
  role: UserRole;
  departmentId: string | null;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  role: UserRole;
  departmentId: string | null;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
