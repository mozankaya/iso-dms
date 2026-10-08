import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Background jobs (PDF copies, notification e-mails, reminders) run on BullMQ and need Redis. This switch is
 * evaluated at import time (like the login rate limit), so tests can turn the queues off before the app loads:
 * with JOBS_ENABLED=false no queue and no worker exists, nothing is queued and Redis is not needed.
 */
export const JOBS_ENABLED = process.env.JOBS_ENABLED !== 'false';

function redisConnection(config: ConfigService) {
  const url = new URL(config.get<string>('REDIS_URL', 'redis://localhost:6379'));
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password && { password: decodeURIComponent(url.password) }),
    ...(url.pathname.length > 1 && { db: Number(url.pathname.slice(1)) }),
  };
}

/** The connection every queue shares; modules that own a queue import this and register the queue themselves. */
@Module({
  imports: JOBS_ENABLED
    ? [
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: redisConnection(config),
            // Keeps the queues of different environments (development, tests) apart on one Redis
            prefix: config.get<string>('REDIS_QUEUE_PREFIX', 'iso-dms'),
          }),
        }),
      ]
    : [],
})
export class JobsModule {}
