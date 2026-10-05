import type { Task } from '../../../packages/contracts/src/index.js';
import {
  normalizeTaskSearchQuery,
  type TaskSearchScope,
} from '../../../packages/contracts/src/task-search.js';
import {
  matchesTaskSearchQuery,
  matchesTaskSearchScope,
} from '../../../packages/domain/src/task-search.js';
import { useSearchPages } from './search-pages.js';

/** Only the current matching Task projection can own ordinary search pages. */
export function useTaskSearchPages(
  query: string,
  tasks: readonly Task[],
  selection: TaskSearchScope,
  available: boolean,
) {
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery ? normalizeTaskSearchQuery(trimmedQuery) : '';
  const scope = JSON.stringify([
    'task',
    query,
    selection,
    available,
    available && normalizedQuery
      ? tasks.filter(
          (task) =>
            matchesTaskSearchScope(task, selection) &&
            matchesTaskSearchQuery(task, normalizedQuery),
        )
      : [],
  ]);
  return useSearchPages<Task>('task', query, scope, selection, available);
}
