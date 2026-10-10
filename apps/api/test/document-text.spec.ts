import { UnprocessableEntityException } from '@nestjs/common';
import JSZip from 'jszip';
import { extractDocxParagraphs } from '../src/modules/documents/document-text/docx-text';
import { diffCells, diffParagraphs, summarize } from '../src/modules/documents/document-text/text-diff';
import { UnreadableDocumentError } from '../src/modules/documents/document-text/text-limits';
import { extractXlsxCells } from '../src/modules/documents/document-text/xlsx-text';
import { buildDocx, buildXlsx, field, paragraph } from './helpers/office-builders';

describe('extractDocxParagraphs', () => {
  it('joins the runs of a paragraph, keeps Turkish characters and drops empty paragraphs', async () => {
    const buffer = await buildDocx(`${paragraph('Müşteri ', 'şikâyetleri', ' kayda alınır.')}<w:p/><w:p><w:r><w:t></w:t></w:r></w:p>${paragraph('İkinci   paragraf')}`);

    expect(await extractDocxParagraphs(buffer)).toEqual(['Müşteri şikâyetleri kayda alınır.', 'İkinci paragraf']);
  });

  it('reads the paragraphs of tables in reading order and decodes entities', async () => {
    const table = `<w:tbl><w:tr><w:tc>${paragraph('A & B')}</w:tc><w:tc>${paragraph('Hücre 2')}</w:tc></w:tr></w:tbl>`;
    const buffer = await buildDocx(`${paragraph('Önce')}${table}${paragraph('Sonra')}`);

    expect(await extractDocxParagraphs(buffer)).toEqual(['Önce', 'A & B', 'Hücre 2', 'Sonra']);
  });

  it('turns tabs and line breaks into spaces and leaves out the document fields', async () => {
    const withBreaks = '<w:p><w:r><w:t>satır</w:t><w:br/><w:t>sonu</w:t><w:tab/><w:t>sekme</w:t></w:r></w:p>';
    const buffer = await buildDocx(`${field('DOC_REVISION_NO', '3')}${withBreaks}${field('SOMETHING_ELSE', 'kalır')}`);

    expect(await extractDocxParagraphs(buffer)).toEqual(['satır sonu sekme', 'kalır']);
  });

  it('refuses what is not a Word package', async () => {
    await expect(extractDocxParagraphs(Buffer.from('plain text'))).rejects.toBeInstanceOf(UnreadableDocumentError);
    const noBody = await JSZip.loadAsync(await buildDocx(''));
    noBody.remove('word/document.xml');
    await expect(extractDocxParagraphs(await noBody.generateAsync({ type: 'nodebuffer' }))).rejects.toBeInstanceOf(UnreadableDocumentError);
  });

  it('refuses a document with more paragraphs than can be compared', async () => {
    const buffer = await buildDocx(paragraph('x').repeat(20_001));
    await expect(extractDocxParagraphs(buffer)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('refuses a part that unpacks to far more than it should (zip bomb)', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(paragraph('x')));
    zip.file('word/document.xml', Buffer.alloc(31 * 1024 * 1024, 0x20), { compression: 'DEFLATE' });
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bomb.length).toBeLessThan(1024 * 1024);

    await expect(extractDocxParagraphs(bomb)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('extractXlsxCells', () => {
  it('reads text through the shared strings and numbers as stored, sheet by sheet', async () => {
    const buffer = await buildXlsx({ Sayfa1: { A1: 'Ürün', B1: 12.5, A2: 'Çay' }, Özet: { A1: 'Toplam' } });

    expect(await extractXlsxCells(buffer)).toEqual([
      { sheet: 'Sayfa1', address: 'A1', value: 'Ürün' },
      { sheet: 'Sayfa1', address: 'B1', value: '12.5' },
      { sheet: 'Sayfa1', address: 'A2', value: 'Çay' },
      { sheet: 'Özet', address: 'A1', value: 'Toplam' },
    ]);
  });

  it('reads inline strings and formulas without a stored value, and skips empty cells', async () => {
    const zip = await JSZip.loadAsync(await buildXlsx({ Sayfa1: { A1: 'x' } }));
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>satır içi</t></is></c><c r="B1"><f>SUM(A2:A3)</f></c><c r="C1" t="s"/><c r="D1"><v>3</v><f>1+2</f></c></row></sheetData></worksheet>',
    );
    const cells = await extractXlsxCells(await zip.generateAsync({ type: 'nodebuffer' }));

    expect(cells).toEqual([
      { sheet: 'Sayfa1', address: 'A1', value: 'satır içi' },
      { sheet: 'Sayfa1', address: 'B1', value: '=SUM(A2:A3)' },
      { sheet: 'Sayfa1', address: 'D1', value: '3' },
    ]);
  });

  it('leaves out the cells of the document fields: the application writes them and they change with every revision', async () => {
    const buffer = await buildXlsx({ Sayfa1: { A1: 'Kod', B1: 'PR-KK-001', A2: 'Ürün', B2: 'Çay' } }, { DOC_CODE: 'Sayfa1!$B$1' });

    expect((await extractXlsxCells(buffer)).map((cell) => `${cell.address}=${cell.value}`)).toEqual(['A1=Kod', 'A2=Ürün', 'B2=Çay']);
  });

  it('refuses what is not an Excel package', async () => {
    await expect(extractXlsxCells(Buffer.from('plain text'))).rejects.toBeInstanceOf(UnreadableDocumentError);
  });
});

describe('diffParagraphs', () => {
  const kinds = (blocks: ReturnType<typeof diffParagraphs>) => blocks.map((block) => block.kind);

  it('marks everything equal for the same text', () => {
    const blocks = diffParagraphs(['a', 'b'], ['a', 'b']);
    expect(kinds(blocks)).toEqual(['equal', 'equal']);
    expect(summarize(blocks)).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('finds added and removed paragraphs', () => {
    const blocks = diffParagraphs(['bir', 'iki', 'üç'], ['bir', 'üç', 'dört']);
    expect(kinds(blocks)).toEqual(['equal', 'removed', 'equal', 'added']);
    expect(blocks[1].segments).toEqual([{ type: 'removed', text: 'iki' }]);
    expect(blocks[3].segments).toEqual([{ type: 'added', text: 'dört' }]);
    expect(summarize(blocks)).toEqual({ added: 1, removed: 1, changed: 0 });
  });

  it('shows an edited paragraph by word', () => {
    const blocks = diffParagraphs(
      ['Kayıtlar beş yıl süreyle saklanır.', 'son'],
      ['Kayıtlar on yıl süreyle saklanır.', 'son'],
    );
    expect(kinds(blocks)).toEqual(['changed', 'equal']);
    expect(blocks[0].segments.map((s) => `${s.type}:${s.text}`)).toEqual([
      'equal:Kayıtlar ',
      'removed:beş',
      'added:on',
      'equal: yıl süreyle saklanır.',
    ]);
  });

  it('does not call a paragraph that was replaced by an unrelated one an edit', () => {
    const blocks = diffParagraphs(['Tamamen farklı bir cümle burada'], ['xyz 123']);
    expect(kinds(blocks)).toEqual(['removed', 'added']);
  });

  it('handles an empty side', () => {
    expect(kinds(diffParagraphs([], ['a']))).toEqual(['added']);
    expect(kinds(diffParagraphs(['a'], []))).toEqual(['removed']);
    expect(diffParagraphs([], [])).toEqual([]);
  });

  it('pairs a run of replaced paragraphs in order and lists the surplus ones', () => {
    const blocks = diffParagraphs(['a1 b1 c1', 'x'], ['a1 b2 c1', 'y', 'z']);
    expect(summarize(blocks)).toEqual({ added: 2, removed: 1, changed: 1 });
  });
});

describe('diffCells', () => {
  it('lists added, removed and changed cells in sheet and reading order', () => {
    const before = [
      { sheet: 'S', address: 'A1', value: 'aynı' },
      { sheet: 'S', address: 'B2', value: 'eski' },
      { sheet: 'S', address: 'C3', value: 'silinecek' },
    ];
    const after = [
      { sheet: 'S', address: 'A1', value: 'aynı' },
      { sheet: 'S', address: 'B2', value: 'yeni' },
      { sheet: 'S', address: 'A10', value: 'eklenen' },
      { sheet: 'T', address: 'A1', value: 'yeni sayfa' },
    ];

    const cells = diffCells(before, after);

    expect(cells).toEqual([
      { kind: 'changed', sheet: 'S', address: 'B2', from: 'eski', to: 'yeni' },
      { kind: 'removed', sheet: 'S', address: 'C3', from: 'silinecek', to: null },
      { kind: 'added', sheet: 'S', address: 'A10', from: null, to: 'eklenen' },
      { kind: 'added', sheet: 'T', address: 'A1', from: null, to: 'yeni sayfa' },
    ]);
    expect(summarize(cells)).toEqual({ added: 2, removed: 1, changed: 1 });
  });

  it('finds nothing in equal sheets', () => {
    const cells = [{ sheet: 'S', address: 'A1', value: '1' }];
    expect(diffCells(cells, cells)).toEqual([]);
  });
});
