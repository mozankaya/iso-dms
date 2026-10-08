import { COMPARE_MAX_BLOCKS, COMPARE_MAX_TEXT_CHARS } from '@iso-dms/shared';
import { withoutDocumentFieldControls } from '../document-fields/docx-fields';
import { decodeXml, openPackage, readPart, tooLargeToCompare, UnreadableDocumentError } from './text-limits';

/** The text of a run: its text, tabs and line breaks. */
const RUN_PIECES = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:noBreakHyphen\s*\/>/g;
const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

function paragraphText(xml: string): string {
  let text = '';
  for (const piece of xml.matchAll(RUN_PIECES)) {
    if (piece[1] !== undefined) text += decodeXml(piece[1]);
    else if (piece[0].startsWith('<w:tab')) text += '\t';
    else if (piece[0].startsWith('<w:noBreakHyphen')) text += '-';
    else text += ' ';
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The paragraphs of the body of a .docx file in reading order, tables included (a cell is a run of paragraphs
 * like any other). Headers and footers are left out, and so are the document fields (PROJECT.md 6.14, 6.15).
 * Empty paragraphs are dropped.
 */
export async function extractDocxParagraphs(buffer: Buffer): Promise<string[]> {
  const zip = await openPackage(buffer);
  const body = await readPart(zip, 'word/document.xml');
  if (body === null) throw new UnreadableDocumentError('The file has no document part');

  const paragraphs: string[] = [];
  let chars = 0;
  for (const match of withoutDocumentFieldControls(body).matchAll(PARAGRAPH)) {
    const text = paragraphText(match[1]);
    if (!text) continue;
    chars += text.length;
    if (chars > COMPARE_MAX_TEXT_CHARS || paragraphs.length >= COMPARE_MAX_BLOCKS) throw tooLargeToCompare();
    paragraphs.push(text);
  }
  return paragraphs;
}
