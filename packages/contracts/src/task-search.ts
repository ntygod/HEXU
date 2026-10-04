import { DomainError, record, text, type Task } from './index.js';

export interface TaskSearchPage {
  items: Task[];
  nextCursor: string | null;
}

export interface TaskSearchQuery {
  q: string;
  cursor: string | null;
}

/** Preserve ordinary Task search's trim, length and locale case-folding rules. */
export function normalizeTaskSearchQuery(value: unknown): string {
  return text(value, '搜索', 160).toLocaleLowerCase();
}

export function parseTaskSearchQuery(value: unknown): TaskSearchQuery {
  const query = record(value);
  const q = normalizeTaskSearchQuery(query.q);
  const cursor = query.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
  )
    throw new DomainError('INVALID_CURSOR', '搜索游标无效，请重新搜索');
  return { q, cursor: cursor === undefined ? null : cursor };
}
