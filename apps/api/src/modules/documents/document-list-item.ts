import type { DocumentListItemDto } from '@iso-dms/shared';
import type { Prisma } from '../../generated/prisma/client';

/** Fields needed to build a DocumentListItemDto. */
export const DOCUMENT_LIST_SELECT = {
  id: true,
  code: true,
  title: true,
  fileType: true,
  status: true,
  categoryId: true,
  firstPublishedAt: true,
  revisedAt: true,
  department: { select: { id: true, name: true, code: true } },
  currentRevision: { select: { revisionNo: true } },
} satisfies Prisma.DocumentSelect;

export type DocumentListRow = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_LIST_SELECT }>;

export function toDocumentListItem(document: DocumentListRow, canEdit: boolean): DocumentListItemDto {
  return {
    id: document.id,
    code: document.code,
    title: document.title,
    fileType: document.fileType,
    status: document.status,
    categoryId: document.categoryId,
    department: document.department,
    firstPublishedAt: document.firstPublishedAt?.toISOString() ?? null,
    revisedAt: document.revisedAt?.toISOString() ?? null,
    revisionNo: document.currentRevision?.revisionNo ?? null,
    canEdit,
  };
}
