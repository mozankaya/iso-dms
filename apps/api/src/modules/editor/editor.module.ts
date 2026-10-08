import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { EditorCallbackService } from './editor-callback.service';
import { EditorConfigService } from './editor-config.service';
import { EditSessionGate } from './edit-session-gate.service';
import { EditorController } from './editor.controller';
import { FileTokenService } from './file-token.service';
import { OnlyOfficeCommandClient } from './onlyoffice-command.client';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';
import { RevisionPdfConverter } from './revision-pdf-converter';

@Module({
  imports: [AuditLogsModule],
  controllers: [EditorController],
  providers: [
    EditorConfigService,
    EditorCallbackService,
    FileTokenService,
    OnlyOfficeJwtService,
    OnlyOfficeCommandClient,
    EditSessionGate,
    RevisionPdfConverter,
  ],
  // Other modules only get the gate and the converter: they ask whether editing is over, or for a PDF, without knowing about ONLYOFFICE
  exports: [EditSessionGate, RevisionPdfConverter],
})
export class EditorModule {}
