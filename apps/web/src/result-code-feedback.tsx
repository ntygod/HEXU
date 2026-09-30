import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Message, Task } from '../../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../../packages/contracts/src/results.js';
import type {
  CodeFileDifference,
  ResultCodeEvidence,
} from '../../../packages/contracts/src/result-code.js';
import {
  parseResultCodeFeedback,
  type ResultCodeFeedbackInput,
} from '../../../packages/contracts/src/result-code-feedback.js';
import { countTextLines } from '../../../packages/domain/src/line-difference.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, useApp, useTaskDraft } from './state.js';
import './result-code-feedback.css';
interface Draft {
  path: string;
  side: '' | 'before' | 'after';
  range: boolean;
  start: string;
  end: string;
  body: string;
  attempt?: { key: string; input: ResultCodeFeedbackInput };
}
const decode = (text: string): Draft | null => {
  try {
    return text ? (JSON.parse(text) as Draft) : null;
  } catch {
    return null;
  }
};
export const codeFeedbackHref = (m: Message) =>
  `/results/${m.resultId}/versions/${m.resultRevisionId}/feedback/${m.id}`;
export function CodeFeedbackEntry({
  task,
  version,
  evidence,
  children,
}: {
  task: Task;
  version: ResultRevision;
  evidence?: ResultCodeEvidence;
  children: (open?: (file: CodeFileDifference) => void) => ReactNode;
}) {
  const { data, version: accessVersion, refresh, notice, readDraft, saveDraft } = useApp();
  const purpose = `code-feedback:${version.resultId}:${version.id}`;
  const [stored, setStored] = useTaskDraft(task.id, purpose);
  const draft = decode(stored);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deniedAt, setDeniedAt] = useState<number | null>(null),
    [saved, setSaved] = useState<Message | null>(null);
  const alive = useRef(true),
    inFlight = useRef(false),
    currentAccessVersion = useRef(accessVersion);
  currentAccessVersion.current = accessVersion;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const currentTask = data.tasks.find((t) => t.id === task.id),
    editable = !!currentTask && canEditTask(data, currentTask) && deniedAt !== accessVersion;
  useEffect(() => {
    if (!editable) {
      setOpen(false);
      setSaved(null);
    }
  }, [editable]);
  const put = (value: Draft | null) => setStored(value ? JSON.stringify(value) : '');
  const change = (patch: Partial<Draft>) => {
    if (draft && !busy && !draft.attempt) put({ ...draft, ...patch });
  };
  const file = evidence?.difference?.files.find((f) => f.path === draft?.path);
  const meta = draft?.side ? file?.[draft.side] : null;
  const content = draft?.side === 'before' ? file?.beforeText : file?.afterText;
  const lines = file?.display === 'text' && meta ? countTextLines(content ?? '') : 0;
  let input: ResultCodeFeedbackInput | null = null;
  if (draft && meta && draft.side)
    try {
      input = parseResultCodeFeedback({
        body: draft.body,
        path: draft.path,
        side: draft.side,
        objectId: meta.objectId,
        range: draft.range ? { start: Number(draft.start), end: Number(draft.end) } : null,
      });
      if (input.range && (file?.display !== 'text' || input.range.end > lines)) input = null;
    } catch {
      /* Keep incomplete form inputs visible. */
    }
  async function send(confirm = false) {
    if (!draft || !editable || inFlight.current || (!confirm && draft.attempt)) return;
    const attempt = confirm
      ? draft.attempt
      : input
        ? { key: crypto.randomUUID(), input: structuredClone(input) }
        : null;
    if (!attempt) return;
    const original = { ...draft, attempt };
    put(original);
    inFlight.current = true;
    setBusy(true);
    setError('');
    const matches = () => decode(readDraft(task.id, purpose) ?? '')?.attempt?.key === attempt.key;
    try {
      const message = await request<Message>(
        `/results/${version.resultId}/versions/${version.id}/code-feedback`,
        { method: 'POST', body: attempt.input, key: attempt.key },
      );
      if (!matches()) return;
      saveDraft(task.id, purpose, '');
      if (!alive.current) return;
      put(null);
      setOpen(false);
      setSaved(message);
      notice(`反馈已保存到原任务的v${version.revision}`);
      await refresh().catch(() => {});
    } catch (cause) {
      // Revocation may have cleared this request while its response was in flight.
      // A late response must not restore that draft through an older editable closure.
      if (!matches()) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const revoked = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      if (known || revoked)
        saveDraft(
          task.id,
          purpose,
          revoked ? '' : JSON.stringify({ ...original, attempt: undefined }),
        );
      if (!alive.current) return;
      if (revoked) {
        put(null);
        setDeniedAt(currentAccessVersion.current);
        setOpen(false);
      } else if (known) put({ ...original, attempt: undefined });
      setError(cause instanceof Error ? cause.message : '代码反馈发送失败');
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const openFile = (selected: CodeFileDifference) => {
    if (!editable) return;
    if (!draft) put({ path: selected.path, side: '', range: false, start: '', end: '', body: '' });
    else if (!draft.attempt && draft.path !== selected.path) {
      notice('已有未发送的固定文件反馈，请先处理原草稿');
    }
    setError('');
    setOpen(true);
  };
  return (
    <>
      {children(editable ? openFile : undefined)}
      {editable && draft && (
        <section className="code-feedback-notice" aria-label="固定代码反馈草稿">
          <strong>{draft.attempt ? '原反馈结果待确认' : '未发送的代码反馈'}</strong>
          <p>
            v{version.revision} · <code>{draft.path}</code>；
            {draft.attempt
              ? '确认会重用原正文、范围和操作标识，关闭不撤回请求。'
              : '草稿仅在当前账号/空间的页面内存中保留。'}
          </p>
          <Button type="button" onClick={() => setOpen(true)}>
            继续固定文件反馈
          </Button>
        </section>
      )}
      {saved && (
        <p className="code-feedback-notice">
          <Link to={codeFeedbackHref(saved)}>查看已保存反馈的代码位置</Link>
        </p>
      )}
      {error && !open && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && editable && draft && (
        <Dialog title="对固定代码提出反馈" onClose={() => setOpen(false)}>
          <form
            className="code-feedback-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <p>
              固定成果v{version.revision} · {version.title}
            </p>
            <p>
              <code>{draft.path}</code>
            </p>
            <p>
              反馈保存在原任务；不会自动发送给执行工具，也不会修改文件。新版本不会替换这个位置。
            </p>
            <label className="field">
              反馈代码侧
              <select
                aria-label="反馈代码侧"
                value={draft.side}
                disabled={busy || !!draft.attempt}
                onChange={(e) =>
                  change({
                    side: e.target.value as Draft['side'],
                    range: false,
                    start: '',
                    end: '',
                  })
                }
              >
                <option value="">明确选择起点文件或所选文件</option>
                {file?.before && <option value="before">起点文件</option>}
                {file?.after && <option value="after">所选文件</option>}
              </select>
            </label>
            {meta && (
              <p className="code-feedback-origin">
                固定对象 <code>{meta.objectId}</code> ·{' '}
                {file?.display === 'text' ? `${lines}行完整已共享正文` : '正文未共享，仅可定位文件'}
              </p>
            )}
            <label className="check-line">
              <input
                type="checkbox"
                checked={draft.range}
                disabled={busy || !!draft.attempt || !lines}
                onChange={(e) => change({ range: e.target.checked, start: '', end: '' })}
              />
              指定此侧的行范围
            </label>
            {draft.range && (
              <div className="code-feedback-range">
                <label className="field">
                  开始行
                  <input
                    aria-label="反馈开始行"
                    type="number"
                    min={1}
                    max={lines}
                    step={1}
                    value={draft.start}
                    disabled={busy || !!draft.attempt}
                    onChange={(e) => change({ start: e.target.value })}
                  />
                </label>
                <label className="field">
                  结束行
                  <input
                    aria-label="反馈结束行"
                    type="number"
                    min={1}
                    max={lines}
                    step={1}
                    value={draft.end}
                    disabled={busy || !!draft.attempt}
                    onChange={(e) => change({ end: e.target.value })}
                  />
                </label>
              </div>
            )}
            <label className="field">
              反馈内容
              <textarea
                aria-label="固定代码反馈内容"
                rows={5}
                maxLength={12000}
                value={draft.body}
                disabled={busy || !!draft.attempt}
                onChange={(e) => change({ body: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
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
            {draft.attempt && (
              <section className="code-feedback-notice" aria-label="代码反馈待确认">
                <p>
                  请求可能已保存。仅确认原固定反馈，不能改投其他文件或版本。待确认包仅在当前页面会话内存中保留，请先确认结果再刷新页面；已保存反馈可在原任务历史查看。
                </p>
                <Button type="button" busy={busy} onClick={() => void send(true)}>
                  确认原反馈是否已发送
                </Button>
              </section>
            )}
            <footer className="dialog-actions">
              <Button type="button" onClick={() => setOpen(false)}>
                返回固定文件
              </Button>
              {!draft.attempt && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    put(null);
                    setOpen(false);
                  }}
                >
                  清除未发送草稿
                </Button>
              )}
              {!draft.attempt && (
                <Button type="submit" variant="primary" busy={busy} disabled={!input}>
                  发送代码反馈
                </Button>
              )}
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}
