import { useEffect, useRef, useState } from 'react';
import type { Task, User } from '../../../packages/contracts/src/index.js';
import type {
  TaskAssignmentInput,
  TaskAssignmentOptions,
  TaskAssignmentHistory,
} from '../../../packages/contracts/src/task-assignment.js';
import {
  ApiError,
  assignTaskOwner,
  taskAssignmentHistory,
} from '../../../packages/client/src/index.js';
import { Avatar, Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp, useLoad } from './state.js';
import './task-assignment.css';

export function recordedPerson(id: string | null | undefined, members: User[]) {
  return id
    ? (members.find((member) => member.id === id)?.name ?? '原成员（当前名单未提供）')
    : '未记录';
}
export function TaskOwner({ task }: { task: Task }) {
  const { data } = useApp();
  if (task.visibility !== 'project' || !task.projectId)
    return (
      <span className="task-owner">负责人：{recordedPerson(task.ownerUserId, data.members)}</span>
    );
  return <ProjectTaskOwner key={task.id} task={task} />;
}
function ProjectTaskOwner({ task }: { task: Task }) {
  const { data, refresh } = useApp();
  const { value, error } = useLoad<TaskAssignmentOptions>(`/tasks/${task.id}/assignment`);
  const [open, setOpen] = useState(false);
  const editable = canEditTask(data, task);
  // A permission downgrade destroys the editor and its local selection, even while saving.
  useEffect(() => setOpen(false), [editable]);
  const owner = value?.owner.id === task.ownerUserId ? value.owner : null;
  return (
    <>
      <span className="task-owner" aria-label="任务负责人">
        <Avatar user={data.members.find((member) => member.id === task.ownerUserId)} size="small" />
        <span>
          负责人：{owner?.name ?? recordedPerson(task.ownerUserId, data.members)}
          {owner?.availability === 'removed'
            ? '（已不在项目）'
            : owner?.availability === 'read_only'
              ? '（当前只读）'
              : ''}
        </span>
        <button
          className="text-button"
          disabled={!value || value.revision !== task.revision}
          onClick={() => setOpen(true)}
        >
          {editable ? '更改负责人' : '改派记录'}
        </button>
        {error && (
          <button className="text-button" title={error} onClick={() => void refresh()}>
            重试负责人信息
          </button>
        )}
      </span>
      {open && value && (
        <AssignmentDrawer
          task={task}
          options={value}
          editable={editable}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function AssignmentDrawer({
  task,
  options,
  editable,
  onClose,
}: {
  task: Task;
  options: TaskAssignmentOptions;
  editable: boolean;
  onClose(): void;
}) {
  const { data, refresh, notice } = useApp();
  const [base, setBase] = useState(task);
  const [selected, setSelected] = useState(task.ownerUserId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState<{ body: TaskAssignmentInput; key: string } | null>(
    null,
  );
  const [historyOpen, setHistoryOpen] = useState(!editable);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const conflict = task.revision !== base.revision || options.revision !== base.revision;
  const eligible = options.candidates.some((person) => person.id === selected);
  const dirty = selected !== base.ownerUserId;
  async function save(attempt: { body: TaskAssignmentInput; key: string }) {
    if (busy || !editable) return;
    setBusy(true);
    setError('');
    try {
      await assignTaskOwner(task.id, attempt.body, attempt.key);
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(
        refreshed
          ? '任务负责人已更新，原执行和账户保持不变'
          : '改派已保存，页面刷新失败，请重新加载',
        !refreshed,
      );
      onClose();
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setError(cause instanceof Error ? cause.message : '改派失败');
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title={editable ? '更改任务负责人' : '任务改派记录'}
      drawer
      onClose={() => !busy && onClose()}
    >
      <form
        className="drawer-form task-assignment"
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable || busy || uncertain || conflict || !dirty || !eligible) return;
          void save({
            body: { expectedRevision: base.revision, ownerUserId: selected },
            key: crypto.randomUUID(),
          });
        }}
      >
        <div className="dialog-body">
          <span className="eyebrow">
            {task.shortId} · 任务修订 {base.revision}
          </span>
          <h3>{task.title}</h3>
          <p>创建者：{recordedPerson(task.createdByUserId, data.members)}</p>
          <div className="notice-box">
            <p>
              只改变任务责任归属，不转移代码目录、节点权限、模型账户或原生历史，不停止已有执行。待接续安排将暂停并保留原材料，需重新确认。
            </p>
          </div>
          {data.mode === 'local-preview' && (
            <p className="muted">当前为示例工作台，候选人是示例成员，不代表真实团队账号。</p>
          )}
          {editable && (
            <label>
              新的负责人
              <select
                aria-label="新的负责人"
                value={selected}
                disabled={busy || !!uncertain}
                onChange={(event) => setSelected(event.target.value)}
              >
                {!eligible && (
                  <option value={selected} disabled>
                    {options.owner.id === selected
                      ? (options.owner.name ?? '原负责人')
                      : '先前选择的成员'}
                    （当前不可分配）
                  </option>
                )}
                {options.candidates.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
              <small>仅当前有编辑或管理权限的项目成员可以接任。</small>
            </label>
          )}
          {editable && !eligible && <p role="alert">所选成员已不具备项目编辑权限，请重新选择。</p>}
          {editable && conflict && !uncertain && (
            <section className="assignment-conflict" aria-label="改派冲突">
              <h3>任务已发生变化</h3>
              <p>
                当前负责人：{options.owner.name ?? '未提供'}
                。你的选择仍然保留，请核对最新任务后再保存。
              </p>
              <div className="assignment-actions">
                <Button
                  disabled={busy || options.revision !== task.revision}
                  onClick={() => {
                    setBase(task);
                    setSelected(task.ownerUserId);
                    setError('');
                  }}
                >
                  载入最新负责人
                </Button>
                <Button
                  disabled={busy || options.revision !== task.revision}
                  onClick={() => {
                    setBase(task);
                    setError('');
                  }}
                >
                  保留选择，基于最新修订
                </Button>
              </div>
            </section>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {uncertain && (
            <div className="notice-box">
              <p>保存回执未确认；不要创建另一条改派请求。关闭不会撤回已经发出的操作。</p>
              <Button busy={busy} onClick={() => void save(uncertain)}>
                确认上次改派结果
              </Button>
            </div>
          )}
          <section className="assignment-history">
            <button
              type="button"
              className="text-button"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              改派记录
            </button>
            {historyOpen && <AssignmentHistory taskId={task.id} />}
          </section>
        </div>
        <div className="dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {editable && (
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!dirty || !eligible || conflict || !!uncertain}
            >
              保存负责人
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
function AssignmentHistory({ taskId }: { taskId: string }) {
  const [page, setPage] = useState<TaskAssignmentHistory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function load(before?: number) {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError('');
    try {
      const result = await taskAssignmentHistory(taskId, before, next.signal);
      if (next.signal.aborted) return;
      setPage((current) => ({
        ...result,
        items: before ? [...(current?.items ?? []), ...result.items] : result.items,
      }));
    } catch (cause) {
      if (!next.signal.aborted)
        setError(cause instanceof Error ? cause.message : '无法读取改派记录');
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [taskId]);
  return (
    <div aria-label="负责人变更历史">
      {page?.items.map((item) => (
        <article key={item.revision}>
          <strong>
            {item.fromName ?? '原负责人（姓名未记录）'} → {item.toName}
          </strong>
          <p>
            {item.actorName} · {time(item.createdAt)} · 修订 {item.revision}
          </p>
        </article>
      ))}
      {page && !page.items.length && (
        <p>暂无改派记录。早期创建者和历史未记录时，不根据当前负责人补造。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在读取改派记录…</p>}
      {(error || page?.nextCursor) && (
        <Button disabled={busy} onClick={() => void load(page?.nextCursor ?? undefined)}>
          {error ? '重试改派记录' : '更多改派记录'}
        </Button>
      )}
    </div>
  );
}
