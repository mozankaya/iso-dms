import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { buildStandardDocx } from '../prisma/standard-template';
import { cleanFieldValue, fillDocumentFields, findDocumentFields, InvalidDocxError } from '../src/modules/documents/document-fields/docx-fields';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

let blank: Buffer;

beforeAll(async () => {
  blank = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
});

const control = (tag: string, content: string, extra = '') =>
  `<w:sdt><w:sdtPr><w:alias w:val="${tag}"/><w:tag w:val="${tag}"/><w:id w:val="${Math.floor(Math.random() * 1e6)}"/>${extra}<w:text/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
const run = (text: string, properties = '') => `<w:r>${properties}<w:t>${text}</w:t></w:r>`;

/** The blank template with the given header, footer and body XML put in. */
async function docx(parts: { header?: string; footer?: string; body?: string }): Promise<Buffer> {
  const zip = await JSZip.loadAsync(blank);
  if (parts.header) zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${parts.header}</w:hdr>`);
  if (parts.footer) zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${parts.footer}</w:ftr>`);
  if (parts.body) {
    const document = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', document.replace('<w:p/>', parts.body));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const partOf = async (buffer: Buffer, name: string) => (await JSZip.loadAsync(buffer)).file(name)!.async('string');
const texts = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);

describe('findDocumentFields', () => {
  it('finds the known fields wherever they are, once each, in the order of the list', async () => {
    const buffer = await docx({
      header: `<w:p>${control('DOC_TITLE', run('x'))}${control('DOC_CODE', run('x'))}</w:p>`,
      footer: `<w:p>${control('DOC_CODE', run('x'))}${control('DOC_REVISION_NO', run('x'))}</w:p>`,
      body: `<w:p>${control('DOC_PREPARED_BY', run('x'))}</w:p>`,
    });
    expect(await findDocumentFields(buffer)).toEqual(['DOC_CODE', 'DOC_TITLE', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
  });

  it('ignores controls with other tags, controls without a tag and plain text that looks like a field', async () => {
    const buffer = await docx({
      header: `<w:p>${control('SOMETHING_ELSE', run('x'))}${run('{{DOC_CODE}}')}<w:sdt><w:sdtPr><w:id w:val="9"/></w:sdtPr><w:sdtContent>${run('y')}</w:sdtContent></w:sdt></w:p>`,
    });
    expect(await findDocumentFields(buffer)).toEqual([]);
  });

  it('finds nothing in a file without headers and controls, and in the standard template finds all five', async () => {
    expect(await findDocumentFields(blank)).toEqual([]);
    expect(await findDocumentFields(await buildStandardDocx())).toEqual(['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
  });

  it('refuses what is not a zip package', async () => {
    await expect(findDocumentFields(Buffer.from('plain text'))).rejects.toBeInstanceOf(InvalidDocxError);
  });
});

describe('fillDocumentFields', () => {
  it('writes the values into the controls of the header, the footer and the body', async () => {
    const buffer = await docx({
      header: `<w:p>${control('DOC_CODE', run('KOD'))}</w:p>`,
      footer: `<w:p>${control('DOC_CODE', run('KOD'))}${control('DOC_REVISION_NO', run('0'))}</w:p>`,
      body: `<w:p>${control('DOC_TITLE', run('AD'))}</w:p>`,
    });

    const { buffer: filled, changes } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001', DOC_REVISION_NO: '2', DOC_TITLE: 'Prosedür' });

    expect(texts(await partOf(filled, 'word/header1.xml'))).toEqual(['PR-KK-001']);
    expect(texts(await partOf(filled, 'word/footer1.xml'))).toEqual(['PR-KK-001', '2']);
    expect(texts(await partOf(filled, 'word/document.xml'))).toContain('Prosedür');
    expect(changes).toEqual({
      DOC_CODE: { from: 'KOD', to: 'PR-KK-001', count: 2 },
      DOC_REVISION_NO: { from: '0', to: '2', count: 1 },
      DOC_TITLE: { from: 'AD', to: 'Prosedür', count: 1 },
    });
  });

  it('keeps the tag, so the next revision can be filled in again', async () => {
    const first = await fillDocumentFields(await docx({ header: `<w:p>${control('DOC_REVISION_NO', run('0'))}</w:p>` }), { DOC_REVISION_NO: '1' });
    const second = await fillDocumentFields(first.buffer, { DOC_REVISION_NO: '2' });

    expect(texts(await partOf(second.buffer, 'word/header1.xml'))).toEqual(['2']);
    expect(second.changes.DOC_REVISION_NO).toEqual({ from: '1', to: '2', count: 1 });
    expect(await findDocumentFields(second.buffer)).toEqual(['DOC_REVISION_NO']);
  });

  it('changes nothing, and gives back the very same buffer, when the controls show the values already', async () => {
    const buffer = await docx({ header: `<w:p>${control('DOC_CODE', run('PR-KK-001'))}</w:p>` });
    const result = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001', DOC_TITLE: 'Yok' });
    expect(result.buffer).toBe(buffer);
    expect(result.changes).toEqual({});
  });

  it('does the same for a file without any field', async () => {
    const result = await fillDocumentFields(blank, { DOC_CODE: 'PR-KK-001' });
    expect(result.buffer).toBe(blank);
  });

  it('leaves a field alone for which no value is given, and the controls with other tags', async () => {
    const buffer = await docx({ header: `<w:p>${control('DOC_CODE', run('KOD'))}${control('DOC_TITLE', run('AD'))}${control('OTHER', run('DIĞER'))}</w:p>` });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001' });
    expect(texts(await partOf(filled, 'word/header1.xml'))).toEqual(['PR-KK-001', 'AD', 'DIĞER']);
  });

  it('turns characters that mean something in XML into text, never into markup', async () => {
    const buffer = await docx({ header: `<w:p>${control('DOC_TITLE', run('AD'))}</w:p>` });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_TITLE: 'A & B <w:p>"x"</w:p> & ünlü' });

    const xml = await partOf(filled, 'word/header1.xml');
    expect(xml).toContain('A &amp; B &lt;w:p&gt;"x"&lt;/w:p&gt; &amp; ünlü');
    expect(xml.match(/<w:p>/g)).toHaveLength(1);
    // And what the control shows reads back as the value
    expect((await fillDocumentFields(filled, { DOC_TITLE: 'A & B <w:p>"x"</w:p> & ünlü' })).buffer).toBe(filled);
  });

  it('replaces the text of a control made of several runs, keeping the formatting of the first', async () => {
    const buffer = await docx({
      header: `<w:p>${control('DOC_TITLE', `${run('Prosedür ', '<w:rPr><w:b/></w:rPr>')}${run('Adı')}`)}</w:p>`,
    });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_TITLE: 'Yeni Ad' });

    const xml = await partOf(filled, 'word/header1.xml');
    expect(texts(xml)).toEqual(['Yeni Ad', '']);
    expect(xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Yeni Ad</w:t></w:r>');
  });

  it('fills a control that shows a placeholder, and stops it from showing as one', async () => {
    const buffer = await docx({
      header: `<w:p><w:sdt><w:sdtPr><w:tag w:val="DOC_CODE"/><w:id w:val="5"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Metin girmek için tıklayın</w:t></w:r></w:sdtContent></w:sdt></w:p>`,
    });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001' });

    const xml = await partOf(filled, 'word/header1.xml');
    expect(texts(xml)).toEqual(['PR-KK-001']);
    expect(xml).not.toContain('showingPlcHdr');
    expect(xml).not.toContain('PlaceholderText');
  });

  it('fills an empty control, inline or holding a paragraph', async () => {
    const inline = await fillDocumentFields(await docx({ header: `<w:p>${control('DOC_CODE', '')}</w:p>` }), { DOC_CODE: 'PR-KK-001' });
    expect(texts(await partOf(inline.buffer, 'word/header1.xml'))).toEqual(['PR-KK-001']);

    const block = await fillDocumentFields(await docx({ header: control('DOC_CODE', '<w:p></w:p>') }), { DOC_CODE: 'PR-KK-001' });
    expect(texts(await partOf(block.buffer, 'word/header1.xml'))).toEqual(['PR-KK-001']);
  });

  it('fills controls inside a table cell and controls inside controls', async () => {
    const nested = control('DOC_TITLE', run('iç'));
    const buffer = await docx({
      header: `<w:tbl><w:tr><w:tc><w:p>${control('DOC_CODE', run('KOD'))}</w:p></w:tc><w:tc><w:p>${control('OUTER', nested)}</w:p></w:tc></w:tr></w:tbl><w:p/>`,
    });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001', DOC_TITLE: 'Başlık' });
    expect(texts(await partOf(filled, 'word/header1.xml'))).toEqual(['PR-KK-001', 'Başlık']);
  });

  it('touches nothing but the controls: the other parts of the package stay as they were', async () => {
    const buffer = await docx({ header: `<w:p>${control('DOC_CODE', run('KOD'))}</w:p>` });
    const before = await JSZip.loadAsync(buffer);
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001' });
    const after = await JSZip.loadAsync(filled);

    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    for (const name of Object.keys(before.files).filter((entry) => entry !== 'word/header1.xml' && !before.files[entry].dir)) {
      expect(await after.file(name)!.async('string')).toBe(await before.file(name)!.async('string'));
    }
    const header = await partOf(filled, 'word/header1.xml');
    expect(header).toContain('<w:tag w:val="DOC_CODE"/>');
  });

  it('keeps the locks of a control', async () => {
    const buffer = await docx({ header: `<w:p>${control('DOC_CODE', run('KOD'), '<w:lock w:val="sdtContentLocked"/>')}</w:p>` });
    const { buffer: filled } = await fillDocumentFields(buffer, { DOC_CODE: 'PR-KK-001' });
    expect(await partOf(filled, 'word/header1.xml')).toContain('<w:lock w:val="sdtContentLocked"/>');
  });

  it('fills the standard template, and the result is a docx that opens again', async () => {
    const { buffer: filled, changes } = await fillDocumentFields(await buildStandardDocx(), {
      DOC_CODE: 'PR-KK-001',
      DOC_TITLE: 'Doküman Kontrol Prosedürü',
      DOC_DEPARTMENT: 'Kalite Koordinatörlüğü',
      DOC_REVISION_NO: '0',
      DOC_PREPARED_BY: 'Ece Editör',
    });
    expect(Object.keys(changes).sort()).toEqual(['DOC_CODE', 'DOC_DEPARTMENT', 'DOC_PREPARED_BY', 'DOC_REVISION_NO', 'DOC_TITLE']);
    const header = texts(await partOf(filled, 'word/header1.xml'));
    expect(header).toEqual(expect.arrayContaining(['PR-KK-001', 'Doküman Kontrol Prosedürü', 'Kalite Koordinatörlüğü', '0', 'Ece Editör']));
    expect(await findDocumentFields(filled)).toHaveLength(5);
  });

  it('refuses what is not a zip package', async () => {
    await expect(fillDocumentFields(Buffer.from('plain text'), { DOC_CODE: 'x' })).rejects.toBeInstanceOf(InvalidDocxError);
  });
});

describe('cleanFieldValue', () => {
  it.each([
    ['  Prosedür  ', 'Prosedür'],
    ['Satır\nsonu\tve  boşluk', 'Satır sonu ve boşluk'],
    ['Kontrol\u0000karakteri\u0007', 'Kontrol karakteri'],
    ['', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(cleanFieldValue(input)).toBe(expected);
  });

  it('cuts a value that is too long', () => {
    expect(cleanFieldValue('a'.repeat(400))).toHaveLength(300);
  });
});
