import { DOCUMENT_FIELD_TAGS, type DocumentFieldTag } from '@iso-dms/shared';
import JSZip from 'jszip';
import { attribute, sharedStrings, sheetParts, textOf } from '../document-text/xlsx-package';
import { decodeXml, readPart, UnreadableDocumentError } from '../document-text/text-limits';
import { cleanFieldValue, type DocumentFieldValues, type FillResult } from './docx-fields';

/**
 * Reading and writing the document fields of an .xlsx file (PROJECT.md 6.14). A field is a cell with a defined name
 * (Excel: Formulas > Name Manager, or the name box next to the formula bar) that is one of the field tags, such as
 * DOC_CODE. Only a name that points at a single cell is a field: a name over several cells says nothing about which
 * of them is meant, so it is left alone. The value is written into the cell as text, the formatting of the cell is
 * kept, a cell with a formula is never overwritten, and every other part of the package stays byte for byte the same.
 */

export class InvalidXlsxError extends Error {}

export interface FieldTarget {
  tag: DocumentFieldTag;
  sheet: string;
  part: string;
  /** Upper case, without the dollar signs: B2 */
  address: string;
}

const SINGLE_CELL = /^(?:'((?:[^']|'')*)'|([^'!]+))!\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/;

const columnNumber = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

async function load(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new InvalidXlsxError('The file is not a zip package');
  }
}

/** The cells that are document fields: the known names of the workbook that point at one cell of an existing sheet. */
export async function readFieldTargets(zip: JSZip): Promise<FieldTarget[]> {
  let sheets;
  let workbook;
  try {
    sheets = await sheetParts(zip);
    workbook = await readPart(zip, 'xl/workbook.xml');
  } catch (error) {
    if (error instanceof UnreadableDocumentError) throw new InvalidXlsxError(error.message);
    throw error;
  }
  if (workbook === null) throw new InvalidXlsxError('The file has no workbook part');

  const byName = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));
  const targets: FieldTarget[] = [];
  for (const match of workbook.matchAll(/<definedName\s([^>]*)>([^<]*)<\/definedName>/g)) {
    const tag = (attribute(` ${match[1]}`, 'name') ?? '').toUpperCase() as DocumentFieldTag;
    if (!(DOCUMENT_FIELD_TAGS as readonly string[]).includes(tag)) continue;

    const reference = SINGLE_CELL.exec(decodeXml(match[2]).trim());
    if (!reference) continue;
    const [, quoted, bare, column, row, endColumn, endRow] = reference;
    // A range of several cells does not say which one is the field
    if (endColumn !== undefined && (columnNumber(endColumn) !== columnNumber(column) || endRow !== row)) continue;

    const sheet = byName.get((quoted !== undefined ? quoted.replace(/''/g, "'") : bare).toLowerCase());
    if (!sheet) continue;
    const address = `${column.toUpperCase()}${row}`;
    if (!targets.some((target) => target.tag === tag && target.part === sheet.part && target.address === address)) {
      targets.push({ tag, sheet: sheet.name, part: sheet.part, address });
    }
  }
  return targets;
}

/** The known field tags that point at a cell of the workbook, in the order of DOCUMENT_FIELD_TAGS. */
export async function findXlsxFields(buffer: Buffer): Promise<DocumentFieldTag[]> {
  const found = new Set((await readFieldTargets(await load(buffer))).map((target) => target.tag));
  return DOCUMENT_FIELD_TAGS.filter((tag) => found.has(tag));
}

/** Where a cell with this address starts in the sheet, how it is written and whether it is self-closing. */
function findCell(xml: string, address: string): { start: number; end: number; open: string; inner: string } | null {
  const opening = new RegExp(`<c\\s(?:[^>]*\\s)?r="${address}"[^>]*>`).exec(xml);
  if (!opening) return null;
  const open = opening[0];
  if (open.endsWith('/>')) return { start: opening.index, end: opening.index + open.length, open, inner: '' };
  const close = xml.indexOf('</c>', opening.index + open.length);
  if (close < 0) return null;
  return { start: opening.index, end: close + 4, open, inner: xml.slice(opening.index + open.length, close) };
}

function currentText(cell: { open: string; inner: string }, strings: string[]): string | null {
  // null: a formula, which is not ours to overwrite
  if (/<f[\s>/]/.test(cell.inner)) return null;
  const type = attribute(cell.open, 't');
  if (type === 'inlineStr') return textOf(cell.inner);
  const stored = /<v>([^<]*)<\/v>/.exec(cell.inner)?.[1];
  if (stored === undefined) return '';
  return type === 's' ? (strings[Number(stored)] ?? '') : decodeXml(stored);
}

