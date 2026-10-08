import { COMPARE_MAX_BLOCKS, COMPARE_MAX_TEXT_CHARS } from '@iso-dms/shared';
import type JSZip from 'jszip';
import { decodeXml, openPackage, readPart, tooLargeToCompare, UnreadableDocumentError } from './text-limits';

export interface WorksheetCell {
  sheet: string;
  address: string;
  value: string;
}

const textOf = (xml: string) =>
  [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readPart(zip, 'xl/sharedStrings.xml');
  if (xml === null) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

/** The sheets of the workbook in order, with the part each one is stored in. */
async function sheetParts(zip: JSZip): Promise<{ name: string; part: string }[]> {
  const workbook = await readPart(zip, 'xl/workbook.xml');
  if (workbook === null) throw new UnreadableDocumentError('The file has no workbook part');
  const relationships = (await readPart(zip, 'xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const rel of relationships.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attribute(rel[0], 'Id');
    const target = attribute(rel[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets: { name: string; part: string }[] = [];
  for (const sheet of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attribute(sheet[0], 'name');
    const part = targets.get(attribute(sheet[0], 'r:id') ?? '');
    if (name !== undefined && part) sheets.push({ name, part });
  }
  return sheets;
}

/**
 * Every filled cell of an .xlsx file, sheet by sheet. A cell shows its value as the file stored it (a date is its
 * serial number); a formula without a stored value shows the formula.
 */
export async function extractXlsxCells(buffer: Buffer): Promise<WorksheetCell[]> {
  const zip = await openPackage(buffer);
  const strings = await sharedStrings(zip);
  const cells: WorksheetCell[] = [];
  let chars = 0;

  for (const { name, part } of await sheetParts(zip)) {
    const xml = await readPart(zip, part);
    if (xml === null) continue;
    for (const cell of xml.matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const address = attribute(attributes, 'r');
      const inner = cell[2];
      if (!address || !inner) continue;
      const type = attribute(attributes, 't');
      const stored = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
      const formula = /<f(?:\s[^>]*)?>([^<]*)<\/f>/.exec(inner)?.[1];

      let value: string | undefined;
      if (type === 's') value = stored === undefined ? undefined : strings[Number(stored)];
      else if (type === 'inlineStr') value = textOf(inner);
      else if (stored !== undefined) value = decodeXml(stored);
      else if (formula) value = `=${decodeXml(formula)}`;
      if (value === undefined || value === '') continue;

      chars += value.length;
      if (chars > COMPARE_MAX_TEXT_CHARS || cells.length >= COMPARE_MAX_BLOCKS) throw tooLargeToCompare();
      cells.push({ sheet: name, address, value });
    }
  }
  return cells;
}
