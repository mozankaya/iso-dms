import { buildDownloadFileName, contentDisposition } from '../src/modules/revisions/download-file-name';

describe('buildDownloadFileName', () => {
  const base = { code: 'PR-KK-001', revisionNo: 2, extension: 'docx' };

  it('puts code, title and revision in the name', () => {
    expect(buildDownloadFileName({ ...base, title: 'Doküman Kontrol Prosedürü' })).toBe(
      'PR-KK-001 Doküman Kontrol Prosedürü (Rev 2).docx',
    );
  });

  it('removes characters that are not allowed in file names', () => {
    expect(buildDownloadFileName({ ...base, title: 'Plan: 2026/Q1 *taslak* <v2> "a" | b\\c?' })).toBe(
      'PR-KK-001 Plan 2026 Q1 taslak v2 a b c (Rev 2).docx',
    );
  });

  it('collapses whitespace and control characters', () => {
    expect(buildDownloadFileName({ ...base, title: '  İki   boşluk\n\tsatır  ' })).toBe(
      'PR-KK-001 İki boşluk satır (Rev 2).docx',
    );
  });

  it('shortens very long titles', () => {
    const name = buildDownloadFileName({ ...base, title: 'x'.repeat(300) });
    expect(name).toBe(`PR-KK-001 ${'x'.repeat(100)} (Rev 2).docx`);
  });

  it('falls back to the code when the title has nothing usable', () => {
    expect(buildDownloadFileName({ ...base, title: '???' })).toBe('PR-KK-001 (Rev 2).docx');
  });

  it('uses the extension of the file type', () => {
    expect(buildDownloadFileName({ ...base, title: 'Tablo', extension: 'xlsx' })).toBe('PR-KK-001 Tablo (Rev 2).xlsx');
  });
});

describe('contentDisposition', () => {
  it('sends the real name UTF-8 encoded and a transliterated ASCII fallback', () => {
    const header = contentDisposition('PR-KK-001 Eğitim Şablonu (Rev 0).docx');

    expect(header).toBe(
      `attachment; filename="PR-KK-001 Egitim Sablonu (Rev 0).docx"; filename*=UTF-8''PR-KK-001%20E%C4%9Fitim%20%C5%9Eablonu%20%28Rev%200%29.docx`,
    );
  });

  it('transliterates every Turkish letter', () => {
    const header = contentDisposition('çÇğĞıİöÖşŞüÜ.docx');
    expect(header).toContain('filename="cCgGiIoOsSuU.docx"');
  });

  it('keeps quotes and other non-ASCII characters from breaking the header', () => {
    const header = contentDisposition('a"b\\c € 日本.docx');

    expect(header).toContain('filename="a_b_c _ __.docx"');
    expect(header.split('filename*=')[1]).toMatch(/^UTF-8''[A-Za-z0-9%._-]+$/);
  });

  it('can always be decoded back to the original name', () => {
    const name = "Ayşe'nin (özel) *plan*.xlsx";
    const encoded = contentDisposition(name).split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe(name);
  });
});
