import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, useApp } from './state.js';
import './task-edit.css';

// Owned by the current identity/space Provider. TaskPage also clears it on a denied detail read.
export const TASK_EDIT_DRAFT = 'task-edit';
type Content = Pick<Task, 'title' | 'description' | 'attention'>;
type Baseline = Content & { taskId: string; shortId: string; revision: number };
type Patch = Content & { expectedRevision: number };
interface Attempt {
  body: Patch;
  key: string;
  requestId: string;
}
interface Draft extends Content {
  base: Baseline;
  editorId: string;
  error: string;
  conflicted?: boolean;
  attempt?: Attempt;
}
const baseline = (task: Task): Baseline => ({
  taskId: task.id,
  shortId: task.shortId,
  revision: task.revision,
  title: task.title,
  description: task.description,
  attention: task.attention ?? null,
});
const initial = (task: Task, editorId: string): Draft => ({
  base: baseline(task),
  title: task.title,
  description: task.description,
  attention: task.attention ?? null,
  editorId,
  error: '',
});
function decode(value: string | undefined, taskId: string): Draft | null {
  try {
    const draft = value ? (JSON.parse(value) as Draft) : null;
    return draft?.base.taskId === taskId ? draft : null;
  } catch {
    return null;
  }
}
function ContentComparison({ label, content }: { label: string; content: Content }) {
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <dl>
        <dt>标题</dt>
        <dd>{content.title}</dd>
        <dt>说明</dt>
        <dd>{content.description || '未填写说明'}</dd>
        <dt>需要关注什么</dt>
        <dd>{content.attention || '未填写'}</dd>
      </dl>
    </section>
  );
}

