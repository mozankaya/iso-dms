import { validateEnv } from '../src/config/env.validation';

const other = (letter: string) => letter.repeat(48);

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@postgres:5432/db',
  JWT_ACCESS_SECRET: other('b'),
  JWT_REFRESH_SECRET: other('c'),
  FILE_TOKEN_SECRET: other('d'),
  ONLYOFFICE_JWT_SECRET: other('e'),
  S3_SECRET_KEY: other('f'),
  WEB_URL: 'https://kalite.example.com',
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
};

describe('validateEnv', () => {
  it('needs the database and the secrets in every environment', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, FILE_TOKEN_SECRET, ONLYOFFICE_JWT_SECRET/);
  });

  it('lets a development setup with the example secrets and http addresses through', () => {
    const config = {
      NODE_ENV: 'development',
      DATABASE_URL: 'x',
      JWT_ACCESS_SECRET: 'change-me',
      JWT_REFRESH_SECRET: 'change-me',
      FILE_TOKEN_SECRET: 'change-me',
      ONLYOFFICE_JWT_SECRET: 'change-me',
      WEB_URL: 'http://localhost:3000',
    };
    expect(validateEnv(config)).toBe(config);
  });

  it('accepts a complete production setup', () => {
    expect(validateEnv(production)).toBe(production);
  });

  it('refuses the example secrets in production, the storage secret included', () => {
    expect(() => validateEnv({ ...production, JWT_ACCESS_SECRET: 'change-me' })).toThrow(/Insecure default secrets: JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ ...production, S3_SECRET_KEY: 'change-me-please' })).toThrow(/Insecure default secrets: S3_SECRET_KEY/);
    expect(() => validateEnv({ ...production, S3_SECRET_KEY: undefined })).not.toThrow();
  });

  it('refuses secrets that are too short to be safe', () => {
    expect(() => validateEnv({ ...production, FILE_TOKEN_SECRET: 'short-secret' })).toThrow(/shorter than 24 characters: FILE_TOKEN_SECRET/);
  });

  it('refuses the same secret for access and refresh tokens', () => {
    expect(() => validateEnv({ ...production, JWT_REFRESH_SECRET: production.JWT_ACCESS_SECRET })).toThrow(/must differ/);
  });

  it('wants https addresses for the browser in production, the cookie and the editor depend on it', () => {
    expect(() => validateEnv({ ...production, WEB_URL: 'http://kalite.example.com' })).toThrow(/https:\/\/ addresses in production: WEB_URL/);
    expect(() => validateEnv({ ...production, ONLYOFFICE_PUBLIC_URL: undefined })).toThrow(/ONLYOFFICE_PUBLIC_URL/);
  });

  it('reports every problem at once', () => {
    expect(() => validateEnv({ ...production, JWT_ACCESS_SECRET: 'change-me', WEB_URL: 'http://x' })).toThrow(/Insecure default secrets.*Must be https/);
  });
});
