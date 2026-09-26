import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  ParticipantChange,
  ParticipantEvent,
  TaskParticipantsView,
} from '../../../packages/contracts/src/task-participants.js';
import {
  ApiError,
  changeTaskParticipant,
  taskParticipantHistory,
} from '../../../packages/client/src/index.js';
import { Button, Dialog, Empty } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp, useLoad } from './state.js';
import './task-participants.css';

const stateLabels = {
  active: '参与中',
  left: '已退出参与',
  removed: '已移除',
  access_revoked: '项目访问已撤销',
};
const actionLabels = {
  joined: '加入参与',
  added: '添加参与者',
  left: '退出参与',
  removed: '移除参与者',
  access_revoked: '因访问撤销结束参与',
};
export function TaskParticipants({ task }: { task: Task }) {
  return task.visibility === 'project' && task.projectId ? (
    <ProjectParticipants key={task.id} task={task} />
  ) : null;
}
function ProjectParticipants({ task }: { task: Task }) {
  const { data, refresh } = useApp();
  const { value, error } = useLoad<TaskParticipantsView>(`/tasks/${task.id}/participants`);
  const [open, setOpen] = useState<{ manageable: boolean } | null>(null);
  const manageable = canEditTask(data, task) && !!value?.canManage;
  useEffect(() => setOpen(null), [manageable]);
  const active =
    value?.participants.filter((member) => member.state === 'active' && member.available) ?? [];
  return (
    <>
      <button
        className="text-button"
        disabled={!value || !!error}
        onClick={() => setOpen({ manageable })}
        aria-label={`任务参与者（${active.length}）`}
      >
        参与者 <span className="count">{active.length}</span>
      </button>
      {error && (
        <button className="text-button" title={error} onClick={() => void refresh()}>
          重试参与者信息
        </button>
      )}
      {open && value && open.manageable === manageable && (
        <ParticipantsDrawer
          task={task}
          value={value}
          manageable={manageable}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
function ParticipantsDrawer({
  task,
  value,
  manageable,
  onClose,
}: {
  task: Task;
  value: TaskParticipantsView;
  manageable: boolean;
  onClose(): void;
}) {
  const { data, refresh, notice } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [query, setQuery] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uncertain, setUncertain] = useState<{ body: ParticipantChange; key: string } | null>(null);
  const alive = useRef(true),
    search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const active = value.participants.filter(
    (member) => member.state === 'active' && member.available,
  );
  const selfActive = active.some((member) => member.id === data.user.id);
  const candidates = value.candidates.filter(
    (member) =>
      !active.some((current) => current.id === member.id) &&
      member.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  async function save(attempt: { body: ParticipantChange; key: string }) {
    if (busy || (!manageable && attempt.body.userId !== data.user.id)) return;
    setBusy(true);
    setError('');
    try {
      await changeTaskParticipant(task.id, attempt.body, attempt.key);
      if (!alive.current) return;
      setUncertain(null);
      let refreshed = true;
      await refresh().catch(() => {
        refreshed = false;
      });
      if (!alive.current) return;
      notice(
        refreshed ? '参与操作已确认，当前关系已刷新' : '参与操作已保存，页面刷新失败，请重新加载',
        !refreshed,
      );
      search.current?.focus();
    } catch (cause) {
      if (!alive.current) return;
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setUncertain(known ? null : attempt);
      setError(
        cause instanceof ApiError && cause.status === 409
          ? '参与关系或成员权限已变化。已重新读取，请核对后再次选择。'
          : cause instanceof Error
            ? cause.message
            : '参与操作失败',
      );
      await refresh().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function change(userId: string, action: 'add' | 'remove') {
    if (uncertain || busy) return;
    void save({
      body: { expectedRevision: value.revision, userId, action },
      key: crypto.randomUUID(),
    });
  }
  return (
    <Dialog title="任务参与者" drawer onClose={() => !busy && onClose()}>
      <div className="participants-body">
        <span className="eyebrow">
          {task.shortId} · 参与关系修订 {value.revision}
        </span>
        <h3>{task.title}</h3>
        <p className="hint">
          参与只记录协作关系，查看和编辑仍由项目权限决定。加入或退出不会改变负责人、已有执行或本轮模型材料。
        </p>
        {data.mode === 'local-preview' && (
          <p className="hint">当前使用示例成员，不代表真实团队账号。</p>
        )}
        <div className="participants-self">
          <span>{selfActive ? '你正在参与此任务' : '你尚未参与此任务'}</span>
          <Button
            disabled={busy || !!uncertain}
            onClick={() => change(data.user.id, selfActive ? 'remove' : 'add')}
          >
            {selfActive ? '退出参与' : '参与此任务'}
          </Button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <div className="notice-box" role="status">
            <div>
              <p>上次操作的回执未确认。确认会复用原请求，不会新增一次修改。</p>
              <Button busy={busy} onClick={() => void save(uncertain)}>
                确认上次参与操作
              </Button>
            </div>
          </div>
        )}
        <section aria-label="当前参与者">
          <h4>当前参与者 · {active.length}</h4>
          {!active.length && <p className="hint">还没有参与者，可以先由自己加入。</p>}
          {active.map((member) => (
            <div className="participant-row" key={member.id}>
              <div>
                <strong>
                  {member.name}
                  {member.id === data.user.id ? '（你）' : ''}
                </strong>
                <small>{member.role === 'view' ? '当前只读成员' : '项目成员'}</small>
              </div>
              {(manageable || member.id === data.user.id) && (
                <Button
                  disabled={busy || !!uncertain}
                  aria-label={`移除参与者 ${member.name}`}
                  onClick={() => change(member.id, 'remove')}
                >
                  {member.id === data.user.id ? '退出' : '移除'}
                </Button>
              )}
            </div>
          ))}
        </section>
        {manageable && (
          <section aria-label="添加项目成员">
            <label className="field">
              查找项目成员
              <input
                ref={search}
                aria-label="查找参与成员"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={80}
                placeholder="输入成员姓名"
              />
            </label>
            <div className="participant-candidates">
              {candidates.map((member) => (
                <div className="participant-row" key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <small>
                      {member.role === 'view' ? '只读成员 · 不增加编辑权限' : '项目成员'}
                    </small>
                  </div>
                  <Button
                    disabled={busy || !!uncertain}
                    aria-label={`添加参与者 ${member.name}`}
                    onClick={() => change(member.id, 'add')}
                  >
                    添加
                  </Button>
                </div>
              ))}
              {!candidates.length && <p className="hint">没有匹配的可添加成员。</p>}
            </div>
          </section>
        )}
        {value.participants.some((member) => member.state !== 'active' || !member.available) && (
          <details className="participant-former">
            <summary>此前参与的成员</summary>
            {value.participants
              .filter((member) => member.state !== 'active' || !member.available)
              .map((member) => (
                <div className="participant-row" key={member.id}>
                  <strong>{member.name}</strong>
                  <span className="badge neutral">
                    {!member.available ? '已不在当前项目' : stateLabels[member.state]}
                  </span>
                </div>
              ))}
          </details>
        )}
        <Button onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
          参与变更记录
        </Button>
        {historyOpen && <ParticipationHistory taskId={task.id} />}
      </div>
      <div className="dialog-footer">
        <Button disabled={busy} onClick={onClose}>
          完成
        </Button>
      </div>
    </Dialog>
  );
}
function ParticipationHistory({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<ParticipantEvent[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  async function load(before?: number, signal?: AbortSignal) {
    setBusy(true);
    setError('');
    try {
      const result = await taskParticipantHistory(taskId, before, signal);
      if (alive.current && !signal?.aborted) {
        setItems((old) =>
          before
            ? [
                ...old,
                ...result.items.filter(
                  (item) => !old.some((existing) => existing.revision === item.revision),
                ),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
      }
    } catch (cause) {
      if (alive.current && !signal?.aborted) {
        setItems([]);
        setCursor(null);
        setError(cause instanceof Error ? cause.message : '记录读取失败');
      }
    } finally {
      if (alive.current && !signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [taskId]);
  return (
    <section className="participant-history" aria-label="参与变更历史">
      <Button disabled={busy} onClick={() => void load()}>
        刷新参与记录
      </Button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {items.map((item) => (
        <article key={item.revision}>
          <strong>
            {actionLabels[item.action]} · {item.name}
          </strong>
          <p>
            {item.actorName} · {time(item.createdAt)} · r{item.revision}
          </p>
        </article>
      ))}
      {!items.length && !busy && !error && <Empty title="暂无参与变更记录" />}
      {cursor && (
        <Button busy={busy} onClick={() => void load(cursor)}>
          加载更多参与记录
        </Button>
      )}
    </section>
  );
}
