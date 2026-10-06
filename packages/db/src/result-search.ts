import type { Result, Task } from '../../contracts/src/index.js';
import type { ResultSearchPage } from '../../contracts/src/result-search.js';
import type { TaskSearchQuery } from '../../contracts/src/task-search.js';
import { canonicalJson } from '../../domain/src/index.js';
import { currentResultSearchItems } from '../../domain/src/result-search.js';
import { pageSearchItems, searchHash } from './search-cursor.js';

/** Current Result fields and relevant current parent context form the ordered bookmark. */
export function pageResultSearch(
  results: readonly Result[],
  tasks: readonly Task[],
  query: TaskSearchQuery,
): ResultSearchPage {
  const matches = currentResultSearchItems(results, tasks, query);
  const queryHash = searchHash(
    canonicalJson({ type: 'result', q: query.q, scope: query.scope, projectId: query.projectId }),
  );
  return pageSearchItems(matches, queryHash, query.cursor, 'afterResultId');
}
