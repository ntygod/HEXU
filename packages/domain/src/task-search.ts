import type { Task } from '../../contracts/src/index.js';

export function normalizeTaskSearch(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** Preserve the global search's literal title/description/shortId order. */
export function matchesTaskSearch(
  task: Pick<Task, 'title' | 'description' | 'shortId'>,
  normalizedQuery: string,
): boolean {
  return (task.title + ' ' + task.description + ' ' + task.shortId)
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}
