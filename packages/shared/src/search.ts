import type { DocumentListItemDto } from './documents';

/** Full text search over the documents in force (PROJECT.md 6.16). */

export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 100;
/** Most results one search can return (they are ranked, then paged); more matches are cut off at the lowest rank. */
export const SEARCH_MAX_RESULTS = 1000;
/** Longest text of a revision that is indexed; a longer one is searchable by code and title only. */
export const SEARCH_MAX_TEXT_CHARS = 1_000_000;
export const SEARCH_MAX_SNIPPETS = 3;

/** A piece of a snippet: `match` text is what the search words hit. */
export interface SearchSnippetPartDto {
  text: string;
  match: boolean;
}

export interface SearchResultDto extends DocumentListItemDto {
  /** Where the words were found in the content, best first; empty when only the code or title matched */
  snippets: SearchSnippetPartDto[][];
}

export interface SearchQuery {
  q: string;
  departmentId?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
}
