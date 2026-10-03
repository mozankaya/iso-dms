import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '../../src/generated/prisma/enums';

/** Mints an access token directly, so tests do not depend on the login flow or its rate limit. */
export function signToken(
  app: INestApplication,
  claims: { userId: string; organizationId: string; role: UserRole; departmentId: string | null },
): Promise<string> {
  return app.get(JwtService).signAsync(
    {
      sub: claims.userId,
      organizationId: claims.organizationId,
      role: claims.role,
      departmentId: claims.departmentId,
    },
    { secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 300 },
  );
}
