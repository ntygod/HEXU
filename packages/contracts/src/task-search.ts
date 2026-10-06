import { DomainError, record, text, type Task } from './index.js';

export interface TaskSearchPage {
  items: Task[];
  nextCursor: string | null;
}

export type TaskSearchScope =
  | { scope: 'all' | 'personal'; projectId: null }
  | { scope: 'project'; projectId: string };

export type TaskSearchQuery = TaskSearchScope & {
  q: string;
  cursor: string | null;
};

/** Preserve ordinary Task search's trim, length and locale case-folding rules. */
export function normalizeTaskSearchQuery(value: unknown): string {
  return text(value, '搜索', 160).toLocaleLowerCase();
}

export function parseTaskSearchQuery(value: unknown): TaskSearchQuery {
  const query = record(value);
  const q = normalizeTaskSearchQuery(query.q);
  const scope = Object.hasOwn(query, 'scope') ? query.scope : 'all';
  let searchScope: TaskSearchScope;
  if (scope === 'project') {
    const projectId = text(query.projectId, '项目', 150);
    if (projectId !== query.projectId)
      throw new DomainError('INVALID_INPUT', '项目编号不能包含首尾空白');
    searchScope = { scope, projectId };
  } else if (scope === 'all' || scope === 'personal') {
    if (Object.hasOwn(query, 'projectId'))
      throw new DomainError('INVALID_INPUT', '只有项目搜索范围可以指定项目编号');
    searchScope = { scope, projectId: null };
  } else {
    throw new DomainError('INVALID_INPUT', '搜索范围无效');
  }
  const cursor = query.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
  )
    throw new DomainError('INVALID_CURSOR', '搜索游标无效，请重新搜索');
  return { ...searchScope, q, cursor: cursor === undefined ? null : cursor };
}
