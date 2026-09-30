import { useEffect, useState } from 'react';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type { WorkBranchDiscardPreview } from '../../../packages/contracts/src/work-branch-lifecycle.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { Link, useApp } from './state.js';
import { NodeRunStatus } from './node-execution.js';
const fixed = (v: WorkBranchDiscardPreview) =>
  JSON.stringify({
    taskRevision: v.taskRevision,
    id: v.branch.id,
    revision: v.branch.revision,
    state: v.branch.state,
    runId: v.branch.runId,
    workingCopyId: v.branch.workingCopyId,
    workspaceId: v.branch.workspace?.ticket.id,
    canDiscard: v.canDiscard,
  });
export function BranchDiscardEditor({
  initial,
  open,
  close,
  saved,
  denied,
}: {
  initial: WorkBranch;
  open: boolean;
  close(keepPending: boolean): void;
  saved(): void;
  denied(): void;
}) {
  const { data } = useApp(),
    path = `/tasks/${encodeURIComponent(initial.taskId)}/work-branches/${encodeURIComponent(initial.id)}`,
    read = useAssistanceRead<WorkBranchDiscardPreview>(path + '/discard-preview', 2000),
    command = useAssistanceCommand(saved);
  const [baseline, setBaseline] = useState<WorkBranchDiscardPreview | null>(null),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!baseline && read.value) setBaseline(structuredClone(read.value));
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied || command.denied) denied();
  }, [read.denied, command.denied]);
  const b = baseline?.branch ?? initial,
    task = data.tasks.find((t) => t.id === initial.taskId),
    locked = command.busy || !!command.uncertain,
    stale =
      !!baseline &&
      ((!!read.value && fixed(read.value) !== fixed(baseline)) ||
        (!!task && task.revision > baseline.taskRevision)),
    disabled =
      locked || !confirmed || !baseline?.canDiscard || !read.value || !!read.error || stale,
    live = read.value?.branch ?? b;
  if (!open || read.denied || command.denied) return null;
  return (
    <Dialog
      title="放弃方案并保留现场"
      drawer
      onClose={() => !command.busy && close(!!command.uncertain)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !baseline) return;
          void command.send(path + '/discard-preserving', {
            expectedRevision: baseline.branch.revision,
            expectedTaskRevision: baseline.taskRevision,
            confirmPreserveWorkspace: true,
            confirmExecutionContinues: true,
          });
        }}
      >
        <div className="dialog-body work-branch-lifecycle">
          <section aria-label="固定放弃方案">
            <strong>{b.name}</strong>
            <p className="work-branch-text">{b.goal}</p>
            <dl>
              <dt>固定方案</dt>
              <dd>
                <code>{b.id}</code> · 修订 {baseline?.branch.revision ?? b.revision}
              </dd>
              <dt>独立现场</dt>
              <dd>
                {b.workspace?.ticket.id ? (
                  <>
                    登记记录 <code>{b.workspace.ticket.id}</code>
                  </>
                ) : (
                  '等待核对'
                )}
              </dd>
              <dt>工作区</dt>
              <dd>
                <code>{b.workingCopyId}</code>
              </dd>
              {b.runId && (
                <>
                  <dt>原执行</dt>
                  <dd>
                    <code>{b.runId}</code>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <p className="work-branch-notice">
            只将这个方案标记为已放弃。代码目录、未保存修改、成果版本、已有引用和执行记录全部保留；不停止或清理进程，不删除文件，不撤销节点权限，也不释放目录占用。之后不能从此方案创建新执行。
          </p>
          {live.run ? (
            <section aria-label="原执行当前观察">
              <NodeRunStatus run={live.run} />
              <p>
                执行状态单独更新。若仍在运行，可返回方案卡明确停止；停止请求不等于进程已结束，未知现场继续保留占用。
              </p>
            </section>
          ) : (
            <p>尚无关联执行；已登记目录仍保留。放弃后不会自动创建执行或清理现场。</p>
          )}
          {b.resultId && (
            <p>
              <Link to={`/results/${b.resultId}${b.result?.id ? `/versions/${b.result.id}` : ''}`}>
                查看保留的方案成果
              </Link>
              ；原固定版本不会被放弃动作改写。
            </p>
          )}
          {!baseline && !read.error && <p role="status">正在核对方案与当前选择…</p>}
          {baseline && !baseline.canDiscard && (
            <section className="work-branch-notice" aria-label="放弃方案受阻">
              <p>{baseline.unavailableReason}</p>
              {!locked && b.state === 'selected' && (
                <Link to={`/tasks/${b.taskId}/compare/${b.groupId}`}>
                  去比较中明确取消或替换选择
                </Link>
              )}
            </section>
          )}
          <label className="work-branch-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || !baseline?.canDiscard}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我理解只放弃此方案，现场和成果保留，原执行不会因此停止
          </label>
          {stale && !command.uncertain && (
            <p className="work-branch-notice">
              方案、任务修订或当前选择已变化，原确认范围保留。请明确重新核对并再次确认。
            </p>
          )}
          {read.error && <p role="alert">{read.error}。确认内容保留，暂不能提交新请求。</p>}
          {!command.uncertain && (
            <div className="work-branch-actions">
              <Button type="button" disabled={locked} onClick={read.retry}>
                重读放弃条件
              </Button>
              <Button
                type="button"
                disabled={locked || !read.value || !!read.error}
                onClick={() => {
                  setBaseline(structuredClone(read.value!));
                  setConfirmed(false);
                }}
              >
                重新核对放弃范围
              </Button>
            </div>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section className="work-branch-notice" aria-label="放弃方案请求待确认">
              <p>
                结果尚未确认，方案可能已标记放弃。只会重发原范围、正文和操作标识；关闭不会撤回已保存记录。
              </p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                确认上次放弃请求
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={() => close(!!command.uncertain)}>
            返回方案列表
          </Button>
          <Button type="submit" variant="primary" busy={command.busy} disabled={disabled}>
            确认放弃并保留现场
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
