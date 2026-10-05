import type { Project, Result, Task } from '../../../packages/contracts/src/index.js';
import { matchesResultSearchQuery } from '../../../packages/domain/src/result-search.js';
import { textMatchSnippet, type TextMatchSnippet } from './text-match-snippet.js';

/** Match the keyword input's UTF-16 maxLength; the snippet has its own grapheme budget. */
export const RESULT_LIBRARY_QUERY_LIMIT = 160;

export interface ResultLibraryFilters {
  q: string;
  projectId: string;
  error: string | null;
  active: boolean;
}

/** Bound form values in UTF-16 units without cutting a supplementary code point. */
function boundedFormValue(value: string) {
  let end = RESULT_LIBRARY_QUERY_LIMIT;
  if (
    value.length > end &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  )
    end--;
  return value.slice(0, end);
}

/** Only interpret this library's parameters; unknown parameters belong to their callers. */
export function parseResultLibraryFilters(
  search: string,
  projects: readonly Pick<Project, 'id'>[],
): ResultLibraryFilters {
  const params = new URLSearchParams(search);
  const queryValues = params.getAll('q');
  const projectValues = params.getAll('projectId');
  const q = queryValues[0] ?? '';
  const projectId = projectValues[0] ?? '';
  let error: string | null = null;
  if (queryValues.length > 1 || projectValues.length > 1) {
    error = '成果筛选参数重复，请修改链接或清除筛选。';
  }
  // URLSearchParams repairs bad percent escapes and UTF-8. Validate the original
  // owned values as well so a damaged link never silently searches repaired text.
  for (const part of search.replace(/^\?/, '').split('&')) {
    const separator = part.indexOf('=');
    const key = separator < 0 ? part : part.slice(0, separator);
    let name: string;
    try {
      name = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (name !== 'q' && name !== 'projectId') continue;
    try {
      decodeURIComponent((separator < 0 ? '' : part.slice(separator + 1)).replace(/\+/g, ' '));
    } catch {
      error ??= '成果筛选链接格式无效，请修改链接或清除筛选。';
    }
  }
  if (q.length > RESULT_LIBRARY_QUERY_LIMIT || projectId.length > RESULT_LIBRARY_QUERY_LIMIT) {
    error ??= '成果筛选参数过长，关键词和项目编号最多 160 个字符。';
  }
  if (
    projectValues.length &&
    (!projectId || !projects.some((project) => project.id === projectId))
  ) {
    error ??= '链接中的项目不存在或当前不可见，请重新选择项目或清除筛选。';
  }
  return {
    // Keep a damaged URL reviewable without rendering an unbounded form value.
    q: boundedFormValue(q),
    projectId: boundedFormValue(projectId),
    error,
    active: queryValues.length > 0 || projectValues.length > 0,
  };
}

function matchesText(text: string, needle: string) {
  return text.toLocaleLowerCase().includes(needle);
}

/** Narrow only the supplied current Result collection; task status is not a filter. */
export function filterResultLibrary(
  results: readonly Result[],
  tasks: readonly Task[],
  filters: ResultLibraryFilters,
): Result[] {
  if (filters.error) return [];
  const needle = filters.q.trim().toLocaleLowerCase();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return results.filter((result) => {
    const task = tasksById.get(result.taskId);
    if (filters.projectId && task?.projectId !== filters.projectId) return false;
    return matchesResultSearchQuery(result, task, needle);
  });
}

/** Body-only hits need context near the first match; visible title/Task hits do not. */
export function resultBodyMatchSnippet(
  result: Pick<Result, 'title' | 'body'>,
  task: Pick<Task, 'title' | 'shortId'> | undefined,
  query?: string,
): TextMatchSnippet | null {
  const needle = query?.trim().toLocaleLowerCase();
  if (
    !needle ||
    matchesText(result.title, needle) ||
    (task && (matchesText(task.title, needle) || matchesText(task.shortId, needle)))
  )
    return null;
  return textMatchSnippet(result.body, query);
}

/** Set/clear only library-owned parameters, retaining other URL state and the hash. */
export function resultLibraryUrl(
  currentHref: string,
  changes: { q?: string; projectId?: string },
): string {
  const url = new URL(currentHref);
  const keys = ['q', 'projectId'] as const;
  // Retain untouched raw values, including malformed owned values. Editing one
  // filter must not silently repair another filter or rewrite unrelated state.
  const parts = (url.search ? url.search.slice(1).split('&') : []).filter((part) => {
    const params = new URLSearchParams(part);
    return !keys.some((key) => changes[key] !== undefined && params.has(key));
  });
  for (const key of keys) {
    const value = changes[key];
    if (value) parts.push(new URLSearchParams({ [key]: value }).toString());
  }
  const search = parts.join('&');
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
}
