export const SEED_DEPARTMENTS = [{ name: 'Kalite Koordinatörlüğü', code: 'KK' }];

export const SEED_CATEGORIES = [
  { sortOrder: 1, name: 'Prosedürler', slug: 'procedures', codePrefix: 'PR' },
  { sortOrder: 2, name: 'Talimatlar', slug: 'instructions', codePrefix: 'TL' },
  { sortOrder: 3, name: 'Formlar', slug: 'forms', codePrefix: 'FR' },
  { sortOrder: 4, name: 'Listeler', slug: 'lists', codePrefix: 'LS' },
  { sortOrder: 5, name: 'Planlar', slug: 'plans', codePrefix: 'PL' },
  { sortOrder: 6, name: 'Raporlar', slug: 'reports', codePrefix: 'RP' },
  { sortOrder: 7, name: 'Kılavuzlar', slug: 'guides', codePrefix: 'KL' },
  { sortOrder: 8, name: 'El Kitapları', slug: 'handbooks', codePrefix: 'EK' },
  { sortOrder: 9, name: 'Görev Tanımları', slug: 'job-descriptions', codePrefix: 'GT' },
  { sortOrder: 10, name: 'Organizasyon Şemaları', slug: 'org-charts', codePrefix: 'OS' },
  { sortOrder: 11, name: 'İş Akışları', slug: 'workflows', codePrefix: 'IA' },
  { sortOrder: 12, name: 'Yönetim Dokümanları', slug: 'management-documents', codePrefix: 'YD' },
  { sortOrder: 13, name: 'Sözleşmeler', slug: 'contracts', codePrefix: 'SZ' },
  { sortOrder: 14, name: 'Protokoller', slug: 'protocols', codePrefix: 'PT' },
  {
    sortOrder: 15,
    name: 'Dış Kaynaklı Dokümanlar',
    slug: 'external-documents',
    codePrefix: 'DK',
    isExternal: true,
  },
];

export const SEED_TEMPLATES = [
  { name: 'Boş Word Şablonu', fileType: 'DOCX', fileName: 'blank.docx' },
  { name: 'Boş Excel Şablonu', fileType: 'XLSX', fileName: 'blank.xlsx' },
] as const;
