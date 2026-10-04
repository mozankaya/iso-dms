const REQUIRED_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'FILE_TOKEN_SECRET',
  'ONLYOFFICE_JWT_SECRET',
];
const SECRET_VARIABLES = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FILE_TOKEN_SECRET', 'ONLYOFFICE_JWT_SECRET'];

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_VARIABLES.filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  if (config.NODE_ENV === 'production') {
    const insecure = SECRET_VARIABLES.filter((name) => String(config[name]).startsWith('change-me'));
    if (insecure.length > 0) {
      throw new Error(`Insecure default secrets in production: ${insecure.join(', ')}`);
    }
  }

  return config;
}
