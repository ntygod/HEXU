import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type MouseEvent,
} from 'react';
import type { Task, TaskStatus, Workbench } from '../../../packages/contracts/src/index.js';
import { request, getActiveSpace } from '../../../packages/client/src/index.js';
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
export const go = (path: string) => {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
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
}
const Context = createContext<AppState | null>(null);
export const useApp = () => {
  const context = useContext(Context);
  if (!context) throw new Error('Missing app context');
  return context;
};
export function Provider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Workbench | null>(null),
    [version, setVersion] = useState(0),
    [fatal, setFatal] = useState(''),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [connected, setConnected] = useState(false),
    [finishing, setFinishing] = useState<Task | null>(null),
    [stopAlso, setStopAlso] = useState(true),
    [busy, setBusy] = useState(false);
  const notice = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(async () => {
    const next = await request<Workbench>('/workbench');
    if (
      !['local-preview', 'team-local'].includes(next.mode) ||
      !Array.isArray(next.tasks) ||
      !Array.isArray(next.projects)
    )
      throw new Error('服务返回的工作台数据格式不正确');
    setData(next);
    setVersion((value) => value + 1);
    setFatal('');
  }, []);
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
      setFinishing(task);
      setStopAlso(true);
      return;
    }
    try {
      await perform(task, status);
    } catch (error) {
      notice((error as Error).message, true);
      await refresh().catch(() => {});
    }
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
  return (
    <Context.Provider value={{ data, version, refresh, notice, changeStatus, connected }}>
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
      {finishing && (
        <Dialog title="标记任务完成" onClose={() => !busy && setFinishing(null)}>
          <div className="dialog-body">
            <p>「{finishing.title}」仍有活动执行。任务完成与执行停止是两件事。</p>
            <label className="check-line">
              <input
                type="checkbox"
                checked={stopAlso}
                onChange={(event) => setStopAlso(event.target.checked)}
              />
              同时请求停止当前执行
            </label>
            <p className="muted">取消勾选后，任务会标记完成，执行仍保持可见。</p>
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setFinishing(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await perform(finishing, 'done', stopAlso ? 'stop' : 'keep');
                  setFinishing(null);
                } catch (error) {
                  notice((error as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              标记完成
            </Button>
          </div>
        </Dialog>
      )}
    </Context.Provider>
  );
}
export function useLoad<T>(path: string) {
  const { version } = useApp();
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    request<T>(path, { signal: controller.signal })
      .then(setValue)
      .catch((error) => {
        if (error.name !== 'AbortError') {
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
