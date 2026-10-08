import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { HealthDto } from '@iso-dms/shared';
import { StorageService } from '../src/modules/storage/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-test-app';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const health = () => request(app.getHttpServer()).get('/api/health');

describe('GET /api/health', () => {
  it('answers without a login and says what is up', async () => {
    const response = await health();
    const body = response.body as HealthDto;

    expect(response.status).toBe(200);
    expect(body.checks).toMatchObject({ database: 'up', storage: 'up', redis: 'disabled' });
    // The editor is a separate server: this test does not depend on it being started
    expect(['ok', 'degraded']).toContain(body.status);
    expect(['up', 'down']).toContain(body.checks.editor);
  });

  it('says nothing but the states', async () => {
    const body = (await health()).body as HealthDto;
    expect(Object.keys(body).sort()).toEqual(['checks', 'status']);
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'editor', 'redis', 'storage']);
  });

  it('answers 503 when the files cannot be reached, and tells which part is down', async () => {
    jest.spyOn(app.get(StorageService), 'ping').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:9000'));

    const response = await health();

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'down', checks: { storage: 'down', database: 'up' } });
    // Nothing of the error leaks
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
  });

  it('answers 503 when the database cannot be reached', async () => {
    jest.spyOn(app.get(PrismaService), '$queryRaw').mockRejectedValue(new Error('database down') as never);

    const response = await health();

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'down', checks: { database: 'down' } });
  });

  it('is not held up for ever by a part that does not answer', async () => {
    jest.spyOn(app.get(StorageService), 'ping').mockImplementation(() => new Promise<void>(() => undefined));

    const started = Date.now();
    const response = await health();

    expect(response.body).toMatchObject({ status: 'down', checks: { storage: 'down' } });
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('is not limited by the rate limit', async () => {
    // More than the 200 a minute the other endpoints get from one address
    const server = request(app.getHttpServer());
    for (let i = 0; i < 210; i++) {
      const response = await server.get('/api/health');
      if (response.status !== 200) throw new Error(`request ${i + 1} answered ${response.status}`);
    }
  });
});
