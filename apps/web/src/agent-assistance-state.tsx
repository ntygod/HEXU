import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import type { AssistanceDetail } from '../../../packages/contracts/src/assistance.js';
import { useApp, canEditTask } from './state.js';
import { Button } from '../../../packages/ui/src/index.js';

type Packet = { path: string; body: unknown; key: string; method: 'POST' };
type State = {
  pending: Packet | null;
  busy: boolean;
  error: string;
  denied: boolean;
  conflict: boolean;
  receiptId?: string;
};
const empty: State = { pending: null, busy: false, error: '', denied: false, conflict: false };
function createStore() {
  const entries = new Map<string, State>();
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    active: true,
    entries: () => [...entries.entries()],
    revision: () => revision,
    get: (key: string) => entries.get(key) ?? empty,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set: (key: string, next: State) => {
      entries.set(key, next);
      revision++;
      listeners.forEach((fn) => fn());
    },
    clear: () => {
      entries.clear();
      revision++;
      listeners.forEach((fn) => fn());
    },
  };
}
const Context = createContext<ReturnType<typeof createStore> | null>(null);
/** Separate business packets, in memory only; never stores credential responses. */
export function AgentAssistanceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStore);
  const { data, version } = useApp();
  const revision = useSyncExternalStore(store.subscribe, store.revision, store.revision);
  useEffect(() => {
    store.active = true;
    return () => {
      store.active = false;
      store.clear();
    };
  }, [store]);
  // Continue read-only access validation for collapsed uncertain packets.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function verify() {
      for (const [scope, state] of store.entries()) {
        const packet = state.pending;
        if (!packet || state.busy) continue;
        const assistance = /^\/assistances\/([^/]+)/.exec(packet.path);
        const create = /^create:([^:]+):(.+)$/.exec(scope);
        const path = assistance
          ? `/assistances/${assistance[1]}`
          : create
            ? `/tasks/${create[1]}/messages/${create[2]}/assistance-preview`
            : null;
        if (!path) continue;
        const revoke = () => {
          if (!controller.signal.aborted && store.active && store.get(scope).pending === packet)
            store.set(scope, { ...empty, denied: true });
        };
        const task = create ? data.tasks.find((task) => task.id === create[1]) : undefined;
        if (task && !canEditTask(data, task)) {
          revoke();
          continue;
        }
        try {
          const current = await request<AssistanceDetail>(path, { signal: controller.signal });
          if (assistance && current.assistance.accessEnded) revoke();
        } catch (cause) {
          if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) revoke();
          // Transient reads never discard a fixed package.
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void verify(), 5000);
    }
    void verify();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [store, revision, version, data]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useAgentAssistanceCommand<T>(scope: string, onSaved: (value: T) => void) {
  const context = useContext(Context);
  const [local] = useState(createStore);
  const store = context ?? local;
  const current = useRef(onSaved);
  current.current = onSaved;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (!context) {
        store.active = false;
        store.clear();
      }
    };
  }, [store, context]);
  const value = useSyncExternalStore(
    store.subscribe,
    () => store.get(scope),
    () => store.get(scope),
  );
  async function execute(packet: Packet) {
    if (!store.active || store.get(scope).busy || store.get(scope).denied) return;
    store.set(scope, { ...empty, pending: packet, busy: true });
    try {
      const result = await request<T>(packet.path, packet);
      if (!store.active || store.get(scope).pending !== packet) return;
      // An ACK ends the write. Any later refresh is GET-only, outside this catch.
      const receiptId =
        result && typeof result === 'object' && 'assistance' in result
          ? (result as { assistance?: { id?: string } }).assistance?.id
          : undefined;
      store.set(scope, receiptId ? { ...empty, receiptId } : empty);
      if (alive.current) current.current(result);
    } catch (cause) {
      if (!store.active || store.get(scope).pending !== packet) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      store.set(scope, {
        pending: known ? null : packet,
        busy: false,
        denied: cause instanceof ApiError && [401, 403, 404].includes(cause.status),
        conflict: cause instanceof ApiError && cause.status === 409,
        error: cause instanceof Error ? cause.message : '保存结果未知',
      });
    }
  }
  return {
    ...value,
    send: (path: string, body: unknown) =>
      store.get(scope).pending
        ? Promise.resolve()
        : execute({ path, body: structuredClone(body), key: crypto.randomUUID(), method: 'POST' }),
    confirm: () => {
      const packet = store.get(scope).pending;
      return packet ? execute(packet) : Promise.resolve();
    },
    forgetReceipt: () => {
      if (!store.get(scope).pending && !store.get(scope).busy) store.set(scope, empty);
    },
    revoke: () => store.set(scope, { ...empty, denied: true }),
  };
}
export function AgentAssistanceFeedback({
  command,
}: {
  command: ReturnType<typeof useAgentAssistanceCommand>;
}) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.pending && !command.busy && (
        <section className="assistance-warning" aria-label="Agent 协助保存结果未知">
          <p>结果未知。原内容、版本和操作标识已固定；关闭不会撤回已提交工作。</p>
          <Button type="button" onClick={() => void command.confirm()}>
            确认原 Agent 协助操作
          </Button>
        </section>
      )}
    </>
  );
}
