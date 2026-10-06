import type { Task } from '../../contracts/src/index.js';
import type { TaskSearchScope } from '../../contracts/src/task-search.js';

export function matchesTaskSearchScope(
  task: Pick<Task, 'projectId'>,
  scope: TaskSearchScope,
): boolean {
  return scope.scope === 'all' || task.projectId === scope.projectId;
}

/** Field order and separating spaces are part of ordinary Task search matching. */
export function matchesTaskSearchQuery(
  task: Pick<Task, 'title' | 'description' | 'shortId'>,
  normalizedQuery: string,
): boolean {
  return `${task.title} ${task.description} ${task.shortId}`
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}