const encode = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function writtenCell(address: string, attributes: string, value: string): string {
  return `<c r="${address}"${attributes} t="inlineStr"><is><t xml:space="preserve">${encode(value)}</t></is></c>`;
}

/** The attributes of the cell that are kept (its style), without its address and type. */
function keptAttributes(open: string): string {
  return [...open.matchAll(/\s([\w:]+)="([^"]*)"/g)]
    .filter(([, name]) => name !== 'r' && name !== 't' && name !== 'cm' && name !== 'vm')
    .map(([, name, value]) => ` ${name}="${value}"`)
    .join('');
}

/** A cell that is not in the sheet yet, put in the right place of its row (and the row in the right place of the sheet). */
function insertCell(xml: string, address: string, value: string): string | null {
  const [, letters, rowText] = /^([A-Z]+)(\d+)$/.exec(address)!;
  const column = columnNumber(letters);
  const cell = writtenCell(address, '', value);

  const rowOpening = new RegExp(`<row\\s(?:[^>]*\\s)?r="${rowText}"[^>]*>`).exec(xml);
  if (rowOpening) {
    const open = rowOpening[0];
    if (open.endsWith('/>')) return xml.slice(0, rowOpening.index) + open.slice(0, -2).trimEnd() + `>${cell}</row>` + xml.slice(rowOpening.index + open.length);
    const bodyStart = rowOpening.index + open.length;
    const bodyEnd = xml.indexOf('</row>', bodyStart);
    if (bodyEnd < 0) return null;
    let at = bodyEnd;
    for (const existing of xml.slice(bodyStart, bodyEnd).matchAll(/<c\s(?:[^>]*\s)?r="([A-Z]+)\d+"/g)) {
      if (columnNumber(existing[1]) > column) {
        at = bodyStart + existing.index;
        break;
      }
    }
    return xml.slice(0, at) + cell + xml.slice(at);
  }

  const row = `<row r="${rowText}">${cell}</row>`;
  if (/<sheetData\s*\/>/.test(xml)) return xml.replace(/<sheetData\s*\/>/, `<sheetData>${row}</sheetData>`);
  const dataStart = xml.search(/<sheetData[\s>]/);
  const dataEnd = xml.indexOf('</sheetData>');
  if (dataStart < 0 || dataEnd < 0) return null;
  let at = dataEnd;
  for (const existing of xml.slice(dataStart, dataEnd).matchAll(/<row\s(?:[^>]*\s)?r="(\d+)"/g)) {
    if (Number(existing[1]) > Number(rowText)) {
      at = dataStart + existing.index;
      break;
    }
  }
  return xml.slice(0, at) + row + xml.slice(at);
}

/**
 * Writes the values into the cells of the fields that have one. A cell that already shows the value is left alone,
 * so filling a file twice changes nothing the second time; a cell with a formula is left alone too.
 */
export async function fillXlsxFields(buffer: Buffer, values: DocumentFieldValues): Promise<FillResult> {
  const zip = await load(buffer);
  const targets = (await readFieldTargets(zip)).filter((target) => values[target.tag] !== undefined);
  if (targets.length === 0) return { buffer, changes: {} };

  const strings = await sharedStrings(zip);
  const changes: FillResult['changes'] = {};
  let anyChange = false;

  for (const part of [...new Set(targets.map((target) => target.part))]) {
    const entry = zip.file(part);
    if (!entry) continue;
    let xml = await entry.async('string');
    let partChanged = false;

    for (const target of targets.filter((candidate) => candidate.part === part)) {
      const value = cleanFieldValue(values[target.tag]!);
      const cell = findCell(xml, target.address);
      let updated: string | null;
      let from = '';

      if (cell) {
        const current = currentText(cell, strings);
        if (current === null || current === value) continue;
        from = current;
        updated = xml.slice(0, cell.start) + writtenCell(target.address, keptAttributes(cell.open), value) + xml.slice(cell.end);
      } else {
        updated = insertCell(xml, target.address, value);
      }
      if (updated === null) continue;
      xml = updated;
      partChanged = true;

      const change = changes[target.tag];
      if (change) {
        change.count += 1;
        change.from = from;
      } else {
        changes[target.tag] = { from, to: value, count: 1 };
      }
    }

    if (partChanged) {
      zip.file(part, xml);
      anyChange = true;
    }
  }

  if (!anyChange) return { buffer, changes: {} };
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changes };
}
