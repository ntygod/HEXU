import type { Task } from '../../contracts/src/index.js';

/** Field order and separating spaces are part of ordinary Task search matching. */
export function matchesTaskSearchQuery(
  task: Pick<Task, 'title' | 'description' | 'shortId'>,
  normalizedQuery: string,
): boolean {
  return `${task.title} ${task.description} ${task.shortId}`
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}
