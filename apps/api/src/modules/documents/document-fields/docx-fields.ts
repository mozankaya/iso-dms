import { DOCUMENT_FIELD_TAGS, DOCUMENT_FIELD_VALUE_MAX_LENGTH, type DocumentFieldTag } from '@iso-dms/shared';
import JSZip from 'jszip';

/**
 * Reading and writing the document fields of a .docx file (PROJECT.md 6.14). The fields are content controls
 * (`<w:sdt>`) whose tag names the field. Controls are used because plain `{{PLACEHOLDER}}` text is cut into runs
 * by Word and cannot be found reliably, and because the tag survives when the text is replaced, so the next
 * revision can be filled in again. ONLYOFFICE keeps the controls, their tags and locks when it saves the file.
 *
 * Only the text inside a control with a known tag is touched; every other part of the package stays byte for byte
 * the same. The XML is not parsed into a tree: the controls are found by scanning for their tags, which is enough
 * for what is changed and keeps the rest of the file exactly as Word wrote it.
 */

/** Parts of the package that can hold a field: the body, the headers and the footers. */
const FIELD_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;

export class InvalidDocxError extends Error {}

export type DocumentFieldValues = Partial<Record<DocumentFieldTag, string>>;

export interface FieldChange {
  from: string;
  to: string;
  /** How many controls with this tag changed (the same field can be in the header and the footer) */
  count: number;
}

export interface FillResult {
  /** The file as it is now; the very buffer that was given when nothing needed to change */
  buffer: Buffer;
  changes: Partial<Record<DocumentFieldTag, FieldChange>>;
}

interface Control {
  /** Offsets in the part: the whole control, and what is between <w:sdtContent> and </w:sdtContent> */
  start: number;
  end: number;
  propsStart: number;
  propsEnd: number;
  contentStart: number;
  contentEnd: number;
  tag: string | null;
}

const isKnownTag = (tag: string | null): tag is DocumentFieldTag => tag !== null && (DOCUMENT_FIELD_TAGS as readonly string[]).includes(tag);

/** Every content control of a part, nested ones included. */
function findControls(xml: string): Control[] {
  const controls: Control[] = [];
  const stack: Control[] = [];
  const tokens = /<(\/?)w:(sdt|sdtPr|sdtContent)(?=[\s/>])[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tokens.exec(xml))) {
    const [token, closing, name, selfClosing] = match;
    const top = stack[stack.length - 1];
    if (name === 'sdt') {
      if (closing) {
        const finished = stack.pop();
        if (finished) {
          finished.end = match.index + token.length;
          if (finished.propsStart >= 0 && finished.propsEnd >= finished.propsStart) {
            const props = xml.slice(finished.propsStart, finished.propsEnd);
            finished.tag = /<w:tag\s[^>]*?w:val="([^"]*)"/.exec(props)?.[1] ?? null;
          }
          controls.push(finished);
        }
      } else if (!selfClosing) {
        stack.push({ start: match.index, end: -1, propsStart: -1, propsEnd: -1, contentStart: -1, contentEnd: -1, tag: null });
      }
    } else if (name === 'sdtPr' && top) {
      if (!closing && !selfClosing && top.propsStart < 0) top.propsStart = match.index;
      if (closing && top.propsEnd < 0) top.propsEnd = match.index + token.length;
    } else if (name === 'sdtContent' && top) {
      if (!closing && !selfClosing && top.contentStart < 0) top.contentStart = match.index + token.length;
      if (closing && top.contentEnd < 0) top.contentEnd = match.index;
    }
  }
  return controls.filter((control) => control.end > 0).sort((a, b) => a.start - b.start);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity]);
const encode = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What a person reads in a piece of content: the text of its runs, in order. */
function textOf(content: string): string {
  return [...content.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1])).join('');
}

/** A value fit for one line of a header: no control characters, no line breaks, not endlessly long. */
export function cleanFieldValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_FIELD_VALUE_MAX_LENGTH);
}

