import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObjectStorage } from './object-storage';

@Injectable()
export class StorageService extends ObjectStorage implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(config: ConfigService) {
    super({
      endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
      port: Number(config.get('S3_PORT', 9000)),
      useSsl: config.get('S3_USE_SSL') === 'true',
      accessKey: config.getOrThrow<string>('S3_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('S3_SECRET_KEY'),
      bucket: config.getOrThrow<string>('S3_BUCKET'),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBucket();
    } catch (error) {
      // The API stays up for endpoints that need no files; the next file operation retries
      this.logger.error(`Object storage is not reachable: ${(error as Error).message}`);
    }
  }
}
