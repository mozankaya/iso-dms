/** All user-facing text lives here so more languages can be added later. */
export const tr = {
  app: {
    title: "Kalite Doküman Yönetim Sistemi",
    shortTitle: "KDYS",
    description: "ISO 9001:2015 Kalite Doküman Yönetim Sistemi",
  },
  common: {
    loading: "Yükleniyor...",
    retry: "Tekrar dene",
    menu: "Menü",
    closeMenu: "Menüyü kapat",
  },
  auth: {
    loginTitle: "Giriş Yap",
    loginSubtitle: "Hesabınızla oturum açın",
    email: "E-posta",
    password: "Şifre",
    submit: "Giriş Yap",
    submitting: "Giriş yapılıyor...",
    logout: "Çıkış Yap",
  },
  validation: {
    emailRequired: "E-posta adresi gerekli",
    emailInvalid: "Geçerli bir e-posta adresi girin",
    passwordRequired: "Şifre gerekli",
  },
  dashboard: {
    title: "Ana Sayfa",
    totalDocuments: "Toplam Doküman",
    categories: "Kategoriler",
    documentCount: (count: number) => `${count} doküman`,
    noCategories: "Henüz kategori tanımlanmamış.",
    categoriesError: "Kategoriler yüklenemedi.",
    statsError: "Sayaçlar yüklenemedi.",
  },
  category: {
    notFound: "Kategori bulunamadı.",
    backToHome: "Ana sayfaya dön",
  },
  documents: {
    columns: {
      code: "Doküman Kodu",
      title: "Doküman Adı",
      department: "Birim",
      firstPublishedAt: "İlk Yayın Tarihi",
      revisedAt: "Revizyon Tarihi",
      revisionNo: "Revizyon No",
    },
    tableLabel: "Doküman listesi",
    searchLabel: "Doküman ara",
    searchPlaceholder: "Kod veya ad ile ara...",
    departmentFilter: "Birim",
    allDepartments: "Tüm birimler",
    statusFilter: "Durum",
    allStatuses: "Tüm durumlar",
    sortLabel: "Sıralama",
    ascending: "artan",
    descending: "azalan",
    clearFilters: "Filtreleri temizle",
    empty: "Bu kategoride henüz doküman yok.",
    emptyFiltered: "Aramanızla eşleşen doküman bulunamadı.",
    error: "Dokümanlar yüklenemedi.",
    total: (count: number) => `${count} doküman`,
    pageOf: (page: number, totalPages: number) => `Sayfa ${page} / ${totalPages}`,
    previousPage: "Önceki",
    nextPage: "Sonraki",
    pagination: "Sayfalama",
    status: {
      DRAFT: "Taslak",
      IN_REVIEW: "Onayda",
      PUBLISHED: "Yayında",
      WITHDRAWN: "GEÇERSİZ",
    },
  },
  nav: {
    home: "Ana Sayfa",
    categories: "Kategoriler",
  },
  errors: {
    INVALID_CREDENTIALS: "E-posta veya şifre hatalı.",
    UNAUTHORIZED: "Oturum açmanız gerekiyor.",
    INVALID_TOKEN: "Oturumunuz sona erdi. Lütfen tekrar giriş yapın.",
    INVALID_REFRESH_TOKEN: "Oturumunuz sona erdi. Lütfen tekrar giriş yapın.",
    FORBIDDEN: "Bu işlem için yetkiniz yok.",
    TOO_MANY_REQUESTS: "Çok fazla deneme yaptınız. Lütfen biraz bekleyip tekrar deneyin.",
    NETWORK: "Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.",
    UNKNOWN: "Beklenmeyen bir hata oluştu.",
  },
} as const;

type ErrorCode = keyof typeof tr.errors;

/** Maps an API error (code and/or HTTP status) to a Turkish message. */
export function errorMessage(error: { code?: string; status?: number }): string {
  if (error.code && error.code in tr.errors) {
    return tr.errors[error.code as ErrorCode];
  }
  if (error.status === 429) return tr.errors.TOO_MANY_REQUESTS;
  if (error.status === 401) return tr.errors.UNAUTHORIZED;
  if (error.status === 403) return tr.errors.FORBIDDEN;
  return tr.errors.UNKNOWN;
}
