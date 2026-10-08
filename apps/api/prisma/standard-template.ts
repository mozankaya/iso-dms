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