/** The content of a control with its text replaced; the formatting of the first run is kept. */
function withText(content: string, value: string): string {
  const text = encode(value);
  const placeholderStyle = /<w:rStyle\s+w:val="PlaceholderText"\s*\/>/g;
  const cleaned = content.replace(placeholderStyle, '');

  if (/<w:t[\s>/]/.test(cleaned)) {
    let first = true;
    return cleaned.replace(/<w:t(?:\s[^>]*)?(?:\/>|>[^<]*<\/w:t>)/g, () => {
      if (!first) return '<w:t></w:t>';
      first = false;
      return `<w:t xml:space="preserve">${text}</w:t>`;
    });
  }
  const run = `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  // A control that holds paragraphs (block level) gets the run inside its first paragraph
  const closeParagraph = cleaned.search(/<\/w:p>/);
  if (closeParagraph >= 0) return cleaned.slice(0, closeParagraph) + run + cleaned.slice(closeParagraph);
  return run;
}

async function load(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new InvalidDocxError('The file is not a zip package');
  }
}

/** The known field tags that appear in the file, in the order of DOCUMENT_FIELD_TAGS. */
export async function findDocumentFields(buffer: Buffer): Promise<DocumentFieldTag[]> {
  const zip = await load(buffer);
  const found = new Set<DocumentFieldTag>();
  for (const name of Object.keys(zip.files).filter((entry) => FIELD_PART.test(entry))) {
    const xml = await zip.file(name)!.async('string');
    for (const control of findControls(xml)) if (isKnownTag(control.tag)) found.add(control.tag);
  }
  return DOCUMENT_FIELD_TAGS.filter((tag) => found.has(tag));
}

/**
 * Writes the values into the controls whose tag has one. A control that already shows the value is left alone, so
 * filling a file twice changes nothing the second time. Values are cleaned and escaped; nothing a user typed can
 * become markup.
 */
export async function fillDocumentFields(buffer: Buffer, values: DocumentFieldValues): Promise<FillResult> {
  const zip = await load(buffer);
  const changes: FillResult['changes'] = {};
  let anyChange = false;

  for (const name of Object.keys(zip.files).filter((entry) => FIELD_PART.test(entry))) {
    const xml = await zip.file(name)!.async('string');
    const targets = findControls(xml).filter((control) => isKnownTag(control.tag) && values[control.tag] !== undefined && control.contentStart >= 0 && control.contentEnd >= control.contentStart);
    if (targets.length === 0) continue;

    // From the end, so the offsets of the controls still to do stay valid; a control inside one already done is skipped
    let result = xml;
    let lowest = Number.POSITIVE_INFINITY;
    let partChanged = false;
    for (const control of [...targets].sort((a, b) => b.start - a.start)) {
      if (control.end > lowest) continue;
      const tag = control.tag as DocumentFieldTag;
      const value = cleanFieldValue(values[tag]!);
      const content = xml.slice(control.contentStart, control.contentEnd);
      const current = textOf(content);
      const showsPlaceholder = /<w:showingPlcHdr\s*\/>/.test(xml.slice(control.propsStart, control.propsEnd));
      if (current === value && !showsPlaceholder) continue;

      let properties = xml.slice(control.propsStart, control.propsEnd);
      properties = properties.replace(/<w:showingPlcHdr\s*\/>/g, '');
      result =
        result.slice(0, control.propsStart) +
        properties +
        result.slice(control.propsEnd, control.contentStart) +
        withText(content, value) +
        result.slice(control.contentEnd);
      lowest = control.start;
      partChanged = true;

      const entry = changes[tag];
      if (entry) {
        entry.count += 1;
        entry.from = current;
      } else {
        changes[tag] = { from: current, to: value, count: 1 };
      }
    }

    if (partChanged) {
      zip.file(name, result);
      anyChange = true;
    }
  }

  if (!anyChange) return { buffer, changes: {} };
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changes };
}

/**
 * The part with the controls of the known document fields cut out. The fields change in every revision by
 * themselves (revision number, preparer), so they are noise when two revisions are compared.
 */
export function withoutDocumentFieldControls(xml: string): string {
  const known = findControls(xml).filter((control) => isKnownTag(control.tag));
  let result = '';
  let position = 0;
  for (const control of known) {
    if (control.start < position) continue; // nested in a control that was cut already
    result += xml.slice(position, control.start);
    position = control.end;
  }
  return result + xml.slice(position);
}
