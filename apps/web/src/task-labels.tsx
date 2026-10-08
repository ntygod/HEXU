import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import {
  parseTaskLabel,
  parseTaskLabelsChange,
  TASK_LABEL_LIMIT,
  type TaskLabelsChange,
  type TaskLabelsReceipt,
  type TaskLabelsView,
} from '../../../packages/contracts/src/task-labels.js';
import { ApiError, request } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, useApp } from './state.js';
import { handleTaskLabelKeyDown } from './task-label-input.js';
import './task-labels.css';

export function TaskLabelChips({ labels = [] }: { labels?: string[] }) {
  return labels.length ? (
    <span className="task-label-chips" aria-label="任务标签">
      {labels.map((label) => (
        <span className="badge" key={label}>
          {label}
        </span>
      ))}
    </span>
  ) : null;
}
export function TaskLabels({ task }: { task: Task }) {
  const { data } = useApp();
  return task.visibility === 'project' && task.projectId ? (
    <Labels
      key={`${data.mode}:${data.user.id}:${data.space?.id ?? 'preview'}:${task.id}`}
      task={task}
    />
  ) : null;
}
function Labels({ task }: { task: Task }) {
  const { data, version, notice } = useApp();
  const [value, setValue] = useState<TaskLabelsView | null>(null);
  const [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [denied, setDenied] = useState(false);
  const read = useRef<AbortController | null>(null);
  const known = data.tasks.find((item) => item.id === task.id);
  const mayEdit = !!known && canEditTask(data, known);
  const editable = mayEdit && !!value?.canEdit;
  const load = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const next = await request<TaskLabelsView>(`/tasks/${task.id}/labels`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setValue(next);
      setError('');
      setDenied(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const forbidden = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      if (forbidden) {
        setValue(null);
        setOpen(false);
        setDenied(true);
      }
      setError(cause instanceof Error ? cause.message : '标签暂时读取失败');
    }
  }, [task.id]);
  useEffect(() => {
    void load();
    return () => read.current?.abort();
  }, [load, version]);
  // Current permission loss ends the editor session; a later re-grant cannot revive it.
  useEffect(() => setOpen(false), [editable]);
  function deny() {
    read.current?.abort();
    setValue(null);
    setOpen(false);
    setDenied(true);
    notice('当前已无法编辑任务，标签草稿和待确认请求已清除', true);
  }
  if (!known) return null;
  return (
    <>
      <button
        className="text-button"
        disabled={!value || denied || value.canEdit !== mayEdit}
        onClick={() => {
          void load();
          setOpen(true);
        }}
        aria-label="查看任务标签"
      >
        标签 <span className="count">{value?.labels.length ?? 0}</span>
      </button>
      {error && (
        <button className="text-button" onClick={() => void load()} title={error}>
          重试任务标签
        </button>
      )}
      {open && value && !denied && (
        <LabelEditor
          task={task}
          current={value}
          editable={editable}
          readError={error}
          reread={load}
          onClose={() => setOpen(false)}
          onDenied={deny}
        />
      )}
    </>
  );
}
function LabelEditor({
  task,
  current,
  editable,
  readError,
  reread,
  onClose,
  onDenied,
}: {
  task: Task;
  current: TaskLabelsView;
  editable: boolean;
  readError: string;
  reread(): Promise<void>;
  onClose(): void;
  onDenied(): void;
}) {
  const { refresh, notice } = useApp();
  const [base, setBase] = useState(() => structuredClone(current));
  const [labels, setLabels] = useState(() => [...current.labels]);
  const [input, setInput] = useState(''),
    [error, setError] = useState(''),
    [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState<{ body: TaskLabelsChange; key: string } | null>(null);
  const alive = useRef(true),
    sending = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changed = current.revision !== base.revision || conflicted;
  const dirty = JSON.stringify([...labels].sort()) !== JSON.stringify(base.labels);
  const locked = busy || !!attempt;
  function close() {
    alive.current = false;
    onClose();
  }
  function add() {
    if (locked) return;
    try {
      const label = parseTaskLabel(input);
      const next = parseTaskLabelsChange({
        expectedRevision: base.revision,
        labels: [...labels, label],
      });
      setLabels(next.labels);
      setInput('');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '标签无效');
    }
  }
  function useCurrent(keep: boolean) {
    setBase(structuredClone(current));
    setConflicted(false);
    setError('');
    if (!keep) {
      setLabels([...current.labels]);
      setInput('');
    }
  }
  async function save(confirm = false) {
    if (
      !alive.current ||
      !editable ||
      sending.current ||
      (!confirm && (locked || changed || !dirty || !!input.trim()))
    )
      return;
    const packet = confirm
      ? attempt
      : {
          body: parseTaskLabelsChange({ expectedRevision: base.revision, labels }),
          key: crypto.randomUUID(),
        };
    if (!packet) return;
    sending.current = true;
    setBusy(true);
    setAttempt(packet);
    setError('');
    try {
      const receipt = await request<TaskLabelsReceipt>(`/tasks/${task.id}/labels`, {
        method: 'POST',
        body: packet.body,
        key: packet.key,
      });
      if (!alive.current) return;
      if (
        receipt.taskId !== task.id ||
        receipt.revision !== packet.body.expectedRevision + 1 ||
        JSON.stringify(receipt.labels) !== JSON.stringify(packet.body.labels)
      )
        throw new ApiError('服务未返回可核对的原标签回执，请确认原请求', 'INVALID_RESPONSE', 502);
      notice(
        `标签已保存 · 本次回执为标签修订 ${receipt.revision}${confirm ? '，当前可能已有后续修改' : ''}`,
      );
      close();
      await refresh().catch(() => {});
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        alive.current = false;
        onDenied();
        return;
      }
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setAttempt(known ? null : packet);
      setConflicted(cause instanceof ApiError && cause.status === 409);
      setError(cause instanceof Error ? cause.message : '标签保存失败');
      await reread();
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog title="任务标签" onClose={close}>
      <form
        className="drawer-form task-label-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-body">
          <p>
            {task.shortId} · {task.title}
          </p>
          <p className="hint">
            标签用于整理和筛选本任务；每项任务最多 16 个，每个最多 32 字。同名标签区分大小写。
          </p>
          {!editable ? (
            <>
              <p>你可以查看标签，当前没有编辑权限。</p>
              <TaskLabelChips labels={current.labels} />
              {!current.labels.length && <p>尚无标签</p>}
            </>
          ) : (
            <>
              <p className="hint">
                本次编辑基于标签修订 {base.revision}。保存不会改变工作说明或启动执行。
              </p>
              <section aria-label="本次标签草稿" className="task-label-draft">
                {labels.map((label) => (
                  <div key={label}>
                    <span>{label}</span>
                    <Button
                      type="button"
                      disabled={locked}
                      aria-label={`移除标签：${label}`}
                      onClick={() => setLabels(labels.filter((item) => item !== label))}
                    >
                      移除
                    </Button>
                  </div>
                ))}
                {!labels.length && <p>尚无标签</p>}
              </section>
              <label className="field">
                新标签
                <input
                  autoFocus
                  aria-label="新标签"
                  value={input}
                  maxLength={32}
                  disabled={locked || labels.length >= TASK_LABEL_LIMIT}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => handleTaskLabelKeyDown(event, add)}
                />
              </label>
              <Button
                type="button"
                disabled={locked || !input.trim() || labels.length >= TASK_LABEL_LIMIT}
                onClick={add}
              >
                加入草稿
              </Button>
              {!!input.trim() && <p className="hint">先将新标签加入草稿，再保存整个标签集合。</p>}
              {changed && (
                <section className="task-label-conflict" aria-label="标签版本冲突">
                  <h3>标签已变化，请先核对</h3>
                  <p>你输入的草稿已保留。当前标签修订 {current.revision}：</p>
                  <TaskLabelChips labels={current.labels} />
                  {!current.labels.length && <p>当前没有标签</p>}
                  <div className="task-label-actions">
                    <Button type="button" disabled={locked} onClick={() => useCurrent(false)}>
                      丢弃草稿，载入当前标签
                    </Button>
                    <Button
                      type="button"
                      disabled={locked || current.revision === base.revision}
                      onClick={() => useCurrent(true)}
                    >
                      保留草稿，采用当前基线
                    </Button>
                  </div>
                  <p className="hint">保留草稿后再次保存会替换当前完整标签集合。</p>
                </section>
              )}
              {attempt && (
                <section className="task-label-conflict" aria-label="标签保存待确认">
                  <p>
                    原标签请求已提交，尚未确认回执。关闭不会撤销已提交的保存，草稿和待确认请求仅保留在本次抽屉。
                  </p>
                  <Button type="button" busy={busy} onClick={() => void save(true)}>
                    确认原标签是否已保存
                  </Button>
                </section>
              )}
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {readError && (
            <p className="form-error" role="alert">
              当前标签暂时读取失败，输入已保留：{readError}
            </p>
          )}
          <Button type="button" disabled={busy} onClick={() => void reread()}>
            重新读取标签
          </Button>
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={close}>
            关闭
          </Button>
          {editable && (
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={locked || changed || !dirty || !!input.trim()}
            >
              保存标签
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
