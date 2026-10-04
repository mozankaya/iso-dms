import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { EditorCallbackService } from './editor-callback.service';
import { EditorConfigService } from './editor-config.service';
import { EditorController } from './editor.controller';
import { FileTokenService } from './file-token.service';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [EditorController],
  providers: [EditorConfigService, EditorCallbackService, FileTokenService, OnlyOfficeJwtService],
})
export class EditorModule {}
