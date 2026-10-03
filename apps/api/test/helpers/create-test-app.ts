import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

/** Test-only routes used to exercise the global guards and the @Roles() decorator. */
export async function createTestApp(): Promise<INestApplication> {
  // Imported lazily: LOGIN_RATE_LIMIT is read when the auth controller module is first loaded.
  const { AppModule } = await import('../../src/app.module');
  const { setupApp } = await import('../../src/setup-app');
  const { Roles } = await import('../../src/common/decorators/roles.decorator');

  @Controller('test')
  class TestController {
    @Get('admin-only')
    @Roles('ADMIN')
    adminOnly() {
      return { ok: true };
    }

    @Get('any-user')
    anyUser() {
      return { ok: true };
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TestController],
  }).compile();

  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();
  return app;
}
