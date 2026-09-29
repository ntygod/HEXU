import { useEffect, useState } from 'react';
import type { HandoffView } from '../../../packages/contracts/src/handoffs.js';
import type { Task } from '../../../packages/contracts/src/index.js';
import type {
  HandoffAcceptance,
  HandoffAcceptancePreview,
} from '../../../packages/contracts/src/handoff-acceptance.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { HandoffWorkspace } from './handoff-workspace.js';

function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="handoff-notice" aria-label="接手确认回执待确认">
          <p>
            请求结果未确认。这里只对账原邀请、任务版本、职责选择与操作标识，关闭不会撤回已提交确认。
          </p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次接手请求
          </Button>
        </section>
      )}
    </>
  );
}
function AcceptanceForm({
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
  const read = useAssistanceRead<HandoffAcceptancePreview>(path + '/acceptance-preview', 2000);
  const [baseline, setBaseline] = useState<HandoffAcceptancePreview | null>(null);
  const [transferOwner, setTransferOwner] = useState(false);
  const command = useAssistanceCommand<HandoffAcceptance>(saved);
  useEffect(() => {
    if (!baseline && read.value) setBaseline(structuredClone(read.value));
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied || command.denied) denied();
  }, [read.denied, command.denied, denied]);
  if (read.denied || command.denied) return null;
  const stale =
    !!baseline &&
    !!read.value &&
    (baseline.contextHash !== read.value.contextHash ||
      baseline.taskRevision !== read.value.taskRevision ||
      baseline.handoffRevision !== read.value.handoffRevision);
  const locked = command.busy || !!command.uncertain || !!read.error || !baseline;
  return (
    <form
      className="handoff-editor"
      aria-label="接受接手确认"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && baseline)
          void command.send(path + '/accept', {
            expectedHandoffRevision: baseline.handoffRevision,
            expectedTaskRevision: baseline.taskRevision,
            contextHash: baseline.contextHash,
            transferOwner,
          });
      }}
    >
      <h3>核对本次接手</h3>
      {baseline ? (
        <>
          <p>
            当前任务：{baseline.taskTitle} · 修订 {baseline.taskRevision}
          </p>
          <div className="handoff-text">{baseline.taskDescription || '当前任务没有补充说明。'}</div>
          <p>
            先保存十分钟内有效的确认，再到本人节点核验原恢复目录。核验和提交成功后你成为当前操作者；不会自动开始模型执行。
          </p>
          {baseline.transferOwnerRequested ? (
            <label className="checkpoint-consent">
              <input
                type="checkbox"
                checked={transferOwner}
                disabled={locked}
                onChange={(e) => setTransferOwner(e.target.checked)}
              />
              我同时接受负责人职责；未勾选时保留当前负责人
            </label>
          ) : (
            <p>本次邀请不移交负责人职责。</p>
          )}
        </>
      ) : (
        <p role="status">正在读取当前任务与邀请…</p>
      )}
      {read.error && (
        <p role="alert">
          {read.error}
          <Button type="button" onClick={read.retry}>
            重读接手条件
          </Button>
        </p>
      )}
      {stale && (
        <section className="handoff-notice" aria-label="接手确认内容变化">
          <p>
            任务说明、讨论或邀请版本已有变化。原选择保留，请核对「{read.value?.taskTitle}
            」及最新讨论。
          </p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setBaseline(structuredClone(read.value));
              setTransferOwner(false);
            }}
          >
            已核对最新接手内容
          </Button>
        </section>
      )}
      <Feedback command={command} />
      <div className="handoff-actions">
        <Button type="submit" variant="primary" busy={command.busy} disabled={locked || stale}>
          开始本机确认
        </Button>
        <Button type="button" disabled={command.busy} onClick={close}>
          关闭确认编辑
        </Button>
      </div>
    </form>
  );
}
function Operation({
  op,
  task,
  path,
  editable,
  reload,
}: {
  op: HandoffAcceptance;
  task: Task;
  path: string;
  editable: boolean;
  reload(): void;
}) {
  const { data } = useApp();
  const command = useAssistanceCommand<HandoffAcceptance>(reload);
  const labels = {
    waiting_local: '等待接收节点本机确认',
    needs_attention: '接手确认需要重新核对',
    succeeded: '接手已提交',
    cancelled: '接手确认已取消',
  };
  return (
    <article className="handoff-material" aria-label="接手确认记录">
      <strong>{labels[op.state]}</strong>
      <p>
        任务修订 {op.ticket.taskRevision} ·{' '}
        {op.ticket.transferOwner ? '同时接受负责人职责' : '保留原负责人'}
      </p>
      {op.reason && <p>{op.reason}</p>}
      {op.state === 'waiting_local' && (
        <>
          <p>
            有效至 {time(op.ticket.expiresAt)}
            。需使用本机已经恢复的原目录，网页不接收路径；存在旧写入或文件变化时不会接受。
          </p>
          {editable && data.user.id === op.ticket.recipientId && (
            <pre aria-label="本机接手确认命令">{`npm run runner:handoff-accept -- --operation ${op.ticket.id} --state /path/to/receiver-state --target /path/to/restored-directory`}</pre>
          )}
        </>
      )}
      {op.state === 'succeeded' && (
        <p>
          提交时间 {time(op.acceptedAt!)}；本机核验 {op.proof?.files} 个文件、
          {op.proof?.bytes.toLocaleString()} 字节。接手没有启动
          Run，后续文件变化和实际执行独立记录。
        </p>
      )}
      {op.state === 'succeeded' &&
        editable &&
        data.user.id === op.ticket.recipientId &&
        task.operatorUserId === data.user.id && (
          <HandoffWorkspace key={`${data.user.id}:${data.space?.id}`} task={task} op={op} />
        )}
      {editable && <Feedback command={command} />}
      {editable && !command.denied && ['waiting_local', 'needs_attention'].includes(op.state) && (
        <Button
          busy={command.busy}
          disabled={!!command.uncertain}
          onClick={() =>
            void command.send(`${path}/acceptances/${op.ticket.id}/cancel`, {
              expectedRevision: op.revision,
            })
          }
        >
          取消这次接手确认
        </Button>
      )}
    </article>
  );
}
export function HandoffAcceptancePanel({
  task,
  view,
  path,
  editable,
}: {
  task: Task;
  view: HandoffView;
  path: string;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false),
    [revoked, setRevoked] = useState(false);
  const read = useAssistanceRead<{ items: HandoffAcceptance[] }>(
    open ? path + '/acceptances' : null,
    2000,
  );
  useEffect(() => {
    if (!editable || read.denied) setCreating(false);
  }, [editable, read.denied]);
  useEffect(() => {
    if (view.handoff.state !== 'offered') setCreating(false);
  }, [view.handoff.state]);
  const pending = read.value?.items.some((op) => op.state === 'waiting_local');
  return (
    <section className="handoff-panel-status" aria-label="接手处理">
      <Button
        onClick={() => {
          setOpen((v) => !v);
          setCreating(false);
        }}
      >
        {open ? '收起接手处理' : view.canAccept ? '接受接手' : '查看接手处理'}
      </Button>
      {open &&
        (read.denied ? (
          <p role="alert">接手处理读取权限已失效，内容已清除。</p>
        ) : (
          <>
            {read.error && (
              <p role="alert">
                {read.error}
                <Button onClick={read.retry}>重读接手处理</Button>
              </p>
            )}
            {revoked && (
              <p role="alert">接手编辑权限已失效，未保存选择已清除；请恢复权限后重新打开窗口。</p>
            )}
            {view.canAccept && editable && !creating && !pending && (
              <Button
                variant="primary"
                disabled={revoked || !!read.error || !read.value}
                onClick={() => setCreating(true)}
              >
                核对并接受
              </Button>
            )}
            {creating && editable && (
              <AcceptanceForm
                path={path}
                close={() => setCreating(false)}
                denied={() => {
                  setCreating(false);
                  setRevoked(true);
                }}
                saved={() => {
                  setCreating(false);
                  read.retry();
                }}
              />
            )}
            {read.value?.items.map((op) => (
              <Operation
                key={`${op.ticket.id}:${editable}`}
                task={task}
                op={op}
                path={path}
                editable={editable}
                reload={read.retry}
              />
            ))}
            {!read.value && <p role="status">正在读取接手处理…</p>}
            {read.value && !read.value.items.length && (
              <p>尚未发起本机确认。历史恢复报告不能直接切换任务操作者。</p>
            )}
          </>
        ))}
    </section>
  );
}
