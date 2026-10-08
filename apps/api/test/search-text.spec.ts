import { buildSnippets, foldForSearch, parseSearchQuery, toIndexText, toTsQuery } from '../src/modules/search/search-text';

describe('foldForSearch', () => {
  it('turns Turkish letters into ASCII, both cases, and lowercases', () => {
    expect(foldForSearch('ŞİKÂYET ışık ĞÜÖÇ ğüöç İI')).toBe('sikayet isik guoc guoc ii');
  });

  it('turns everything that is not a letter or a digit into a space', () => {
    expect(foldForSearch('PR-KK-001; (a.b) "x"\n\ty')).toBe('pr kk 001   a b   x   y');
  });

  it('keeps letters of other scripts and digits', () => {
    expect(foldForSearch('Привет 123 日本')).toBe('привет 123 日本');
  });

  it('keeps one character for one character, whatever the text (positions stay valid)', () => {
    for (const text of ['İstanbul İİİ', 'ǅ ß ŉ ﬃ', 'ȧb', '😀 emoji 😀', 'Ünite 3 — Ölçüm']) {
      expect(foldForSearch(text)).toHaveLength(text.length);
    }
  });
});

describe('parseSearchQuery', () => {
  it('makes a group of every bare word and of every quoted phrase', () => {
    expect(parseSearchQuery('saklama "süre sonu" Kayıt')).toEqual([['saklama'], ['sure', 'sonu'], ['kayit']]);
  });

  it('cuts words at punctuation but keeps what was typed together as one group', () => {
    expect(parseSearchQuery('PR-KK-001')).toEqual([['pr', 'kk', '001']]);
  });

  it('ignores pieces without letters or digits and an unclosed quote still works', () => {
    expect(parseSearchQuery('--- & ! ()')).toEqual([]);
    expect(parseSearchQuery('"saklama süresi')).toEqual([['saklama'], ['suresi']]);
    expect(parseSearchQuery('""')).toEqual([]);
  });

  it('takes at most ten groups', () => {
    expect(parseSearchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))).toHaveLength(10);
  });
});

describe('toTsQuery', () => {
  it('makes every word a prefix, joins a phrase with <-> and the groups with &', () => {
    expect(toTsQuery([['saklama'], ['sure', 'sonu']])).toBe("'saklama':* & 'sure':* <-> 'sonu':*");
  });

  it('cannot carry query operators: only letters and digits survive the fold', () => {
    const query = toTsQuery(parseSearchQuery("a' | !b & (c):* <-> d'; drop"));
    expect(query).toMatch(/^('[\p{L}\p{N}]+':\*)( <-> '[\p{L}\p{N}]+':\*)*( & ('[\p{L}\p{N}]+':\*)( <-> '[\p{L}\p{N}]+':\*)*)*$/u);
  });
});

describe('toIndexText', () => {
  it('folds the parts together, normalising accents first', () => {
    expect(toIndexText('PR-KK-001', 'Müşteri Şikâyetleri')).toBe('pr kk 001 musteri sikayetleri');
    // "ş" written as s + combining cedilla becomes the single letter first
    expect(toIndexText('ş')).toBe('s');
  });
});

describe('buildSnippets', () => {
  const content = 'Müşteri şikâyetleri kayda alınır. '.repeat(3) + 'Kayıtlar on yıl süreyle saklanır. ' + 'Başka bir cümle. '.repeat(30) + 'Saklama süresi dolan kayıtlar imha edilir.';

  it('marks the hits and keeps the original text, case and Turkish letters', () => {
    const [snippet] = buildSnippets('Müşteri Şikâyetleri kayda alınır.', parseSearchQuery('sikayet'));
    expect(snippet).toEqual([
      { text: 'Müşteri ', match: false },
      { text: 'Şikâyetleri', match: true },
      { text: ' kayda alınır.', match: false },
    ]);
  });

  it('matches the start of words only', () => {
    expect(buildSnippets('Prosedürler ve yordamlar', parseSearchQuery('dur'))).toEqual([]);
    expect(buildSnippets('Prosedürler ve yordamlar', parseSearchQuery('prosedur'))).toHaveLength(1);
  });

  it('shows at most three places, each with ellipses where the text goes on', () => {
    const snippets = buildSnippets(content, parseSearchQuery('kayıt'));
    expect(snippets.length).toBeLessThanOrEqual(3);
    expect(snippets.length).toBeGreaterThan(1);
    for (const snippet of snippets) {
      expect(snippet.some((part) => part.match)).toBe(true);
      expect(snippet.map((part) => part.text).join('').length).toBeLessThan(260);
    }
    expect(snippets[snippets.length - 1].map((p) => p.text).join('').startsWith('…') || snippets[0].map((p) => p.text).join('').endsWith('…')).toBe(true);
  });

  it('puts an ellipsis at the cut ends only', () => {
    const [snippet] = buildSnippets('kısa bir kayıt', parseSearchQuery('kayit'));
    const text = snippet.map((part) => part.text).join('');
    expect(text).toBe('kısa bir kayıt');
  });

  it('replaces line breaks with spaces and highlights every query word', () => {
    const [snippet] = buildSnippets('saklama\nsüresi dolan', parseSearchQuery('saklama suresi'));
    expect(snippet.map((part) => part.text).join('')).toBe('saklama süresi dolan');
    expect(snippet.filter((part) => part.match).map((part) => part.text)).toEqual(['saklama', 'süresi']);
  });

  it('finds nothing in empty content or without words', () => {
    expect(buildSnippets('', parseSearchQuery('a'))).toEqual([]);
    expect(buildSnippets('metin', [])).toEqual([]);
  });
});
