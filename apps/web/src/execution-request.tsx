import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
interface Attempt {
  path: string;
  body: Record<string, unknown>;
  key: string;
  message: string;
}
/** A lost execution response is a receipt question, never a new paid launch request. */
export function useExecutionRequest(onConfirmed: () => void, onDenied: () => void) {
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<Attempt | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(attempt: Attempt) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(attempt.path, { method: 'POST', body: attempt.body, key: attempt.key });
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(
        refreshed ? attempt.message : '请求已保存，页面刷新失败，请重新加载后核对运行记录',
        !refreshed,
      );
      onConfirmed();
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setError(cause instanceof Error ? cause.message : '执行请求失败');
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      await refresh().catch(() => {});
      if (alive.current && denied) {
        notice('访问权限已变化，执行编辑已关闭，请重新核对任务', true);
        onDenied();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return {
    busy,
    error,
    uncertain,
    locked: busy || !!uncertain,
    send: (path: string, body: Record<string, unknown>, message: string) =>
      save({ path, body: structuredClone(body), key: crypto.randomUUID(), message }),
    confirm: () => (uncertain ? save(uncertain) : Promise.resolve()),
  };
}
export function ExecutionReceipt({
  delivery,
}: {
  delivery: ReturnType<typeof useExecutionRequest>;
}) {
  return (
    <>
      {delivery.error && (
        <p className="form-error" role="alert">
          {delivery.error}
        </p>
      )}
      {delivery.uncertain && (
        <section className="project-material-warning" aria-label="执行请求待确认">
          <strong>执行请求的回执尚未确认</strong>
          <p>
            原请求可能已经提交。确认会重用同一份要求、选材和操作标识；关闭不会取消已提交的工作。
          </p>
          <Button type="button" busy={delivery.busy} onClick={() => void delivery.confirm()}>
            确认上次执行请求
          </Button>
        </section>
      )}
    </>
  );
}
