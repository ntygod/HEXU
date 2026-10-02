import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskSearchPage } from '../../../packages/contracts/src/index.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import {
  Button,
  Dialog,
  Icon,
  StatusBadge,
  type IconName,
} from '../../../packages/ui/src/index.js';
import { go, useApp } from './state.js';
import './command-menu.css';

interface SearchPage {
  // Keep the bounded input for HTTP: locale lowercasing can expand UTF-16 length.
  query: string;
  items: { id: string; content: string }[];
  nextCursor: string | null;
  loaded: boolean;
  busy: 'search' | 'more' | null;
  error: string;
  needsSearch: boolean;
}
function emptyPage(query = ''): SearchPage {
  return {
    query,
    items: [],
    nextCursor: null,
    loaded: false,
    busy: query ? 'search' : null,
    error: '',
    needsSearch: false,
  };
}
function searchContent(task: Pick<Task, 'title' | 'description' | 'shortId'>) {
  return JSON.stringify([task.title, task.description, task.shortId]);
}

export function Search({ onClose, onNewTask }: { onClose(): void; onNewTask(): void }) {
  const { data } = useApp();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<SearchPage>(() => emptyPage());
  const pageRef = useRef(page);
  const epoch = useRef(0);
  const pending = useRef<{ epoch: number; controller: AbortController } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const tasks = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const currentTasks = useRef(tasks);
  currentTasks.current = tasks;
  const previousTasks = useRef(tasks);

  function update(next: SearchPage) {
    pageRef.current = next;
    setPage(next);
  }
  function invalidate() {
    epoch.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current?.controller.abort();
    pending.current = null;
  }
  function close() {
    invalidate();
    onClose();
  }
  async function load(cursor: string | null, generation = epoch.current) {
    const current = pageRef.current;
    // A ref guards repeated activation before the busy state has rendered.
    if (
      generation !== epoch.current ||
      pending.current ||
      !current.query ||
      current.needsSearch ||
      (cursor !== null && (!current.loaded || cursor !== current.nextCursor))
    )
      return;
    const read = { epoch: generation, controller: new AbortController() };
    pending.current = read;
    const isCurrent = () =>
      pending.current === read && epoch.current === read.epoch && !read.controller.signal.aborted;
    update({ ...current, busy: cursor === null ? 'search' : 'more', error: '' });
    const query = new URLSearchParams({ q: current.query });
    if (cursor !== null) query.set('cursor', cursor);
    try {
      const response = await request<TaskSearchPage>(`/search?${query}`, {
        signal: read.controller.signal,
      });
      if (!isCurrent()) return;
      const items = new Map(
        cursor === null ? [] : pageRef.current.items.map((item) => [item.id, item]),
      );
      let changed = false;
      // Workbench owns the full current visibility set and the displayed content.
      // Trust the server's matching only for unchanged searchable content: the
      // browser's default locale can differ from the server's casing rules.
      for (const item of response.items) {
        const task = currentTasks.current.get(item.id);
        const content = searchContent(item);
        if (task && searchContent(task) === content) items.set(item.id, { id: item.id, content });
        else changed = true;
      }
      update({
        ...pageRef.current,
        items: [...items.values()],
        nextCursor: changed ? null : response.nextCursor,
        needsSearch: changed,
        loaded: true,
        error: '',
      });
    } catch (cause) {
      if (!isCurrent()) return;
      const invalidCursor = cause instanceof ApiError && cause.code === 'INVALID_CURSOR';
      update({
        ...pageRef.current,
        nextCursor: invalidCursor ? null : pageRef.current.nextCursor,
        needsSearch: invalidCursor,
        error: invalidCursor
          ? '搜索结果已变化，请重新搜索。'
          : cause instanceof Error
            ? cause.message
            : '无法搜索任务，请稍后重试。',
      });
    } finally {
      if (isCurrent()) {
        pending.current = null;
        update({ ...pageRef.current, busy: null });
      }
    }
  }
  function search(value: string, debounce = true) {
    // Invalidate synchronously, before a changed query can render or debounce.
    invalidate();
    setQ(value);
    const query = value.trim();
    update(emptyPage(query));
    if (results.current) results.current.scrollTop = 0;
    if (!query) return;
    const generation = epoch.current;
    if (debounce)
      timer.current = setTimeout(() => {
        timer.current = null;
        void load(null, generation);
      }, 150);
    else void load(null, generation);
  }
  useLayoutEffect(() => () => invalidate(), []);
  useLayoutEffect(() => {
    const before = previousTasks.current;
    previousTasks.current = tasks;
    const current = pageRef.current;
    const changed =
      [...before.keys()].some((id) => !tasks.has(id)) ||
      current.items.some((item) => {
        const task = tasks.get(item.id);
        return !task || searchContent(task) !== item.content;
      });
    if (!changed) return;
    invalidate();
    // Erase IDs as well as hiding rows: regranting or editing back must not revive
    // an old result, including one returned by an already-cancelled request.
    update({
      ...current,
      items: current.items.filter((item) => {
        const task = tasks.get(item.id);
        return task && searchContent(task) === item.content;
      }),
      nextCursor: null,
      busy: null,
      error: '',
      needsSearch: !!current.query,
    });
  }, [tasks]);

  const commands: { name: string; icon: IconName; action: () => void }[] = [
    {
      name: '新建任务',
      icon: 'plus',
      action: () => {
        invalidate();
        onNewTask();
      },
    },
    {
      name: '打开工作台',
      icon: 'home',
      action: () => {
        go('/');
        close();
      },
    },
    {
      name: '查看项目',
      icon: 'folder',
      action: () => {
        go('/projects');
        close();
      },
    },
    {
      name: '查看成果',
      icon: 'box',
      action: () => {
        go('/results');
        close();
      },
    },
    {
      name: data.mode === 'team-local' ? '空间与账号' : '资源与设置',
      icon: 'settings',
      action: () => {
        go('/settings');
        close();
      },
    },
  ];
  const items = page.items.flatMap((item) => {
    const task = tasks.get(item.id);
    return task && searchContent(task) === item.content ? [task] : [];
  });
  return (
    <Dialog title="搜索与快捷操作" onClose={close} wide>
      <div className="dialog-body">
        <div className="command-search-field">
          <Icon name="search" />
          <input
            ref={input}
            autoFocus
            aria-label="全局搜索"
            maxLength={160}
            placeholder="任务标题、编号，或新建、项目、设置…"
            value={q}
            onChange={(e) => search(e.target.value)}
          />
          {q && (
            <button
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => {
                search('');
                input.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
          <kbd>ESC</kbd>
        </div>
        {page.query && (
          <div className="command-search-tools">
            <span className="hint">当前显示 {items.length} 项</span>
            <Button onClick={() => search(q, false)}>重新搜索</Button>
          </div>
        )}
        {commands.some((command) => command.name.includes(q.trim())) && (
          <div className="command-actions" aria-label="快捷操作">
            <span className="command-section-label">快捷操作</span>
            {commands
              .filter((command) => command.name.includes(q.trim()))
              .map((command) => (
                <button key={command.name} onClick={command.action}>
                  <Icon name={command.icon} size={17} />
                  <span>{command.name}</span>
                  <Icon name="arrow" size={14} />
                </button>
              ))}
          </div>
        )}
        <div
          className="command-results"
          ref={results}
          role="region"
          aria-label="任务搜索结果"
          aria-busy={!!page.busy}
        >
          {items.length > 0 && <span className="command-section-label">当前可见任务</span>}
          {items.map((task) => (
            <button
              key={task.id}
              data-task-id={task.id}
              onClick={() => {
                go(`/tasks/${task.id}`);
                close();
              }}
            >
              <Icon name="file" />
              <div>
                <strong>{task.title}</strong>
                <small>{task.shortId}</small>
              </div>
              <StatusBadge status={task.status} />
              <Icon name="arrow" size={15} />
            </button>
          ))}
          {!items.length && !page.busy && !page.error && !page.needsSearch && (
            <p className="muted compact-empty">
              {!page.query ? '输入关键词，搜索当前可见的任务。' : '没有找到匹配的任务。'}
            </p>
          )}
          {page.query && (
            <div className="command-search-pagination">
              {page.busy && (
                <p role="status">{page.busy === 'more' ? '正在加载更多…' : '正在搜索…'}</p>
              )}
              {page.error && <p role="alert">{page.error}</p>}
              {page.needsSearch && !page.error && (
                <p role="status">当前可见任务已变化，请重新搜索。</p>
              )}
              {page.error && !page.needsSearch && (
                <Button disabled={!!page.busy} onClick={() => void load(page.nextCursor)}>
                  重试
                </Button>
              )}
              {page.nextCursor && !page.error && !page.needsSearch && (
                <Button disabled={!!page.busy} onClick={() => void load(page.nextCursor)}>
                  加载更多任务
                </Button>
              )}
              {page.loaded &&
                items.length > 0 &&
                !page.nextCursor &&
                !page.needsSearch &&
                !page.busy &&
                !page.error && <p role="status">已显示全部匹配任务</p>}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
