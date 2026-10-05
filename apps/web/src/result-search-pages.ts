import type { Result, Task } from '../../../packages/contracts/src/index.js';
import type { ResultSearchHit } from '../../../packages/contracts/src/result-search.js';
import {
  normalizeTaskSearchQuery,
  type TaskSearchScope,
} from '../../../packages/contracts/src/task-search.js';
import { currentResultSearchItems } from '../../../packages/domain/src/result-search.js';
import { useSearchPages } from './search-pages.js';

/** Current Results and their matching/source Task fields own these pages together. */
export function useResultSearchPages(
  query: string,
  results: readonly Result[],
  tasks: readonly Task[],
  selection: TaskSearchScope,
  available: boolean,
) {
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery ? normalizeTaskSearchQuery(trimmedQuery) : '';
  const scope = JSON.stringify([
    'result',
    query,
    selection,
    available,
    available && normalizedQuery
      ? currentResultSearchItems(results, tasks, { ...selection, q: normalizedQuery })
      : [],
  ]);
  return useSearchPages<ResultSearchHit>('result', query, scope, selection, available);
}
