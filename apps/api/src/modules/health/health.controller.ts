import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { HealthDto } from '@iso-dms/shared';
import { Public } from '../../common/decorators/public.decorator';
import { HealthService } from './health.service';

/**
 * Open to everybody and free of the rate limit: monitors and the container runtime ask it often. It says only
 * whether each part is up, nothing about versions, addresses or errors. 503 when the database or the files are
 * unreachable (the application cannot work), 200 otherwise, `degraded` when only the queue or the editor is down.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<HealthDto> {
    const result = await this.health.check();
    if (result.status === 'down') res.status(503);
    return result;
  }
}
