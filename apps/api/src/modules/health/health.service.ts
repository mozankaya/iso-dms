import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { HealthDto, HealthState } from '@iso-dms/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS_ENABLED } from '../jobs/jobs.module';
import { StorageService } from '../storage/storage.service';

const CHECK_TIMEOUT_MS = 3000;

/** Whether the parts the application stands on answer (PROJECT.md 11.1). Nothing here says why one does not. */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthDto> {
    const [database, storage, redis, editor] = await Promise.all([
      this.run(() => this.prisma.$queryRaw`SELECT 1`),
      this.run(() => this.storage.ping()),
      JOBS_ENABLED ? this.run(() => this.pingRedis()) : Promise.resolve<HealthState>('disabled'),
      this.run(() => this.pingEditor()),
    ]);

    // Without the database or the files nothing works; a queue or editor that is down only takes features away
    const status = database === 'down' || storage === 'down' ? 'down' : redis === 'down' || editor === 'down' ? 'degraded' : 'ok';
    return { status, checks: { database, storage, redis, editor } };
  }

  private async run(check: () => Promise<unknown>): Promise<HealthState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }

  private async pingRedis(): Promise<void> {
    const client = new Redis(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
      lazyConnect: true,
      connectTimeout: CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    // A failed connection is also reported through this event; without a listener it would be thrown unhandled
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
    } finally {
      client.disconnect();
    }
  }

  private async pingEditor(): Promise<void> {
    const base = this.config.get<string>('ONLYOFFICE_INTERNAL_URL', 'http://localhost:8080').replace(/\/+$/, '');
    const response = await fetch(`${base}/healthcheck`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok || (await response.text()).trim() !== 'true') throw new Error('editor not ready');
  }
}
