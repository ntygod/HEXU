import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { SearchType } from '../../../packages/contracts/src/result-search.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import { ApiError, request } from '../../../packages/client/src/index.js';

interface SearchView<Item> {
  scope: string;
  items: Item[];
  nextCursor: string | null;
  busy: 'initial' | 'more' | null;
  error: string;
  needsRestart: boolean;
  searched: boolean;
  focusItemId: string | null;
}
interface SearchRead<Item> {
  type: SearchType;
  query: string;
  selection: TaskSearchScope;
  view: SearchView<Item>;
  inFlight: boolean;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}
const emptyView = <Item>(scope: string, searching: boolean): SearchView<Item> => ({
  scope,
  items: [],
  nextCursor: null,
  busy: searching ? 'initial' : null,
  error: '',
  needsRestart: false,
  searched: false,
  focusItemId: null,
});

/** The command dialog's ordinary page-read lifecycle, shared by its row types. */
export function useSearchPages<Item extends { id: string }>(
  type: SearchType,
  query: string,
  scope: string,
  selection: TaskSearchScope,
  available: boolean,
) {
  const trimmedQuery = query.trim();
  const current = useRef<SearchRead<Item> | null>(null);
  const [view, setView] = useState(() => emptyView<Item>(scope, available && !!trimmedQuery));

  const release = useCallback((read: SearchRead<Item>) => {
    if (read.timer !== null) clearTimeout(read.timer);
    read.controller?.abort();
    read.timer = null;
    read.controller = null;
    read.inFlight = false;
    read.view = emptyView<Item>(read.view.scope, false);
    if (current.current === read) current.current = null;
  }, []);

  const readPage = useCallback((read: SearchRead<Item>, cursor: string | null) => {
    // This ref guard is synchronous: two activations before React paints still
    // issue only one read for the current cursor.
    if (current.current !== read || read.inFlight) return;
    read.inFlight = true;
    read.timer = null;
    const controller = new AbortController();
    read.controller = controller;
    const isCurrent = () => current.current === read && !controller.signal.aborted;
    const publish = (next: SearchView<Item>) => {
      if (!isCurrent()) return;
      read.view = next;
      setView(next);
    };
    publish({ ...read.view, busy: cursor ? 'more' : 'initial', error: '', focusItemId: null });
    const scopeParams =
      read.selection.scope === 'project'
        ? `&scope=project&projectId=${encodeURIComponent(read.selection.projectId)}`
        : read.selection.scope === 'personal'
          ? '&scope=personal'
          : '';
    const typeParam = read.type === 'task' ? '' : `&type=${read.type}`;
    const path = `/search?q=${encodeURIComponent(read.query)}${typeParam}${scopeParams}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    void request<{ items: Item[]; nextCursor: string | null }>(path, { signal: controller.signal })
      .then((page) => {
        if (!isCurrent()) return;
        publish({
          ...read.view,
          items: cursor ? [...read.view.items, ...page.items] : page.items,
          nextCursor: page.nextCursor,
          searched: true,
          focusItemId: cursor ? (page.items[0]?.id ?? null) : null,
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
          focusItemId: null,
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
      const read: SearchRead<Item> = {
        type,
        query,
        selection,
        view: emptyView<Item>(scope, !!query),
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
    [type, readPage, release],
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
    ...(view.scope === scope ? view : emptyView<Item>(scope, available && !!trimmedQuery)),
    loadMore,
    restart,
    cancel,
  };
}
