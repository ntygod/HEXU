import { useEffect, useRef, useState } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type {
  ResultFeedbackFollowUpOrigin,
  ResultFeedbackFollowUpPreview,
  ResultFeedbackFollowUpList,
} from '../../../packages/contracts/src/result-feedback-followups.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog, StatusBadge } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, useApp, useTaskDraft } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import './feedback-followups.css';
const sourceHref = (origin: ResultFeedbackFollowUpOrigin) =>
  `/results/${origin.resultId}/versions/${origin.resultRevisionId}/messages/${origin.messageId}`;
export function FollowUpTaskOrigin({ origin }: { origin: ResultFeedbackFollowUpOrigin }) {
  return (
    <details className="followup-task-origin" aria-label="后续任务的固定来源">
      <summary>
        来自原反馈：{origin.sourceTaskShortId} · {origin.resultTitle} v{origin.resultRevision}
      </summary>
      <p>
        原任务（创建时名称）：{origin.sourceTaskTitle} · 反馈作者：{origin.authorName}
      </p>
      <pre>{origin.body}</pre>
      <div className="followup-origin-links">
        <Link to={sourceHref(origin)}>查看原版本中的反馈</Link>
        <Link to={`/tasks/${origin.sourceTaskId}`}>返回原任务</Link>
        {origin.codeAnchor && (
          <Link
            to={`/results/${origin.resultId}/versions/${origin.resultRevisionId}/feedback/${origin.messageId}`}
          >
            查看原代码反馈位置
          </Link>
        )}
      </div>
      <p className="hint">
        这是创建后续任务时保留的来源；下面的工作说明可独立编辑，原反馈和原任务不会因此改变。
      </p>
    </details>
  );
}
interface Draft {
  title: string;
  description: string;
  attempt?: { title: string; description: string; key: string };
}
const decode = (stored: string): Draft | null => {
  try {
    return stored ? (JSON.parse(stored) as Draft) : null;
  } catch {
    return null;
  }
};
export function FeedbackFollowups({ message }: { message: Message }) {
  const { data, version, readDraft, saveDraft, refresh, notice } = useApp();
  const purpose = `feedback-followup:${message.resultId}:${message.resultRevisionId}:${message.id}`;
  const [stored, setStored] = useTaskDraft(message.taskId, purpose);
  const draft = decode(stored);
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null),
    [saved, setSaved] = useState<Task | null>(null);
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
  const list = useAssistanceRead<ResultFeedbackFollowUpList>(
    open && !creating ? path + '/follow-ups' : null,
  );
  const [preview, setPreview] = useState<ResultFeedbackFollowUpPreview | null>(null),
    [previewError, setPreviewError] = useState(''),
    [reload, setReload] = useState(0);
  const put = (value: Draft | null) => setStored(value ? JSON.stringify(value) : '');
  useEffect(() => {
    if (!editable) {
      setCreating(false);
      setSaved(null);
    }
  }, [editable]);
  useEffect(() => {
    if (!open || !creating || !editable) return;
    const abort = new AbortController();
    setPreview(null);
    setPreviewError('');
    request<ResultFeedbackFollowUpPreview>(path + '/follow-up-preview', { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setPreview(value);
      })
      .catch((cause) => {
        if (abort.signal.aborted) return;
        const text = cause instanceof Error ? cause.message : '无法读取后续任务来源';
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          saveDraft(message.taskId, purpose, '');
          setStored('');
          setCreating(false);
          setDeniedAt(currentVersion.current);
          setError(text);
        } else setPreviewError(text);
      });
    return () => abort.abort();
  }, [open, creating, editable, path, reload, message.taskId, purpose, saveDraft]);
  const available = preview?.available ? preview : null;
  useEffect(() => {
    if (open && creating && available && !stored && editable)
      setStored(
        JSON.stringify({
          title: `跟进：${available.origin.resultTitle}`
            .slice(0, 160)
            .replace(/[\uD800-\uDBFF]$/, ''),
          description: available.origin.body,
        }),
      );
  }, [open, creating, available, stored, editable]);
  async function send(confirm = false) {
    if (
      !draft ||
      !editable ||
      inFlight.current ||
      (!confirm && (draft.attempt || !available || previewError))
    )
      return;
    const attempt = confirm
      ? draft.attempt
      : draft.title.trim()
        ? {
            title: draft.title.trim(),
            description: draft.description.trim(),
            key: crypto.randomUUID(),
          }
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
      const next = await request<Task>(path + '/follow-ups', {
        method: 'POST',
        body: { title: attempt.title, description: attempt.description },
        key: attempt.key,
      });
      if (!matches()) return;
      saveDraft(message.taskId, purpose, '');
      if (!alive.current) return;
      put(null);
      setCreating(false);
      setOpen(false);
      setSaved(next);
      notice('后续任务已创建；原任务不变，尚未开始执行');
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      if (known)
        saveDraft(
          message.taskId,
          purpose,
          denied
            ? ''
            : JSON.stringify({ title: original.title, description: original.description }),
        );
      if (!alive.current) return;
      if (denied) {
        put(null);
        setCreating(false);
        setDeniedAt(currentVersion.current);
      } else if (known) put({ title: original.title, description: original.description });
      setError(cause instanceof Error ? cause.message : '后续任务创建失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="feedback-followups-action">
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setError('');
          setCreating(!!draft?.attempt);
          setOpen(true);
        }}
      >
        {draft?.attempt ? '确认原后续任务请求' : '后续任务'}
      </Button>
      {saved && (
        <Link to={`/tasks/${saved.id}`}>
          打开后续任务：{saved.shortId} {saved.title}
        </Link>
      )}
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <Dialog
          title={creating ? '由反馈建立后续任务' : '这条反馈的后续任务'}
          onClose={() => setOpen(false)}
        >
          {creating && editable ? (
            <form
              className="feedback-followup-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {!preview && !previewError && <p role="status">正在核对原反馈与可见范围…</p>}
              {previewError && (
                <p className="form-error" role="alert">
                  {previewError}
                  <Button type="button" onClick={() => setReload((value) => value + 1)}>
                    重读创建范围
                  </Button>
                </p>
              )}
              {preview && !preview.available && <p role="status">{preview.reason}</p>}
              {available && (
                <>
                  <section className="feedback-followup-source" aria-label="后续任务原反馈">
                    <strong>
                      {available.origin.sourceTaskShortId} · {available.origin.resultTitle} v
                      {available.origin.resultRevision}
                    </strong>
                    <p>原反馈作者：{available.origin.authorName}</p>
                    <details>
                      <summary>查看原反馈全文</summary>
                      <pre>{available.origin.body}</pre>
                    </details>
                  </section>
                  <section className="feedback-followup-scope" aria-label="新任务范围与负责人">
                    <p>
                      {available.target.visibility === 'private'
                        ? '仅自己可见，沿用原私有范围'
                        : `原项目「${available.target.projectName}」的项目成员可见`}
                    </p>
                    <p>
                      新任务由 {available.target.ownerName}
                      （当前操作者）负责，创建后为待开始。不会改派或完成原任务，也不会自动执行。
                    </p>
                  </section>
                </>
              )}
              {available && draft && (
                <>
                  <label className="field">
                    后续任务标题
                    <input
                      aria-label="后续任务标题"
                      maxLength={160}
                      required
                      value={draft.title}
                      disabled={busy || !!draft.attempt}
                      onChange={(event) => put({ ...draft, title: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    后续任务说明
                    <textarea
                      aria-label="后续任务说明"
                      rows={6}
                      maxLength={12000}
                      value={draft.description}
                      disabled={busy || !!draft.attempt}
                      onChange={(event) => put({ ...draft, description: event.target.value })}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                  </label>
                  <p className="hint">
                    上方原反馈单独保留；标题和说明是你确认的新工作内容，可独立编辑。
                  </p>
                </>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {draft?.attempt && (
                <section className="feedback-followup-source" aria-label="后续任务原请求待确认">
                  <p>
                    任务可能已创建，只确认原来源、标题、说明和操作标识；关闭不会撤销。待确认包仅在当前页面会话内存保留，刷新前请先确认。
                  </p>
                  <Button type="button" busy={busy} onClick={() => void send(true)}>
                    确认原后续任务是否已创建
                  </Button>
                </section>
              )}
              <footer className="dialog-actions">
                <Button type="button" onClick={() => setCreating(false)}>
                  返回后续任务列表
                </Button>
                {draft && !draft.attempt && (
                  <>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        put(null);
                        setCreating(false);
                      }}
                    >
                      放弃未提交草稿
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      busy={busy}
                      disabled={!draft.title.trim() || !available || !!previewError}
                    >
                      创建后续任务
                    </Button>
                  </>
                )}
              </footer>
              <p className="hint">
                未提交草稿仅在当前账号/空间的页面会话内保留，硬刷新不恢复。尚未提交时返回或关闭不会创建任务。
              </p>
            </form>
          ) : (
            <div className="feedback-followup-list">
              <p>
                原反馈：{message.actorName} ·{' '}
                {message.body.slice(0, 160).replace(/[\uD800-\uDBFF]$/, '')}
                {message.body.length > 160 ? '…' : ''}
              </p>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {list.error && (
                <p className="form-error" role="alert">
                  {list.error}
                  <Button type="button" onClick={list.retry}>
                    重读后续任务
                  </Button>
                </p>
              )}
              {!list.value && !list.error && <p role="status">正在读取已建立的任务…</p>}
              {list.value && !list.value.items.length && <p>还没有由这条反馈建立的可见任务。</p>}
              {list.value?.items.map((task) => (
                <article className="feedback-followup-item" key={task.id}>
                  <Link to={`/tasks/${task.id}`}>
                    {task.shortId} · {task.title}
                  </Link>
                  <StatusBadge status={task.status} />
                </article>
              ))}
              {list.value?.truncated && <p className="hint">仅显示最近50项可见后续任务。</p>}
              {editable && !list.denied && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setError('');
                    setCreating(true);
                  }}
                >
                  {draft?.attempt
                    ? '确认原创建请求'
                    : draft
                      ? '继续编辑后续任务草稿'
                      : '建立后续任务'}
                </Button>
              )}
              {!editable && <p className="team-readonly">建立新任务需要原任务的当前编辑权限。</p>}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
