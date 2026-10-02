import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from 'react';
import type { Task, TaskStatus, Workbench } from '../../../packages/contracts/src/index.js';
import { ApiError, request, getActiveSpace } from '../../../packages/client/src/index.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
export function canEditTask(data: Workbench, task: Task) {
  return (
    data.mode === 'local-preview' ||
    (task.visibility === 'private'
      ? task.ownerUserId === data.user.id
      : ['edit', 'manage'].includes(
          data.projects.find((p) => p.id === task.projectId)?.access ?? '',
        ))
  );
}
/** Per-history-entry key so back/forward restores scroll and push navigates fresh. */
const entryKey =
  (history.state as { hxKey?: string } | null)?.hxKey ??
  (() => {
    const key = Math.random().toString(36).slice(2);
    history.replaceState({ hxKey: key }, '');
    return key;
  })();
const scrollMemory = new Map<string, { x: number; y: number }>();
const TITLES: [RegExp, string][] = [
  [/^\/projects\/[^/]+/, '项目'],
  [/^\/projects/, '项目'],
  [/^\/tasks\/[^/]+/, '任务'],
  [/^\/results\/[^/]+/, '成果'],
  [/^\/results/, '成果'],
  [/^\/settings/, '资源与设置'],
];
export function go(path: string) {
  scrollMemory.set(entryKey, { x: scrollX, y: scrollY });
  history.pushState({ hxKey: Math.random().toString(36).slice(2) }, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
/** Route chrome that belongs to the document, not a page component: title, scroll, focus. */
const hashJump = { current: false };
export function useRouteChrome(path: string) {
  useEffect(() => {
    const title = TITLES.find(([pattern]) => pattern.test(path))?.[1] ?? '工作台';
    document.title = `${title} · HEXU 合序`;
    // Same path with only the hash changing is an in-page anchor jump: leave
    // scroll and focus to the browser instead of yanking the view to the top.
    if (hashJump.current) {
      hashJump.current = false;
      return;
    }
    const key = (history.state as { hxKey?: string } | null)?.hxKey;
    const saved = key ? scrollMemory.get(key) : undefined;
    if (saved) scrollTo(saved.x, saved.y);
    else scrollTo(0, 0);
    const main = document.getElementById('main-content');
    if (main && !main.contains(document.activeElement)) {
      main.setAttribute('tabindex', '-1');
      main.focus({ preventScroll: true });
    }
  }, [path]);
}
export function Link({
  to,
  children,
  className,
  ...props
}: {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  'aria-current'?: 'page';
}) {
  return (
    <a
      href={to}
      {...props}
      className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        const target = new URL(to, location.href);
        if (target.pathname === location.pathname && target.hash) hashJump.current = true;
        go(to);
      }}
    >
      {children}
    </a>
  );
}
export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const change = () => setPath(location.pathname);
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  return path;
}
interface AppState {
  data: Workbench;
  version: number;
  refresh: () => Promise<void>;
  notice: (text: string, error?: boolean) => void;
  changeStatus: (task: Task, status: TaskStatus) => Promise<void>;
  connected: boolean;
  readDraft(taskId: string, purpose: string): string | undefined;
  saveDraft(taskId: string, purpose: string, text: string): void;
}
const Context = createContext<AppState | null>(null);
interface CompletionSession {
  id: number;
  task: Task;
  stopAlso: boolean;
  busy: boolean;
  revisionChanged: boolean;
}
export const useApp = () => {
  const context = useContext(Context);
  if (!context) throw new Error('Missing app context');
  return context;
};
export function Provider({ children }: { children: ReactNode }) {
  // This memory belongs to the mounted identity/space provider, never browser storage.
  const drafts = useRef(new Map<string, Map<string, string>>()).current;
  const readDraft = useCallback(
    (taskId: string, purpose: string) => drafts.get(taskId)?.get(purpose),
    [drafts],
  );
  const saveDraft = useCallback(
    (taskId: string, purpose: string, text: string) => {
      if (!drafts.has(taskId)) drafts.set(taskId, new Map());
      if (text) drafts.get(taskId)!.set(purpose, text);
      else drafts.get(taskId)!.delete(purpose);
    },
    [drafts],
  );
  const [data, setData] = useState<Workbench | null>(null),
    [version, setVersion] = useState(0),
    [fatal, setFatal] = useState(''),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [connected, setConnected] = useState(false),
    [finishing, setFinishing] = useState<CompletionSession | null>(null);
  const currentData = useRef<Workbench | null>(null);
  const completion = useRef<CompletionSession | null>(null);
  const completionId = useRef(0);
  const setCompletion = useCallback((session: CompletionSession | null) => {
    // Invalidate callbacks immediately, including before React renders refreshed access.
    completion.current = session;
    setFinishing(session);
  }, []);
  const notice = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const readWorkbench = useCallback(
    async (isCurrent?: () => boolean) => {
      const next = await request<Workbench>('/workbench');
      // A completion-owned read may outlive its confirmation just like its POST.
      // Ordinary refreshes still apply the current visibility snapshot as before.
      if (isCurrent && !isCurrent()) return;
      if (
        !['local-preview', 'team-local'].includes(next.mode) ||
        !Array.isArray(next.tasks) ||
        !Array.isArray(next.projects)
      )
        throw new Error('服务返回的工作台数据格式不正确');
      currentData.current = next;
      const session = completion.current;
      if (session) {
        const task = next.tasks.find((item) => item.id === session.task.id);
        if (!task || !canEditTask(next, task)) {
          setCompletion(null);
          notice('任务当前不可编辑，已取消本次完成确认', true);
        } else if (!session.busy && task.revision !== session.task.revision) {
          setCompletion({ ...session, revisionChanged: true });
        }
      }
      setData(next);
      for (const taskId of drafts.keys()) {
        const task = next.tasks.find((item) => item.id === taskId);
        if (!task || !canEditTask(next, task)) drafts.delete(taskId);
      }
      setVersion((value) => value + 1);
      setFatal('');
    },
    [drafts, notice, setCompletion],
  );
  const refresh = useCallback(() => readWorkbench(), [readWorkbench]);
  useEffect(
    () => () => {
      completion.current = null;
    },
    [],
  );
  useEffect(() => {
    refresh().catch((error) => setFatal(error.message));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource(
      '/api/v1/events' +
        (getActiveSpace() ? '?spaceId=' + encodeURIComponent(getActiveSpace()) : ''),
    );
    events.addEventListener('ready', () => setConnected(true));
    events.addEventListener('changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh().catch(() => setConnected(false)), 120);
    });
    events.addEventListener('access-ended', (event) => {
      events.close();
      const reason = JSON.parse((event as MessageEvent).data).reason;
      window.dispatchEvent(
        new Event(reason === 'session' ? 'hexu-auth-required' : 'hexu-space-revoked'),
      );
    });
    events.onerror = () => setConnected(false);
    return () => {
      events.close();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const perform = async (
    task: Task,
    status: TaskStatus,
    activeRunAction: 'stop' | 'keep' = 'stop',
  ) => {
    const action =
      status === 'done'
        ? 'complete'
        : status === 'cancelled'
          ? 'cancel'
          : status === 'in_progress'
            ? 'start'
            : 'reopen';
    await request(`/tasks/${task.id}/${action}`, {
      method: 'POST',
      body: { expectedRevision: task.revision, activeRunAction },
    });
    await refresh();
    notice(status === 'done' ? '已标记完成，随时可以重新打开' : '任务状态已更新');
  };
  const changeStatus = async (task: Task, status: TaskStatus) => {
    if (data && !canEditTask(data, task)) {
      notice('只读项目不能修改任务状态', true);
      return;
    }
    if (
      status === 'done' &&
      data?.runs.some((run) => run.taskId === task.id && isActiveRun(run.state))
    ) {
      const current = currentData.current;
      const selected = current?.tasks.find((item) => item.id === task.id);
      if (!current || !selected || !canEditTask(current, selected)) {
        notice('任务当前不可编辑，请重新查看任务', true);
        return;
      }
      setCompletion({
        id: ++completionId.current,
        task: structuredClone(task),
        stopAlso: true,
        busy: false,
        revisionChanged: selected.revision !== task.revision,
      });
      return;
    }
    try {
      await perform(task, status);
    } catch (error) {
      notice((error as Error).message, true);
      await refresh().catch(() => {});
    }
  };
  const confirmCompletion = async (id: number) => {
    const session = completion.current;
    if (!session || session.id !== id || session.busy) return;
    const current = currentData.current;
    const task = current?.tasks.find((item) => item.id === session.task.id);
    if (!current || !task || !canEditTask(current, task)) {
      setCompletion(null);
      notice('任务当前不可编辑，已取消本次完成确认', true);
      return;
    }
    if (session.revisionChanged || task.revision !== session.task.revision) {
      setCompletion({ ...session, revisionChanged: true });
      return;
    }
    const isCurrent = () => completion.current?.id === id;
    setCompletion({ ...session, busy: true });
    try {
      // Keep the selected revision/choice. A sent command's own SSE update does
      // not invalidate it; only its response establishes whether it was accepted.
      await request(`/tasks/${session.task.id}/complete`, {
        method: 'POST',
        body: {
          expectedRevision: session.task.revision,
          activeRunAction: session.stopAlso ? 'stop' : 'keep',
        },
      });
      if (!isCurrent()) return;
      await readWorkbench(isCurrent);
      if (!isCurrent()) return;
      setCompletion(null);
      notice('已标记完成，随时可以重新打开');
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setCompletion(null);
        notice('任务当前不可编辑，已取消本次完成确认', true);
        return;
      }
      if (error instanceof ApiError && error.status === 409)
        setCompletion({ ...completion.current!, revisionChanged: true });
      await readWorkbench(isCurrent).catch(() => {});
      if (isCurrent()) notice((error as Error).message, true);
    } finally {
      if (isCurrent()) {
        const session = completion.current!;
        const task = currentData.current?.tasks.find((item) => item.id === session.task.id);
        setCompletion({
          ...session,
          busy: false,
          revisionChanged: session.revisionChanged || task?.revision !== session.task.revision,
        });
      }
    }
  };
  const closeCompletion = (id: number) => {
    if (completion.current?.id === id && !completion.current.busy) setCompletion(null);
  };
  if (!data)
    return (
      <div className="startup">
        <div className="startup-mark">H</div>
        <h1>HEXU · 合序</h1>
        {fatal ? (
          <>
            <p role="alert">{fatal}</p>
            <p>
              请在仓库根目录运行 <code>npm run dev</code>
            </p>
            <Button onClick={() => refresh().catch((error) => setFatal(error.message))}>
              重新连接
            </Button>
          </>
        ) : (
          <>
            <span className="spinner" />
            <p>正在打开工作台…</p>
          </>
        )}
      </div>
    );
  const completionTask = finishing && data.tasks.find((task) => task.id === finishing.task.id);
  const revisionChanged =
    finishing &&
    (finishing.revisionChanged ||
      (!finishing.busy && completionTask?.revision !== finishing.task.revision));
  return (
    <Context.Provider
      value={{ data, version, refresh, notice, changeStatus, connected, readDraft, saveDraft }}
    >
      {children}
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          <Icon name={toast.error ? 'warning' : 'check'} />
          {toast.text}
          <button aria-label="关闭通知" onClick={() => setToast(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {finishing && completionTask && canEditTask(data, completionTask) && (
        <Dialog title="标记任务完成" onClose={() => closeCompletion(finishing.id)}>
          <div className="dialog-body">
            <p>「{finishing.task.title}」仍有活动执行。任务完成与执行停止是两件事。</p>
            {revisionChanged && (
              <p role="alert">
                任务已更新，本次完成确认已失效。请关闭后查看当前任务，再重新选择标记完成。
              </p>
            )}
            <label className="check-line">
              <input
                type="checkbox"
                checked={finishing.stopAlso}
                disabled={finishing.busy || !!revisionChanged}
                onChange={(event) => {
                  const session = completion.current;
                  if (session?.id === finishing.id && !session.busy && !session.revisionChanged)
                    setCompletion({ ...session, stopAlso: event.target.checked });
                }}
              />
              同时请求停止当前执行
            </label>
            <p className="muted">取消勾选后，任务会标记完成，执行仍保持可见。</p>
          </div>
          <div className="dialog-footer">
            <Button onClick={() => closeCompletion(finishing.id)} disabled={finishing.busy}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={finishing.busy}
              disabled={!!revisionChanged}
              onClick={() => confirmCompletion(finishing.id)}
            >
              标记完成
            </Button>
          </div>
        </Dialog>
      )}
    </Context.Provider>
  );
}
export function useTaskDraft(
  taskId: string,
  purpose: string,
  initial = '',
): [string, (text: string) => void] {
  const { data, readDraft, saveDraft } = useApp();
  const task = data.tasks.find((item) => item.id === taskId);
  const editable = !!task && canEditTask(data, task);
  const key = `${taskId}:${purpose}:${editable}`;
  const restored = () => (editable ? (readDraft(taskId, purpose) ?? initial) : '');
  const [draft, setDraft] = useState(() => ({ key, text: restored() }));
  const current = draft.key === key ? draft : { key, text: restored() };
  if (draft.key !== key) setDraft(current);
  return [
    current.text,
    (text) => {
      if (!editable) return;
      saveDraft(taskId, purpose, text);
      setDraft({ key, text });
    },
  ];
}
export function useLoad<T>(path: string) {
  const { version } = useApp();
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    request<T>(path, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((error) => {
        // Cancellation during response.json() may be surfaced as INVALID_RESPONSE.
        // A superseded read must not clear the current task and its open editor.
        if (!controller.signal.aborted && error.name !== 'AbortError') {
          setValue(null);
          setError(error.message);
        }
      });
    return () => controller.abort();
  }, [path, version]);
  return { value, error };
}
export function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Singapore',
  });
}
