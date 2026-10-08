import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a reverse proxy the client address is in X-Forwarded-For: without this every request looks like it comes
  // from the proxy, so the login rate limit would be shared by everybody and the audit trail would record the proxy.
  // The value is how many proxies sit in front (1 in the supplied compose file); empty means none.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  setupApp(app);
  app.enableCors({
    origin: process.env.WEB_URL ?? 'http://localhost:3000',
    credentials: true,
    // The browser needs the file name of a download, which is a non-standard response header for CORS
    exposedHeaders: ['Content-Disposition'],
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

bootstrap();
