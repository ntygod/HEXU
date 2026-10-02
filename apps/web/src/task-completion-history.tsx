import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  TaskCompletionEvent,
  TaskCompletionHistory,
} from '../../../packages/contracts/src/task-completion-history.js';
import { ApiError } from '../../../packages/client/src/index.js';
import { taskCompletionHistory } from '../../../packages/client/src/task-completion-history.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { time, useApp } from './state.js';
import './task-completion-history.css';

const actions: Record<string, string> = {
  complete: '标记完成',
  cancel: '取消任务',
  reopen: '重新打开',
};
const actionName = (action: string) =>
  Object.hasOwn(actions, action) ? actions[action]! : `未知动作（${action || '空值'}）`;

export function TaskCompletionHistoryButton({ task }: { task: Task }) {
  const { data } = useApp();
  const [openScope, setOpenScope] = useState<string | null>(null);
  const scope = `${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}:${task.id}`;
  const visible = data.tasks.some((item) => item.id === task.id);
  useEffect(() => setOpenScope(null), [scope, visible]);
  if (!visible) return null;
  return (
    <>
      <button className="text-button" onClick={() => setOpenScope(scope)}>
        完成记录
      </button>
      {openScope === scope && (
        <History key={scope} taskId={task.id} onClose={() => setOpenScope(null)} />
      )}
    </>
  );
}

function History({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { version } = useApp();
  const versionRef = useRef(version);
  versionRef.current = version;
  const [recheck, setRecheck] = useState(0);
  const [page, setPage] = useState<TaskCompletionHistory | null>(null);
  const pageRef = useRef<TaskCompletionHistory | null>(null);
  const [error, setError] = useState<{ message: string; source: 'read' | 'probe' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newer, setNewer] = useState(false);
  const [denied, setDenied] = useState(false);
  const deniedRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const probe = useRef<AbortController | null>(null);
  const attempted = useRef<string | undefined>(undefined);

  function failure(cause: unknown, source: 'read' | 'probe' = 'read') {
    if (cause instanceof ApiError && [401, 403, 404, 422].includes(cause.status)) {
      deniedRef.current = true;
      controller.current?.abort();
      probe.current?.abort();
      pageRef.current = null;
      setPage(null);
      setDenied(true);
      setBusy(false);
      setNewer(false);
    }
    setError({ message: cause instanceof Error ? cause.message : '无法读取完成记录', source });
  }
  async function load(before?: string) {
    if (deniedRef.current) return;
    // Explicit reading supersedes both earlier pagination and SSE permission probes.
    probe.current?.abort();
    controller.current?.abort();
    const next = new AbortController();
    const startedAtVersion = versionRef.current;
    controller.current = next;
    attempted.current = before;
    setBusy(true);
    setError(null);
    try {
      const result = await taskCompletionHistory(taskId, before, next.signal);
      if (next.signal.aborted || deniedRef.current) return;
      const value = {
        ...result,
        items:
          before === undefined
            ? result.items
            : [...(pageRef.current?.items ?? []), ...result.items],
      };
      pageRef.current = value;
      setPage(value);
      if (before === undefined) setNewer(false);
      // The first read can finish after an SSE update whose probe had no page yet.
      if (versionRef.current !== startedAtVersion) setRecheck((value) => value + 1);
    } catch (cause) {
      if (!next.signal.aborted) failure(cause);
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      probe.current?.abort();
    };
  }, [taskId]);
  useEffect(() => {
    if (!pageRef.current || deniedRef.current) return;
    const check = new AbortController();
    probe.current = check;
    // Current authority is checked again; events never replace the records being read.
    void taskCompletionHistory(taskId, undefined, check.signal, 1)
      .then((latest) => {
        if (check.signal.aborted || deniedRef.current) return;
        setNewer((latest.items[0]?.id ?? null) !== (pageRef.current?.items[0]?.id ?? null));
        setError((current) => (current?.source === 'probe' ? null : current));
      })
      .catch((cause: unknown) => {
        if (!check.signal.aborted) failure(cause, 'probe');
      });
    return () => check.abort();
  }, [taskId, version, recheck]);

  return (
    <Dialog title="完成记录" drawer onClose={onClose}>
      <div className="drawer-form">
        <div className="dialog-body task-completion-history">
          <p>查看已记录的完成、取消和重新打开动作。记录不表示执行已停止，也不代表代码已发布。</p>
          {newer && <p role="status">有新的完成记录，可重新读取；已读记录保留。</p>}
          {denied && <p role="alert">完成记录已不可访问，先前记录已清除。</p>}
          {error && (
            <p className="form-error" role="alert">
              {error.message}
            </p>
          )}
          {!denied && (
            <div className="task-completion-history-actions">
              <Button disabled={busy} onClick={() => void load()}>
                重新读取记录
              </Button>
              {error?.source === 'read' && (
                <Button disabled={busy} onClick={() => void load(attempted.current)}>
                  重试记录读取
                </Button>
              )}
              {error?.source === 'probe' && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setRecheck((value) => value + 1);
                  }}
                >
                  重试记录检查
                </Button>
              )}
            </div>
          )}
          {page && !page.items.length && <p>暂无已记录的完成动作。已有任务状态不补造历史。</p>}
          <div className="task-completion-history-records">
            {page?.items.map((item) => (
              <Event key={item.id} item={item} />
            ))}
          </div>
          {busy && <p role="status">正在读取完成记录…</p>}
          {!denied && page?.nextCursor !== null && page?.nextCursor !== undefined && (
            <Button disabled={busy} onClick={() => void load(page.nextCursor!)}>
              更早的记录
            </Button>
          )}
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Dialog>
  );
}

function Event({ item }: { item: TaskCompletionEvent }) {
  const label = actionName(item.action);
  return (
    <article
      className="task-completion-event"
      aria-label={`任务修订 ${item.taskRevision} · ${label}`}
    >
      <h3>
        {label} · 任务修订 {item.taskRevision}
      </h3>
      <p>{item.actorName === null ? '操作者当前不可见' : `读取时显示名：${item.actorName}`}</p>
      <time dateTime={item.createdAt} title={item.createdAt}>
        {time(item.createdAt)}
      </time>
    </article>
  );
}
