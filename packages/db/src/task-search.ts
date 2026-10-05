import type { Task } from '../../contracts/src/index.js';
import type { TaskSearchPage, TaskSearchQuery } from '../../contracts/src/task-search.js';
import { canonicalJson } from '../../domain/src/index.js';
import { matchesTaskSearchQuery, matchesTaskSearchScope } from '../../domain/src/task-search.js';
import { pageSearchItems, searchHash } from './search-cursor.js';

/** Page the current Store.tasks() feed, preserving its original query hash and bookmark. */
export function pageTaskSearch(tasks: readonly Task[], query: TaskSearchQuery): TaskSearchPage {
  const matches = tasks.filter(
    (task) => matchesTaskSearchScope(task, query) && matchesTaskSearchQuery(task, query.q),
  );
  const queryHash = searchHash(
    canonicalJson({ q: query.q, scope: query.scope, projectId: query.projectId }),
  );
  return pageSearchItems(matches, queryHash, query.cursor, 'afterTaskId');
}
