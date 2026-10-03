import { randomUUID } from 'node:crypto';
import type { FileType } from '@iso-dms/shared';

export const FILE_TYPE_INFO: Record<FileType, { extension: string; mimeType: string }> = {
  DOCX: {
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  XLSX: {
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
};

/** Object key of a revision file: {organizationId}/{documentId}/{revisionNo}/{uuid}.{ext} (PROJECT.md 12). */
export function buildRevisionKey(params: {
  organizationId: string;
  documentId: string;
  revisionNo: number;
  fileType: FileType;
}): string {
  const { extension } = FILE_TYPE_INFO[params.fileType];
  return `${params.organizationId}/${params.documentId}/${params.revisionNo}/${randomUUID()}.${extension}`;
}
