import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SearchType } from '../../../packages/contracts/src/result-search.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import { Dialog, Icon, StatusBadge, type IconName } from '../../../packages/ui/src/index.js';
import { go, useApp } from './state.js';
import { useTaskSearchPages } from './task-search-pages.js';
import { useResultSearchPages } from './result-search-pages.js';
import {
  taskSearchProjectLabel,
  taskSearchResultContext,
  taskSearchScopeContext,
} from './task-search-context.js';
import { TaskDescriptionMatch } from './task-match-snippet-view.js';
import { resultSearchResultContext, resultSearchScopeContext } from './result-search-context.js';
import { ResultBodyMatch } from './result-match-snippet-view.js';
import './command-menu.css';
export function Search({ onClose, onNewTask }: { onClose(): void; onNewTask(): void }) {
  const { data } = useApp();
  const [q, setQ] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('task');
  const [selection, setSelection] = useState<TaskSearchScope>({ scope: 'all', projectId: null });
  const context =
    searchType === 'task'
      ? taskSearchScopeContext(selection, data.projects)
      : resultSearchScopeContext(selection, data.projects);
  const taskSearch = useTaskSearchPages(
    q,
    data.tasks,
    selection,
    context.available && searchType === 'task',
  );
  const resultSearch = useResultSearchPages(
    q,
    data.results,
    data.tasks,
    selection,
    context.available && searchType === 'result',
  );
  const search = searchType === 'task' ? taskSearch : resultSearch;
  const itemLabel = searchType === 'task' ? '任务' : '成果';
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
    else if (search.focusItemId) {
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find((button) => button.dataset.searchId === search.focusItemId);
      row?.focus();
    }
  }, [search.needsRestart, search.focusItemId]);
  const status = !context.available
    ? '所选项目当前不可用，请选择其他搜索范围。'
    : !q.trim()
      ? `输入关键词，搜索当前范围内可见的${itemLabel}。`
      : search.needsRestart
        ? '搜索结果已失效，请重新搜索。'
        : search.busy === 'initial'
          ? '正在搜索…'
          : !search.items.length
            ? search.error
              ? '搜索失败，请重试。'
              : `没有找到匹配的${itemLabel}。`
            : `已显示 ${search.items.length} 项${itemLabel}，${
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
            placeholder={
              searchType === 'task'
                ? '任务标题、说明、编号，或新建、项目、设置…'
                : '成果当前标题、正文、关联任务标题或编号…'
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>ESC</kbd>
        </label>
        <label className="command-search-scope">
          <span>搜索类型</span>
          <select
            aria-label="搜索类型"
            value={searchType}
            onChange={(event) => {
              const nextType = event.target.value === 'result' ? 'result' : 'task';
              if (nextType === searchType) return;
              search.cancel();
              setSearchType(nextType);
            }}
          >
            <option value="task">任务</option>
            <option value="result">成果（当前版本）</option>
          </select>
        </label>
        <label className="command-search-scope">
          <span>{itemLabel}搜索范围</span>
          <select
            aria-label={`${itemLabel}搜索范围`}
            title={context.label}
            value={
              selection.scope === 'project' ? `project:${selection.projectId}` : selection.scope
            }
            onChange={(event) => {
              const value = event.target.value;
              setSelection(
                value === 'all' || value === 'personal'
                  ? { scope: value, projectId: null }
                  : { scope: 'project', projectId: value.slice('project:'.length) },
              );
            }}
          >
            <option value="all">全部当前可见{itemLabel}</option>
            <option value="personal">无项目个人{itemLabel}</option>
            {selection.scope === 'project' && !context.available && (
              <option value={`project:${selection.projectId}`} disabled>
                项目不可用
              </option>
            )}
            {data.projects.map((project) => (
              <option key={project.id} value={`project:${project.id}`}>
                {taskSearchProjectLabel(project)}
              </option>
            ))}
          </select>
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
          aria-label={`${itemLabel}搜索结果`}
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
          {search.items.length > 0 && (
            <span className="command-section-label">{context.label}</span>
          )}
          {searchType === 'task' &&
            taskSearch.items.map((task) => {
              const resultContext = taskSearchResultContext(task, data.projects, q);
              return (
                <button
                  key={task.id}
                  data-task-id={task.id}
                  data-search-id={task.id}
                  onClick={() => {
                    go(`/tasks/${task.id}`);
                    close();
                  }}
                >
                  <Icon name="file" />
                  <div className="command-task-heading">
                    <strong>{task.title}</strong>
                    <div className="command-task-meta">
                      <small>{task.shortId}</small>
                      <span className="command-task-revision">修订 {task.revision}</span>
                    </div>
                  </div>
                  <StatusBadge status={task.status} />
                  <Icon name="arrow" size={15} />
                  <div className="command-task-context">
                    <span className="command-task-source">{resultContext.sourceLabel}</span>
                    {resultContext.descriptionMatch && (
                      <TaskDescriptionMatch snippet={resultContext.descriptionMatch} />
                    )}
                  </div>
                </button>
              );
            })}
          {searchType === 'result' &&
            resultSearch.items.map((result) => {
              const resultContext = resultSearchResultContext(
                result,
                result.task,
                data.projects,
                q,
              );
              return (
                <button
                  key={`result:${result.id}`}
                  className="command-result-row"
                  data-result-id={result.id}
                  data-search-id={result.id}
                  onClick={() => {
                    go(`/results/${result.id}`);
                    close();
                  }}
                >
                  <Icon name="box" />
                  <div className="command-result-heading">
                    <strong>{result.title}</strong>
                    <div className="command-result-meta">
                      <span className="command-result-version">当前版本 {result.revision}</span>
                      <span>{resultContext.kindLabel}</span>
                    </div>
                  </div>
                  <Icon name="arrow" size={15} />
                  <div className="command-result-context">
                    <div className="command-result-task">
                      <small>{result.task.shortId}</small>
                      <span>{result.task.title}</span>
                    </div>
                    <span className="command-task-source">{resultContext.sourceLabel}</span>
                    {resultContext.bodyMatch && (
                      <ResultBodyMatch snippet={resultContext.bodyMatch} />
                    )}
                  </div>
                </button>
              );
            })}
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
            aria-label={`${itemLabel}搜索分页状态`}
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
              {search.busy === 'more'
                ? '加载中…'
                : search.error
                  ? '重试加载更多'
                  : `加载更多${itemLabel}`}
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
