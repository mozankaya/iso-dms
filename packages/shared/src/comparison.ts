import type { FileType, RevisionStatus } from './documents';

/**
 * Comparison of two revisions of one document (PROJECT.md 6.15). Only text is compared: formatting, pictures and
 * the document fields in the headers are not.
 */

/** Upper bounds on what is compared; larger files are refused instead of being cut short. */
export const COMPARE_MAX_TEXT_CHARS = 2_000_000;
export const COMPARE_MAX_BLOCKS = 20_000;

export type CompareSegmentType = 'equal' | 'added' | 'removed';

/** A piece of a changed paragraph: `equal` text is in both revisions, `removed` only in the old one, `added` only in the new one. */
export interface CompareSegmentDto {
  type: CompareSegmentType;
  text: string;
}

/** One paragraph of a Word file. `equal`, `added` and `removed` carry a single segment; `changed` is cut up by word. */
export interface CompareBlockDto {
  kind: 'equal' | 'added' | 'removed' | 'changed';
  segments: CompareSegmentDto[];
}

/** One cell of an Excel file that is not the same in both revisions. */
export interface CompareCellDto {
  kind: 'added' | 'removed' | 'changed';
  sheet: string;
  address: string;
  from: string | null;
  to: string | null;
}

export interface CompareSideDto {
  id: string;
  revisionNo: number;
  status: RevisionStatus;
}

export interface CompareSummaryDto {
  added: number;
  removed: number;
  changed: number;
}

export interface RevisionComparisonDto {
  fileType: FileType;
  from: CompareSideDto;
  to: CompareSideDto;
  summary: CompareSummaryDto;
  /** Word files: every paragraph in order (the unchanged ones too, so the changes can be read in context) */
  blocks: CompareBlockDto[];
  /** Excel files: the cells that differ */
  cells: CompareCellDto[];
}
