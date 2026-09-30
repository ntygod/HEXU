import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { RetentionView } from '../../../packages/contracts/src/checkpoint-retention.js';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type { BranchWorkspaceOperation } from '../../../packages/contracts/src/work-branch-workspaces.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { WorkspacePairing } from './handoff-workspace.js';
import { NodeRunPanel, NodeRunStatus } from './node-execution.js';

function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && <p role="alert">{command.error}</p>}
      {command.uncertain && (
        <div className="work-branch-notice" aria-label="现场请求待确认">
          <p>请求结果未确认，使用原方案、材料和请求标识对账；关闭不会取消已提交请求。</p>
          <Button busy={command.busy} onClick={() => void command.confirm()}>
            确认上次现场请求
          </Button>
        </div>
      )}
    </>
  );
}
type Options = { branchRevision: number; startHash: string; items: RetentionView[] };
function Actions({
  task,
  branch,
  startHash,
  path,
  saved,
}: {
  task: Task;
  branch: WorkBranch;
  startHash: string;
  path: string;
  saved(): void;
}) {
  const { data } = useApp();
  const [choosing, setChoosing] = useState(false),
    [baseline, setBaseline] = useState<Options | null>(null),
    [source, setSource] = useState('');
  const [run, setRun] = useState<NonNullable<Parameters<typeof NodeRunPanel>[0]['branch']> | null>(
    null,
  );
  const options = useAssistanceRead<Options>(choosing ? path + '/workspace-options' : null);
  const create = useAssistanceCommand<BranchWorkspaceOperation>(() => {
    setChoosing(false);
    setBaseline(null);
    setSource('');
    saved();
  });
  const cancel = useAssistanceCommand<BranchWorkspaceOperation>(saved);
  const stop = useAssistanceCommand(saved);
  useEffect(() => {
    if (choosing && !baseline && options.value) setBaseline(structuredClone(options.value));
  }, [choosing, baseline, options.value]);
  useEffect(() => {
    if (options.denied || create.denied) {
      setChoosing(false);
      setBaseline(null);
      setSource('');
    }
  }, [options.denied, create.denied]);
  const op = branch.workspace,
    mine = op?.ticket.ownerId === data.user.id;
  const canPrepare =
    branch.state === 'planned' &&
    !branch.runId &&
    (!op || ['cancelled', 'needs_attention'].includes(op.state));
  const chosen = baseline?.items.find((s) => s.request.id === source);
  const locked = create.busy || !!create.uncertain || !!options.error;
  const stale = baseline && baseline.branchRevision !== branch.revision;
  return (
    <div className="work-branch-workspace-actions">
      <Feedback command={create} />
      <Feedback command={cancel} />
      <Feedback command={stop} />
      {canPrepare && !choosing && (
        <Button
          disabled={create.denied || options.denied || !!create.uncertain}
          onClick={() => setChoosing(true)}
        >
          准备独立现场
        </Button>
      )}
      {choosing && (
        <form
          aria-label="独立现场来源选择"
          className="work-branch-editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen?.manifest && baseline && !stale && !locked && canPrepare)
              void create.send(path + '/workspaces', {
                expectedRevision: baseline.branchRevision,
                retentionId: chosen.request.id,
                snapshotHash: chosen.manifest.snapshotHash,
              });
          }}
        >
          <p>选择原本人节点已保留的共同提交副本；目录路径只在本机填写。</p>
          <label className="field">
            原对象副本
            <select
              aria-label="原对象副本"
              required
              value={source}
              disabled={locked}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">选择共同提交的可用副本</option>
              {baseline?.items.map((s) => (
                <option key={s.request.id} value={s.request.id}>
                  {s.request.id.slice(0, 8)} · {s.manifest?.coverage.files} 文件 · 有效至{' '}
                  {time(s.manifest!.expiresAt)}
                </option>
              ))}
            </select>
          </label>
          {baseline && !baseline.items.length && (
            <p>
              此共同提交没有本人可用的对象副本。请先在「代码检查点」请求保留，并到原节点明确核验。
            </p>
          )}
          {options.error && (
            <p role="alert">
              {options.error}
              <Button type="button" onClick={options.retry}>
                重读现场来源
              </Button>
            </p>
          )}
          {stale && (
            <p role="alert">方案已有新版本，原选择保留。请关闭来源选择后核对当前现场记录。</p>
          )}
          <Button
            type="submit"
            variant="primary"
            busy={create.busy}
            disabled={locked || !!stale || !chosen || !canPrepare}
          >
            创建现场准备请求
          </Button>
          <Button
            type="button"
            disabled={create.busy}
            onClick={() => {
              setChoosing(false);
              setBaseline(null);
              setSource('');
            }}
          >
            关闭来源选择
          </Button>
        </form>
      )}
      {op && mine && ['waiting_local', 'prepared'].includes(op.state) && (
        <details open={op.state === 'waiting_local'}>
          <summary>本机现场操作</summary>
          <p>
            请求有效至 {time(op.ticket.expiresAt)}
            。每个方案使用新的独立目录，逐次核对恢复、发布和Git准备。
          </p>
          <pre aria-label="方案现场准备命令">{`npm run runner:branch-workspace -- --operation ${op.ticket.id} --state /path/to/source-state --target /path/to/new-branch-directory`}</pre>
          <pre aria-label="方案现场状态命令">{`npm run runner:branch-workspace-status -- --operation ${op.ticket.id} --state /path/to/source-state`}</pre>
          <p>
            失败或中断时保留现场；先取消网页请求，再使用本机 branch-workspace-cleanup
            处置本次归属材料。已发布目录保留。
          </p>
          {op.state === 'prepared' && (
            <>
              <WorkspacePairing projectId={task.projectId!} purpose="方案现场" />
              <p>使用准备成功后给出的 connect 命令配对，再在新节点执行：</p>
              <pre aria-label="方案现场登记命令">
                npm run runner:branch-bind -- --state /path/to/new-node-state
              </pre>
              <p>登记后单独 enable-execution 并 start，使用自己的工具与账户。</p>
            </>
          )}
        </details>
      )}
      {op &&
        ['waiting_local', 'prepared', 'needs_attention'].includes(op.state) &&
        !cancel.denied && (
          <Button
            busy={cancel.busy}
            disabled={!!cancel.uncertain}
            onClick={() =>
              void cancel.send(`${path}/workspaces/${op.ticket.id}/cancel`, {
                expectedRevision: op.revision,
              })
            }
          >
            取消此现场准备
          </Button>
        )}
      {op?.state === 'bound' && mine && !branch.runId && branch.state !== 'discarded' && (
        <Button
          variant="primary"
          onClick={() =>
            setRun({
              selection: { branchId: branch.id, expectedRevision: branch.revision, startHash },
              nodeId: op.nodeId!,
              workingCopyId: op.workingCopyId!,
              goal: branch.goal,
            })
          }
        >
          准备方案首轮执行
        </Button>
      )}
      {branch.run && isActiveRun(branch.run.state) && (
        <Button
          busy={stop.busy}
          disabled={branch.run.state === 'stopping' || !!stop.uncertain || stop.denied}
          onClick={() => void stop.send(`/runs/${branch.run!.id}/stop`, {})}
        >
          停止此方案执行
        </Button>
      )}
      {run && (
        <NodeRunPanel
          task={task}
          branch={run}
          onClose={() => {
            setRun(null);
            saved();
          }}
        />
      )}
    </div>
  );
}
export function BranchWorkspace({
  task,
  branch,
  startHash,
  path,
  editable,
  saved,
}: {
  task: Task;
  branch: WorkBranch;
  startHash: string;
  path: string;
  editable: boolean;
  saved(): void;
}) {
  const op = branch.workspace;
  const labels = {
    waiting_local: '等待本人本机准备',
    prepared: '现场已报告 · 尚未登记节点',
    bound: '独立现场已登记',
    cancelled: '现场准备已取消',
    needs_attention: '现场准备需要核对',
  };
  return (
    <section className="work-branch-workspace" aria-label="方案独立现场">
      {op ? (
        <>
          <strong>
            {branch.preservation?.executionRegistrationClosed
              ? '原路径执行登记已关闭 · 完整现场已保留'
              : labels[op.state]}
          </strong>
          <p>最后记录 {time(op.updatedAt)}；准备/登记不代表模型已启动。</p>
          {op.reason && <p>{op.reason}</p>}
          {op.proof && (
            <p>本机核验 {time(op.proof.verifiedAt)}，这是历史观察；首轮启动前仍会检查实际文件。</p>
          )}
        </>
      ) : (
        <p>尚无独立目录、Run 或结果。</p>
      )}
      {branch.run && (
        <>
          <NodeRunStatus run={branch.run} />
          <p>
            Run <code>{branch.run.id}</code>。
            {branch.resultId ? '已保存文字成果版本。' : '方案成果尚未绑定。'}
            执行结束不等于选中或整合。
          </p>
        </>
      )}
      {editable && (
        <Actions task={task} branch={branch} startHash={startHash} path={path} saved={saved} />
      )}
    </section>
  );
}
