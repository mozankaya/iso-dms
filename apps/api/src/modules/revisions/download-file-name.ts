const TURKISH_TO_ASCII: Record<string, string> = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
};

const MAX_TITLE_LENGTH = 100;

/** Characters that are not allowed in file names on common systems, plus control characters. */
function clean(text: string): string {
  return text
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "PR-KK-001 Document title (Rev 2).docx" */
export function buildDownloadFileName(params: {
  code: string;
  title: string;
  revisionNo: number;
  extension: string;
}): string {
  const title = clean(params.title).slice(0, MAX_TITLE_LENGTH).trim();
  const base = title ? `${params.code} ${title}` : params.code;
  return `${base} (Rev ${params.revisionNo}).${params.extension}`;
}

/**
 * Content-Disposition header for a download. Carries an ASCII fallback for old clients and the real
 * name (UTF-8, RFC 5987) so Turkish characters survive.
 */
export function contentDisposition(fileName: string): string {
  const fallback = fileName
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (char) => TURKISH_TO_ASCII[char])
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
