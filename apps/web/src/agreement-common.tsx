import { useEffect, useRef, useState } from 'react';
import type {
  AgreementContent,
  ProjectAgreement,
} from '../../../packages/contracts/src/project-agreements.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
export const agreementPath = (projectId: string, id?: string) =>
  `/projects/${encodeURIComponent(projectId)}/agreements${id ? '/' + encodeURIComponent(id) : ''}`;
export const agreementStateText = { active: '有效', inactive: '已停用', superseded: '已替代' };
export function useAgreementRead<T>(path: string | null) {
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
    if (path !== previous.current || !path) {
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
          const denied =
            cause instanceof ApiError && [400, 401, 403, 404, 422].includes(cause.status);
          if (denied) setValue(null);
          setDenied(denied);
          setError(cause instanceof Error ? cause.message : '约定读取失败');
        });
    return () => abort.abort();
  }, [path, version, reload]);
  return {
    value: previous.current === path ? value : null,
    error,
    denied,
    retry: () => setReload((value) => value + 1),
  };
}
export type AgreementAttempt = {
  path: string;
  method: 'POST' | 'PATCH';
  body: unknown;
  key: string;
};
export function useAgreementCommand(onSaved: (value: ProjectAgreement) => void) {
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState<AgreementAttempt | null>(null),
    [denied, setDenied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(attempt: AgreementAttempt) {
    if (busy || denied) return;
    setBusy(true);
    setError('');
    try {
      const value = await request<ProjectAgreement>(attempt.path, attempt);
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(refreshed ? '项目约定已保存' : '约定已保存，页面刷新失败，请重新加载', !refreshed);
      onSaved(value);
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setDenied(cause instanceof ApiError && [401, 403, 404].includes(cause.status));
      setError(cause instanceof Error ? cause.message : '约定操作失败');
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, uncertain, denied, save };
}
export function AgreementFeedback({
  command,
}: {
  command: ReturnType<typeof useAgreementCommand>;
}) {
  return (
    <>
      {command.error && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="agreement-conflict" aria-label="约定操作待确认">
          <strong>尚未确认约定操作结果</strong>
          <p>请求可能已经保存。确认复用原请求；关闭不会撤销已发送的操作。</p>
          <Button
            type="button"
            busy={command.busy}
            onClick={() => void command.save(command.uncertain!)}
          >
            确认上次约定操作
          </Button>
        </section>
      )}
    </>
  );
}
export function AgreementFields({
  value,
  onChange,
  disabled,
}: {
  value: AgreementContent;
  onChange(value: AgreementContent): void;
  disabled: boolean;
}) {
  return (
    <>
      <label className="field">
        约定标题
        <input
          aria-label="约定标题"
          required
          maxLength={120}
          value={value.title}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
        />
      </label>
      <label className="field">
        约定正文
        <textarea
          aria-label="约定正文"
          required
          rows={9}
          maxLength={8000}
          value={value.content}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, content: event.target.value })}
        />
      </label>
    </>
  );
}
