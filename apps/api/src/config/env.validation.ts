const REQUIRED_VARIABLES = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_VARIABLES.filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  if (config.NODE_ENV === 'production') {
    const insecure = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].filter(
      (name) => String(config[name]).startsWith('change-me'),
    );
    if (insecure.length > 0) {
      throw new Error(`Insecure default secrets in production: ${insecure.join(', ')}`);
    }
  }

  return config;
}
