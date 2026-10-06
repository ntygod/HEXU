import { DomainError, record, type Result, type Task } from './index.js';

export type SearchType = 'task' | 'result' | 'agreement';

export interface ResultSearchHit extends Result {
  task: Pick<Task, 'id' | 'title' | 'shortId' | 'projectId'>;
}

export interface ResultSearchPage {
  items: ResultSearchHit[];
  nextCursor: string | null;
}

/** An omitted type keeps the original Task search contract. */
export function parseSearchType(value: unknown): SearchType {
  const query = record(value);
  if (!Object.hasOwn(query, 'type')) return 'task';
  if (query.type !== 'task' && query.type !== 'result' && query.type !== 'agreement')
    throw new DomainError('INVALID_INPUT', '搜索类型无效');
  return query.type;
}
