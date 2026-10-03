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
type TaskAction = 'complete' | 'cancel' | 'start' | 'reopen';
const taskActionLabels: Record<TaskAction, string> = {
  complete: '完成',
  cancel: '取消',
  start: '标记进行中',
  reopen: '重新打开',
};
const taskActionStatuses: Record<TaskAction, TaskStatus> = {
  complete: 'done',
  cancel: 'cancelled',
  start: 'in_progress',
  reopen: 'todo',
};
interface TaskConfirmationPacket {
  readonly task: Readonly<Task>;
  readonly action: TaskAction;
  readonly path: string;
  readonly body: Readonly<{ expectedRevision: number; activeRunAction: 'stop' | 'keep' }>;
  readonly key: string;
  readonly hadActiveRuns: boolean;
  readonly direct: boolean;
}
interface PendingTaskAction {
  readonly packet: TaskConfirmationPacket;
  outcome: 'unknown' | 'accepted';
  error: string;
  operationId?: string;
}
interface TaskConfirmationSession {
  id: number;
  task: Task;
  action: TaskAction;
  direct?: boolean;
  hadActiveRuns: boolean;
  executionChanged: boolean;
  stopAlso: boolean;
  busy: boolean;
  revisionChanged: boolean;
  pending?: PendingTaskAction;
  operationId?: string;
  recovering?: boolean;
}
function unavailableConfirmation(action: TaskConfirmationSession['action']) {
  return action === 'cancel'
    ? '任务当前不可编辑，已关闭本次取消确认'
    : action === 'complete'
      ? '任务当前不可编辑，已取消本次完成确认'
      : '任务当前不可编辑，已关闭本次状态请求';
}
function isAccessDenial(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}
function newlyActiveCancellation(session: TaskConfirmationSession, data: Workbench) {
  return (
    session.action === 'cancel' &&
    !session.hadActiveRuns &&
    data.runs.some((run) => run.taskId === session.task.id && isActiveRun(run.state))
  );
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
    [confirming, setConfirming] = useState<TaskConfirmationSession | null>(null);
  const currentData = useRef<Workbench | null>(null);
  const pendingActions = useRef(new Map<string, PendingTaskAction>()).current;
  const providerGeneration = useRef(0);
  const workbenchReadId = useRef(0);
  const successfulWorkbenchReadId = useRef(0);
  const confirmation = useRef<TaskConfirmationSession | null>(null);
  const confirmationId = useRef(0);
  const setConfirmation = useCallback((session: TaskConfirmationSession | null) => {
    // Invalidate callbacks immediately, including before React renders refreshed access.
    confirmation.current = session;
    setConfirming(session);
  }, []);
  const notice = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const readWorkbench = useCallback(
    async (isCurrent?: () => boolean) => {
      const generation = providerGeneration.current;
      const readId = ++workbenchReadId.current;
      let next: Workbench;
      try {
        next = await request<Workbench>('/workbench');
      } catch (error) {
        if (
          generation === providerGeneration.current &&
          (!isCurrent || isCurrent()) &&
          readId > successfulWorkbenchReadId.current &&
          isAccessDenial(error)
        ) {
          pendingActions.clear();
          const session = confirmation.current;
          if (session) {
            setConfirmation(null);
            notice(unavailableConfirmation(session.action), true);
          }
        }
        throw error;
      }
      // A confirmation-owned read may outlive its session just like its POST.
      // Ordinary refreshes still apply the current visibility snapshot as before.
      if (generation !== providerGeneration.current || (isCurrent && !isCurrent())) return;
      if (
        !['local-preview', 'team-local'].includes(next.mode) ||
        !Array.isArray(next.tasks) ||
        !Array.isArray(next.projects)
      )
        throw new Error('服务返回的工作台数据格式不正确');
      // A later successful visibility read supersedes an older global denial.
      // This guards denial cleanup without changing ordinary successful refreshes.
      successfulWorkbenchReadId.current = Math.max(successfulWorkbenchReadId.current, readId);
      currentData.current = next;
      // Dismissed requests belong to this Provider too. Revocation must discard
      // them even when there is no dialog to close; a later grant cannot revive them.
      for (const taskId of pendingActions.keys()) {
        const task = next.tasks.find((item) => item.id === taskId);
        if (!task || !canEditTask(next, task)) pendingActions.delete(taskId);
      }
      const session = confirmation.current;
      if (session) {
        const task = next.tasks.find((item) => item.id === session.task.id);
        if (!task || !canEditTask(next, task)) {
          setConfirmation(null);
          notice(unavailableConfirmation(session.action), true);
        } else if (!session.busy && !session.pending) {
          setConfirmation({
            ...session,
            revisionChanged: session.revisionChanged || task.revision !== session.task.revision,
            executionChanged: session.executionChanged || newlyActiveCancellation(session, next),
          });
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
    [drafts, notice, pendingActions, setConfirmation],
  );
  const refresh = useCallback(() => readWorkbench(), [readWorkbench]);
  useEffect(
    () => () => {
      providerGeneration.current++;
      pendingActions.clear();
      drafts.clear();
      currentData.current = null;
      confirmation.current = null;
    },
    [drafts, pendingActions],
  );
  useEffect(() => {
    let route = location.pathname + location.search;
    const detachDirectAction = () => {
      const next = location.pathname + location.search;
      if (next === route) return;
      route = next;
      // A direct first send has no dialog to dismiss before navigating. Retain
      // its packet, but detach the old page's presentation and owned reads.
      if (confirmation.current?.direct) setConfirmation(null);
    };
    window.addEventListener('popstate', detachDirectAction);
    return () => window.removeEventListener('popstate', detachDirectAction);
  }, [setConfirmation]);
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
  const changeStatus = async (task: Task, status: TaskStatus) => {
    const current = currentData.current;
    const selected = current?.tasks.find((item) => item.id === task.id);
    if (!current || !selected || !canEditTask(current, selected)) {
      pendingActions.delete(task.id);
      if (confirmation.current?.task.id === task.id) setConfirmation(null);
      notice('任务当前不可编辑，请重新查看任务', true);
      return;
    }
    // Every status entry, including direct reopen/start/complete, must resolve
    // the original command before it can start another command for this Task.
    const pending = pendingActions.get(task.id);
    if (pending) {
      if (pending.operationId || confirmation.current?.pending === pending) return;
      const packet = pending.packet;
      setConfirmation({
        id: ++confirmationId.current,
        task: packet.task,
        action: packet.action,
        direct: packet.direct,
        hadActiveRuns: packet.hadActiveRuns,
        executionChanged: false,
        stopAlso: packet.body.activeRunAction === 'stop',
        busy: false,
        revisionChanged: false,
        pending,
        recovering: true,
      });
      return;
    }
    if (
      status === 'cancelled' ||
      (status === 'done' &&
        current.runs.some((run) => run.taskId === task.id && isActiveRun(run.state)))
    ) {
      if (status === 'cancelled' && selected.status === 'cancelled') return;
      const hadActiveRuns = current.runs.some(
        (run) => run.taskId === task.id && isActiveRun(run.state),
      );
      setConfirmation({
        id: ++confirmationId.current,
        task: structuredClone(task),
        action: status === 'cancelled' ? 'cancel' : 'complete',
        hadActiveRuns,
        executionChanged: false,
        // No-active cancellation consent never silently turns into a stop request.
        stopAlso: status === 'done' || hadActiveRuns,
        busy: false,
        revisionChanged: selected.revision !== task.revision,
      });
      return;
    }
    // Direct actions still send on the first click. Their session is hidden until
    // recovery is needed, but owns the same immutable packet as confirmed actions.
    const session: TaskConfirmationSession = {
      id: ++confirmationId.current,
      task: structuredClone(task),
      action: status === 'done' ? 'complete' : status === 'in_progress' ? 'start' : 'reopen',
      direct: true,
      hadActiveRuns: current.runs.some((run) => run.taskId === task.id && isActiveRun(run.state)),
      executionChanged: false,
      stopAlso: true,
      busy: false,
      revisionChanged: selected.revision !== task.revision,
    };
    setConfirmation(session);
    await confirmTaskAction(session.id);
  };
  const confirmTaskAction = async (id: number) => {
    const session = confirmation.current;
    if (!session || session.id !== id || session.busy) return;
    const current = currentData.current;
    const task = current?.tasks.find((item) => item.id === session.task.id);
    if (!current || !task || !canEditTask(current, task)) {
      pendingActions.delete(session.task.id);
      setConfirmation(null);
      notice(unavailableConfirmation(session.action), true);
      return;
    }
    const executionChanged = session.executionChanged || newlyActiveCancellation(session, current);
    if (
      !session.pending &&
      (session.revisionChanged || task.revision !== session.task.revision || executionChanged)
    ) {
      if (session.direct) {
        setConfirmation(null);
        notice('任务已更新，请重新查看任务后再更改状态', true);
        return;
      }
      setConfirmation({
        ...session,
        revisionChanged: session.revisionChanged || task.revision !== session.task.revision,
        executionChanged,
      });
      return;
    }
    const packet: TaskConfirmationPacket =
      session.pending?.packet ??
      Object.freeze({
        task: Object.freeze(structuredClone(session.task)),
        action: session.action,
        path: `/tasks/${encodeURIComponent(session.task.id)}/${session.action}`,
        body: Object.freeze({
          expectedRevision: session.task.revision,
          activeRunAction: session.stopAlso ? 'stop' : 'keep',
        }),
        key: crypto.randomUUID(),
        hadActiveRuns: session.hadActiveRuns,
        direct: !!session.direct,
      });
    const operationId = crypto.randomUUID();
    const generation = providerGeneration.current;
    const isCurrent = () =>
      generation === providerGeneration.current &&
      confirmation.current?.id === id &&
      confirmation.current.operationId === operationId;
    const ownsPacket = () =>
      generation === providerGeneration.current &&
      pendingActions.get(packet.task.id)?.packet === packet &&
      pendingActions.get(packet.task.id)?.operationId === operationId;
    const putPending = (pending: PendingTaskAction) => {
      const next = { ...pending, operationId };
      pendingActions.set(packet.task.id, next);
      if (isCurrent()) setConfirmation({ ...confirmation.current!, pending: next });
    };
    setConfirmation({ ...session, operationId, busy: true, recovering: !!session.pending });
    // Store the immutable packet before the very first POST. Dialog ownership is
    // separate: closing an uncertain result only dismisses its current presentation.
    putPending({ packet, outcome: session.pending?.outcome ?? 'unknown', error: '' });
    try {
      if (session.pending?.outcome !== 'accepted') {
        try {
          const receipt = await request<Task>(packet.path, {
            method: 'POST',
            body: packet.body,
            key: packet.key,
          });
          if (!ownsPacket()) return;
          if (
            receipt?.id !== packet.task.id ||
            receipt.status !== taskActionStatuses[packet.action] ||
            receipt.revision !== packet.body.expectedRevision + 1
          )
            throw new ApiError(
              '服务未返回可核对的原请求回执，请确认原请求结果',
              'INVALID_RESPONSE',
              502,
            );
          // Acceptance is established by the original Task receipt, never by an
          // SSE projection or the success/failure of the subsequent Workbench GET.
          putPending({ packet, outcome: 'accepted', error: '' });
        } catch (error) {
          if (!ownsPacket()) return;
          if (isAccessDenial(error)) {
            pendingActions.delete(packet.task.id);
            if (isCurrent()) {
              setConfirmation(null);
              notice(unavailableConfirmation(session.action), true);
            }
            return;
          }
          const message = error instanceof Error ? error.message : '暂时无法确认原请求结果';
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            pendingActions.delete(packet.task.id);
            if (isCurrent())
              setConfirmation({
                ...confirmation.current!,
                pending: undefined,
                revisionChanged: session.revisionChanged || error.status === 409,
              });
          } else {
            putPending({ packet, outcome: 'unknown', error: message });
          }
          if (isCurrent()) {
            await readWorkbench(isCurrent).catch(() => {});
            if (isCurrent()) {
              notice(message, true);
              if (session.direct && !pendingActions.has(packet.task.id)) setConfirmation(null);
            }
          }
          return;
        }
      }
      // A different Task's session may be open now. Keep the known ACK in its
      // provider-owned packet, without applying an old session's refresh or UI.
      if (!isCurrent()) return;
      try {
        await readWorkbench(isCurrent);
        if (!isCurrent()) return;
        pendingActions.delete(packet.task.id);
        setConfirmation(null);
        notice(
          session.pending
            ? `原${taskActionLabels[packet.action]}请求已确认于任务修订 ${packet.body.expectedRevision + 1}；当前任务可能已有后续变化`
            : packet.action === 'cancel'
              ? '已取消任务，讨论和成果已保留，随时可以重新打开'
              : packet.action === 'complete'
                ? '已标记完成，随时可以重新打开'
                : '任务状态已更新',
        );
      } catch (error) {
        if (!isCurrent()) return;
        putPending({
          packet,
          outcome: 'accepted',
          error: error instanceof Error ? error.message : '暂时无法刷新任务状态',
        });
        notice('原请求已确认成功，暂时无法刷新任务状态。请重试刷新。', true);
      }
    } finally {
      if (ownsPacket()) {
        const pending = { ...pendingActions.get(packet.task.id)!, operationId: undefined };
        pendingActions.set(packet.task.id, pending);
        if (isCurrent()) setConfirmation({ ...confirmation.current!, pending });
      }
      if (isCurrent()) {
        const session = confirmation.current!;
        const task = currentData.current?.tasks.find((item) => item.id === session.task.id);
        setConfirmation({
          ...session,
          busy: false,
          revisionChanged:
            !session.pending &&
            (session.revisionChanged || task?.revision !== session.task.revision),
          executionChanged:
            !session.pending &&
            (session.executionChanged ||
              (!!currentData.current && newlyActiveCancellation(session, currentData.current))),
        });
      }
    }
  };
  const closeConfirmation = (id: number) => {
    if (confirmation.current?.id === id && !confirmation.current.busy) setConfirmation(null);
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
  const confirmationTask = confirming && data.tasks.find((task) => task.id === confirming.task.id);
  const revisionChanged =
    confirming &&
    !confirming.pending &&
    (confirming.revisionChanged ||
      (!confirming.busy && confirmationTask?.revision !== confirming.task.revision));
  const activeRuns = confirming
    ? data.runs.filter((run) => run.taskId === confirming.task.id && isActiveRun(run.state))
    : [];
  const executionChanged =
    confirming &&
    !confirming.pending &&
    (confirming.executionChanged ||
      (!confirming.busy && newlyActiveCancellation(confirming, data)));
  const cancellation = confirming?.action === 'cancel';
  const pending = confirming?.pending;
  const showRecovery = !!pending && (!confirming.busy || confirming.recovering);
  const showConfirmation =
    confirming &&
    (!confirming.direct || showRecovery) &&
    confirmationTask &&
    canEditTask(data, confirmationTask);
  const confirmationInvalid = !!revisionChanged || !!executionChanged;
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
      {confirming && showConfirmation && (
        <Dialog
          title={
            cancellation
              ? '取消任务'
              : confirming.action === 'start'
                ? '标记任务进行中'
                : confirming.action === 'reopen'
                  ? '重新打开任务'
                  : '标记任务完成'
          }
          onClose={() => closeConfirmation(confirming.id)}
        >
          <div className="dialog-body">
            {confirming.direct ? (
              <p>
                「{confirming.task.title}」的原{taskActionLabels[confirming.action]}请求已提交。
                {confirming.action === 'complete'
                  ? '任务完成与执行停止是两件事。'
                  : '本次只更改任务状态，不会启动或停止执行。'}
              </p>
            ) : cancellation ? (
              <>
                <p>
                  {pending
                    ? `「${confirming.task.title}」的原取消请求已提交。讨论和成果会保留，之后仍可重新打开任务。`
                    : `确认不再继续「${confirming.task.title}」？讨论和成果会保留，之后仍可重新打开任务。`}
                </p>
                {pending ||
                confirming.hadActiveRuns ||
                activeRuns.length > 0 ||
                executionChanged ? (
                  <p>
                    当前有 {activeRuns.length} 项活动执行。停止中或连接未知的执行也计入其中。
                    取消任务不代表执行已经停止。
                  </p>
                ) : (
                  <p>当前没有活动执行，本次只取消任务，不请求停止执行。</p>
                )}
              </>
            ) : pending ? (
              <p>
                「{confirming.task.title}」的原完成请求已提交。当前有 {activeRuns.length}{' '}
                项活动执行。任务完成与执行停止是两件事。
              </p>
            ) : (
              <p>「{confirming.task.title}」仍有活动执行。任务完成与执行停止是两件事。</p>
            )}
            {pending && (
              <section
                aria-label={
                  pending.outcome === 'accepted' ? '任务状态请求已确认' : '任务状态请求待确认'
                }
              >
                <p role="status">
                  {pending.outcome === 'accepted'
                    ? `原请求已确认成功，回执为任务修订 ${pending.packet.body.expectedRevision + 1}；当前任务可能已有后续变化。`
                    : confirming.busy
                      ? '原请求已提交，正在等待可核对的回执。'
                      : confirming.direct
                        ? '尚未确认原请求是否成功，原请求内容已锁定。'
                        : '尚未确认原请求是否成功，停止选择已锁定。'}
                </p>
                <p>
                  {confirming.direct
                    ? confirming.action === 'complete'
                      ? '原处理方式：标记任务完成，并请求停止处理时的活动执行；请求停止不等于已终止。'
                      : `原操作：${confirming.action === 'start' ? '将任务标记为进行中' : '将任务重新打开为待处理'}。`
                    : pending.packet.body.activeRunAction === 'stop'
                      ? '原选择：同时请求停止执行；请求停止不等于已终止。'
                      : '原选择：只更改任务状态，不请求停止执行。'}
                </p>
                <p>
                  {pending.outcome === 'accepted'
                    ? '刷新只读取当前任务状态，不会再次提交状态请求。'
                    : `本次保留原任务、原修订 ${pending.packet.body.expectedRevision} 和${confirming.direct ? '原处理方式' : '停止选择'}；确认结果会重试同一请求。`}
                  关闭不会撤回已提交的操作。
                </p>
                {pending.error && <p role="alert">{pending.error}</p>}
              </section>
            )}
            {revisionChanged && (
              <p role="alert">
                {cancellation
                  ? '任务已更新，本次取消确认已失效。请返回后查看当前任务，再重新选择取消任务。'
                  : '任务已更新，本次完成确认已失效。请关闭后查看当前任务，再重新选择标记完成。'}
              </p>
            )}
            {executionChanged && (
              <p role="alert">活动执行已变化，本次取消确认已失效。请返回后重新确认。</p>
            )}
            {!confirming.direct && (!cancellation || confirming.hadActiveRuns) && (
              <>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={confirming.stopAlso}
                    disabled={confirming.busy || !!pending || confirmationInvalid}
                    onChange={(event) => {
                      const session = confirmation.current;
                      if (
                        session?.id === confirming.id &&
                        !session.busy &&
                        !session.pending &&
                        !session.revisionChanged &&
                        !session.executionChanged
                      )
                        setConfirmation({ ...session, stopAlso: event.target.checked });
                    }}
                  />
                  同时请求停止当前执行
                </label>
                <p className="muted">
                  {cancellation
                    ? '取消勾选后，仅取消任务，不请求停止执行；实际执行状态仍单独显示。请求停止也不等于已终止。'
                    : '取消勾选后，任务会标记完成，执行仍保持可见。'}
                </p>
              </>
            )}
          </div>
          <div className="dialog-footer">
            <Button onClick={() => closeConfirmation(confirming.id)} disabled={confirming.busy}>
              {showRecovery ? '暂时关闭' : cancellation ? '返回' : '取消'}
            </Button>
            <Button
              variant="primary"
              busy={confirming.busy}
              disabled={confirmationInvalid}
              onClick={() => confirmTaskAction(confirming.id)}
            >
              {showRecovery
                ? pending!.outcome === 'accepted'
                  ? '刷新任务状态'
                  : '确认原请求结果'
                : cancellation
                  ? '确认取消任务'
                  : '标记完成'}
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
