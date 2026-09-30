import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  WorkBranch,
  WorkBranchEvent,
  WorkBranchOptions,
  WorkBranchPage,
  WorkBranchView,
} from '../../../packages/contracts/src/work-branches.js';
import { parseWorkBranchCreate } from '../../../packages/contracts/src/work-branches.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import './work-branches.css';
import { BranchWorkspace } from './work-branch-workspaces.js';
import { BranchResult } from './work-branch-results.js';

const base = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}/work-branches`;
function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="work-branch-notice" aria-label="方案请求待确认">
          <p>请求可能已保存。这里只确认原起点、目标、修订和操作标识，关闭不会撤回已提交内容。</p>
          <Button busy={command.busy} onClick={() => void command.confirm()}>
            确认上次方案请求
          </Button>
        </section>
      )}
    </>
  );
}
function Editor({
  path,
  saved,
  close,
  denied,
}: {
  path: string;
  saved(): void;
  close(): void;
  denied(): void;
}) {
  const read = useAssistanceRead<WorkBranchOptions>(path + '/options');
  const [baseline, setBaseline] = useState<WorkBranchOptions | null>(null);
  const [checkpointId, setCheckpointId] = useState('');
  const [specs, setSpecs] = useState([
    { name: '方案 A', goal: '' },
    { name: '方案 B', goal: '' },
  ]);
  const command = useAssistanceCommand<WorkBranchView>(saved);
  useEffect(() => {
    if (!baseline && read.value) setBaseline(structuredClone(read.value));
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied || command.denied) denied();
  }, [read.denied, command.denied]);
  if (read.denied || command.denied) return null;
  const stale = !!baseline && !!read.value && baseline.taskRevision !== read.value.taskRevision;
  const locked = command.busy || !!command.uncertain || !!read.error || !baseline;
  const chosen = baseline?.checkpoints.find((c) => c.id === checkpointId);
  let payload: ReturnType<typeof parseWorkBranchCreate> | null = null;
  let validationError = '';
  if (baseline && chosen && specs.every((s) => s.name.trim() && s.goal.trim())) {
    try {
      payload = parseWorkBranchCreate({
        expectedTaskRevision: baseline.taskRevision,
        checkpointId,
        branches: specs,
      });
    } catch (cause) {
      validationError = (cause as Error).message;
    }
  }
  return (
    <form
      className="work-branch-editor"
      aria-label="方案定义编辑"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && payload) void command.send(path, payload);
      }}
    >
      <h3>从同一起点定义方案</h3>
      {baseline ? (
        <>
          <section aria-label="共同任务说明">
            <strong>
              {baseline.taskTitle} · 修订 {baseline.taskRevision}
            </strong>
            <p className="work-branch-text">
              {baseline.taskDescription || '当前任务没有补充说明。'}
            </p>
          </section>
          <label className="field">
            共同提交引用
            <select
              aria-label="共同提交引用"
              value={checkpointId}
              required
              disabled={locked}
              onChange={(e) => setCheckpointId(e.target.value)}
            >
              <option value="">选择已记录的代码起点</option>
              {baseline.checkpoints.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.request.label} · {c.manifest.commit.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
          {!baseline.checkpoints.length && (
            <p>尚无提交引用。请先在本任务的「代码检查点」中明确记录代码起点，再重新打开编辑。</p>
          )}
          {chosen && (
            <div className="work-branch-notice">
              <code>{chosen.manifest.commit}</code>
              <p>
                只使用这份已提交代码引用，不包含当时或现在的未提交文件。实际对象和独立目录在后续准备时核验。
              </p>
            </div>
          )}
          <div className="work-branch-specs">
            {specs.map((spec, index) => (
              <fieldset key={index} disabled={locked}>
                <legend>方案 {index + 1}</legend>
                <label className="field">
                  名称
                  <input
                    aria-label={`方案 ${index + 1} 名称`}
                    value={spec.name}
                    required
                    maxLength={60}
                    onChange={(e) =>
                      setSpecs((old) =>
                        old.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)),
                      )
                    }
                  />
                </label>
                <label className="field">
                  独立目标
                  <textarea
                    aria-label={`方案 ${index + 1} 目标`}
                    value={spec.goal}
                    required
                    maxLength={3000}
                    rows={3}
                    onChange={(e) =>
                      setSpecs((old) =>
                        old.map((v, i) => (i === index ? { ...v, goal: e.target.value } : v)),
                      )
                    }
                  />
                </label>
                {specs.length > 2 && (
                  <Button
                    type="button"
                    onClick={() => setSpecs((old) => old.filter((_, i) => i !== index))}
                  >
                    移除方案 {index + 1}
                  </Button>
                )}
              </fieldset>
            ))}
          </div>
          <Button
            type="button"
            disabled={locked || specs.length >= 6}
            onClick={() => setSpecs((old) => [...old, { name: '', goal: '' }])}
          >
            增加一个方案
          </Button>
        </>
      ) : (
        <p role="status">正在读取共同起点…</p>
      )}
      {read.error && (
        <p role="alert">
          {read.error}
          <Button type="button" onClick={read.retry}>
            重读共同起点
          </Button>
        </p>
      )}
      {stale && (
        <section className="work-branch-notice" aria-label="共同任务版本变化">
          <p>
            任务版本已变化。已填写的方案保留，请核对最新说明「{read.value?.taskTitle}
            」后采用新基线。
          </p>
          <p className="work-branch-text">{read.value?.taskDescription}</p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setBaseline(structuredClone(read.value));
              if (!read.value?.checkpoints.some((c) => c.id === checkpointId)) setCheckpointId('');
            }}
          >
            已核对共同任务说明
          </Button>
        </section>
      )}
      <Feedback command={command} />
      {validationError && (
        <p role="alert" className="form-error">
          {validationError}
        </p>
      )}
      <p>保存后各方案为待准备。当前不会创建目录、启动模型或产生结果。</p>
      <div className="work-branch-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || stale || !payload}
        >
          保存方案组
        </Button>
        <Button type="button" disabled={command.busy} onClick={close}>
          关闭方案编辑
        </Button>
      </div>
    </form>
  );
}
function BranchHistory({ path }: { path: string }) {
  const read = useAssistanceRead<{ items: WorkBranchEvent[] }>(path + '/history');
  if (read.denied) return <p role="alert">方案历史读取权限已失效，内容已清除。</p>;
  return (
    <>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读方案历史</Button>
        </p>
      )}
      {read.value ? (
        <ol aria-label="方案历史">
          {read.value.items.map((e) => (
            <li key={e.revision}>
              {
                {
                  plan: '定义方案',
                  discard: '放弃方案',
                  workspace_requested: '请求独立现场',
                  workspace_prepared: '报告现场准备',
                  workspace_bound: '登记独立现场',
                  workspace_cancelled: '取消现场准备',
                  run_created: '保存方案执行',
                  run_started: '方案实际启动',
                  result_saved: '保存成果版本',
                  result_selected: '选用成果版本',
                  selection_cleared: '取消或替换选择',
                }[e.action]
              }{' '}
              · {e.actor.name} · {time(e.at)}
            </li>
          ))}
        </ol>
      ) : (
        <p role="status">正在读取方案历史…</p>
      )}
    </>
  );
}
function Discard({ branch, path, saved }: { branch: WorkBranch; path: string; saved(): void }) {
  const command = useAssistanceCommand<WorkBranchView>(saved);
  if (command.denied) return <p role="alert">方案编辑权限已失效。</p>;
  return (
    <>
      <Feedback command={command} />
      {branch.state === 'planned' &&
        !branch.workingCopyId &&
        (!branch.workspace ||
          ['cancelled', 'needs_attention'].includes(branch.workspace.state)) && (
          <Button
            busy={command.busy}
            disabled={!!command.uncertain}
            onClick={() =>
              void command.send(path + '/discard', { expectedRevision: branch.revision })
            }
          >
            放弃此方案
          </Button>
        )}
    </>
  );
}
function Branch({
  task,
  startHash,
  branch,
  path,
  editable,
  saved,
}: {
  task: Task;
  startHash: string;
  branch: WorkBranch;
  path: string;
  editable: boolean;
  saved(): void;
}) {
  const [history, setHistory] = useState(false);
  return (
    <article className="work-branch-card" aria-label={`方案：${branch.name}`}>
      <header>
        <strong>{branch.name}</strong>
        <span className="badge neutral">
          {branch.state === 'discarded'
            ? '已放弃'
            : branch.state === 'selected'
              ? '已选用固定版本'
              : branch.state === 'ready'
                ? '已有固定成果'
                : branch.runId
                  ? '已关联执行'
                  : branch.workingCopyId
                    ? '已登记现场'
                    : '待准备'}
        </span>
      </header>
      <p className="work-branch-text">{branch.goal}</p>
      {branch.state !== 'discarded' && (
        <BranchWorkspace
          task={task}
          branch={branch}
          startHash={startHash}
          path={path}
          editable={editable}
          saved={saved}
        />
      )}
      <div className="work-branch-actions">
        {editable && <Discard branch={branch} path={path} saved={saved} />}
        <Button onClick={() => setHistory((v) => !v)}>
          {history ? '收起方案历史' : '查看方案历史'}
        </Button>
      </div>
      <BranchResult branch={branch} path={path} editable={editable} saved={saved} />
      {history && <BranchHistory path={path} />}
    </article>
  );
}
function Panel({ task }: { task: Task }) {
  const { data } = useApp();
  const path = base(task.id),
    editable = canEditTask(data, task);
  const [creating, setCreating] = useState(false),
    [revoked, setRevoked] = useState(false),
    [cursor, setCursor] = useState<number | null>(null);
  const read = useAssistanceRead<WorkBranchPage>(path + (cursor ? `?cursor=${cursor}` : ''));
  useEffect(() => {
    if (!editable || read.denied) setCreating(false);
  }, [editable, read.denied]);
  if (read.denied) return <p role="alert">方案读取权限已失效，内容与编辑已清除。</p>;
  return (
    <div className="work-branches-panel">
      <p>为同一任务记录不同实现目标，固定共同说明与代码提交。方案定义不会自动开始并行执行。</p>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读方案组</Button>
        </p>
      )}
      {revoked && <p role="alert">编辑权限已失效，临时方案已清除；请核对权限后重新打开窗口。</p>}
      {editable && !creating && (
        <Button
          variant="primary"
          disabled={revoked || !!read.error || !read.value}
          onClick={() => setCreating(true)}
        >
          定义一组方案
        </Button>
      )}
      {editable && creating && (
        <Editor
          path={path}
          close={() => setCreating(false)}
          denied={() => {
            setCreating(false);
            setRevoked(true);
          }}
          saved={() => {
            setCreating(false);
            setCursor(null);
            read.retry();
          }}
        />
      )}
      {read.value ? (
        read.value.items.length ? (
          read.value.items.map((v) => (
            <section className="work-branch-group" key={v.group.id} aria-label="共同起点方案组">
              <header>
                <h3>{v.group.start.taskTitle}</h3>
                <span>
                  {v.group.createdBy.name} · {time(v.group.createdAt)}
                </span>
              </header>
              <Link className="button secondary" to={`/tasks/${task.id}/compare/${v.group.id}`}>
                比较与选择方案
              </Link>
              {v.selection?.branchId && (
                <p>
                  已选用 {v.selection.branchName} · v{v.selection.resultRevision}
                  ，后来保存的版本不会自动替换此选择。
                </p>
              )}
              <details>
                <summary>共同起点与范围</summary>
                <p className="work-branch-text">
                  {v.group.start.taskDescription || '当时没有补充说明。'}
                </p>
                <p>
                  {v.group.start.checkpoint.request.label} · 任务修订 {v.group.start.taskRevision}
                </p>
                <code>{v.group.start.checkpoint.manifest.commit}</code>
                <p>单提交引用，未包含未提交内容。尚未核验各方案的实际代码目录。</p>
                <p>
                  共同起点指纹 <code>{v.group.startHash}</code>
                </p>
              </details>
              {v.taskChanged && (
                <p className="work-branch-notice">任务已有新版本，这组方案仍保留原共同起点。</p>
              )}
              {v.branches.map((b) => (
                <Branch
                  key={b.id}
                  task={task}
                  startHash={v.group.startHash}
                  branch={b}
                  path={`${path}/${b.id}`}
                  editable={editable}
                  saved={read.retry}
                />
              ))}
            </section>
          ))
        ) : (
          <p>尚未定义方案组。可以先记录代码检查点，再描述不同实现目标。</p>
        )
      ) : (
        <p role="status">正在读取方案组…</p>
      )}
      <div className="work-branch-actions">
        {cursor && <Button onClick={() => setCursor(null)}>最新方案组</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>更早方案组</Button>
        )}
      </div>
    </div>
  );
}
function Entry({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>方案分支</Button>
      {open && (
        <Dialog title="任务方案分支" drawer onClose={() => setOpen(false)}>
          <Panel task={task} />
        </Dialog>
      )}
    </>
  );
}
export function TaskWorkBranches({ task }: { task: Task }) {
  const { data } = useApp();
  if (data.mode !== 'team-local' || !task.projectId || task.visibility !== 'project') return null;
  return <Entry key={`${data.user.id}:${data.space?.id}:${task.id}`} task={task} />;
}
