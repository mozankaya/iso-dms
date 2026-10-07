import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsQueryService } from './audit-logs-query.service';
import { AuditLogsService } from './audit-logs.service';

@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService, AuditLogsQueryService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
