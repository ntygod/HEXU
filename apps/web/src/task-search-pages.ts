import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import {
  normalizeTaskSearchQuery,
  type TaskSearchPage,
  type TaskSearchScope,
} from '../../../packages/contracts/src/task-search.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import {
  matchesTaskSearchQuery,
  matchesTaskSearchScope,
} from '../../../packages/domain/src/task-search.js';

interface TaskSearchView {
  scope: string;
  items: Task[];
  nextCursor: string | null;
  busy: 'initial' | 'more' | null;
  error: string;
  needsRestart: boolean;
  searched: boolean;
  focusTaskId: string | null;
}
interface SearchRead {
  query: string;
  selection: TaskSearchScope;
  view: TaskSearchView;
  inFlight: boolean;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}
const emptyView = (scope: string, searching: boolean): TaskSearchView => ({
  scope,
  items: [],
  nextCursor: null,
  busy: searching ? 'initial' : null,
  error: '',
  needsRestart: false,
  searched: false,
  focusTaskId: null,
});

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
  const current = useRef<SearchRead | null>(null);
  const [view, setView] = useState(() => emptyView(scope, available && !!trimmedQuery));

  const release = useCallback((read: SearchRead) => {
    if (read.timer !== null) clearTimeout(read.timer);
    read.controller?.abort();
    read.timer = null;
    read.controller = null;
    read.inFlight = false;
    read.view = emptyView(read.view.scope, false);
    if (current.current === read) current.current = null;
  }, []);

  const readPage = useCallback((read: SearchRead, cursor: string | null) => {
    // This ref guard is synchronous: two activations before React paints still
    // issue only one read for the current cursor.
    if (current.current !== read || read.inFlight) return;
    read.inFlight = true;
    read.timer = null;
    const controller = new AbortController();
    read.controller = controller;
    const isCurrent = () => current.current === read && !controller.signal.aborted;
    const publish = (next: TaskSearchView) => {
      if (!isCurrent()) return;
      read.view = next;
      setView(next);
    };
    publish({ ...read.view, busy: cursor ? 'more' : 'initial', error: '', focusTaskId: null });
    const scopeParams =
      read.selection.scope === 'project'
        ? `&scope=project&projectId=${encodeURIComponent(read.selection.projectId)}`
        : read.selection.scope === 'personal'
          ? '&scope=personal'
          : '';
    const path = `/search?q=${encodeURIComponent(read.query)}${scopeParams}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    void request<TaskSearchPage>(path, { signal: controller.signal })
      .then((page) => {
        if (!isCurrent()) return;
        publish({
          ...read.view,
          items: cursor ? [...read.view.items, ...page.items] : page.items,
          nextCursor: page.nextCursor,
          searched: true,
          focusTaskId: cursor ? (page.items[0]?.id ?? null) : null,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const needsRestart =
          !!cursor &&
          error instanceof ApiError &&
          ['INVALID_CURSOR', 'SEARCH_RESULTS_CHANGED'].includes(error.code);
        publish({
          ...read.view,
          items: !cursor || needsRestart ? [] : read.view.items,
          nextCursor: !cursor || needsRestart ? null : read.view.nextCursor,
          error: error instanceof Error ? error.message : '搜索失败，请重试',
          needsRestart,
          focusTaskId: null,
        });
      })
      .finally(() => {
        if (!isCurrent()) return;
        read.inFlight = false;
        read.controller = null;
        publish({ ...read.view, busy: null });
      });
  }, []);

  const start = useCallback(
    (scope: string, query: string, selection: TaskSearchScope, delay: number) => {
      if (current.current) release(current.current);
      const read: SearchRead = {
        query,
        selection,
        view: emptyView(scope, !!query),
        inFlight: false,
        controller: null,
        timer: null,
      };
      current.current = read;
      setView(read.view);
      if (query) {
        if (delay) read.timer = setTimeout(() => readPage(read, null), delay);
        else readPage(read, null);
      }
      return read;
    },
    [readPage, release],
  );

  useLayoutEffect(() => {
    start(scope, available ? trimmedQuery : '', selection, 150);
    return () => {
      // An explicit retry may have replaced the first read in this scope.
      if (current.current) release(current.current);
    };
  }, [scope, trimmedQuery, selection, available, start, release]);

  const loadMore = useCallback(() => {
    const read = current.current;
    if (!read || read.view.scope !== scope || read.view.needsRestart || !read.view.nextCursor)
      return;
    readPage(read, read.view.nextCursor);
  }, [scope, readPage]);
  const restart = useCallback(() => {
    start(scope, available ? trimmedQuery : '', selection, 0);
  }, [scope, trimmedQuery, selection, available, start]);
  const cancel = useCallback(() => {
    const read = current.current;
    if (!read) return;
    release(read);
    setView(read.view);
  }, [release]);

  // Hide stale rows in the same render as a query/projection change, before the
  // layout cleanup aborts old work and starts the new debounced generation.
  return {
    ...(view.scope === scope ? view : emptyView(scope, available && !!trimmedQuery)),
    loadMore,
    restart,
    cancel,
  };
}
