const REQUIRED_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'FILE_TOKEN_SECRET',
  'ONLYOFFICE_JWT_SECRET',
];
const SECRET_VARIABLES = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FILE_TOKEN_SECRET', 'ONLYOFFICE_JWT_SECRET', 'S3_SECRET_KEY'];

/** A secret shorter than this is guessable: production refuses it (`openssl rand -hex 24` makes 48). */
export const MIN_SECRET_LENGTH = 24;

/**
 * Addresses the browser uses. They have to be https in production: the refresh cookie is `Secure` (a browser
 * drops it over http, so nobody could stay logged in) and the editor is loaded into an https page.
 */
const BROWSER_URL_VARIABLES = ['WEB_URL', 'ONLYOFFICE_PUBLIC_URL'];

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_VARIABLES.filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  if (config.NODE_ENV === 'production') {
    const problems: string[] = [];

    const insecure = SECRET_VARIABLES.filter((name) => String(config[name] ?? '').startsWith('change-me'));
    if (insecure.length > 0) problems.push(`Insecure default secrets: ${insecure.join(', ')}`);

    const short = SECRET_VARIABLES.filter((name) => {
      const value = String(config[name] ?? '');
      return value !== '' && !value.startsWith('change-me') && value.length < MIN_SECRET_LENGTH;
    });
    if (short.length > 0) problems.push(`Secrets shorter than ${MIN_SECRET_LENGTH} characters: ${short.join(', ')}`);

    const accessSecret = String(config.JWT_ACCESS_SECRET ?? '');
    if (accessSecret !== '' && accessSecret === String(config.JWT_REFRESH_SECRET ?? '')) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }

    const notHttps = BROWSER_URL_VARIABLES.filter((name) => !String(config[name] ?? '').startsWith('https://'));
    if (notHttps.length > 0) problems.push(`Must be https:// addresses in production: ${notHttps.join(', ')}`);

    if (problems.length > 0) throw new Error(`Unsafe production configuration. ${problems.join('. ')}`);
  }

  return config;
}
