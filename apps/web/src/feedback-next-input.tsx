import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../../packages/contracts/src/index.js';
import type {
  ResultFeedbackInputOrigin,
  ResultFeedbackInputPreview,
} from '../../../packages/contracts/src/result-feedback-inputs.js';
import { nextInputLabels, type NextInput } from '../../../packages/contracts/src/next-input.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, useApp, useTaskDraft } from './state.js';
import './feedback-next-input.css';

export const feedbackInputSourceHref = (origin: ResultFeedbackInputOrigin) =>
  `/results/${origin.resultId}/versions/${origin.resultRevisionId}/messages/${origin.messageId}`;
export function FeedbackInputOrigin({ origin }: { origin: ResultFeedbackInputOrigin }) {
  return (
    <details className="feedback-input-origin">
      <summary>
        原反馈来源 · {origin.branchName} · v{origin.resultRevision}
      </summary>
      <p>原反馈作者：{origin.authorName}。下面是原文，另行编辑的下一轮要求不会改写它。</p>
      <pre>{origin.body}</pre>
      {origin.codeAnchor && (
        <p>
          原位置：{origin.codeAnchor.path} ·{' '}
          {origin.codeAnchor.side === 'before' ? '起点文件' : '所选文件'} ·{' '}
          {origin.codeAnchor.range
            ? `第${origin.codeAnchor.range.start}–${origin.codeAnchor.range.end}行`
            : '整个文件'}
        </p>
      )}
      <Link to={feedbackInputSourceHref(origin)}>查看原版本反馈</Link>
    </details>
  );
}
interface Draft {
  body: string;
  attempt?: { body: string; key: string };
}
const decode = (stored: string): Draft | null => {
  try {
    return stored ? (JSON.parse(stored) as Draft) : null;
  } catch {
    return null;
  }
};
export function FeedbackNextInputAction({ message }: { message: Message }) {
  const { data, version, readDraft, saveDraft, notice, refresh } = useApp();
  const purpose = `feedback-input:${message.resultId}:${message.resultRevisionId}:${message.id}`;
  const [stored, setStored] = useTaskDraft(message.taskId, purpose);
  const draft = decode(stored);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null),
    [saved, setSaved] = useState<NextInput | null>(null);
  const alive = useRef(true),
    inFlight = useRef(false),
    currentVersion = useRef(version);
  currentVersion.current = version;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const task = data.tasks.find((task) => task.id === message.taskId);
  const editable = !!task && canEditTask(data, task) && deniedAt !== version;
  const path = `/results/${message.resultId}/versions/${message.resultRevisionId}/feedback/${message.id}`;
  const [preview, setPreview] = useState<ResultFeedbackInputPreview | null>(null),
    [previewError, setPreviewError] = useState(''),
    [reload, setReload] = useState(0);
  const put = (value: Draft | null) => setStored(value ? JSON.stringify(value) : '');
  useEffect(() => {
    if (!editable) {
      setOpen(false);
      setSaved(null);
    }
  }, [editable]);
  useEffect(() => {
    if (!open || !editable) return;
    const abort = new AbortController();
    setPreview(null);
    setPreviewError('');
    request<ResultFeedbackInputPreview>(path + '/next-input-preview', { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setPreview(value);
      })
      .catch((cause) => {
        if (abort.signal.aborted) return;
        const messageText = cause instanceof Error ? cause.message : '无法核对原反馈来源';
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          saveDraft(message.taskId, purpose, '');
          setStored('');
          setOpen(false);
          setDeniedAt(currentVersion.current);
          setError(messageText);
        } else setPreviewError(messageText);
      });
    return () => abort.abort();
  }, [open, editable, path, reload, message.taskId, purpose, saveDraft]);
  const origin = preview?.available ? preview.origin : null;
  useEffect(() => {
    if (open && origin && !stored && editable)
      setStored(
        JSON.stringify({ body: origin.body.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, '') }),
      );
  }, [open, origin, stored, editable]);
  async function send(confirm = false) {
    if (
      !draft ||
      !editable ||
      inFlight.current ||
      (!confirm && (draft.attempt || !origin || previewError))
    )
      return;
    const attempt = confirm
      ? draft.attempt
      : draft.body.trim()
        ? { body: draft.body.trim(), key: crypto.randomUUID() }
        : null;
    if (!attempt) return;
    const original = { ...draft, attempt };
    put(original);
    inFlight.current = true;
    setBusy(true);
    setError('');
    const matches = () =>
      decode(readDraft(message.taskId, purpose) ?? '')?.attempt?.key === attempt.key;
    try {
      const value = await request<NextInput>(path + '/next-inputs', {
        method: 'POST',
        body: { body: attempt.body },
        key: attempt.key,
      });
      if (!matches()) return;
      saveDraft(message.taskId, purpose, '');
      if (!alive.current) return;
      put(null);
      setOpen(false);
      setSaved(value);
      notice('下一轮要求已保存，仍需在原方案继续时明确选择和启动');
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      if (known)
        saveDraft(message.taskId, purpose, denied ? '' : JSON.stringify({ body: original.body }));
      if (!alive.current) return;
      if (denied) {
        put(null);
        setOpen(false);
        setDeniedAt(currentVersion.current);
      } else if (known) put({ body: original.body });
      setError(cause instanceof Error ? cause.message : '下一轮要求保存失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="feedback-next-input-action">
      {editable && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {draft?.attempt
            ? '确认原反馈要求是否保存'
            : draft
              ? '继续整理这条反馈'
              : '整理为下一轮要求'}
        </Button>
      )}
      {saved && (
        <p className="feedback-input-saved">
          {nextInputLabels[saved.state]} ·{' '}
          <Link to={`/tasks/${message.taskId}`}>在原任务查看要求与记录</Link>
        </p>
      )}
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && editable && (
        <Dialog title="把反馈整理为下一轮要求" onClose={() => setOpen(false)}>
          <form
            className="feedback-input-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {!preview && !previewError && <p role="status">正在核对原版本和方案来源…</p>}
            {previewError && (
              <p className="form-error" role="alert">
                {previewError}
                <Button type="button" onClick={() => setReload((value) => value + 1)}>
                  重读原反馈来源
                </Button>
              </p>
            )}
            {preview && !preview.available && <p role="status">{preview.reason}</p>}
            {origin && (
              <>
                <section className="feedback-input-source" aria-label="原反馈与固定来源">
                  <strong>
                    {origin.branchName} · 原成果v{origin.resultRevision} · {origin.authorName}
                  </strong>
                  <details>
                    <summary>查看原反馈完整正文</summary>
                    <pre>{origin.body}</pre>
                  </details>
                  {origin.codeAnchor && (
                    <p>
                      原位置：{origin.codeAnchor.path} ·{' '}
                      {origin.codeAnchor.side === 'before' ? '起点文件' : '所选文件'} ·{' '}
                      {origin.codeAnchor.range
                        ? `第${origin.codeAnchor.range.start}–${origin.codeAnchor.range.end}行`
                        : '整个文件'}
                    </p>
                  )}
                </section>
                <p>
                  下方是你确认保存的下一轮要求，与原反馈分开记录。保存不会启动；原方案继续时还需明确勾选并确认执行。只能用于这个方案的同一固定版本。
                </p>
                {origin.body.length > 2000 && (
                  <p className="work-branch-notice">
                    原反馈较长，仅预填前2000字符以内的片段，请整理后确认；上方保留原文。
                  </p>
                )}
              </>
            )}
            {draft && origin && (
              <label className="field">
                我希望下一轮做什么
                <textarea
                  aria-label="从反馈整理的下一轮要求"
                  rows={6}
                  maxLength={2000}
                  value={draft.body}
                  disabled={busy || !!draft.attempt}
                  onChange={(event) => put({ body: event.target.value })}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {draft?.attempt && (
              <section className="feedback-input-source" aria-label="反馈要求原请求待确认">
                <p>
                  保存结果未确认。只确认原反馈、原正文和操作标识，关闭不撤回请求。临时待确认包不跨硬刷新，请先确认；已保存记录保留在原任务。
                </p>
                <Button type="button" busy={busy} onClick={() => void send(true)}>
                  确认这条要求是否已保存
                </Button>
              </section>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={() => setOpen(false)}>
                返回原反馈
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
                    清除未保存要求
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={busy}
                    disabled={!draft.body.trim() || !origin || !!previewError}
                  >
                    保存为待选择要求
                  </Button>
                </>
              )}
            </footer>
            <p className="hint">
              草稿仅在当前账号/空间页面会话内存中保留，硬刷新不恢复。原文只是反馈来源，不会自动当作执行指令。
            </p>
          </form>
        </Dialog>
      )}
    </div>
  );
}
