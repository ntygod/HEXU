import type { Task } from '../../../packages/contracts/src/index.js';
import { textMatchSnippet, type TextMatchSnippet } from './text-match-snippet.js';

export { TEXT_MATCH_SNIPPET_LIMIT as TASK_MATCH_SNIPPET_LIMIT } from './text-match-snippet.js';
export type TaskMatchSnippet = TextMatchSnippet;

/** Preserve the Task predicate's combined title/ID matching and existing fallback. */
export function taskDescriptionMatchSnippet(
  task: Pick<Task, 'title' | 'shortId' | 'description'>,
  query?: string,
): TaskMatchSnippet | null {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle || `${task.title} ${task.shortId}`.toLocaleLowerCase().includes(needle)) return null;
  return textMatchSnippet(task.description, query);
}
