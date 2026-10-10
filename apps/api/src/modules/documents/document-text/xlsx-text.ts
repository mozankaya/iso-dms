import { COMPARE_MAX_BLOCKS, COMPARE_MAX_TEXT_CHARS } from '@iso-dms/shared';
import { readFieldTargets } from '../document-fields/xlsx-fields';
import { decodeXml, openPackage, readPart, tooLargeToCompare } from './text-limits';
import { attribute, sharedStrings, sheetParts, textOf } from './xlsx-package';

export interface WorksheetCell {
  sheet: string;
  address: string;
  value: string;
}

/**
 * Every filled cell of an .xlsx file, sheet by sheet. A cell shows its value as the file stored it (a date is its
 * serial number); a formula without a stored value shows the formula. The cells of the document fields (PROJECT.md
 * 6.14) are left out: the application writes them and they change with every revision.
 */
export async function extractXlsxCells(buffer: Buffer): Promise<WorksheetCell[]> {
  const zip = await openPackage(buffer);
  const strings = await sharedStrings(zip);
  const sheets = await sheetParts(zip);
  const fieldCells = new Set((await readFieldTargets(zip)).map((target) => `${target.part}!${target.address}`));
  const cells: WorksheetCell[] = [];
  let chars = 0;

  for (const { name, part } of sheets) {
    const xml = await readPart(zip, part);
    if (xml === null) continue;
    for (const cell of xml.matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const address = attribute(attributes, 'r');
      const inner = cell[2];
      if (!address || !inner || fieldCells.has(`${part}!${address}`)) continue;
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
