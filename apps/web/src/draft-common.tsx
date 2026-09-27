import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';

export const draftPath = (taskId: string, id?: string) =>
  `/tasks/${encodeURIComponent(taskId)}/ai-drafts${id ? '/' + encodeURIComponent(id) : ''}`;
export function useDraftRead<T>(path: string | null) {
  const { version } = useApp();
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false),
    [reload, setReload] = useState(0);
  const previous = useRef(path);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setDenied(false);
    if (previous.current !== path || !path) {
      previous.current = path;
      setValue(null);
    }
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
          setError(cause instanceof Error ? cause.message : '草稿读取失败');
        });
    return () => abort.abort();
  }, [path, version, reload]);
  return {
    value: previous.current === path ? value : null,
    error,
    denied,
    retry: () => setReload((v) => v + 1),
  };
}
interface DraftAttempt {
  path: string;
  method: 'POST' | 'PATCH';
  body: unknown;
  key: string;
  message: string;
}
export function useDraftCommand<T>(onSaved: (value: T) => void, onBusy: (busy: boolean) => void) {
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<DraftAttempt | null>(null),
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
  async function save(attempt: DraftAttempt) {
    if (busy || denied) return;
    setBusy(true);
    setError('');
    try {
      const value = await request<T>(attempt.path, attempt);
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(refreshed ? attempt.message : '内容已保存，页面刷新失败，请重新加载核对', !refreshed);
      onSaved(value);
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setDenied(cause instanceof ApiError && [401, 403, 404].includes(cause.status));
      setError(cause instanceof Error ? cause.message : '草稿操作失败');
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
    send: (path: string, method: DraftAttempt['method'], body: unknown, message: string) =>
      save({ path, method, body: structuredClone(body), message, key: crypto.randomUUID() }),
    confirm: () => (uncertain ? save(uncertain) : Promise.resolve()),
  };
}
export function DraftFeedback({ command }: { command: ReturnType<typeof useDraftCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="draft-conflict" aria-label="草稿操作待确认">
          <strong>尚未确认保存结果</strong>
          <p>请求可能已经保存。确认会使用原内容与原请求标识，关闭不会撤回操作。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次草稿操作
          </Button>
        </section>
      )}
    </>
  );
}
