import { SEARCH_MAX_SNIPPETS, type SearchSnippetPartDto } from '@iso-dms/shared';

/**
 * Text for searching (PROJECT.md 6.16). Both the indexed text and the query are folded the same way: letters lose
 * their accents and Turkish marks (ş→s, ı/İ→i, ğ→g ...), everything that is not a letter or digit becomes a space.
 * The fold keeps **one character for one character**, so a position in the folded text is a position in the
 * original, which is what makes the snippets (cut from the original, matched in the folded text) possible.
 * PostgreSQL's own Turkish stemmer is not used: it lowercases by the database locale, which turns "I" into "i"
 * instead of "ı", and it would miss words written without Turkish characters.
 */

const FOLD: Record<string, string> = {
  ş: 's', Ş: 's', ı: 'i', İ: 'i', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c',
  â: 'a', Â: 'a', î: 'i', Î: 'i', û: 'u', Û: 'u', ê: 'e', Ê: 'e', ô: 'o', Ô: 'o',
  é: 'e', É: 'e', è: 'e', È: 'e', ë: 'e', Ë: 'e', á: 'a', Á: 'a', à: 'a', À: 'a', ä: 'a', Ä: 'a',
  í: 'i', Í: 'i', ó: 'o', Ó: 'o', ú: 'u', Ú: 'u', ñ: 'n', Ñ: 'n',
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function foldUnit(unit: string): string {
  const mapped = FOLD[unit];
  if (mapped) return mapped;
  const lower = unit.toLowerCase();
  // A letter whose lowercase form is longer would shift every later position: keep it as it is
  const folded = lower.length === 1 ? lower : unit;
  return LETTER_OR_DIGIT.test(folded) ? folded : ' ';
}

/** Same length as the input. Callers normalise the text to NFC first so accents are single characters. */
export function foldForSearch(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) result += foldUnit(text[i]);
  return result;
}

/** The words of the query: bare words, and quoted phrases (several words that have to follow each other). */
export type QueryGroup = string[];

export const QUERY_MAX_GROUPS = 10;

export function parseSearchQuery(query: string): QueryGroup[] {
  const groups: QueryGroup[] = [];
  const pieces = query.normalize('NFC').matchAll(/"([^"]*)"|([^\s"]+)/g);
  for (const piece of pieces) {
    const words = foldForSearch(piece[1] ?? piece[2]).split(' ').filter(Boolean);
    if (words.length === 0) continue;
    // A quoted phrase stays together; a bare piece such as "PR-KK-001" is cut at its punctuation but also has to stay together
    groups.push(words);
    if (groups.length >= QUERY_MAX_GROUPS) break;
  }
  return groups;
}

/** to_tsquery text: every word a prefix, the words of a group next to each other, the groups all required. */
export function toTsQuery(groups: QueryGroup[]): string {
  return groups.map((words) => words.map((word) => `'${word}':*`).join(' <-> ')).join(' & ');
}

/** What goes into to_tsvector: folded, so punctuation cannot join or split words differently from the query. */
export function toIndexText(...parts: string[]): string {
  return foldForSearch(parts.join(' ').normalize('NFC'));
}

const SNIPPET_WIDTH = 200;
const SNIPPET_LEAD = 70;

/** Up to three pieces of the content around the places the words were found, the hits marked. */
export function buildSnippets(content: string, groups: QueryGroup[]): SearchSnippetPartDto[][] {
  const words = [...new Set(groups.flat())].sort((a, b) => b.length - a.length);
  if (words.length === 0 || content.length === 0) return [];

  const folded = foldForSearch(content);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})[\\p{L}\\p{N}]*`, 'gu');
  const hits = [...folded.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

  const snippets: SearchSnippetPartDto[][] = [];
  let windowEnd = -1;
  for (const hit of hits) {
    if (snippets.length >= SEARCH_MAX_SNIPPETS) break;
    if (hit.start < windowEnd) continue;

    let start = Math.max(0, hit.start - SNIPPET_LEAD);
    let end = Math.min(content.length, start + SNIPPET_WIDTH);
    // Cut at word boundaries, unless that would lose the hit
    if (start > 0) {
      const space = folded.indexOf(' ', start);
      if (space >= 0 && space < hit.start) start = space + 1;
    }
    if (end < content.length) {
      const space = folded.lastIndexOf(' ', end);
      if (space > hit.end) end = space;
    }
    windowEnd = end;

    const parts: SearchSnippetPartDto[] = [];
    let cursor = start;
    for (const inside of hits) {
      if (inside.end <= start || inside.start >= end) continue;
      const from = Math.max(inside.start, start);
      const to = Math.min(inside.end, end);
      if (from > cursor) parts.push({ text: content.slice(cursor, from), match: false });
      parts.push({ text: content.slice(from, to), match: true });
      cursor = to;
    }
    if (cursor < end) parts.push({ text: content.slice(cursor, end), match: false });

    if (start > 0) parts[0] = { ...parts[0], text: `…${parts[0].text}` };
    if (end < content.length) parts[parts.length - 1] = { ...parts[parts.length - 1], text: `${parts[parts.length - 1].text}…` };
    snippets.push(parts.map((part) => ({ ...part, text: part.text.replace(/\s+/g, ' ') })));
  }
  return snippets;
}
