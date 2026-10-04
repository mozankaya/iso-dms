import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { RevisionsController } from './revisions.controller';
import { RevisionsService } from './revisions.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [RevisionsController],
  providers: [RevisionsService],
})
export class RevisionsModule {}
