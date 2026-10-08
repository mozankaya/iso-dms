import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AdminTemplatesService } from './admin-templates.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, AdminTemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
