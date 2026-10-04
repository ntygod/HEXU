import { createHash } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import type { TaskSearchPage, TaskSearchQuery } from '../../contracts/src/task-search.js';
import { canonicalJson } from '../../domain/src/index.js';
import { matchesTaskSearchQuery, matchesTaskSearchScope } from '../../domain/src/task-search.js';

const pageSize = 30;
interface Cursor {
  v: 1;
  queryHash: string;
  sequenceHash: string;
  afterTaskId: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalidCursor = () => new DomainError('INVALID_CURSOR', '搜索游标无效，请重新搜索');

function decodeCursor(cursor: string): Cursor {
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== cursor) throw invalidCursor();
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
    const decoded = value as Record<string, unknown>;
    if (
      Object.keys(decoded).length !== 4 ||
      decoded.v !== 1 ||
      typeof decoded.queryHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.queryHash) ||
      typeof decoded.sequenceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.sequenceHash) ||
      typeof decoded.afterTaskId !== 'string' ||
      !decoded.afterTaskId.trim() ||
      decoded.afterTaskId.length > 150
    )
      throw invalidCursor();
    return decoded as unknown as Cursor;
  } catch {
    throw invalidCursor();
  }
}

/**
 * Page only the current, already-visible feed supplied by Store.tasks(). The cursor
 * is a bookmark, not an authorization grant or retained snapshot. Any change to
 * the ordered matching DTOs expires it; a new search starts from current data.
 */
export function pageTaskSearch(tasks: readonly Task[], query: TaskSearchQuery): TaskSearchPage {
  const matches = tasks.filter(
    (task) => matchesTaskSearchScope(task, query) && matchesTaskSearchQuery(task, query.q),
  );
  const queryHash = hash(
    canonicalJson({ q: query.q, scope: query.scope, projectId: query.projectId }),
  );
  const sequenceHash = hash(canonicalJson(matches));
  let start = 0;
  if (query.cursor !== null) {
    const cursor = decodeCursor(query.cursor);
    if (cursor.queryHash !== queryHash) throw invalidCursor();
    if (cursor.sequenceHash !== sequenceHash)
      throw new DomainError('SEARCH_RESULTS_CHANGED', '搜索结果已变化，请重新搜索', 409);
    const anchor = matches.findIndex((task) => task.id === cursor.afterTaskId);
    if (anchor < 0) throw invalidCursor();
    start = anchor + 1;
  }
  const items = matches.slice(start, start + pageSize);
  const cursor: Cursor | null =
    start + items.length < matches.length
      ? { v: 1, queryHash, sequenceHash, afterTaskId: items.at(-1)!.id }
      : null;
  return {
    items,
    nextCursor: cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null,
  };
}
