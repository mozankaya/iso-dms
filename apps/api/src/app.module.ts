import path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { validateEnv } from './config/env.validation';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { ListsModule } from './modules/lists/lists.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { EditorModule } from './modules/editor/editor.module';
import { ReviewRemindersModule } from './modules/review-reminders/review-reminders.module';
import { RevisionsModule } from './modules/revisions/revisions.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { UsersModule } from './modules/users/users.module';
import { StorageModule } from './modules/storage/storage.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Single .env at the repository root
      envFilePath: path.resolve(__dirname, '../../../.env'),
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    JwtModule.register({ global: true }),
    PrismaModule,
    StorageModule,
    AuditLogsModule,
    NotificationsModule,
    ReviewRemindersModule,
    AuthModule,
    CategoriesModule,
    DashboardModule,
    DepartmentsModule,
    DocumentsModule,
    TemplatesModule,
    UsersModule,
    EditorModule,
    RevisionsModule,
    ApprovalsModule,
    ListsModule,
    FeedbackModule,
  ],
  providers: [
    // Guard order matters: rate limit, then authentication, then role check.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
