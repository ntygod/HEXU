import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  ProjectTaskMove,
  ProjectTaskMoveReceipt,
  ProjectTaskOrder,
} from '../../../packages/contracts/src/project-task-order.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import {
  isCurrentProjectTaskOrder,
  isProjectTaskMoveReceipt,
  orderedProjectTasks,
} from './project-task-order-model.js';

export type ProjectOrderBaseline = Pick<ProjectTaskMove, 'expectedRevision' | 'expectedBaseline'>;
type Attempt = {
  readonly projectId: string;
  readonly body: ProjectTaskMove;
  readonly key: string;
  readonly taskLabel: string;
  readonly anchorLabel: string;
  phase: 'sending' | 'unknown' | 'accepted';
  receipt?: ProjectTaskMoveReceipt;
};
type Read = {
  source: readonly Task[];
  scope: string;
  loading: boolean;
  needsRefresh: boolean;
  value: ProjectTaskOrder | null;
  error: string;
};
type Options = {
  projectId: string;
  available: boolean;
  canOrder: boolean;
  tasks: readonly Task[];
  editableIds: readonly string[];
  scope: string;
};
const membership = (tasks: readonly Task[]) =>
  JSON.stringify(tasks.map((task) => [task.id, task.status]));

/** One current order source and one frozen write package for this mounted project. */
export function useProjectTaskOrder(options: Options) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const pendingRef = useRef<Attempt | null>(null);
  const [message, setMessage] = useState('');
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(true);
  const readSequence = useRef(0);
  const session = useRef({ scope: options.scope, generation: 0 });
  if (session.current.scope !== options.scope)
    session.current = { scope: options.scope, generation: session.current.generation + 1 };

  function remember(attempt: Attempt | null) {
    pendingRef.current = attempt;
    setPending(attempt);
  }
  function owns(attempt: Attempt) {
    return alive.current && pendingRef.current?.key === attempt.key;
  }
  function sameSession(generation: number) {
    return alive.current && session.current.generation === generation;
  }
  async function load(generation: number, invalidate = false) {
    const current = latest.current;
    if (!current.available) return false;
    const sequence = ++readSequence.current;
    const acceptedAtStart = pendingRef.current?.phase === 'accepted' ? pendingRef.current : null;
    const currentRead = () =>
      alive.current &&
      sameSession(generation) &&
      sequence === readSequence.current &&
      latest.current.tasks === current.tasks &&
      latest.current.scope === current.scope &&
      latest.current.available;
    setRead((previous) => {
      const coherent = previous && membership(previous.source) === membership(current.tasks);
      return {
        source: current.tasks,
        scope: current.scope,
        loading: true,
        value: coherent ? previous.value : null,
        needsRefresh: invalidate || !!(coherent && previous.needsRefresh),
        error: coherent ? previous.error : '',
      };
    });
    try {
      const value = await request<unknown>(
        `/projects/${encodeURIComponent(current.projectId)}/task-order`,
      );
      if (!currentRead()) return false;
      if (!isCurrentProjectTaskOrder(value, current.projectId, current.tasks))
        throw new Error('任务集合已变化或顺序响应不完整，请重新读取当前顺序。');
      setRead({
        source: current.tasks,
        scope: current.scope,
        loading: false,
        needsRefresh: false,
        value,
        error: '',
      });
      const accepted = pendingRef.current;
      if (
        acceptedAtStart &&
        accepted?.key === acceptedAtStart.key &&
        accepted?.phase === 'accepted' &&
        accepted.receipt &&
        value.revision >= accepted.receipt.revision
      ) {
        remember(null);
        setCompletedKey(accepted.key);
        setMessage('排序已保存，已读取当前顺序。');
      }
      return true;
    } catch (cause) {
      if (!currentRead()) return false;
      const knownFailure = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setRead((previous) => ({
        source: current.tasks,
        scope: current.scope,
        loading: false,
        needsRefresh: true,
        value:
          !knownFailure && previous && membership(previous.source) === membership(current.tasks)
            ? previous.value
            : null,
        error: cause instanceof Error ? cause.message : '读取任务顺序失败。',
      }));
      return false;
    }
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++readSequence.current;
    };
  }, []);
  useEffect(() => {
    // Background reads use the current interaction, independently of any old POST callback.
    if (options.available) void load(session.current.generation);
    else {
      ++readSequence.current;
      setRead(null);
    }
    // The existing project projection is the only refresh/visibility input.
  }, [options.available, options.projectId, options.tasks, options.scope]);
  useEffect(() => setMessage(''), [options.scope]);
  const editSignature = JSON.stringify(options.editableIds);
  useEffect(() => {
    const attempt = pendingRef.current;
    if (
      !options.available ||
      !options.canOrder ||
      (attempt &&
        (!options.editableIds.includes(attempt.body.taskId) ||
          !options.tasks.some((task) => task.id === attempt.body.anchorTaskId)))
    ) {
      remember(null);
      setOpen(false);
      setMessage('');
      if (attempt || open) {
        ++session.current.generation;
        if (options.available) void load(session.current.generation);
      }
    }
  }, [options.available, options.canOrder, editSignature, options.tasks]);

  const currentRead = read && membership(read.source) === membership(options.tasks) ? read : null;
  const value = currentRead?.value ?? null;
  const displayable = !!value;
  const ready = displayable && !currentRead?.error && !currentRead?.needsRefresh;

  async function send(attempt: Attempt) {
    const current = latest.current;
    if (
      !alive.current ||
      !current.available ||
      !current.canOrder ||
      !current.editableIds.includes(attempt.body.taskId) ||
      pendingRef.current?.phase === 'sending' ||
      (pendingRef.current && pendingRef.current.key !== attempt.key) ||
      attempt.phase === 'accepted'
    )
      return;
    const generation = session.current.generation;
    remember({ ...attempt, phase: 'sending' });
    setCompletedKey(null);
    setMessage('');
    try {
      const receipt = await request<unknown>(
        `/projects/${encodeURIComponent(attempt.projectId)}/task-order/move`,
        { method: 'POST', body: attempt.body, key: attempt.key },
      );
      if (!owns(attempt)) return;
      if (!isProjectTaskMoveReceipt(receipt, attempt.projectId, attempt.body))
        throw new Error('尚未收到可核对的排序回执，请确认原请求。');
      remember({ ...attempt, phase: 'accepted', receipt });
      if (sameSession(generation)) await load(generation);
    } catch (cause) {
      if (!owns(attempt)) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (!known) {
        remember({ ...attempt, phase: 'unknown' });
        if (sameSession(generation)) setMessage('排序结果尚未确认，请确认上次排序后再移动任务。');
      } else {
        remember(null);
        if (!sameSession(generation)) return;
        setMessage(
          cause.status === 409
            ? '排序已被其他操作改变。本次未应用；请查看最新顺序后重新选择位置。'
            : cause.message,
        );
        await load(generation, true);
      }
    }
  }

  function move(
    task: Task,
    anchor: Task,
    placement: 'before' | 'after',
    base?: ProjectOrderBaseline,
  ) {
    const current = latest.current;
    if (
      !open ||
      !ready ||
      !value ||
      !current.canOrder ||
      pendingRef.current ||
      current.scope !== options.scope ||
      current.tasks !== options.tasks ||
      task.id === anchor.id ||
      task.projectId !== current.projectId ||
      anchor.projectId !== current.projectId ||
      task.status === 'cancelled' ||
      !current.editableIds.includes(task.id)
    )
      return;
    const body = Object.freeze({
      taskId: task.id,
      anchorTaskId: anchor.id,
      placement,
      expectedRevision: base?.expectedRevision ?? value.revision,
      expectedBaseline: base?.expectedBaseline ?? value.baseline,
    });
    const key = crypto.randomUUID();
    void send({
      projectId: current.projectId,
      body,
      key,
      taskLabel: `${task.shortId} · ${task.title}`,
      anchorLabel: `${anchor.shortId} · ${anchor.title}`,
      phase: 'unknown',
    });
    return key;
  }

  return {
    open,
    pending,
    message,
    completedKey,
    interaction: session.current.generation,
    ready,
    displayable,
    loading: options.available && (!currentRead || currentRead.loading),
    error: currentRead?.error ?? '',
    orderedTasks: value ? orderedProjectTasks(options.tasks, value) : [],
    base: value ? { expectedRevision: value.revision, expectedBaseline: value.baseline } : null,
    canOrder: options.canOrder,
    editableIds: options.editableIds,
    scope: options.scope,
    move,
    load: () => load(session.current.generation),
    retry() {
      const attempt = pendingRef.current;
      if (attempt?.phase === 'unknown') void send(attempt);
      else if (attempt?.phase === 'accepted') void load(session.current.generation);
    },
    toggle() {
      if (!latest.current.available || !latest.current.canOrder) return;
      ++session.current.generation;
      ++readSequence.current;
      setOpen((previous) => !previous);
      // Detach old owned/background reads and start a read belonging to this interaction.
      // Keeping a coherent value here preserves rows and focus while that read is pending.
      void load(session.current.generation);
    },
  };
}

export type ProjectTaskOrderState = ReturnType<typeof useProjectTaskOrder>;
