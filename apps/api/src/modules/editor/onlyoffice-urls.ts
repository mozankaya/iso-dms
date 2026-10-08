import type { ConfigService } from '@nestjs/config';

/**
 * The document server reports its own address (the one the browser knows); the API may only fetch from the
 * configured origins, and always through the internal one. Anything else is refused (SSRF protection).
 */
export function toInternalOnlyOfficeUrl(config: ConfigService, reported: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(reported);
  } catch {
    return null;
  }

  const internal = new URL(config.get<string>('ONLYOFFICE_INTERNAL_URL', 'http://localhost:8080'));
  const publicUrl = new URL(config.get<string>('ONLYOFFICE_PUBLIC_URL', 'http://localhost:8080'));
  if (parsed.origin !== internal.origin && parsed.origin !== publicUrl.origin) return null;

  return `${internal.origin}${parsed.pathname}${parsed.search}`;
}
