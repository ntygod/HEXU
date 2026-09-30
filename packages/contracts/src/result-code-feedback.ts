import { DomainError, text } from './index.js';
import { exact } from './nodes.js';
import { commitOid } from './checkpoints.js';
export interface CodeFeedbackRange {
  start: number;
  end: number;
}
export interface ResultCodeFeedbackInput {
  body: string;
  path: string;
  side: 'before' | 'after';
  objectId: string;
  range: CodeFeedbackRange | null;
}
/** Server-derived location in one immutable, explicitly shared result report. */
export interface ResultCodeFeedbackAnchor {
  version: 1;
  kind: 'result_code_file';
  path: string;
  side: 'before' | 'after';
  objectId: string;
  referenceHash: string;
  differenceHash: string;
  range: CodeFeedbackRange | null;
}
export function parseResultCodeFeedback(input: unknown): ResultCodeFeedbackInput {
  const b = exact(input, ['body', 'path', 'side', 'objectId', 'range']);
  if (
    typeof b.path !== 'string' ||
    !b.path ||
    new TextEncoder().encode(b.path).length > 4096 ||
    /[\p{Cc}\p{Cf}\\]/u.test(b.path) ||
    b.path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  )
    throw new DomainError('INVALID_INPUT', '请选择已共享的固定文件');
  if (b.side !== 'before' && b.side !== 'after')
    throw new DomainError('INVALID_INPUT', '请明确选择起点文件或所选文件');
  let range: CodeFeedbackRange | null = null;
  if (b.range !== null) {
    const r = exact(b.range, ['start', 'end']);
    if (
      !Number.isSafeInteger(r.start) ||
      !Number.isSafeInteger(r.end) ||
      (r.start as number) < 1 ||
      (r.end as number) < (r.start as number) ||
      (r.end as number) > 1000000
    )
      throw new DomainError('INVALID_INPUT', '行范围必须从1开始且结束行不小于开始行');
    range = { start: r.start as number, end: r.end as number };
  }
  return {
    body: text(b.body, '反馈', 12000),
    path: b.path,
    side: b.side,
    objectId: commitOid(b.objectId),
    range,
  };
}
