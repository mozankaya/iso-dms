import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { FileType } from '@iso-dms/shared';
import JSZip from 'jszip';
import { FILE_TYPE_INFO } from '../storage/storage-keys';

/** Entry that must exist inside the zip package for each Office format. */
const REQUIRED_PART: Record<FileType, string> = {
  DOCX: 'word/document.xml',
  XLSX: 'xl/workbook.xml',
};

// Some browsers and operating systems send generic types for Office files
const GENERIC_MIME_TYPES = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'];

function unsupported(): BadRequestException {
  return new BadRequestException({
    code: 'UNSUPPORTED_FILE_TYPE',
    message: 'Only .docx and .xlsx files are accepted',
  });
}

/**
 * Content check: an Office file is a zip package with a content-types part and the main document part.
 * Only the zip directory is read; nothing is decompressed.
 */
export async function assertOfficePackage(buffer: Buffer, fileType: FileType): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    if (!zip.file('[Content_Types].xml') || !zip.file(REQUIRED_PART[fileType])) {
      throw new Error('missing part');
    }
  } catch {
    throw new BadRequestException({
      code: 'INVALID_FILE_CONTENT',
      message: 'The file content does not match the file type',
    });
  }
}

/**
 * Validates an uploaded Office file (PROJECT.md 12): extension, MIME type and the actual content.
 * Returns the file type derived from the extension.
 */
export async function validateOfficeFile(
  file: { originalname: string; mimetype: string; buffer: Buffer },
  maxBytes: number,
): Promise<FileType> {
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  const fileType = (Object.keys(FILE_TYPE_INFO) as FileType[]).find(
    (type) => FILE_TYPE_INFO[type].extension === extension,
  );
  if (!fileType || file.originalname.split('.').length < 2) throw unsupported();

  const mimeType = file.mimetype.toLowerCase();
  if (mimeType !== FILE_TYPE_INFO[fileType].mimeType && !GENERIC_MIME_TYPES.includes(mimeType)) {
    throw unsupported();
  }

  if (file.buffer.length === 0) {
    throw new BadRequestException({ code: 'EMPTY_FILE', message: 'The file is empty' });
  }
  if (file.buffer.length > maxBytes) {
    throw new PayloadTooLargeException({ code: 'FILE_TOO_LARGE', message: 'The file is too large' });
  }

  await assertOfficePackage(file.buffer, fileType);

  return fileType;
}