export function EditTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const { data } = useApp();
  return (
    <TaskEditor
      key={`${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}:${task.id}`}
      task={task}
      onClose={onClose}
    />
  );
}
function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const { data, readDraft, saveDraft, refresh, notice } = useApp();
  const known = data.tasks.find((item) => item.id === task.id);
  const current = known && known.revision > task.revision ? known : task;
  const editable = !!known && canEditTask(data, known);
  const [editorId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (!editable) return null;
    const stored = decode(readDraft(task.id, TASK_EDIT_DRAFT), task.id);
    return stored ? { ...stored, editorId } : initial(current, editorId);
  });
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const alive = useRef(true),
    inFlight = useRef(false),
    canEdit = useRef(editable),
    latestDraft = useRef(draft);
  canEdit.current = editable;
  latestDraft.current = draft;

  // Every mount takes ownership, even when it resumes the same immutable request.
  // A response from a closed editor may not erase or close its replacement.
  useLayoutEffect(() => {
    alive.current = true;
    const next = latestDraft.current;
    if (next && canEdit.current) saveDraft(task.id, TASK_EDIT_DRAFT, JSON.stringify(next));
    return () => {
      alive.current = false;
    };
  }, [task.id, saveDraft]);
  function ownsEditor() {
    return (
      alive.current &&
      canEdit.current &&
      decode(readDraft(task.id, TASK_EDIT_DRAFT), task.id)?.editorId === editorId
    );
  }
  function put(next: Draft | null) {
    latestDraft.current = next;
    saveDraft(task.id, TASK_EDIT_DRAFT, next ? JSON.stringify(next) : '');
    setDraft(next);
  }
  useEffect(() => {
    if (!editable) {
      alive.current = false;
      saveDraft(task.id, TASK_EDIT_DRAFT, '');
      setDraft(null);
      onClose();
    }
  }, [editable, task.id, saveDraft, onClose]);
  const changed = !!draft && current.revision !== draft.base.revision;
  const blocked = changed || !!draft?.conflicted;
  const dirty =
    !!draft &&
    (draft.title.trim() !== draft.base.title ||
      draft.description.trim() !== draft.base.description ||
      (draft.attention?.trim() || null) !== draft.base.attention);
  const contentChanged =
    !!draft &&
    (current.title !== draft.base.title ||
      current.description !== draft.base.description ||
      (current.attention ?? null) !== draft.base.attention);

  function close() {
    if (!ownsEditor()) return;
    // Unsent Cancel is a discard. Submitted work cannot be cancelled by dismissing its UI.
    if (!latestDraft.current?.attempt) put(null);
    alive.current = false;
    onClose();
  }
  async function reread() {
    if (!ownsEditor() || reading) return;
    setReading(true);
    try {
      await refresh();
    } catch (cause) {
      if (ownsEditor() && latestDraft.current)
        put({
          ...latestDraft.current,
          error: cause instanceof Error ? cause.message : '暂时无法重读当前任务',
        });
    } finally {
      if (ownsEditor()) setReading(false);
    }
  }
  async function send(confirm = false) {
    const local = latestDraft.current;
    if (!local || !ownsEditor() || inFlight.current) return;
    if (!confirm && (local.attempt || blocked || !dirty || !local.title.trim())) return;
    const packet = confirm
      ? local.attempt
      : {
          body: {
            expectedRevision: local.base.revision,
            title: local.title,
            description: local.description,
            attention: local.attention || null,
          },
          key: crypto.randomUUID(),
        };
    if (!packet) return;
    const attempt: Attempt = { ...packet, requestId: crypto.randomUUID() };
    const original = { ...local, attempt, error: '' };
    inFlight.current = true;
    put(original);
    setBusy(true);
    const matches = () =>
      ownsEditor() &&
      decode(readDraft(task.id, TASK_EDIT_DRAFT), task.id)?.attempt?.requestId ===
        attempt.requestId;
    try {
      const receipt = await request<Task>(`/tasks/${encodeURIComponent(local.base.taskId)}`, {
        method: 'PATCH',
        body: attempt.body,
        key: attempt.key,
      });
      if (!matches()) return;
      if (
        receipt.id !== local.base.taskId ||
        receipt.revision !== attempt.body.expectedRevision + 1
      )
        throw new ApiError('服务未返回可核对的原修改回执，请确认原请求', 'INVALID_RESPONSE', 502);
      put(null);
      alive.current = false;
      notice(
        confirm
          ? `原修改已确认保存于任务修订 ${receipt.revision}；当前任务可能已有后续修改`
          : `工作说明已保存 · 本次回执为任务修订 ${receipt.revision}`,
      );
      // Close before refreshing, never from a continuation that can outlive this editor.
      onClose();
      await refresh().catch(() => {});
    } catch (cause) {
      if (!matches()) return;
      const knownFailure = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      const error = cause instanceof Error ? cause.message : '工作说明保存失败';
      if (denied) {
        canEdit.current = false;
        put(null);
        alive.current = false;
        notice('当前已无法编辑此任务，工作说明草稿和待确认请求已清除', true);
        onClose();
      } else {
        const { attempt: _attempt, ...unsent } = original;
        put(
          knownFailure
            ? { ...unsent, error, conflicted: cause instanceof ApiError && cause.status === 409 }
            : { ...original, error },
        );
      }
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!editable || !draft) return null;
  const locked = busy || !!draft.attempt;
  return (
    <Dialog title="编辑工作说明" onClose={close}>
      <form
        className="task-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="dialog-body">
          <section className="task-edit-baseline" aria-label="工作说明固定基线">
            <strong>
              {draft.base.shortId} · 本次编辑基于任务修订 {draft.base.revision}
            </strong>
            <p>{draft.base.title}</p>
            <p>只修改标题、说明与关注内容，不会自动发送给正在运行的模型。</p>
          </section>
          {blocked && (
            <section className="task-edit-conflict" aria-label="工作说明版本冲突">
              <h3>任务已有变化，请先核对</h3>
              <p role="status">
                {changed
                  ? `当前任务修订 ${current.revision}；你的草稿仍基于修订 ${draft.base.revision}。`
                  : '服务端报告版本冲突，请重读当前任务后再核对。'}
                不会自动覆盖草稿或调整提交基线。
              </p>
              {changed && !contentChanged && (
                <p>标题、说明与关注内容未变，任务的其他信息已有更新，仍需明确选择编辑基线。</p>
              )}
              <div className="task-edit-comparison">
                <ContentComparison label="本次原内容" content={draft.base} />
                <ContentComparison label="当前内容" content={current} />
              </div>
              <div className="task-edit-actions">
                <Button
                  type="button"
                  disabled={locked || !changed}
                  onClick={() => {
                    if (ownsEditor() && !latestDraft.current?.attempt)
                      put(initial(current, editorId));
                  }}
                >
                  放弃草稿并载入最新版
                </Button>
                <Button
                  type="button"
                  disabled={locked || !changed}
                  onClick={() => {
                    if (ownsEditor() && latestDraft.current && !latestDraft.current.attempt)
                      put({
                        ...latestDraft.current,
                        base: baseline(current),
                        error: '',
                        conflicted: false,
                      });
                  }}
                >
                  保留草稿并使用当前版本
                </Button>
                <Button type="button" busy={reading} onClick={() => void reread()}>
                  重读当前任务
                </Button>
              </div>
              <p className="hint">
                保留草稿不会立即保存；再次保存会提交输入框中的全部标题、说明和关注内容。
              </p>
            </section>
          )}
          <label className="field">
            标题
            <input
              autoFocus
              aria-label="标题"
              required
              maxLength={160}
              value={draft.title}
              disabled={locked}
              onChange={(event) => put({ ...draft, title: event.target.value })}
            />
          </label>
          <label className="field">
            说明
            <textarea
              aria-label="说明"
              rows={5}
              maxLength={12000}
              value={draft.description}
              disabled={locked}
              onChange={(event) => put({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="field">
            需要关注什么 <span>可选</span>
            <input
              aria-label="需要关注什么"
              maxLength={300}
              value={draft.attention ?? ''}
              disabled={locked}
              onChange={(event) => put({ ...draft, attention: event.target.value || null })}
              placeholder="例如：等待接口字段确认"
            />
          </label>
          {draft.error && (
            <p className="form-error" role="alert">
              {draft.error}
            </p>
          )}
          {draft.attempt && (
            <section className="task-edit-conflict" aria-label="工作说明保存待确认">
              <h3>{busy ? '原修改请求已提交，正在等待回执' : '尚未确认原修改是否已保存'}</h3>
              <p>
                请求可能已经保存。只确认原任务、原基线、原内容和操作标识，不会重新提交新草稿；关闭不撤销已提交的工作。
              </p>
              <Button type="button" busy={busy} onClick={() => void send(true)}>
                确认原修改是否已保存
              </Button>
            </section>
          )}
          <p className="hint">
            草稿与待确认请求只在当前页面会话的内存中保留，刷新页面或切换账号、空间后清除。未提交时关闭会放弃草稿。
          </p>
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={close}>
            {draft.attempt ? '关闭并保留待确认请求' : '取消'}
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={blocked || !!draft.attempt || !dirty || !draft.title.trim()}
          >
            保存修改
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
