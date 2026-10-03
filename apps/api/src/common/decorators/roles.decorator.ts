import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/enums';

export const ROLES_KEY = 'roles';

/** Restricts a route to the listed roles. Roles are explicit, there is no implicit hierarchy. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
