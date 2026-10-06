import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  parseTaskCreate,
  type Task,
  type Workbench,
} from '../../../packages/contracts/src/index.js';
import { ApiError, getActiveSpace, request } from '../../../packages/client/src/index.js';

type CreateBody = ReturnType<typeof parseTaskCreate>;
interface CreationPacket {
  readonly actorId: string;
  readonly spaceId: string;
  readonly path: string;
  readonly body: Readonly<CreateBody>;
  readonly key: string;
  readonly projectName: string;
}
interface PendingCreation {
  readonly packet: CreationPacket;
  readonly receipt?: Readonly<Task>;
  readonly operationId?: string;
  readonly error: string;
}
interface CreationSession {
  readonly id: string;
  readonly onClose: () => void;
  readonly blocked?: boolean;
}
interface CreationView {
  sessionId?: string;
  pending: PendingCreation | null;
  error: string;
  blocked: boolean;
  rejectedBody?: Readonly<CreateBody>;
}
interface CreationOptions {
  currentData: () => Workbench | null;
  readWorkbench: (isCurrent: () => boolean, ownsIdentity: () => boolean) => Promise<void>;
  notice: (text: string, error?: boolean) => void;
  onCreated: (taskId: string) => void;
}
export function canCreateTask(data: Workbench, projectId: string | null) {
  if (!projectId) return true;
  const project = data.projects.find((item) => item.id === projectId.trim());
  return (
    !!project &&
    (data.mode === 'local-preview' || ['edit', 'manage'].includes(project.access ?? ''))
  );
}
function ownsIdentity(data: Workbench, packet: CreationPacket) {
  return data.user.id === packet.actorId && (data.space?.id ?? 'space-demo') === packet.spaceId;
}
function creationReceipt(value: unknown, packet: CreationPacket): Readonly<Task> {
  const receipt = value as Partial<Task> | null;
  // The server trims all three accepted fields. The original wire body stays
  // unchanged for recovery; only the receipt comparison uses this normalization.
  const expected = parseTaskCreate(packet.body);
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    typeof receipt.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.id) ||
    typeof receipt.shortId !== 'string' ||
    !/^HX-\d+$/.test(receipt.shortId) ||
    receipt.spaceId !== packet.spaceId ||
    receipt.projectId !== expected.projectId ||
    receipt.visibility !== (expected.projectId ? 'project' : 'private') ||
    receipt.ownerUserId !== packet.actorId ||
    receipt.createdByUserId !== packet.actorId ||
    receipt.title !== expected.title ||
    receipt.description !== expected.description ||
    receipt.status !== 'todo' ||
    receipt.revision !== 1 ||
    receipt.attention !== null ||
    typeof receipt.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    receipt.updatedAt !== receipt.createdAt
  )
    throw new ApiError('服务未返回可核对的原创建回执，请确认原创建结果', 'INVALID_RESPONSE', 502);
  return Object.freeze(structuredClone(receipt as Task));
}
const accessDenial = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
const unavailable = '任务创建权限已失效，请重新查看后再创建';

