import type { Result, Task } from '../../contracts/src/index.js';
import type { ResultSearchHit } from '../../contracts/src/result-search.js';
import type { TaskSearchScope } from '../../contracts/src/task-search.js';
import { matchesTaskSearchScope } from './task-search.js';

/** Each current field matches independently, preserving the Result library rules. */
export function matchesResultSearchQuery(
  result: Pick<Result, 'title' | 'body'>,
  task: Pick<Task, 'title' | 'shortId'> | undefined,
  normalizedQuery: string,
): boolean {
  return (
    !normalizedQuery ||
    result.title.toLocaleLowerCase().includes(normalizedQuery) ||
    result.body.toLocaleLowerCase().includes(normalizedQuery) ||
    (!!task &&
      (task.title.toLocaleLowerCase().includes(normalizedQuery) ||
        task.shortId.toLocaleLowerCase().includes(normalizedQuery)))
  );
}

/** Join current parents before scope/matching; preserve the supplied Result order. */
export function currentResultSearchItems(
  results: readonly Result[],
  tasks: readonly Task[],
  selection: TaskSearchScope & { q: string },
): ResultSearchHit[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const items: ResultSearchHit[] = [];
  for (const result of results) {
    const task = tasksById.get(result.taskId);
    if (
      !task ||
      !matchesTaskSearchScope(task, selection) ||
      !matchesResultSearchQuery(result, task, selection.q)
    )
      continue;
    items.push({
      ...result,
      task: { id: task.id, title: task.title, shortId: task.shortId, projectId: task.projectId },
    });
  }
  return items;
}
