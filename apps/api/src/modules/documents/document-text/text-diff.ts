import type { CompareBlockDto, CompareCellDto, CompareSegmentDto, CompareSummaryDto } from '@iso-dms/shared';
import { diffArrays, diffWordsWithSpace } from 'diff';
import type { WorksheetCell } from './xlsx-text';

/** Below this share of common text a replaced paragraph is shown as removed + added instead of as edited. */
const MIN_SIMILARITY = 0.4;

function wordSegments(from: string, to: string): { segments: CompareSegmentDto[]; similarity: number } {
  const segments: CompareSegmentDto[] = [];
  let common = 0;
  for (const part of diffWordsWithSpace(from, to)) {
    const type = part.added ? 'added' : part.removed ? 'removed' : 'equal';
    if (type === 'equal') common += part.value.length;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += part.value;
    else segments.push({ type, text: part.value });
  }
  return { segments, similarity: common / Math.max(from.length, to.length, 1) };
}

export function summarize(items: { kind: string }[]): CompareSummaryDto {
  const count = (kind: string) => items.filter((item) => item.kind === kind).length;
  return { added: count('added'), removed: count('removed'), changed: count('changed') };
}

/**
 * Paragraph level difference: paragraphs are matched as a whole, and where a run of removed paragraphs meets a
 * run of added ones they are paired in order; a pair that is alike enough is an edited paragraph shown by word.
 */
export function diffParagraphs(from: string[], to: string[]): CompareBlockDto[] {
  const blocks: CompareBlockDto[] = [];
  const parts = diffArrays(from, to);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const text of part.value) blocks.push({ kind: 'equal', segments: [{ type: 'equal', text }] });
      continue;
    }
    // jsdiff lists a removal before the addition that replaces it
    const next = parts[i + 1];
    const pairedWithNext = part.removed === true && next?.added === true;
    const removed = part.removed ? part.value : [];
    const added = part.added ? part.value : pairedWithNext ? next.value : [];
    if (pairedWithNext) i++;

    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index++) {
      const edit = wordSegments(removed[index], added[index]);
      if (edit.similarity >= MIN_SIMILARITY) {
        blocks.push({ kind: 'changed', segments: edit.segments });
      } else {
        // Not alike: not an edit, both paragraphs are listed as they are
        blocks.push({ kind: 'removed', segments: [{ type: 'removed', text: removed[index] }] });
        blocks.push({ kind: 'added', segments: [{ type: 'added', text: added[index] }] });
      }
    }
    for (const text of removed.slice(paired)) blocks.push({ kind: 'removed', segments: [{ type: 'removed', text }] });
    for (const text of added.slice(paired)) blocks.push({ kind: 'added', segments: [{ type: 'added', text }] });
  }
  return blocks;
}

function columnNumber(letters: string): number {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

/** The cells that differ, sheet by sheet (sheets of the new revision first), in reading order inside a sheet. */
export function diffCells(from: WorksheetCell[], to: WorksheetCell[]): CompareCellDto[] {
  const key = (cell: WorksheetCell) => `${cell.sheet}\u0000${cell.address}`;
  const before = new Map(from.map((cell) => [key(cell), cell]));
  const after = new Map(to.map((cell) => [key(cell), cell]));
  const result: CompareCellDto[] = [];

  for (const cell of from) {
    const other = after.get(key(cell));
    if (!other) result.push({ kind: 'removed', sheet: cell.sheet, address: cell.address, from: cell.value, to: null });
    else if (other.value !== cell.value) {
      result.push({ kind: 'changed', sheet: cell.sheet, address: cell.address, from: cell.value, to: other.value });
    }
  }
  for (const cell of to) {
    if (!before.has(key(cell))) result.push({ kind: 'added', sheet: cell.sheet, address: cell.address, from: null, to: cell.value });
  }

  const sheetOrder = [...new Set([...to, ...from].map((cell) => cell.sheet))];
  const position = (cell: CompareCellDto) => {
    const match = /^([A-Z]+)(\d+)$/.exec(cell.address);
    return [sheetOrder.indexOf(cell.sheet), match ? Number(match[2]) : 0, match ? columnNumber(match[1]) : 0];
  };
  return result.sort((a, b) => {
    const [sa, ra, ca] = position(a);
    const [sb, rb, cb] = position(b);
    return sa - sb || ra - rb || ca - cb;
  });
}