/** One ordinary create request per mounted identity/space Provider, never storage. */
export function useTaskCreation(options: CreationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<PendingCreation | null>(null);
  const session = useRef<CreationSession | null>(null);
  const generation = useRef(0);
  const [view, setView] = useState<CreationView>({ pending: null, error: '', blocked: false });
  const publish = useCallback((error = '', rejectedBody?: Readonly<CreateBody>) => {
    setView({
      sessionId: session.current?.id,
      pending: pending.current,
      error,
      blocked: !!session.current?.blocked,
      rejectedBody,
    });
  }, []);
  const detach = useCallback(
    (id: string) => {
      if (session.current?.id !== id) return;
      session.current = null;
      publish();
    },
    [publish],
  );
  const close = useCallback(
    (id: string) => {
      const current = session.current;
      if (current?.id !== id) return;
      detach(id);
      current.onClose();
    },
    [detach],
  );
  const open = useCallback(
    (id: string, onClose: () => void) => {
      const previous = session.current;
      session.current = { id, onClose };
      publish();
      if (previous && previous.id !== id) previous.onClose();
    },
    [publish],
  );
  const clear = useCallback(() => {
    pending.current = null;
    const current = session.current;
    session.current = null;
    publish();
    if (current) {
      current.onClose();
      latest.current.notice(unavailable, true);
    }
  }, [publish]);
  const reconcile = useCallback(
    (data: Workbench) => {
      const packet = pending.current?.packet;
      if (packet && (!ownsIdentity(data, packet) || !canCreateTask(data, packet.body.projectId)))
        clear();
    },
    [clear],
  );
  useLayoutEffect(() => {
    let route = location.pathname + location.search;
    const navigate = () => {
      const next = location.pathname + location.search;
      if (next === route) return;
      route = next;
      if (session.current) close(session.current.id);
    };
    window.addEventListener('popstate', navigate);
    return () => {
      window.removeEventListener('popstate', navigate);
      // Invalidate before the replacement Provider can mount a new editor, not
      // later in passive cleanup after an obsolete response broadcasts events.
      generation.current++;
      pending.current = null;
      session.current = null;
    };
  }, [close]);

  const submit = useCallback(
    async (id: string, body: CreateBody, confirmOriginal: boolean) => {
      const currentSession = session.current;
      if (currentSession?.id !== id || currentSession.blocked || pending.current?.operationId)
        return;
      // A stale entry cannot turn a draft submission into recovery consent, or
      // a recovery click into a new request after its packet was discarded.
      if (!!pending.current !== confirmOriginal) return;
      const data = latest.current.currentData();
      const existing = pending.current;
      const projectId = existing ? existing.packet.body.projectId : body.projectId;
      if (
        !data ||
        !canCreateTask(data, projectId) ||
        (existing && !ownsIdentity(data, existing.packet))
      ) {
        clear();
        return;
      }
      if (!existing) {
        try {
          parseTaskCreate(body);
        } catch (error) {
          publish(error instanceof Error ? error.message : '请检查任务内容');
          return;
        }
      }
      const packet: CreationPacket =
        existing?.packet ??
        Object.freeze({
          actorId: data.user.id,
          spaceId: data.space?.id ?? 'space-demo',
          path: `/spaces/${encodeURIComponent(data.space?.id ?? 'space-demo')}/tasks`,
          body: Object.freeze({ ...body }),
          key: crypto.randomUUID(),
          projectName:
            data.projects.find((project) => project.id === body.projectId?.trim())?.name ??
            '我的个人工作',
        });
      const operationId = crypto.randomUUID();
      const ownerGeneration = generation.current;
      const activeSpace = getActiveSpace();
      const ownsRequestIdentity = () => {
        const current = latest.current.currentData();
        return (
          ownerGeneration === generation.current &&
          !!current &&
          ownsIdentity(current, packet) &&
          getActiveSpace() === activeSpace
        );
      };
      const ownsPacket = () =>
        ownerGeneration === generation.current &&
        pending.current?.packet === packet &&
        pending.current.operationId === operationId;
      const isCurrent = () =>
        ownsPacket() && session.current?.id === id && !session.current.blocked;
      const put = (next: PendingCreation) => {
        pending.current = next;
        publish();
      };
      // Store before awaiting: another submit/entry sees the same synchronous guard.
      put({ packet, receipt: existing?.receipt, operationId, error: '' });
      try {
        if (!existing?.receipt) {
          try {
            const value = await request<unknown>(packet.path, {
              method: 'POST',
              body: packet.body,
              key: packet.key,
              // Authentication loss remains global for this identity even after
              // dismissal or a project downgrade discards its business packet.
              shouldNotifyAccessLoss: ownsRequestIdentity,
            });
            if (!ownsPacket()) return;
            const receipt = creationReceipt(value, packet);
            // An ACK can update a still-owned packet after dismissal. It does not
            // authorize an older presentation to refresh, close or navigate a newer one.
            put({ packet, receipt, operationId, error: '' });
          } catch (error) {
            if (!ownsPacket()) return;
            if (accessDenial(error)) {
              pending.current = null;
              if (session.current?.id === id) {
                close(id);
                latest.current.notice(unavailable, true);
              } else if (session.current) session.current = { ...session.current, blocked: true };
              publish(unavailable);
              return;
            }
            const message = error instanceof Error ? error.message : '暂时无法确认原创建结果';
            if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
              pending.current = null;
              publish(message, session.current ? packet.body : undefined);
              return;
            }
            put({ packet, operationId, error: message });
            return;
          }
        }
        if (!isCurrent()) return;
        try {
          await latest.current.readWorkbench(isCurrent, ownsRequestIdentity);
          if (!isCurrent()) return;
          const receipt = pending.current!.receipt!;
          pending.current = null;
          close(id);
          latest.current.onCreated(receipt.id);
        } catch (error) {
          if (!isCurrent()) return;
          put({
            ...pending.current!,
            error: error instanceof Error ? error.message : '暂时无法刷新已创建任务',
          });
        }
      } finally {
        if (ownsPacket()) put({ ...pending.current!, operationId: undefined });
      }
    },
    [clear, close, publish],
  );
  return { view, open, close, detach, submit, clear, reconcile };
}
export type TaskCreation = ReturnType<typeof useTaskCreation>;
