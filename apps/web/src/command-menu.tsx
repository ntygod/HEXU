import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, Icon, StatusBadge, type IconName } from '../../../packages/ui/src/index.js';
import { go, useApp } from './state.js';
import { useTaskSearchPages } from './task-search-pages.js';
import './command-menu.css';
export function Search({ onClose, onNewTask }: { onClose(): void; onNewTask(): void }) {
  const { data } = useApp();
  const [q, setQ] = useState('');
  const search = useTaskSearchPages(q, data.tasks);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const focusedResult = useRef<HTMLElement | null>(null);
  const committedScope = useRef(search.scope);
  const renderedScope = useRef(search.scope);
  renderedScope.current = search.scope;
  const close = () => {
    search.cancel();
    onClose();
  };
  const commands: { name: string; icon: IconName; action: () => void }[] = [
    {
      name: '新建任务',
      icon: 'plus',
      action: () => {
        search.cancel();
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
  useLayoutEffect(() => {
    if (committedScope.current !== search.scope) {
      const previousResult = focusedResult.current;
      if (
        previousResult &&
        !previousResult.isConnected &&
        (!document.activeElement || document.activeElement === document.body)
      )
        inputRef.current?.focus();
      focusedResult.current = null;
      committedScope.current = search.scope;
    }
  }, [search.scope]);
  useLayoutEffect(() => {
    if (search.needsRestart) restartRef.current?.focus();
    else if (search.focusTaskId) {
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find((button) => button.dataset.taskId === search.focusTaskId);
      row?.focus();
    }
  }, [search.needsRestart, search.focusTaskId]);
  const status = !q.trim()
    ? '输入关键词，搜索当前可见的任务。'
    : search.needsRestart
      ? '搜索结果已失效，请重新搜索。'
      : search.busy === 'initial'
        ? '正在搜索…'
        : !search.items.length
          ? search.error
            ? '搜索失败，请重试。'
            : '没有找到匹配的任务。'
          : `已显示 ${search.items.length} 项任务，${
              search.busy === 'more'
                ? '正在加载更多…'
                : search.error
                  ? '可重试加载更多'
                  : search.nextCursor
                    ? '可继续加载'
                    : '已加载全部结果'
            }`;
  return (
    <Dialog title="搜索与快捷操作" onClose={close} wide>
      <div className="dialog-body command-search-body">
        <label className="command-search-field">
          <Icon name="search" />
          <input
            ref={inputRef}
            autoFocus
            aria-label="全局搜索"
            maxLength={160}
            placeholder="任务标题、编号，或新建、项目、设置…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>ESC</kbd>
        </label>
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
          id={`${id}-results`}
          ref={listRef}
          role="region"
          aria-label="任务搜索结果"
          aria-busy={!!search.busy}
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLElement) focusedResult.current = event.target;
          }}
          onBlurCapture={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
              return;
            // Removing a focused row may omit blur or dispatch it during the
            // reset commit. Keep that row until the layout check can recover it.
            if (
              renderedScope.current === committedScope.current ||
              (event.relatedTarget && event.relatedTarget !== document.body)
            )
              focusedResult.current = null;
          }}
        >
          {search.items.length > 0 && <span className="command-section-label">当前可见任务</span>}
          {search.items.map((task) => (
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
        </div>
        {search.error && (
          <p className="command-search-error" role="alert">
            {search.error}
          </p>
        )}
        <div className="command-search-footer">
          <p
            id={`${id}-status`}
            role="status"
            aria-label="任务搜索分页状态"
            aria-live="polite"
            aria-atomic="true"
          >
            {status}
          </p>
          {search.needsRestart || (search.error && !search.items.length) ? (
            <button
              className="button secondary"
              ref={restartRef}
              aria-controls={`${id}-results`}
              aria-describedby={`${id}-status`}
              onClick={() => {
                inputRef.current?.focus();
                search.restart();
              }}
            >
              {search.needsRestart ? '重新搜索' : '重试搜索'}
            </button>
          ) : search.nextCursor ? (
            <button
              className="button secondary"
              disabled={!!search.busy}
              aria-busy={search.busy === 'more'}
              aria-controls={`${id}-results`}
              aria-describedby={`${id}-status`}
              onClick={search.loadMore}
            >
              {search.busy === 'more' ? '加载中…' : search.error ? '重试加载更多' : '加载更多任务'}
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
