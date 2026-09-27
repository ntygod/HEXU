import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
export const assistancePath = (id: string) => `/assistances/${encodeURIComponent(id)}`;

export function useAssistanceRead<T>(path: string | null, interval = 2000) {
  const { version } = useApp();
  const [result, setResult] = useState<{
    path: string | null;
    value: T | null;
    error: string;
    denied: boolean;
  }>({ path, value: null, error: '', denied: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (!path) return;
      try {
        const value = await request<T>(path, { signal: abort.signal });
        if (!abort.signal.aborted) setResult({ path, value, error: '', denied: false });
      } catch (cause) {
        if (abort.signal.aborted) return;
        const denied = cause instanceof ApiError && [401, 403, 404, 422].includes(cause.status);
        setResult((old) => ({
          path,
          value: denied || old.path !== path ? null : old.value,
          denied,
          error: cause instanceof Error ? cause.message : '协助读取失败',
        }));
        if (denied) return; // Do not bring a revoked editor back after reauthorization.
      }
      if (!abort.signal.aborted && interval) timer = setTimeout(() => void read(), interval);
    }
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, version, reload, interval]);
  return {
    value: result.path === path ? result.value : null,
    error: result.path === path ? result.error : '',
    denied: result.path === path && result.denied,
    retry: () => setReload((v) => v + 1),
  };
}
interface Attempt {
  path: string;
  method: 'POST';
  body: unknown;
  key: string;
}
export function useAssistanceCommand<T>(saved: (value: T) => void) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<Attempt | null>(null),
    [denied, setDenied] = useState(false);
  const alive = useRef(true),
    inFlight = useRef(false),
    callback = useRef(saved);
  callback.current = saved;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(attempt: Attempt) {
    if (inFlight.current || denied) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<T>(attempt.path, attempt);
      if (!alive.current) return;
      setUncertain(null);
      callback.current(result);
      await refresh().catch(() => {});
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setDenied(cause instanceof ApiError && [401, 403, 404].includes(cause.status));
      setError(cause instanceof Error ? cause.message : '协助操作失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return {
    busy,
    error,
    uncertain,
    denied,
    send: (path: string, body: unknown) =>
      uncertain
        ? Promise.resolve()
        : save({ path, method: 'POST', body: structuredClone(body), key: crypto.randomUUID() }),
    confirm: () => (uncertain ? save(uncertain) : Promise.resolve()),
  };
}
export function AssistanceFeedback({
  command,
}: {
  command: ReturnType<typeof useAssistanceCommand>;
}) {
  return (
    <>
      {command.error && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="assistance-warning" aria-label="协助操作待确认">
          <strong>尚未确认保存结果</strong>
          <p>请求可能已保存。确认将使用原接收者、原内容与原操作标识；关闭不会撤回请求。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次协助操作
          </Button>
        </section>
      )}
    </>
  );
}
