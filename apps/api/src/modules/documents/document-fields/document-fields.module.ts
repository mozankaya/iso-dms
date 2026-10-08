import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { DocumentFieldsService } from './document-fields.service';

@Module({
  imports: [AuditLogsModule],
  providers: [DocumentFieldsService],
  exports: [DocumentFieldsService],
})
export class DocumentFieldsModule {}
