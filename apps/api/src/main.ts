import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
