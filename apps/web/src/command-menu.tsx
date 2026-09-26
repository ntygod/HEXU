import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import { request } from '../../../packages/client/src/index.js';
import { Dialog, Icon, StatusBadge } from '../../../packages/ui/src/index.js';
import { go, useApp } from './state.js';
import './command-menu.css';
export function Search({ onClose, onNewTask }: { onClose(): void; onNewTask(): void }) {
  const { data } = useApp();
  const commands = [
    { name: '新建任务', icon: 'plus', action: onNewTask },
    {
      name: '打开工作台',
      icon: 'home',
      action: () => {
        go('/');
        onClose();
      },
    },
    {
      name: '查看项目',
      icon: 'folder',
      action: () => {
        go('/projects');
        onClose();
      },
    },
    {
      name: '查看成果',
      icon: 'box',
      action: () => {
        go('/results');
        onClose();
      },
    },
    {
      name: data.mode === 'team-local' ? '空间与账号' : '资源与设置',
      icon: 'settings',
      action: () => {
        go('/settings');
        onClose();
      },
    },
  ];
  const [q, setQ] = useState(''),
    [items, setItems] = useState<Task[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!q.trim()) {
      setItems([]);
      setBusy(false);
      setError('');
      return () => controller.abort();
    }
    setBusy(true);
    setItems([]);
    setError('');
    const timer = setTimeout(
      () =>
        request<{ items: Task[] }>(`/search?q=${encodeURIComponent(q.trim())}`, {
          signal: controller.signal,
        })
          .then((result) => {
            if (!controller.signal.aborted) {
              setItems(result.items);
              setError('');
            }
          })
          .catch((error) => {
            if (error.name !== 'AbortError') {
              setItems([]);
              setError(error.message);
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setBusy(false);
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  return (
    <Dialog title="搜索与快捷操作" onClose={onClose} wide>
      <div className="dialog-body">
        <label className="command-search-field">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="全局搜索"
            maxLength={160}
            placeholder="任务标题、编号，或新建、项目、设置…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>ESC</kbd>
        </label>
        {error && <p role="alert">{error}</p>}
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
        <div className="command-results">
          {items.length > 0 && <span className="command-section-label">当前可见任务</span>}
          {items.map((task) => (
            <button
              key={task.id}
              onClick={() => {
                go(`/tasks/${task.id}`);
                onClose();
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
          {!items.length && (
            <p className="muted compact-empty">
              {!q.trim()
                ? '输入关键词，搜索当前可见的任务。'
                : busy
                  ? '正在搜索…'
                  : '没有找到匹配的任务。'}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
