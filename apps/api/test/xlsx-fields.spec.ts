import JSZip from 'jszip';
import { buildStandardXlsx } from '../prisma/standard-template';
import { InvalidXlsxError, fillXlsxFields, findXlsxFields } from '../src/modules/documents/document-fields/xlsx-fields';
import { buildXlsx } from './helpers/office-builders';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** The workbook of the helper with its first sheet replaced by the given XML. */
async function withSheetXml(sheetData: string, names: Record<string, string>, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildXlsx({ Sayfa1: { A1: 'x' } }, names));
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>${sheetData}</worksheet>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const sheetOf = async (buffer: Buffer, part = 'xl/worksheets/sheet1.xml') => (await JSZip.loadAsync(buffer)).file(part)!.async('string');

describe('findXlsxFields', () => {
  it('finds the five fields of the standard template, in the order of the list', async () => {
    expect(await findXlsxFields(await buildStandardXlsx())).toEqual(['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY']);
  });

  it('finds nothing in a workbook without names, and ignores names that are not fields', async () => {
    expect(await findXlsxFields(await buildXlsx({ Sayfa1: { A1: 'x' } }))).toEqual([]);
    expect(await findXlsxFields(await buildXlsx({ Sayfa1: { A1: 'x' } }, { TOPLAM: 'Sayfa1!$A$1', DOC_BASKA: 'Sayfa1!$A$1' }))).toEqual([]);
  });

  it('takes the names whatever their case, absolute or not, and a one cell range', async () => {
    const buffer = await buildXlsx({ Sayfa1: {} }, { doc_code: 'Sayfa1!B1', Doc_Title: 'Sayfa1!$B$2:$B$2' });
    expect(await findXlsxFields(buffer)).toEqual(['DOC_CODE', 'DOC_TITLE']);
  });

  it('leaves out a name over several cells, a name of a sheet that is not there and a name that is not a cell', async () => {
    const buffer = await buildXlsx({ Sayfa1: {} }, {
      DOC_CODE: 'Sayfa1!$B$1:$B$3',
      DOC_TITLE: 'Yok!$B$1',
      DOC_DEPARTMENT: '"sabit metin"',
      DOC_REVISION_NO: 'Sayfa1!$1:$1',
      DOC_PREPARED_BY: '[1]Sayfa1!$B$1',
    });
    expect(await findXlsxFields(buffer)).toEqual([]);
  });

  it('reads the quoted name of a sheet, with a space or an apostrophe in it', async () => {
    const buffer = await buildXlsx({ 'Ana Sayfa': {}, "Ali'nin Sayfası": {} }, { DOC_CODE: "'Ana Sayfa'!$B$1", DOC_TITLE: "'Ali''nin Sayfası'!$B$1" });
    expect(await findXlsxFields(buffer)).toEqual(['DOC_CODE', 'DOC_TITLE']);
  });

  it('refuses what is not an Excel package', async () => {
    await expect(findXlsxFields(Buffer.from('plain text'))).rejects.toBeInstanceOf(InvalidXlsxError);
    const noWorkbook = await JSZip.loadAsync(await buildXlsx({ Sayfa1: {} }));
    noWorkbook.remove('xl/workbook.xml');
    await expect(findXlsxFields(await noWorkbook.generateAsync({ type: 'nodebuffer' }))).rejects.toBeInstanceOf(InvalidXlsxError);
  });
});

