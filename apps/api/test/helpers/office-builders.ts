import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A paragraph made of one run per given piece (Word cuts text into runs wherever it likes). */
export const paragraph = (...pieces: string[]) => `<w:p>${pieces.map((piece) => `<w:r><w:t xml:space="preserve">${escape(piece)}</w:t></w:r>`).join('')}</w:p>`;

export const field = (tag: string, text: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p></w:sdtContent></w:sdt>`;

/** The blank Word template with the given body XML (paragraphs, tables) in place of its empty paragraph. */
export async function buildDocx(bodyXml: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path.resolve(__dirname, '../../templates/blank.docx')));
  const document = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', document.replace('<w:p/>', bodyXml));
  return zip.generateAsync({ type: 'nodebuffer' });
}

export type SheetCells = Record<string, string | number>;

/** The blank Excel template with the given cells on its first sheet (text through the shared strings, like Excel does). */
export async function buildXlsx(sheets: Record<string, SheetCells>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path.resolve(__dirname, '../../templates/blank.xlsx')));
  const strings: string[] = [];
  const names = Object.keys(sheets);

  names.forEach((name, index) => {
    const rows = new Map<number, string[]>();
    for (const [address, value] of Object.entries(sheets[name])) {
      const row = Number(/\d+/.exec(address)![0]);
      let cell: string;
      if (typeof value === 'number') cell = `<c r="${address}"><v>${value}</v></c>`;
      else {
        strings.push(value);
        cell = `<c r="${address}" t="s"><v>${strings.length - 1}</v></c>`;
      }
      rows.set(row, [...(rows.get(row) ?? []), cell]);
    }
    const data = [...rows.entries()].sort(([a], [b]) => a - b).map(([row, cells]) => `<row r="${row}">${cells.join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`);
  });

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${escape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  );
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`).join('')}</sst>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
