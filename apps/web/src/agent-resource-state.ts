import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ApiError } from '../../../packages/client/src/index.js';
import {
  saveAgentPacket,
  type AgentWritePacket,
  type AgentWriteResult,
} from '../../../packages/client/src/agent-capabilities.js';
export const accessDenied = (e: unknown) =>
  e instanceof ApiError && [401, 403, 404].includes(e.status);
export function useAgentRead<T>(load: (signal: AbortSignal) => Promise<T>, version: number) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false),
    [tick, setTick] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const controller = new AbortController();
    void latest
      .current(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setValue(next);
        setError('');
        setDenied(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '读取失败');
        if (accessDenied(e)) {
          setValue(null);
          setDenied(true);
        }
      });
    return () => controller.abort();
  }, [version, tick]);
  return { value, error, denied, refresh: () => setTick((n) => n + 1) };
}
interface WriteSnapshot {
  pending: AgentWritePacket | null;
  busy: boolean;
  error: string;
}
function createWriteStore() {
  let snapshot: WriteSnapshot = { pending: null, busy: false, error: '' };
  const listeners = new Set<() => void>();
  return {
    active: true,
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: WriteSnapshot) => {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}
const AgentWriteContext = createContext<ReturnType<typeof createWriteStore> | null>(null);
/** Scoped under the identity gate and above routes. Nothing is stored in browser storage. */
export function AgentRequestProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createWriteStore);
  useEffect(() => {
    store.active = true;
    return () => {
      store.active = false;
      store.update({ pending: null, busy: false, error: '' });
    };
  }, [store]);
  return createElement(AgentWriteContext.Provider, { value: store }, children);
}
/** One immutable packet survives route changes and unknown transport outcomes. */
export function useAgentWrite(
  onAccepted: (result: AgentWriteResult) => void,
  onDenied: () => void,
) {
  const context = useContext(AgentWriteContext);
  const [local] = useState(createWriteStore);
  const store = context ?? local;
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!context) store.active = true;
    return () => {
      alive.current = false;
      if (!context) store.active = false;
    };
  }, [store, context]);
  const clear = () => store.update({ pending: null, busy: false, error: '' });
  const submit = async (input: Omit<AgentWritePacket, 'key'>) => {
    if (store.get().busy || !store.active) return;
    const fixed = store.get().pending ?? {
      ...input,
      body: structuredClone(input.body),
      key: crypto.randomUUID(),
    };
    store.update({ pending: fixed, busy: true, error: '' });
    try {
      const result = await saveAgentPacket(fixed);
      if (!store.active || store.get().pending !== fixed) return;
      clear();
      if (alive.current) onAccepted(result);
    } catch (e) {
      if (!store.active || store.get().pending !== fixed) return;
      if (accessDenied(e)) {
        clear();
        if (alive.current) onDenied();
      } else if (e instanceof ApiError && e.status < 500) {
        store.update({ pending: null, busy: false, error: e.message });
      } else
        store.update({
          pending: fixed,
          busy: false,
          error: '写入结果未知。再次确认只会使用同一请求内容与标识。离开页面不会撤销已提交工作。',
        });
    }
  };
  return { ...state, submit, clear };
}
