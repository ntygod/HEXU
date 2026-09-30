import { useEffect, useRef, useState } from 'react';
import type { ResultDetail, ResultRevision } from '../../../packages/contracts/src/results.js';
import type {
  MemberResultVersionInput,
  MemberResultVersionPreview,
  MemberResultVersionReceipt,
} from '../../../packages/contracts/src/member-result-versions.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, useApp, useTaskDraft } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import './member-result-versions.css';
interface Draft extends MemberResultVersionInput {
  baseTitle: string;
  baseBody: string;
  attempt?: { body: MemberResultVersionInput; key: string };
}
const decode = (value: string): Draft | null => {
  try {
    return value ? (JSON.parse(value) as Draft) : null;
  } catch {
    return null;
  }
};
const initial = (version: ResultRevision): Draft => ({
  expectedRevision: version.revision,
  expectedRevisionId: version.id,
  title: version.title,
  body: version.body,
  baseTitle: version.title,
  baseBody: version.body,
});
export function MemberResultVersions({ detail }: { detail: ResultDetail }) {
  const { data, version: appVersion, readDraft, saveDraft, refresh, notice } = useApp();
  const { result, task, version } = detail;
  const purpose = `member-result-version:${result.id}`;
  const [stored, setStored] = useTaskDraft(task.id, purpose);
  const draft = decode(stored);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null),
    [saved, setSaved] = useState<MemberResultVersionReceipt | null>(null);
  const alive = useRef(true),
    inFlight = useRef(false),
    currentAppVersion = useRef(appVersion);
  currentAppVersion.current = appVersion;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const editable = canEditTask(data, task) && deniedAt !== appVersion;
  const preview = useAssistanceRead<MemberResultVersionPreview>(
    open && editable ? `/results/${result.id}/member-version-preview` : null,
  );
  const latest = preview.value?.available ? preview.value.version : null;
  const changed =
    !!draft &&
    !!latest &&
    (draft.expectedRevision !== latest.revision || draft.expectedRevisionId !== latest.id);
  const put = (next: Draft | null) => setStored(next ? JSON.stringify(next) : '');
  useEffect(() => {
    if (!editable) {
      setOpen(false);
      setSaved(null);
    }
  }, [editable]);
  useEffect(() => {
    if (preview.denied) {
      saveDraft(task.id, purpose, '');
      setStored('');
      setOpen(false);
      setDeniedAt(currentAppVersion.current);
      setError(preview.error);
    }
  }, [preview.denied, preview.error, task.id, purpose, saveDraft]);
  useEffect(() => {
    if (open && editable && latest && !stored) setStored(JSON.stringify(initial(latest)));
  }, [open, editable, latest, stored]);
  async function send(confirm = false) {
    if (
      !draft ||
      !editable ||
      inFlight.current ||
      (!confirm && (draft.attempt || !latest || changed || preview.error))
    )
      return;
    const attempt = confirm
      ? draft.attempt
      : draft.title.trim() && draft.body.trim()
        ? {
            key: crypto.randomUUID(),
            body: {
              title: draft.title.trim(),
              body: draft.body.trim(),
              expectedRevision: draft.expectedRevision,
              expectedRevisionId: draft.expectedRevisionId,
            },
          }
        : null;
    if (!attempt) return;
    const original = { ...draft, attempt };
    put(original);
    inFlight.current = true;
    setBusy(true);
    setError('');
    const matches = () => decode(readDraft(task.id, purpose) ?? '')?.attempt?.key === attempt.key;
    try {
      const receipt = await request<MemberResultVersionReceipt>(`/results/${result.id}/versions`, {
        method: 'POST',
        body: attempt.body,
        key: attempt.key,
      });
      if (!matches()) return;
      saveDraft(task.id, purpose, '');
      if (!alive.current) return;
      put(null);
      setOpen(false);
      setSaved(receipt);
      notice(`文字成果已另存为v${receipt.revision}；旧版正文和反馈保持原位置`);
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      const { attempt: _attempt, ...unsent } = original;
      if (known) saveDraft(task.id, purpose, denied ? '' : JSON.stringify(unsent));
      if (!alive.current) return;
      if (denied) {
        put(null);
        setOpen(false);
        setDeniedAt(currentAppVersion.current);
      } else if (known) put(unsent);
      setError(cause instanceof Error ? cause.message : '文字成果保存失败');
      preview.retry();
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (version.kind !== 'text' || version.source.kind === 'work_branch') return null;
  const newest = detail.revisions.find((r) => r.revision === result.revision);
  return (
    <div className="member-version-actions">
      {version.revision === result.revision || draft ? (
        <Button
          disabled={!editable}
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {draft?.attempt ? '确认原文字修订请求' : draft ? '继续编辑文字修订' : '编辑并保存新版本'}
        </Button>
      ) : (
        newest &&
        saved?.revision !== result.revision && (
          <Link className="button secondary" to={`/results/${result.id}/versions/${newest.id}`}>
            查看最新版后修订
          </Link>
        )
      )}
      {saved && (
        <Link to={`/results/${result.id}/versions/${saved.revisionId}`}>
          查看已保存的v{saved.revision}
        </Link>
      )}
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && editable && (
        <Dialog title="保存文字成果新版本" onClose={() => setOpen(false)}>
          <form
            className="member-version-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <p className="hint">
              仍保存在同一份成果中。只发布你确认的标题和说明，旧版正文、反馈和后续任务来源不会改写；任务状态和执行保持原状。
            </p>
            {preview.error && (
              <p className="form-error" role="alert">
                {preview.error}
                <Button type="button" onClick={preview.retry}>
                  重读最新版本
                </Button>
              </p>
            )}
            {!preview.value && !preview.error && <p role="status">正在核对文字成果与最新版本…</p>}
            {preview.value && !preview.value.available && (
              <p role="status">{preview.value.reason}</p>
            )}
            {draft && (
              <>
                <section className="member-version-baseline" aria-label="文字修订固定基线">
                  <strong>
                    本次编辑基于v{draft.expectedRevision} · {draft.baseTitle}
                  </strong>
                  <details>
                    <summary>查看本次原说明</summary>
                    <pre>{draft.baseBody}</pre>
                  </details>
                </section>
                {changed && latest && (
                  <section
                    className="member-version-conflict"
                    role="status"
                    aria-label="文字成果已有新版本"
                  >
                    <strong>
                      另一份v{latest.revision}已保存；你的草稿仍基于v{draft.expectedRevision}。
                    </strong>
                    <p>先核对新内容。这里不会自动替换草稿或调整提交基线。</p>
                    <details>
                      <summary>查看最新标题和说明</summary>
                      <strong>{latest.title}</strong>
                      <pre>{latest.body}</pre>
                    </details>
                    {!draft.attempt && (
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          put(initial(latest));
                          setError('');
                        }}
                      >
                        放弃草稿并载入最新版
                      </Button>
                    )}
                  </section>
                )}
                <label className="field">
                  新版本标题
                  <input
                    aria-label="新版本标题"
                    autoFocus
                    required
                    maxLength={160}
                    value={draft.title}
                    disabled={busy || !!draft.attempt}
                    onChange={(event) => put({ ...draft, title: event.target.value })}
                  />
                </label>
                <label className="field">
                  新版本说明
                  <textarea
                    aria-label="新版本说明"
                    required
                    rows={8}
                    maxLength={12000}
                    value={draft.body}
                    disabled={busy || !!draft.attempt}
                    onChange={(event) => put({ ...draft, body: event.target.value })}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                </label>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {draft?.attempt && (
              <section className="member-version-baseline" aria-label="原文字修订请求待确认">
                <p>
                  新版本可能已经保存。只确认原基线、标题、说明和操作标识；关闭不会撤回。待确认包仅在本次页面会话保留，刷新前请先确认。
                </p>
                <Button type="button" busy={busy} onClick={() => void send(true)}>
                  确认原请求是否已保存
                </Button>
              </section>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={() => setOpen(false)}>
                关闭并保留草稿
              </Button>
              {draft && !draft.attempt && (
                <>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      put(null);
                      setOpen(false);
                    }}
                  >
                    放弃未提交修订
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={busy}
                    disabled={
                      !draft.title.trim() ||
                      !draft.body.trim() ||
                      !latest ||
                      changed ||
                      !!preview.error
                    }
                  >
                    保存为新版本
                  </Button>
                </>
              )}
            </footer>
            <p className="hint">
              草稿仅存在当前账号/空间的页面会话内，硬刷新不恢复。打开或关闭编辑器不会发布版本。
            </p>
          </form>
        </Dialog>
      )}
    </div>
  );
}
