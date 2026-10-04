import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/** Signs the editor configuration and verifies the callbacks of the ONLYOFFICE document server. */
@Injectable()
export class OnlyOfficeJwtService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  sign(payload: Record<string, unknown>): Promise<string> {
    return this.jwt.signAsync(payload, { secret: this.secret() });
  }

  /**
   * Verifies a token sent by the document server and returns the data it carries. The server puts the
   * token in the Authorization header (data nested under "payload") or, depending on its settings, in the
   * body (data at the top level). The verified data is the only thing callers should trust.
   */
  async verifyCallback(
    authorizationHeader: string | undefined,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headerToken = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice(7) : undefined;
    const token = headerToken ?? (typeof body.token === 'string' ? body.token : undefined);
    if (!token) throw this.invalid();

    try {
      const decoded = await this.jwt.verifyAsync<Record<string, unknown>>(token, { secret: this.secret() });
      const nested = decoded.payload;
      return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : decoded;
    } catch {
      throw this.invalid();
    }
  }

  private invalid(): ForbiddenException {
    return new ForbiddenException({ code: 'INVALID_EDITOR_TOKEN', message: 'Invalid editor token' });
  }

  private secret(): string {
    return this.config.getOrThrow<string>('ONLYOFFICE_JWT_SECRET');
  }
}