describe('fillXlsxFields', () => {
  it('fills the standard template, keeps the style of the cells and writes the rest of the sheet as it was', async () => {
    const template = await buildStandardXlsx();

    const { buffer, changes } = await fillXlsxFields(template, {
      DOC_CODE: 'PR-KK-001',
      DOC_TITLE: 'Müşteri Şikâyetleri Prosedürü',
      DOC_DEPARTMENT: 'Kalite Koordinatörlüğü',
      DOC_REVISION_NO: '2',
      DOC_PREPARED_BY: 'Ece Editör',
    });

    const sheet = await sheetOf(buffer);
    expect(sheet).toContain('<c r="B1" s="2" t="inlineStr"><is><t xml:space="preserve">PR-KK-001</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="2" t="inlineStr"><is><t xml:space="preserve">Müşteri Şikâyetleri Prosedürü</t></is></c>');
    expect(sheet).toContain('<c r="D3" s="2" t="inlineStr"><is><t xml:space="preserve">Ece Editör</t></is></c>');
    // Labels, merged cells and widths are not touched
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t>Doküman Kodu</t></is></c>');
    expect(sheet).toContain('<mergeCell ref="B2:D2"/>');
    expect(Object.keys(changes).sort()).toEqual(['DOC_CODE', 'DOC_DEPARTMENT', 'DOC_PREPARED_BY', 'DOC_REVISION_NO', 'DOC_TITLE']);
    expect(changes.DOC_CODE).toEqual({ from: '', to: 'PR-KK-001', count: 1 });

    // Every other part of the package is the same bytes
    const before = await JSZip.loadAsync(template);
    const after = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(before.files).filter((entry) => !before.files[entry].dir && entry !== 'xl/worksheets/sheet1.xml')) {
      expect(await after.file(name)!.async('string')).toBe(await before.file(name)!.async('string'));
    }
  });

  it('changes nothing the second time and returns the very same buffer', async () => {
    const values = { DOC_CODE: 'PR-KK-001', DOC_REVISION_NO: '0' };
    const first = await fillXlsxFields(await buildStandardXlsx(), values);

    const second = await fillXlsxFields(first.buffer, values);

    expect(second.buffer).toBe(first.buffer);
    expect(second.changes).toEqual({});
  });

  it('replaces the value that is there and says what it was (a shared string and a number)', async () => {
    const buffer = await buildXlsx({ Sayfa1: { B1: 'ESKİ KOD', B2: 7 } }, { DOC_CODE: 'Sayfa1!$B$1', DOC_REVISION_NO: 'Sayfa1!$B$2' });

    const { buffer: filled, changes } = await fillXlsxFields(buffer, { DOC_CODE: 'PR-KK-009', DOC_REVISION_NO: '3' });

    expect(changes).toEqual({ DOC_CODE: { from: 'ESKİ KOD', to: 'PR-KK-009', count: 1 }, DOC_REVISION_NO: { from: '7', to: '3', count: 1 } });
    const sheet = await sheetOf(filled);
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">PR-KK-009</t></is></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">3</t></is></c>');
    expect(sheet).not.toContain('<v>7</v>');
  });

  it('puts a cell that is not there in its place: in an existing row in the order of the columns, and in a new row in the order of the rows', async () => {
    const sheetData = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="F1" t="inlineStr"><is><t>f</t></is></c></row><row r="5"><c r="A5"><v>5</v></c></row></sheetData>';
    const buffer = await withSheetXml(sheetData, { DOC_CODE: 'Sayfa1!$C$1', DOC_TITLE: 'Sayfa1!$B$3', DOC_DEPARTMENT: 'Sayfa1!$B$9', DOC_REVISION_NO: 'Sayfa1!$H$1' });

    const { buffer: filled } = await fillXlsxFields(buffer, { DOC_CODE: 'KOD', DOC_TITLE: 'AD', DOC_DEPARTMENT: 'BİRİM', DOC_REVISION_NO: '1' });

    const sheet = await sheetOf(filled);
    const cells = [...sheet.matchAll(/<c r="([A-Z]+\d+)"/g)].map((m) => m[1]);
    expect(cells).toEqual(['A1', 'C1', 'F1', 'H1', 'B3', 'A5', 'B9']);
    expect(sheet.indexOf('<row r="3">')).toBeGreaterThan(sheet.indexOf('<row r="1">'));
    expect(sheet.indexOf('<row r="3">')).toBeLessThan(sheet.indexOf('<row r="5">'));
    expect(sheet.indexOf('<row r="9">')).toBeGreaterThan(sheet.indexOf('<row r="5">'));
  });

  it('fills an empty sheet and a row that is written as an empty element', async () => {
    const empty = await fillXlsxFields(await withSheetXml('<sheetData/>', { DOC_CODE: 'Sayfa1!$B$2' }), { DOC_CODE: 'KOD' });
    expect(await sheetOf(empty.buffer)).toContain('<sheetData><row r="2"><c r="B2" t="inlineStr">');

    const emptyRow = await fillXlsxFields(await withSheetXml('<sheetData><row r="2" ht="20"/></sheetData>', { DOC_CODE: 'Sayfa1!$B$2' }), { DOC_CODE: 'KOD' });
    expect(await sheetOf(emptyRow.buffer)).toContain('<row r="2" ht="20"><c r="B2" t="inlineStr">');
  });

  it('never writes over a cell with a formula', async () => {
    const sheetData = '<sheetData><row r="1"><c r="B1" s="4"><f>A1&amp;"-x"</f><v>x-x</v></c></row></sheetData>';
    const buffer = await withSheetXml(sheetData, { DOC_CODE: 'Sayfa1!$B$1' });

    const { buffer: filled, changes } = await fillXlsxFields(buffer, { DOC_CODE: 'KOD' });

    expect(filled).toBe(buffer);
    expect(changes).toEqual({});
  });

  it('writes the value as text, never as markup, without control characters and not longer than a line of a header', async () => {
    const buffer = await buildXlsx({ Sayfa1: {} }, { DOC_TITLE: 'Sayfa1!$B$1', DOC_CODE: 'Sayfa1!$B$2' });

    const { buffer: filled, changes } = await fillXlsxFields(buffer, { DOC_TITLE: 'A & B <b>kalın</b>\n"satır"\t' + 'x'.repeat(400), DOC_CODE: '<script>' });

    const sheet = await sheetOf(filled);
    expect(sheet).toContain('A &amp; B &lt;b&gt;kalın&lt;/b&gt; "satır" xxx');
    expect(sheet).toContain('&lt;script&gt;');
    expect(sheet).not.toContain('<b>kalın');
    expect(changes.DOC_TITLE!.to).toHaveLength(300);
  });

  it('fills every cell that has the name, on every sheet, and leaves the tags it has no value for alone', async () => {
    const buffer = await buildXlsx({ Sayfa1: {}, Sayfa2: {} }, { DOC_CODE: 'Sayfa1!$B$1', DOC_TITLE: 'Sayfa2!$B$1' });
    const zip = await JSZip.loadAsync(buffer);
    zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace('</definedNames>', '<definedName name="DOC_CODE" localSheetId="1">Sayfa2!$C$4</definedName></definedNames>'));

    const { buffer: filled, changes } = await fillXlsxFields(await zip.generateAsync({ type: 'nodebuffer' }), { DOC_CODE: 'KOD' });

    expect(changes).toEqual({ DOC_CODE: { from: '', to: 'KOD', count: 2 } });
    expect(await sheetOf(filled, 'xl/worksheets/sheet1.xml')).toContain('KOD');
    expect(await sheetOf(filled, 'xl/worksheets/sheet2.xml')).toContain('<c r="C4" t="inlineStr">');
    // DOC_TITLE had no value: its sheet only has what it had
    expect(await sheetOf(filled, 'xl/worksheets/sheet2.xml')).not.toContain('<c r="B1"');
  });

  it('leaves a file without fields, a name over several cells and a broken package as they are', async () => {
    const plain = await buildXlsx({ Sayfa1: { A1: 'x' } });
    expect((await fillXlsxFields(plain, { DOC_CODE: 'KOD' })).buffer).toBe(plain);
    const range = await buildXlsx({ Sayfa1: {} }, { DOC_CODE: 'Sayfa1!$B$1:$B$2' });
    expect((await fillXlsxFields(range, { DOC_CODE: 'KOD' })).buffer).toBe(range);
    await expect(fillXlsxFields(Buffer.from('not a package'), { DOC_CODE: 'KOD' })).rejects.toBeInstanceOf(InvalidXlsxError);
  });
});
