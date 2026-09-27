import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  CheckpointOption,
  CheckpointPage,
  CheckpointRequest,
  CommitCheckpoint,
} from '../../../packages/contracts/src/checkpoints.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp } from './state.js';
import { useAssistanceRead, useAssistanceCommand } from './assistance-common.js';
import './checkpoints.css';
const basePath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
const states = {
  pending: '等待本机核对',
  recorded: '引用已记录',
  cancelled: '已取消',
  expired: '已过期',
  invalidated: '原节点授权已失效',
};
export function TaskCheckpoints({ task }: { task: Task }) {
  const { data } = useApp();
  const [open, setOpen] = useState(false);
  if (data.mode !== 'team-local' || task.visibility === 'private') return null;
  return (
    <>
      <button className="text-button" onClick={() => setOpen(true)}>
        代码检查点
      </button>
      {open && (
        <Dialog title="代码检查点" drawer onClose={() => setOpen(false)}>
          <CheckpointPanel
            key={`${task.id}:${data.user.id}:${canEditTask(data, task)}`}
            task={task}
          />
        </Dialog>
      )}
    </>
  );
}
function CommandFeedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p className="form-error" role="alert">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="checkpoint-notice" aria-label="检查点请求待确认">
          <strong>尚未确认请求结果</strong>
          <p>只确认原提交、原节点和同一请求，不新建第二份请求。关闭面板不会撤回已经发送的请求。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次检查点操作
          </Button>
        </section>
      )}
    </>
  );
}
function CheckpointPanel({ task }: { task: Task }) {
  const { data } = useApp();
  const editable = canEditTask(data, task);
  const [creating, setCreating] = useState(false),
    [cursor, setCursor] = useState<number | null>(null);
  const read = useAssistanceRead<CheckpointPage>(
    basePath(task.id) + '/checkpoints' + (cursor ? `?cursor=${cursor}` : ''),
    3000,
  );
  useEffect(() => {
    if (!editable || read.denied) setCreating(false);
  }, [editable, read.denied]);
  const cancel = useAssistanceCommand<CheckpointRequest>(() => read.retry());
  if (read.denied)
    return (
      <div className="checkpoint-panel">
        <p role="alert">访问已撤销，检查点内容已清除。</p>
      </div>
    );
  return (
    <div className="checkpoint-panel">
      <section className="checkpoint-heading">
        <Icon name="code" />
        <div>
          <h3>保留明确的代码起点</h3>
          <p>记录一个已存在的 Git 提交；不提交、不复制、不恢复代码，也不停止当前执行。</p>
        </div>
      </section>
      <section className="checkpoint-notice">
        <strong>当前仅支持本机提交引用</strong>
        <p>
          核对提交和根树对象，不保证全部文件、LFS
          或子模块可恢复。暂存、未提交、未跟踪与忽略内容不包含；未核对远端，也不是代码备份。
        </p>
      </section>
      {read.error && (
        <div role="alert">
          <p>{read.error}</p>
          <Button onClick={read.retry}>重读检查点</Button>
        </div>
      )}
      {!creating && editable && (
        <Button variant="primary" disabled={!!read.error} onClick={() => setCreating(true)}>
          记录提交检查点
        </Button>
      )}
      {creating && editable && (
        <CheckpointEditor
          task={task}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setCursor(null);
            read.retry();
          }}
        />
      )}
      <CommandFeedback command={cancel} />
      <section aria-label="检查点记录" className="checkpoint-list">
        {!read.value ? (
          <p role="status">正在读取检查点…</p>
        ) : !read.value.requests.length ? (
          <p className="empty-hint">
            尚未记录检查点。先选择本人节点和完整提交 ID，再到该节点本机确认。
          </p>
        ) : (
          read.value.requests.map((r) => {
            const checkpoint = read.value!.checkpoints.find((c) => c.id === r.checkpointId);
            return (
              <article className="checkpoint-card" key={r.id}>
                <header>
                  <strong>{r.label}</strong>
                  <span>{states[r.state]}</span>
                </header>
                <p>
                  {r.nodeName} · {r.workspaceName} · {r.requestedBy.name}
                </p>
                <code aria-label="检查点提交">{r.commit}</code>
                {checkpoint ? (
                  <CheckpointRecord record={checkpoint} />
                ) : (
                  <>
                    <p>
                      请求时间：{time(r.createdAt)} · 有效至 {time(r.expiresAt)}
                    </p>
                    {r.state === 'pending' && r.requestedBy.id === data.user.id && (
                      <>
                        <p>在对应 Runner 所在电脑执行，使用配对时的私有状态目录：</p>
                        <pre aria-label="本机检查点命令">{`npm run runner -- checkpoint --request ${r.id} --state /path/to/private-state`}</pre>
                        <p>终端会显示实际目录和提交，明确确认后才核对并公开引用。无需模型账户。</p>
                        <Button
                          disabled={!editable || !!read.error || !!cancel.uncertain}
                          busy={cancel.busy}
                          onClick={() =>
                            void cancel.send(
                              basePath(task.id) + `/checkpoint-requests/${r.id}/cancel`,
                              {},
                            )
                          }
                        >
                          取消检查点请求
                        </Button>
                      </>
                    )}
                  </>
                )}
              </article>
            );
          })
        )}
      </section>
      <div className="checkpoint-actions">
        {cursor && <Button onClick={() => setCursor(null)}>返回最新检查点</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>更早的检查点</Button>
        )}
      </div>
    </div>
  );
}
function CheckpointRecord({ record: r }: { record: CommitCheckpoint }) {
  const m = r.manifest,
    s = m.workingCopy;
  return (
    <>
      <p>本机核对时间：{time(m.verifiedAt)}；仅代表当时对象存在，不持续保证可用。</p>
      <p aria-label="未包含的工作区改动">
        {s.state === 'available'
          ? `观察到：暂存 ${s.staged} · 工作区修改 ${s.modified} · 未跟踪条目 ${s.untracked} · 冲突 ${s.conflicts}。这些可变内容均未包含，数量可能随后变化。`
          : '工作区变更数量不可确认；不能据此认为工作区干净。所有未提交内容仍不包含。'}
      </p>
      <details>
        <summary>查看固定对象与来源</summary>
        <dl>
          <dt>根树 · {m.objectFormat}</dt>
          <dd>
            <code>{m.tree}</code>
          </dd>
          <dt>本机授权仓库指纹（不是远端身份）</dt>
          <dd>
            <code>{m.repositoryIdentity}</code>
          </dd>
          <dt>记录标识</dt>
          <dd>
            <code>{r.id}</code>
          </dd>
          <dt>范围</dt>
          <dd>仅提交与根树哈希；Git 对象未上传、未固定保留，不含分支引用或凭证。</dd>
        </dl>
      </details>
    </>
  );
}
function CheckpointEditor({
  task,
  onSaved,
  onClose,
}: {
  task: Task;
  onSaved(): void;
  onClose(): void;
}) {
  const read = useAssistanceRead<{ items: CheckpointOption[] }>(
    basePath(task.id) + '/checkpoint-options',
    3000,
  );
  const [node, setNode] = useState(''),
    [workspace, setWorkspace] = useState(''),
    [commit, setCommit] = useState(''),
    [label, setLabel] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [revision, setRevision] = useState(task.revision);
  const command = useAssistanceCommand<CheckpointRequest>(onSaved);
  useEffect(() => {
    if (read.denied || command.denied) {
      setNode('');
      setWorkspace('');
      setCommit('');
      setLabel('');
      setConfirmed(false);
    }
  }, [read.denied, command.denied]);
  const selected = read.value?.items.find((n) => n.nodeId === node);
  const locked = command.busy || !!command.uncertain || !!read.error;
  const stale = revision !== task.revision;
  if (read.denied || command.denied)
    return <p role="alert">创建权限已撤销，请关闭面板后重新核对。</p>;
  return (
    <form
      className="checkpoint-editor"
      aria-label="新建提交检查点"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && confirmed)
          void command.send(basePath(task.id) + '/checkpoint-requests', {
            nodeId: node,
            workspaceId: workspace,
            commit,
            label,
            expectedTaskRevision: revision,
            confirmReference: true,
          });
      }}
    >
      <h3>选择已存在的提交</h3>
      <fieldset disabled={locked}>
        <label className="field">
          检查点名称
          <input
            aria-label="检查点名称"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="field">
          来源节点
          <select
            aria-label="检查点来源节点"
            value={node}
            onChange={(e) => {
              setNode(e.target.value);
              setWorkspace('');
              setConfirmed(false);
            }}
          >
            <option value="">选择本人节点</option>
            {read.value?.items.map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.nodeName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          授权目录
          <select
            aria-label="检查点授权目录"
            value={workspace}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">选择目录别名</option>
            {selected?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          完整提交 ID
          <input
            aria-label="完整提交 ID"
            value={commit}
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setCommit(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <p>
          从 Git 取得完整的 40 或 64 位小写提交 ID，不接受分支名、标签或短 ID。网页不读取本机代码。
        </p>
        <label className="checkpoint-consent">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我确认仅记录此提交的本机引用；未提交内容不包含，相关项目成员可以查看引用。
        </label>
      </fieldset>
      {read.error && (
        <p className="form-error" role="alert">
          {read.error}
          <Button onClick={read.retry} type="button">
            重读节点选项
          </Button>
        </p>
      )}
      {stale && (
        <section className="checkpoint-notice">
          <p>任务版本已变化，当前选择保留。核对任务后再创建请求。</p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setRevision(task.revision);
              setConfirmed(false);
            }}
          >
            已核对当前任务
          </Button>
        </section>
      )}
      <CommandFeedback command={command} />
      <div className="checkpoint-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={
            locked ||
            stale ||
            !confirmed ||
            !label.trim() ||
            !selected?.workspaces.some((w) => w.id === workspace) ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
          }
        >
          创建本机核对请求
        </Button>
        <Button type="button" disabled={command.busy} onClick={onClose}>
          关闭创建
        </Button>
      </div>
    </form>
  );
}
