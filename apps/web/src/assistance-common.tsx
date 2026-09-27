import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';

// Bounded access can expire without an SSE write; re-read open shared content periodically.
export function useAssistanceRead<T>(path: string | null) {
  const { version } = useApp();
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false),
    [reload, setReload] = useState(0);
  const scope = useRef(path);
  useEffect(() => {
    const abort = new AbortController();
    if (scope.current !== path || !path) {
      scope.current = path;
      setValue(null);
    }
    setError('');
    setDenied(false);
    if (path)
      void request<T>(path, { signal: abort.signal })
        .then((next) => {
          if (!abort.signal.aborted) setValue(next);
        })
        .catch((cause) => {
          if (abort.signal.aborted) return;
          const forbidden =
            cause instanceof ApiError && [400, 401, 403, 404, 422].includes(cause.status);
          if (forbidden) setValue(null);
          setDenied(forbidden);
          setError(cause instanceof Error ? cause.message : '协助内容读取失败');
        });
    return () => abort.abort();
  }, [path, version, reload]);
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(() => setReload((v) => v + 1), 15000);
    return () => clearInterval(timer);
  }, [path]);
  return {
    value: scope.current === path ? value : null,
    error,
    denied,
    retry: () => setReload((v) => v + 1),
  };
}
interface Attempt {
  path: string;
  body: unknown;
  key: string;
  message: string;
}
export function useAssistanceCommand<T>(
  onSaved: (value: T) => void,
  onBusy: (value: boolean) => void,
) {
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<Attempt | null>(null),
    [denied, setDenied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  async function save(attempt: Attempt) {
    if (busy || denied) return;
    setBusy(true);
    setError('');
    try {
      const next = await request<T>(attempt.path, {
        method: 'POST',
        body: attempt.body,
        key: attempt.key,
      });
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(
        refreshed ? attempt.message : '协助操作已保存，页面刷新失败，请重新加载核对',
        !refreshed,
      );
      onSaved(next);
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setDenied(cause instanceof ApiError && [401, 403, 404].includes(cause.status));
      setError(cause instanceof Error ? cause.message : '协助操作失败');
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return {
    busy,
    error,
    uncertain,
    denied,
    send: (path: string, body: unknown, message: string) =>
      save({ path, body: structuredClone(body), key: crypto.randomUUID(), message }),
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
        <section className="assistance-notice" aria-label="协助操作待确认">
          <strong>尚未确认操作结果</strong>
          <p>确认会重用相同内容和原请求标识；关闭不会撤回已发送的操作。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次协助操作
          </Button>
        </section>
      )}
    </>
  );
}
