import JSZip from 'jszip';

/**
 * The Word template with a header that carries the data of the document (PROJECT.md 6.14): code, title, department,
 * revision number and the one who prepared it, each in a content control the application fills in. The controls are
 * locked against editing their content, so a person cannot type over what the system writes.
 */

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1984" w:right="1417" w:bottom="1417" w:left="1417" w:header="567" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
  .join('');

const label = (text: string, width: number) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:sz w:val="18"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:tc>`;

let nextId = 7100;
const value = (tag: string, title: string, width: number, span = 1) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr><w:p><w:sdt><w:sdtPr><w:alias w:val="${title}"/><w:tag w:val="${tag}"/><w:id w:val="${nextId++}"/><w:lock w:val="sdtContentLocked"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>${title}</w:t></w:r></w:sdtContent></w:sdt></w:p></w:tc>`;

function header(): string {
  nextId = 7100;
  const rows = [
    `<w:tr>${label('Doküman Kodu', 1700)}${value('DOC_CODE', 'Doküman Kodu', 3000)}${label('Revizyon No', 1700)}${value('DOC_REVISION_NO', 'Revizyon No', 2660)}</w:tr>`,
    `<w:tr>${label('Doküman Adı', 1700)}${value('DOC_TITLE', 'Doküman Adı', 7360, 3)}</w:tr>`,
    `<w:tr>${label('Birim', 1700)}${value('DOC_DEPARTMENT', 'Birim', 3000)}${label('Hazırlayan', 1700)}${value('DOC_PREPARED_BY', 'Hazırlayan', 2660)}</w:tr>`,
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}><w:tbl><w:tblPr><w:tblW w:w="9060" w:type="dxa"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="1700"/><w:gridCol w:w="3000"/><w:gridCol w:w="1700"/><w:gridCol w:w="2660"/></w:tblGrid>${rows}</w:tbl><w:p/></w:hdr>`;
}

export async function buildStandardDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);
  zip.file('word/document.xml', DOCUMENT);
  zip.file('word/header1.xml', header());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * The Excel counterpart: a block at the top of the first sheet with the same five data (PROJECT.md 6.14). Each value
 * cell has a defined name (DOC_CODE ...) which is what makes it a field; the labels next to them are plain text.
 */
const SHEET_NAME = 'Sayfa1';

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const XLSX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const FIELD_CELLS: Record<string, string> = {
  DOC_CODE: '$B$1',
  DOC_REVISION_NO: '$D$1',
  DOC_TITLE: '$B$2',
  DOC_DEPARTMENT: '$B$3',
  DOC_PREPARED_BY: '$D$3',
};

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets><definedNames>${Object.entries(FIELD_CELLS)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, cell]) => `<definedName name="${name}">${SHEET_NAME}!${cell}</definedName>`)
  .join('')}</definedNames></workbook>`;

// Style 1: a label (bold, shaded, bordered); style 2: a value (bordered)
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right><top style="thin"><color rgb="FF808080"/></top><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const labelCell = (address: string, text: string) => `<c r="${address}" s="1" t="inlineStr"><is><t>${text}</t></is></c>`;
const valueCell = (address: string) => `<c r="${address}" s="2"/>`;

const XLSX_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/><col min="4" max="4" width="28" customWidth="1"/></cols><sheetData><row r="1">${labelCell('A1', 'Doküman Kodu')}${valueCell('B1')}${labelCell('C1', 'Revizyon No')}${valueCell('D1')}</row><row r="2">${labelCell('A2', 'Doküman Adı')}${valueCell('B2')}${valueCell('C2')}${valueCell('D2')}</row><row r="3">${labelCell('A3', 'Birim')}${valueCell('B3')}${labelCell('C3', 'Hazırlayan')}${valueCell('D3')}</row></sheetData><mergeCells count="1"><mergeCell ref="B2:D2"/></mergeCells></worksheet>`;

export async function buildStandardXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', XLSX_CONTENT_TYPES);
  zip.file('_rels/.rels', XLSX_ROOT_RELS);
  zip.file('xl/workbook.xml', XLSX_WORKBOOK);
  zip.file('xl/_rels/workbook.xml.rels', XLSX_WORKBOOK_RELS);
  zip.file('xl/styles.xml', XLSX_STYLES);
  zip.file('xl/worksheets/sheet1.xml', XLSX_SHEET);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
