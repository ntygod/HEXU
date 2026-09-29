import { CheckpointRestoreResults } from './checkpoint-restore-results.js';
import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { RetentionView } from '../../../packages/contracts/src/checkpoint-retention.js';
import type {
  TransferView,
  TransferNode,
  TransferState,
} from '../../../packages/contracts/src/checkpoint-transfer.js';
import { Button } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp } from './state.js';
import { useAssistanceRead, useAssistanceCommand } from './assistance-common.js';
import './checkpoint-transfers.css';
const labels: Record<TransferState, string> = {
  offered: '等待接收端本机同意',
  accepted: '接收端已同意，等待源节点发送',
  uploading: '密文上传中，尚不可接收',
  available: '密文已就绪，等待接收端核验',
  received: '接收端已核验独立副本（最后报告）',
  cancelled: '传输已取消',
  expired: '传输已到期',
  invalidated: '传输授权或来源已失效',
};
const active = (state: TransferState) =>
  !['received', 'cancelled', 'expired', 'invalidated'].includes(state);
const cli = (mode: string, id: string) =>
  `npm run runner:transfer -- ${mode} --transfer ${id} --state /path/to/private-state`;
function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="checkpoint-notice">
          <strong>传输操作回执未确认</strong>
          <p>只确认原来源、接收节点和请求，不重新发送对象；关闭页面不会撤销已提交请求。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次传输操作
          </Button>
        </section>
      )}
    </>
  );
}
function Editor({
  path,
  task,
  blocked,
  onSaved,
  onClose,
}: {
  path: string;
  task: Task;
  blocked: boolean;
  onSaved(): void;
  onClose(): void;
}) {
  const options = useAssistanceRead<{ items: TransferNode[] }>(path + '/options', 3000);
  const [target, setTarget] = useState(''),
    [consent, setConsent] = useState(false),
    [revision, setRevision] = useState(task.revision);
  const command = useAssistanceCommand<TransferView>(onSaved);
  const stale = task.revision !== revision,
    locked = command.busy || !!command.uncertain || blocked || !!options.error || !options.value;
  const valid = !!options.value?.items.some((n) => n.id === target);
  if (options.denied || command.denied) return <p role="alert">传输编辑权限已失效，内容已清除。</p>;
  return (
    <form
      className="checkpoint-editor"
      aria-label="创建对象传输"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && consent && valid)
          void command.send(path, {
            targetNodeId: target,
            expectedTaskRevision: revision,
            confirmTransfer: true,
          });
      }}
    >
      <h3>选择接收节点</h3>
      <fieldset disabled={locked}>
        <label className="field">
          接收节点
          <select
            aria-label="接收节点"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setConsent(false);
            }}
          >
            <option value="">选择同项目的节点</option>
            {options.value?.items.map((n) => (
              <option key={n.id} value={n.id}>
                {n.ownerName} · {n.name} · {n.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {options.value && !options.value.items.length && (
          <p>没有符合条件的接收节点。双方需在同一项目有编辑权限，并使用各自已配对的 Linux 节点。</p>
        )}
        <label className="checkpoint-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          我确认将此份固定提交对象传给所选节点，可能包含已提交的敏感内容；收发双方仍需分别在本机同意。
        </label>
      </fieldset>
      {options.error && (
        <p role="alert">
          {options.error}
          <Button type="button" onClick={options.retry}>
            重读接收节点
          </Button>
        </p>
      )}
      {stale && (
        <div className="checkpoint-notice">
          <p>任务已变化，选择保留；请先核对当前任务。</p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setRevision(task.revision);
              setConsent(false);
            }}
          >
            已核对传输任务
          </Button>
        </div>
      )}
      <Feedback command={command} />
      <div className="checkpoint-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || stale || !consent || !valid}
        >
          创建传输请求
        </Button>
        <Button type="button" disabled={command.busy} onClick={onClose}>
          关闭传输编辑
        </Button>
      </div>
    </form>
  );
}
function TransferCard({
  view,
  path,
  task,
  reload,
}: {
  view: TransferView;
  path: string;
  task: Task;
  reload(): void;
}) {
  const { data } = useApp(),
    t = view.ticket;
  const sender = data.user.id === t.source.ownerId,
    recipient = data.user.id === t.target.ownerId;
  const editable = canEditTask(data, task) && (sender || recipient);
  const command = useAssistanceCommand<TransferView>(reload);
  return (
    <article className="transfer-card" aria-label="对象传输记录">
      <header>
        <strong>{labels[view.state]}</strong>
        <span>
          {t.manifest.coverage.objects} 个对象 · {t.manifest.coverage.bytes.toLocaleString()} 字节
        </span>
      </header>
      <p>
        {t.sourceName} → {t.target.ownerName} / {t.target.name}
      </p>
      <p>
        提交 <code>{t.manifest.commit}</code>
      </p>
      <p>
        传输截止：{time(t.expiresAt)}；接收副本原期限：{time(t.manifest.expiresAt)}
        。到期停止新的传输，不自动删除已经收到的本机字节。
      </p>
      {view.envelope && (
        <p>
          已确认上传 {view.uploadedChunks} / {view.envelope.chunks}{' '}
          个密文块；完整上传不等于接收核验。
        </p>
      )}
      {view.receivedAt && (
        <p>
          服务收到核验回执：{time(view.receivedAt)}。仅为最后报告，不保证对象现在仍存在或未被修改。
        </p>
      )}
      {!view.authorized && (
        <p className="form-error">原节点权限已失效，历史不能授予新的材料读取。</p>
      )}
      <details>
        <summary>固定来源与传输边界</summary>
        <p>
          传输 <code>{t.id}</code>
        </p>
        <p>
          接收节点 <code>{t.target.id}</code>
        </p>
        <p>
          快照指纹 <code>{t.manifest.snapshotHash}</code>
        </p>
        <p>
          LFS 仅指针 {t.manifest.coverage.lfsPointers} · 子模块仅引用 {t.manifest.coverage.gitlinks}{' '}
          · 未展开符号链接 {t.manifest.coverage.symlinks}。没有祖先历史和未提交内容。
        </p>
        <p>独立接收对象不会创建工作目录，不是接手、负责人转移或模型执行授权。</p>
      </details>
      {editable && view.authorized && active(view.state) && (
        <details>
          <summary>本机收发操作</summary>
          {recipient && (
            <>
              <p>接收节点本人先明确输入 RECEIVE，再由源节点发送；密文就绪后执行 receive。</p>
              <pre aria-label="接收同意命令">{cli('accept', t.id)}</pre>
              <pre aria-label="接收对象命令">{cli('receive', t.id)}</pre>
            </>
          )}
          {sender && (
            <>
              <p>原节点本人明确输入 SEND 后发送固定对象。网络故障时复用相同命令，只对账原密文。</p>
              <pre aria-label="发送对象命令">{cli('send', t.id)}</pre>
            </>
          )}
        </details>
      )}
      {editable && (
        <details>
          <summary>本机状态与明确清理</summary>
          <pre>{cli('status', t.id)}</pre>
          <pre>{cli('forget', t.id)}</pre>
          <p>
            FORGET
            只删除当前节点的本次材料，不撤回对方副本或删除源仓库；网页取消只关闭尚未完成的传输。
          </p>
        </details>
      )}
      {view.state === 'received' && (
        <section className="receiver-restore" aria-label="接收副本恢复">
          <p>
            收到对象不等于文件已恢复。接收节点需以自己的原身份重新预检并确认写入与发布，不继承发送者目录权限。
          </p>
          {recipient &&
            editable &&
            view.authorized &&
            t.manifest.expiresAt > new Date().toISOString() && (
              <details>
                <summary>在接收节点恢复到新目录</summary>
                <p>
                  以下路径仅在接收节点本机指定；每次分别输入 PLAN、RESTORE 和
                  PUBLISH。不会使用发送者凭证，也不自动启动模型。
                </p>
                <pre aria-label="接收副本预检命令">{`npm run runner:restore-plan -- --transfer ${t.id} --state /path/to/receiver-state --target /existing/parent/new-directory`}</pre>
                <pre aria-label="接收副本恢复命令">{`npm run runner:restore -- --transfer ${t.id} --state /path/to/receiver-state --target /existing/parent/new-directory`}</pre>
              </details>
            )}
          <CheckpointRestoreResults
            retentionPath={`${path}/${encodeURIComponent(t.id)}`}
            editable={recipient && editable && view.authorized}
            sourceKind="transfer"
          />
        </section>
      )}
      <Feedback command={command} />
      {editable && active(view.state) && !command.denied && (
        <Button
          busy={command.busy}
          disabled={!!command.uncertain}
          onClick={() => void command.send(`${path}/${t.id}/cancel`, {})}
        >
          取消对象传输
        </Button>
      )}
    </article>
  );
}
function Panel({ path, task, retention }: { path: string; task: Task; retention: RetentionView }) {
  const { data } = useApp();
  const read = useAssistanceRead<{ items: TransferView[] }>(path, 3000);
  const editable =
    canEditTask(data, task) &&
    retention.request.ownerId === data.user.id &&
    retention.nodeAuthorized;
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!editable) setCreating(false);
  }, [editable]);
  if (read.denied) return <p role="alert">对象传输读取权限已失效，内容已清除。</p>;
  return (
    <section className="checkpoint-transfers" aria-label="受控对象传输">
      <div className="checkpoint-notice">
        <strong>只传固定对象，不接管工作现场</strong>
        <p>
          首版为同一控制服务、同项目、同机回环的两个 Linux 节点。最多 16 MiB / 2048
          个对象；服务只暂存密文，接收端独立核验后才报告收到。
        </p>
        <p>
          可能包含已提交的敏感内容。已确认接收的副本可由接收节点另行恢复；不修改原节点绑定或复制发送者账号。
        </p>
      </div>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读对象传输</Button>
        </p>
      )}
      {editable && retention.state === 'retained' && !creating && (
        <Button disabled={!!read.error || !read.value} onClick={() => setCreating(true)}>
          向另一节点传输
        </Button>
      )}
      {creating && editable && (
        <Editor
          path={path}
          task={task}
          blocked={!!read.error || retention.state !== 'retained'}
          onSaved={() => {
            setCreating(false);
            read.retry();
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {!read.value ? (
        <p role="status">正在读取对象传输…</p>
      ) : !read.value.items.length ? (
        <p>尚无明确创建的对象传输。节点配对不代表同意发送代码。</p>
      ) : (
        read.value.items.map((v) => (
          <TransferCard key={v.ticket.id} view={v} path={path} task={task} reload={read.retry} />
        ))
      )}
    </section>
  );
}
export function CheckpointTransfers({
  retentionPath,
  task,
  retention,
}: {
  retentionPath: string;
  task: Task;
  retention: RetentionView;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen((v) => !v)}>{open ? '收起对象传输' : '查看对象传输'}</Button>
      {open && <Panel path={retentionPath + '/transfers'} task={task} retention={retention} />}
    </>
  );
}
