import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../../packages/contracts/src/index.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, go, Link, useApp, useTaskDraft } from './state.js';
import './result-feedback-reply.css';

export const feedbackMessageHref = (message: Message, id = message.id) =>
  `/results/${message.resultId}/versions/${message.resultRevisionId}/messages/${id}`;
interface Draft {
  body: string;
  attempt?: { body: string; key: string };
}
const decode = (stored: string): Draft => {
  try {
    return stored ? (JSON.parse(stored) as Draft) : { body: '' };
  } catch {
    return { body: '' };
  }
};
export function FeedbackReplyAction({ message }: { message: Message }) {
  const { data, version, readDraft, saveDraft, refresh, notice } = useApp();
  const purpose = `feedback-reply:${message.resultId}:${message.resultRevisionId}:${message.id}`;
  const [stored, setStored] = useTaskDraft(message.taskId, purpose);
  const draft = decode(stored);
  const sourcePreview = message.body.slice(0, 240).replace(/[\uD800-\uDBFF]$/, '');
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null),
    [saved, setSaved] = useState<Message | null>(null);
  const container = useRef<HTMLDivElement>(null),
    alive = useRef(true),
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
  useEffect(() => {
    if (!editable) {
      setOpen(false);
      setSaved(null);
    }
  }, [editable]);
  const encode = (value: Draft | null) =>
    value && (value.body || value.attempt) ? JSON.stringify(value) : '';
  const put = (value: Draft | null) => setStored(encode(value));
  async function send(confirm = false) {
    if (!editable || inFlight.current || (!confirm && draft.attempt)) return;
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
      decode(readDraft(message.taskId, purpose) ?? '').attempt?.key === attempt.key;
    try {
      const reply = await request<Message>(
        `/results/${message.resultId}/versions/${message.resultRevisionId}/feedback/${message.id}/replies`,
        { method: 'POST', body: { body: attempt.body }, key: attempt.key },
      );
      if (!matches()) return;
      saveDraft(message.taskId, purpose, '');
      if (!alive.current) return;
      put(null);
      setOpen(false);
      setSaved(reply);
      notice('回复已保存在原任务与同一成果版本');
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      if (known) saveDraft(message.taskId, purpose, denied ? '' : encode({ body: original.body }));
      if (!alive.current) return;
      if (denied) {
        put(null);
        setOpen(false);
        setDeniedAt(currentVersion.current);
      } else if (known) put({ body: original.body });
      setError(cause instanceof Error ? cause.message : '回复发送失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="feedback-reply-action" ref={container}>
      {editable && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {draft.attempt
            ? '确认这条反馈的原回复'
            : draft.body
              ? '继续回复这条反馈'
              : '回复这条反馈'}
        </Button>
      )}
      {saved && <Link to={feedbackMessageHref(saved)}>查看刚保存的回复</Link>}
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && editable && (
        <Dialog title="回复这条成果反馈" onClose={() => setOpen(false)}>
          <form
            className="feedback-reply-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <section className="feedback-reply-source" aria-label="正在回复的原反馈">
              <strong>回复 {message.actorName}</strong>
              <p>
                {sourcePreview}
                {sourcePreview.length < message.body.length ? '…' : ''}
              </p>
              <a
                href={feedbackMessageHref(message)}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  setOpen(false);
                  const target = feedbackMessageHref(message);
                  if (location.pathname !== target) go(target);
                  else
                    requestAnimationFrame(() => {
                      const source = container.current?.closest<HTMLElement>('article.message');
                      if (source) {
                        source.scrollIntoView({ block: 'center' });
                        source.tabIndex = -1;
                        source.focus({ preventScroll: true });
                      }
                    });
                }}
              >
                查看原版本中的完整反馈
              </a>
              {message.codeAnchor && (
                <p>
                  原位置：{message.codeAnchor.path} ·{' '}
                  {message.codeAnchor.side === 'before' ? '起点文件' : '所选文件'} ·{' '}
                  {message.codeAnchor.range
                    ? `第${message.codeAnchor.range.start}–${message.codeAnchor.range.end}行`
                    : '整个文件'}
                </p>
              )}
            </section>
            <p>
              回复保存在原任务和这条反馈的固定版本{message.codeAnchor ? '，沿用原代码位置' : ''}。
              新版本不改变回复对象，也不会自动启动执行。
            </p>
            <label className="field">
              回复内容
              <textarea
                aria-label="具体反馈回复内容"
                rows={5}
                maxLength={12000}
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
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {draft.attempt ? (
              <section className="feedback-reply-source" aria-label="原反馈回复待确认">
                <p>
                  请求可能已保存。只确认原反馈、原正文与操作标识，关闭不会撤回。待确认包仅在当前页面会话内存中保留，请先确认再刷新；已保存回复可从原任务查看。
                </p>
                <Button type="button" busy={busy} onClick={() => void send(true)}>
                  确认原回复是否已保存
                </Button>
              </section>
            ) : (
              <p className="hint">
                关闭会在当前账号和空间的页面会话中保留草稿；硬刷新不恢复。⌘ / Ctrl + Enter 发送。
              </p>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={() => setOpen(false)}>
                返回原反馈
              </Button>
              {!draft.attempt && (
                <>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      put(null);
                      setOpen(false);
                    }}
                  >
                    清除未发送回复
                  </Button>
                  <Button type="submit" variant="primary" busy={busy} disabled={!draft.body.trim()}>
                    发送这条回复
                  </Button>
                </>
              )}
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
