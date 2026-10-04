import type { Task } from '../../../packages/contracts/src/index.js';

/** Includes the optional leading/trailing ellipses, measured in Unicode code points. */
export const TASK_MATCH_SNIPPET_LIMIT = 160;

export interface TaskMatchSnippet {
  before: string;
  match: string;
  after: string;
}

/** Presentation only: never use this helper to decide which Tasks match a filter.
 * Keep the original text and whole-string locale casing used by the search predicate.
 * Both clipping and highlighting expand to whole graphemes. An over-budget match
 * shows its first fitting graphemes; truncation ellipses stay outside the mark.
 * If even its first grapheme cannot fit, retain the caller's existing display.
 */
export function taskDescriptionMatchSnippet(
  task: Pick<Task, 'title' | 'shortId' | 'description'>,
  query?: string,
): TaskMatchSnippet | null {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle || `${task.title} ${task.shortId}`.toLocaleLowerCase().includes(needle)) return null;
  const source = task.description;
  const folded = source.toLocaleLowerCase();
  const found = folded.indexOf(needle);
  if (found < 0) return null;

  const offsets = [0];
  const points = [0];
  for (const { segment, index } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(source)) {
    let count = 0;
    for (const _ of segment) count++;
    offsets.push(index + segment.length);
    points.push(points.at(-1)! + count);
  }
  const last = offsets.length - 1;
  const foldedOffsets = new Map<number, number>([
    [0, 0],
    [last, folded.length],
  ]);
  // A whole prefix retains casing context within each grapheme (e.g. dotted I).
  // Context across graphemes, such as final sigma, can change letters but not
  // their offsets. Do not concatenate independently lowercased graphemes.
  function foldedOffset(boundary: number) {
    let offset = foldedOffsets.get(boundary);
    if (offset === undefined) {
      offset = source.slice(0, offsets[boundary]!).toLocaleLowerCase().length;
      foldedOffsets.set(boundary, offset);
    }
    return offset;
  }
  function boundaryAtOrAfter(offset: number) {
    let low = 0;
    let high = last;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (foldedOffset(middle) < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  const startBoundary = boundaryAtOrAfter(found);
  const matchStart = foldedOffset(startBoundary) > found ? startBoundary - 1 : startBoundary;
  const fullMatchEnd = boundaryAtOrAfter(found + needle.length);
  // Fail closed if a locale's context-dependent length changes make either
  // boundary ambiguous. This only suppresses a snippet, never the Task itself.
  for (const boundary of [matchStart, fullMatchEnd]) {
    if (
      foldedOffset(boundary) !==
      folded.length - source.slice(offsets[boundary]!).toLocaleLowerCase().length
    )
      return null;
  }
  function size(start: number, end: number) {
    return points[end]! - points[start]! + Number(start > 0) + Number(end < last);
  }
  let matchEnd = fullMatchEnd;
  if (size(matchStart, matchEnd) > TASK_MATCH_SNIPPET_LIMIT) {
    matchEnd = matchStart;
    while (matchEnd < fullMatchEnd && size(matchStart, matchEnd + 1) <= TASK_MATCH_SNIPPET_LIMIT)
      matchEnd++;
    if (matchEnd === matchStart) return null;
  }

  let start = matchStart;
  let end = matchEnd;
  if (matchEnd === fullMatchEnd) {
    // Add balanced context where it fits; never skip a large adjacent grapheme.
    while (start > 0 || end < last) {
      const canLeft = start > 0 && size(start - 1, end) <= TASK_MATCH_SNIPPET_LIMIT;
      const canRight = end < last && size(start, end + 1) <= TASK_MATCH_SNIPPET_LIMIT;
      if (!canLeft && !canRight) break;
      const leftPoints = points[matchStart]! - points[start]!;
      const rightPoints = points[end]! - points[matchEnd]!;
      if (canLeft && (!canRight || leftPoints <= rightPoints)) start--;
      else end++;
    }
  }
  return {
    before: (start > 0 ? '…' : '') + source.slice(offsets[start], offsets[matchStart]),
    match: source.slice(offsets[matchStart], offsets[matchEnd]),
    after: source.slice(offsets[matchEnd], offsets[end]) + (end < last ? '…' : ''),
  };
}
