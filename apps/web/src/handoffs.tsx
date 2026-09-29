import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  HandoffList,
  HandoffOptions,
  HandoffView,
  HandoffState,
  HandoffMaterial,
  HandoffEvent,
} from '../../../packages/contracts/src/handoffs.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import './handoffs.css';

const base = (id: string) => `/tasks/${encodeURIComponent(id)}/handoffs`;
const labels: Record<HandoffState, string> = {
  offered: '待接手邀请',
  rejected: '已拒绝',
  withdrawn: '已撤回',
  expired: '已到期',
};
function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="handoff-notice" aria-label="接手邀请回执待确认">
          <p>
            回复未确认。确认会使用原材料、内容、版本与操作标识；关闭窗口不会撤回已经发出的请求。
          </p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次邀请操作
          </Button>
        </section>
      )}
    </>
  );
}
function Material({ value }: { value: HandoffMaterial }) {
  return (
    <section className="handoff-material" aria-label="固定接手材料">
      <strong>
        {value.recipient.name} · {value.targetNodeName}
      </strong>
      <code>{value.commit}</code>
      <p>
        {value.coverage.files} 个文件对象 · {value.coverage.bytes.toLocaleString()} 字节；材料有效至{' '}
        {time(value.expiresAt)}
      </p>
      <p>
        接收回执：{time(value.receivedAt)}
        。这是独立对象副本的最后核验记录，文件是否已恢复需另行查看。
      </p>
      <details>
        <summary>材料范围</summary>
        <p>
          不含祖先历史、未提交内容；LFS 指针 {value.coverage.lfsPointers}、子模块引用{' '}
          {value.coverage.gitlinks}、符号链接 {value.coverage.symlinks} 不能当作完整外部文件。
        </p>
        <p>
          传输标识 <code>{value.transferId}</code>
        </p>
        <p>
          快照指纹 <code>{value.snapshotHash}</code>
        </p>
      </details>
    </section>
  );
}
function Editor({
  task,
  blocked,
  saved,
  close,
  onDenied,
}: {
  task: Task;
  blocked: boolean;
  saved(): void;
  close(): void;
  onDenied(): void;
}) {
  const read = useAssistanceRead<HandoffOptions>(base(task.id) + '/options', 3000);
  const [material, setMaterial] = useState<HandoffMaterial | null>(null);
  const [revision, setRevision] = useState(task.revision);
  const [baselineTitle, setBaselineTitle] = useState(task.title);
  const [summary, setSummary] = useState(task.title);
  const [remainingWork, setRemainingWork] = useState('');
  const [environment, setEnvironment] = useState('');
  const [hours, setHours] = useState(24);
  const command = useAssistanceCommand<HandoffView>(saved);
  const denied = read.denied || command.denied;
  useEffect(() => {
    if (denied) onDenied();
  }, [denied, onDenied]);
  if (denied) return null;
  const stale = revision !== task.revision;
  const available =
    material &&
    read.value?.materials.some(
      (m) => m.transferId === material.transferId && m.transferHash === material.transferHash,
    );
  const locked = blocked || command.busy || !!command.uncertain || !!read.error || !read.value;
  return (
    <form
      className="handoff-editor"
      aria-label="发布接手邀请"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && available && summary.trim())
          void command.send(base(task.id), {
            transferId: material!.transferId,
            transferHash: material!.transferHash,
            expectedTaskRevision: revision,
            summary,
            remainingWork,
            environment,
            hours,
          });
      }}
    >
      <h3>准备接手说明</h3>
      <fieldset disabled={locked}>
        <label className="field">
          接收者与已接收副本
          <select
            value={material?.transferId ?? ''}
            onChange={(e) => {
              const selected = read.value?.materials.find((m) => m.transferId === e.target.value);
              setMaterial(selected ? structuredClone(selected) : null);
            }}
          >
            <option value="">选择已确认接收的副本</option>
            {read.value?.materials.map((m) => (
              <option key={m.transferId} value={m.transferId}>
                {m.recipient.name} · {m.targetNodeName} · {m.commit.slice(0, 12)} ·{' '}
                {m.transferId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {read.value && !read.value.materials.length && (
          <p>
            尚无可邀请的接收者。先在代码检查点中，将固定副本明确传给同项目另一位成员的节点，并由对方确认接收。
          </p>
        )}
        {material && <Material value={material} />}
        {material && !available && (
          <p role="alert">所选材料当前不可用于新邀请，请重新核对来源与权限。</p>
        )}
        <label className="field">
          工作摘要
          <textarea
            rows={3}
            maxLength={4000}
            required
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="field">
          剩余工作
          <textarea
            rows={3}
            maxLength={4000}
            value={remainingWork}
            onChange={(e) => setRemainingWork(e.target.value)}
          />
        </label>
        <label className="field">
          环境说明
          <textarea
            rows={2}
            maxLength={2000}
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            placeholder="仅写必要环境和缺失项，不填写密钥"
          />
        </label>
        <label className="field">
          邀请有效期
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={1}>1 小时</option>
            <option value={24}>24 小时</option>
            <option value={72}>72 小时</option>
          </select>
        </label>
        <p>
          有效期不超过原材料期限。发布说明供项目成员查看，接收者由固定副本确定；不转移负责人、目录权限或模型账号。
        </p>
      </fieldset>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button type="button" onClick={read.retry}>
            重读接手材料
          </Button>
        </p>
      )}
      {stale && (
        <section className="handoff-notice" aria-label="邀请任务版本变化">
          <p>
            编辑期间任务从「{baselineTitle}」变为「{task.title}」（修订 {revision} → {task.revision}
            ）。当前文字和材料选择已保留。
          </p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setRevision(task.revision);
              setBaselineTitle(task.title);
            }}
          >
            已核对当前任务与邀请内容
          </Button>
        </section>
      )}
      <Feedback command={command} />
      <div className="handoff-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || stale || !available || !summary.trim()}
        >
          发布邀请
        </Button>
        <Button type="button" disabled={command.busy} onClick={close}>
          取消编辑
        </Button>
      </div>
    </form>
  );
}
function History({ path }: { path: string }) {
  const read = useAssistanceRead<{ items: HandoffEvent[] }>(path + '/history', 0);
  const action = {
    offer: '发布邀请',
    reject: '拒绝邀请',
    withdraw: '撤回邀请',
    expire: '邀请到期',
  };
  if (read.denied) return <p role="alert">流转记录读取权限已失效。</p>;
  return (
    <section aria-label="邀请流转记录">
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读邀请记录</Button>
        </p>
      )}
      {!read.value ? (
        <p role="status">正在读取流转记录…</p>
      ) : (
        <ol>
          {read.value.items.map((e) => (
            <li key={e.revision}>
              {action[e.action]} · {e.actor?.name ?? '系统'} · {time(e.at)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function Card({
  view,
  path,
  editable,
  reload,
}: {
  view: HandoffView;
  path: string;
  editable: boolean;
  reload(): void;
}) {
  const h = view.handoff;
  const [history, setHistory] = useState(false);
  const command = useAssistanceCommand<HandoffView>(reload);
  return (
    <article className="handoff-card" aria-label="接手邀请记录">
      <header>
        <strong>{labels[h.state]}</strong>
        <span>
          {h.sender.name} → {h.material.recipient.name}
        </span>
      </header>
      <p>
        发布时任务：{h.taskTitle} · 修订 {h.taskRevision}
      </p>
      <div className="handoff-text">{h.summary}</div>
      {h.remainingWork && (
        <section>
          <h4>剩余工作</h4>
          <div className="handoff-text">{h.remainingWork}</div>
        </section>
      )}
      {h.environment && (
        <section>
          <h4>环境说明</h4>
          <div className="handoff-text">{h.environment}</div>
        </section>
      )}
      <Material value={h.material} />
      <p>邀请有效至 {time(h.expiresAt)}</p>
      {view.taskChanged && (
        <p className="handoff-notice">
          任务已有新版本；这里仍保留发布时的工作说明，没有自动同步后续变化。
        </p>
      )}
      {!view.materialAvailable && (
        <p className="handoff-notice">
          原材料已到期或当前授权不可用。历史说明保留，不授予新的材料访问。
        </p>
      )}
      {h.state === 'offered' && (
        <p>邀请已发布。接受接手与操作者切换尚未开放，现有恢复记录不代表已经接管任务。</p>
      )}
      {editable && !command.denied && (
        <>
          <Feedback command={command} />
          <div className="handoff-actions">
            {view.canReject && (
              <Button
                busy={command.busy}
                disabled={!!command.uncertain}
                onClick={() =>
                  void command.send(path + '/reject', { expectedRevision: h.revision })
                }
              >
                拒绝邀请
              </Button>
            )}
            {view.canWithdraw && (
              <Button
                busy={command.busy}
                disabled={!!command.uncertain}
                onClick={() =>
                  void command.send(path + '/withdraw', { expectedRevision: h.revision })
                }
              >
                撤回邀请
              </Button>
            )}
          </div>
        </>
      )}
      <Button onClick={() => setHistory((v) => !v)}>
        {history ? '收起流转记录' : '查看流转记录'}
      </Button>
      {history && <History path={path} />}
    </article>
  );
}
function Panel({ task }: { task: Task }) {
  const { data } = useApp();
  const [creating, setCreating] = useState(false);
  const [editorRevoked, setEditorRevoked] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const path = base(task.id);
  const read = useAssistanceRead<HandoffList>(path + (cursor ? `?cursor=${cursor}` : ''), 3000);
  const editable = canEditTask(data, task);
  useEffect(() => {
    if (!editable || read.denied) setCreating(false);
  }, [editable, read.denied]);
  if (read.denied) return <p role="alert">接手邀请读取权限已失效，内容与编辑已清除。</p>;
  return (
    <div className="handoff-panel">
      <p>
        将固定工作说明和代码副本交给同项目的指定成员；邀请本身不会启动模型、停止旧工作或改变任务负责人。
      </p>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读接手邀请</Button>
        </p>
      )}
      {editorRevoked && (
        <p role="alert">邀请编辑权限已失效，未保存内容已清除；恢复权限后请重新打开邀请窗口。</p>
      )}
      {editable && !creating && (
        <Button
          variant="primary"
          disabled={!!read.error || !read.value || editorRevoked}
          onClick={() => setCreating(true)}
        >
          准备接手邀请
        </Button>
      )}
      {creating && editable && (
        <Editor
          task={task}
          blocked={!!read.error}
          close={() => setCreating(false)}
          onDenied={() => {
            setCreating(false);
            setEditorRevoked(true);
          }}
          saved={() => {
            setCreating(false);
            setCursor(null);
            read.retry();
          }}
        />
      )}
      {!read.value ? (
        <p role="status">正在读取接手邀请…</p>
      ) : !read.value.items.length ? (
        <p>尚未发布接手邀请。普通代码传输与任务改派不会自动创建邀请。</p>
      ) : (
        read.value.items.map((v) => (
          <Card
            key={`${v.handoff.id}:${editable}`}
            view={v}
            path={`${path}/${v.handoff.id}`}
            editable={editable}
            reload={read.retry}
          />
        ))
      )}
      <div className="handoff-actions">
        {cursor && <Button onClick={() => setCursor(null)}>最新邀请</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>更早邀请</Button>
        )}
      </div>
    </div>
  );
}
function Entry({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>接手邀请</Button>
      {open && (
        <Dialog title="任务接手邀请" drawer onClose={() => setOpen(false)}>
          <Panel task={task} />
        </Dialog>
      )}
    </>
  );
}
export function TaskHandoffs({ task }: { task: Task }) {
  const { data } = useApp();
  if (data.mode !== 'team-local' || task.visibility !== 'project') return null;
  return <Entry key={`${data.user.id}:${data.space?.id}:${task.id}`} task={task} />;
}
