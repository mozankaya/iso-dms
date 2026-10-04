import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

export type FileTokenPurpose = 'download' | 'callback';

export interface FileTokenPayload {
  purpose: FileTokenPurpose;
  revisionId: string;
  organizationId: string;
}

/** The document server fetches the file right after the editor opens: a short window is enough. */
const DOWNLOAD_TTL_SECONDS = 15 * 60;
/**
 * The callback URL is fixed when the editor opens and used until the last user leaves, which can take
 * hours. The token alone does not authorise anything: every callback must also carry a valid ONLYOFFICE JWT.
 */
const CALLBACK_TTL_SECONDS = 24 * 60 * 60;

/** Signed, short-lived tokens in the URLs handed to the document server (PROJECT.md 7.3). */
@Injectable()
export class FileTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  sign(payload: FileTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.secret(),
      expiresIn: payload.purpose === 'download' ? DOWNLOAD_TTL_SECONDS : CALLBACK_TTL_SECONDS,
    });
  }

  /** Verifies signature, expiry, purpose and the revision the token was issued for. */
  async verify(token: string | undefined, purpose: FileTokenPurpose, revisionId: string): Promise<FileTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<FileTokenPayload>(token ?? '', { secret: this.secret() });
      if (payload.purpose === purpose && payload.revisionId === revisionId) return payload;
    } catch {
      // fall through: do not reveal why the token was refused
    }
    throw new ForbiddenException({ code: 'INVALID_FILE_TOKEN', message: 'Invalid or expired file token' });
  }

  private secret(): string {
    return this.config.getOrThrow<string>('FILE_TOKEN_SECRET');
  }
}
