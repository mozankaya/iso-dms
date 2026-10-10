import type JSZip from 'jszip';
import { decodeXml, readPart, UnreadableDocumentError } from './text-limits';

/** Reading the structure of an .xlsx package: what the text extraction and the document fields both need. */

export const textOf = (xml: string) =>
  [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

export function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

export async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readPart(zip, 'xl/sharedStrings.xml');
  if (xml === null) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

export interface SheetPart {
  name: string;
  part: string;
}

/** The sheets of the workbook in order, with the part each one is stored in. */
export async function sheetParts(zip: JSZip): Promise<SheetPart[]> {
  const workbook = await readPart(zip, 'xl/workbook.xml');
  if (workbook === null) throw new UnreadableDocumentError('The file has no workbook part');
  const relationships = (await readPart(zip, 'xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const rel of relationships.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attribute(rel[0], 'Id');
    const target = attribute(rel[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets: SheetPart[] = [];
  for (const sheet of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attribute(sheet[0], 'name');
    const part = targets.get(attribute(sheet[0], 'r:id') ?? '');
    if (name !== undefined && part) sheets.push({ name, part });
  }
  return sheets;
}
