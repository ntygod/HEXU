/** A display comparison of already-shared complete text, never an applicable patch. */
export interface TextLine {
  text: string;
  ending: 'LF' | 'CRLF' | 'CR' | 'none';
}
export interface DifferenceLine extends TextLine {
  kind: 'context' | 'addition' | 'deletion';
  before: number | null;
  after: number | null;
}
export type TextLineComparison =
  | { kind: 'diff'; rows: DifferenceLine[]; added: number; removed: number }
  | { kind: 'fallback'; reason: 'size' | 'complexity' };
export const LINE_DIFFERENCE_LIMITS = {
  characters: 32768,
  lines: 2000,
  cells: 250000,
} as const;
function lines(text: string): TextLine[] {
  const result: TextLine[] = [];
  const ending = /\r\n|\r|\n/g;
  let offset = 0;
  for (const match of text.matchAll(ending)) {
    result.push({
      text: text.slice(offset, match.index),
      ending: match[0] === '\r\n' ? 'CRLF' : match[0] === '\r' ? 'CR' : 'LF',
    });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) result.push({ text: text.slice(offset), ending: 'none' });
  return result;
}
/** Read-only excerpt from already-shared text, with the same line boundaries. */
export function textLineRange(text: string, start: number, end: number): TextLine[] {
  return lines(text).slice(start - 1, end);
}
/** Same line numbering as the diff, including CRLF/CR and an unterminated tail. */
export function countTextLines(text: string): number {
  let count = 0;
  for (const _ of text.matchAll(/\r\n|\r|\n/g)) count++;
  return count + (text && !/[\r\n]$/.test(text) ? 1 : 0);
}
const same = (a: TextLine, b: TextLine) => a.text === b.text && a.ending === b.ending;
export function compareTextLines(before: string, after: string): TextLineComparison {
  if (before.length + after.length > LINE_DIFFERENCE_LIMITS.characters)
    return { kind: 'fallback', reason: 'size' };
  const a = lines(before),
    b = lines(after);
  if (a.length + b.length > LINE_DIFFERENCE_LIMITS.lines)
    return { kind: 'fallback', reason: 'size' };
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && same(a[prefix]!, b[prefix]!)) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    same(a[a.length - suffix - 1]!, b[b.length - suffix - 1]!)
  )
    suffix++;
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix;
  // Bound work before allocating the matrix. No partial comparison is called complete.
  if (n && m && (n + 1) * (m + 1) > LINE_DIFFERENCE_LIMITS.cells)
    return { kind: 'fallback', reason: 'complexity' };
  const rows: DifferenceLine[] = [];
  const emit = (kind: DifferenceLine['kind'], x: number | null, y: number | null) => {
    rows.push({
      ...(x === null ? b[y!] : a[x])!,
      kind,
      before: x === null ? null : x + 1,
      after: y === null ? null : y + 1,
    });
  };
  for (let i = 0; i < prefix; i++) emit('context', i, i);
  if (!n || !m) {
    for (let i = 0; i < n; i++) emit('deletion', prefix + i, null);
    for (let j = 0; j < m; j++) emit('addition', null, prefix + j);
  } else {
    const width = m + 1,
      lcs = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * width + j] = same(a[prefix + i]!, b[prefix + j]!)
          ? 1 + lcs[(i + 1) * width + j + 1]!
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && same(a[prefix + i]!, b[prefix + j]!)) {
        emit('context', prefix + i++, prefix + j++);
      } else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        emit('deletion', prefix + i++, null);
      } else emit('addition', null, prefix + j++);
    }
  }
  for (let i = suffix; i > 0; i--) emit('context', a.length - i, b.length - i);
  return {
    kind: 'diff',
    rows,
    added: rows.filter((r) => r.kind === 'addition').length,
    removed: rows.filter((r) => r.kind === 'deletion').length,
  };
}
