import { DomainError, record, text, type Task } from './index.js';

export const TASK_SEARCH_PAGE_SIZE = 30;
export const TASK_SEARCH_CURSOR_MAX_LENGTH = 512;

export interface TaskSearchPage {
  items: Task[];
  nextCursor: string | null;
}

export interface TaskSearchQuery {
  q: string;
  cursor: string | null;
}

export function invalidTaskSearchCursor(): DomainError {
  return new DomainError('INVALID_CURSOR', '搜索位置已无效，请重新搜索', 409);
}

export function parseTaskSearchQuery(value: unknown): TaskSearchQuery {
  const query = record(value);
  const q = text(query.q, '搜索', 160);
  const cursor = query.cursor === undefined ? null : query.cursor;
  if (
    cursor !== null &&
    (typeof cursor !== 'string' ||
      cursor.length > TASK_SEARCH_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(cursor))
  )
    throw invalidTaskSearchCursor();
  // Existing search ignored unknown fields. Keep that compatibility; only q and
  // cursor affect this fixed-size Task search, and duplicate known fields fail.
  if (query.cursor === null) throw invalidTaskSearchCursor();
  return { q, cursor };
}
