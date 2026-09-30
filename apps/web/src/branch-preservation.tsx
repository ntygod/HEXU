import { useEffect, useState } from 'react';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type { BranchCleanupOptions } from '../../../packages/contracts/src/branch-cleanup-check.js';
import type { BranchPreservationView } from '../../../packages/contracts/src/branch-preservation.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { useApp, time } from './state.js';
import { quoteShellArgument } from './integration-trial-command.js';

export interface BranchPreservationDraft {
  branch: WorkBranch;
  cancel?: BranchPreservationView;
}
const path = (b: WorkBranch) =>
  `/tasks/${encodeURIComponent(b.taskId)}/work-branches/${encodeURIComponent(b.id)}`;
const labels: Record<BranchPreservationView['state'], string> = {
  requested: '等待本人本机确认',
  moving: '本机处置已开始 · 尚未确认移出',
  preserved: '已完整移出并保留',
  failed: '本次未移出',
  needs_attention: '结果未确认 · 保留两处现场与占用',
  cancelled: '请求已取消 · 不回滚文件',
};
export function BranchPreservationEditor({
  draft,
  open,
  close,
  saved,
  denied,
}: {
  draft: BranchPreservationDraft;
  open: boolean;
  close(keepPending: boolean): void;
  saved(view: BranchPreservationView): void;
  denied(): void;
}) {
  const { data } = useApp(),
    b = draft.branch;
  const options = useAssistanceRead<BranchCleanupOptions>(
      draft.cancel ? null : path(b) + '/cleanup-options',
    ),
    record = useAssistanceRead<BranchPreservationView>(
      draft.cancel ? `${path(b)}/preservations/${draft.cancel.request.id}` : null,
    ),
    command = useAssistanceCommand<BranchPreservationView>(saved);
  const [baseline, setBaseline] = useState<BranchCleanupOptions | null>(null),
    [cancelBaseline, setCancelBaseline] = useState(draft.cancel ?? null),
    [retentionId, setRetentionId] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!baseline && options.value) setBaseline(structuredClone(options.value));
  }, [baseline, options.value]);
  useEffect(() => {
    if (options.denied || record.denied || command.denied) denied();
  }, [options.denied, record.denied, command.denied]);
  const locked = command.busy || !!command.uncertain,
    read = draft.cancel ? record : options,
    material = baseline?.materials.find((m) => m.retention.request.id === retentionId),
    currentMaterial = options.value?.materials.find((m) => m.retention.request.id === retentionId),
    task = data.tasks.find((t) => t.id === b.taskId),
    stale = draft.cancel
      ? !!cancelBaseline &&
        !!record.value &&
        (record.value.revision !== cancelBaseline.revision ||
          record.value.state !== cancelBaseline.state)
      : !!baseline &&
        ((!!task && task.revision > baseline.taskRevision) ||
          (!!options.value &&
            (options.value.branch.revision !== baseline.branch.revision ||
              options.value.taskRevision !== baseline.taskRevision ||
              options.value.originHash !== baseline.originHash ||
              (!!material && JSON.stringify(material) !== JSON.stringify(currentMaterial))))),
    existing = options.value?.branch.preservation,
    unavailable = !!existing && !['failed', 'cancelled'].includes(existing.state),
    available = draft.cancel
      ? record.value?.canCancel
      : baseline?.canInspect &&
        options.value?.canInspect &&
        material &&
        currentMaterial &&
        !unavailable,
    disabled = locked || !confirmed || !available || !!read.error || !read.value || stale;
  if (!open || read.denied || command.denied) return null;
  const title = draft.cancel ? '取消尚未开始的移出请求' : '移出并保留完整现场';
  return (
    <Dialog title={title} drawer onClose={() => !command.busy && close(!!command.uncertain)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled) return;
          if (draft.cancel && cancelBaseline)
            void command.send(`${path(b)}/preservations/${draft.cancel.request.id}/cancel`, {
              expectedRevision: cancelBaseline.revision,
            });
          else if (baseline && material)
            void command.send(path(b) + '/preservations', {
              expectedRevision: baseline.branch.revision,
              expectedTaskRevision: baseline.taskRevision,
              retentionId,
              confirmMoveCompleteDirectory: true,
              confirmKeepGitAndContents: true,
            });
        }}
      >
        <div className="dialog-body work-branch-lifecycle work-branch-workspace">
          <strong>{b.name}</strong>
          <p>
            固定方案 <code>{b.id}</code> · 原工作区 <code>{b.workingCopyId}</code>
          </p>
          {draft.cancel ? (
            <>
              <p>
                只取消这条尚未开始的请求，不移动、删除或恢复文件。原节点一旦开始或结果未知，就不能用此入口撤回移动。
              </p>
              <p>
                请求 <code>{draft.cancel.request.id}</code> ·{' '}
                {record.value ? labels[record.value.state] : labels[draft.cancel.state]}
              </p>
            </>
          ) : (
            <>
              <p className="work-branch-notice">
                将完整原目录连同.git、全部原内容移到本人在本机明确指定的全新私有位置。不是永久删除，不释放磁盘空间；原路径退出执行登记，保留位置不会自动获得新的执行或共享权限。
              </p>
              <p>
                网页仅保存固定请求。本机仍须单独确认全部写入者停止和实际保留位置；不会替你停止进程。未保存修改、未知占用、当前权限或材料变化仍阻止移动；跨文件系统与linked
                worktree不支持。
              </p>
              <label className="field">
                固定提交与独立副本
                <select
                  aria-label="移出保护副本"
                  value={retentionId}
                  disabled={locked}
                  onChange={(e) => {
                    setRetentionId(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">明确选择同一现场的保留副本</option>
                  {baseline?.materials.map((m) => (
                    <option key={m.retention.request.id} value={m.retention.request.id}>
                      {m.checkpoint.request.label} · {m.checkpoint.manifest.commit.slice(0, 12)} ·{' '}
                      {m.retention.request.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              {material && (
                <p>
                  固定提交 <code>{material.checkpoint.manifest.commit}</code>
                  <br />
                  副本 <code>{retentionId}</code> · 有效至{' '}
                  {time(material.retention.manifest!.expiresAt)}
                  。副本本身只是单提交快照；本次移动保留完整.git，不把副本当成完整Git历史备份。
                </p>
              )}
              {baseline && !baseline.materials.length && (
                <p>
                  没有原本人同一现场的有效对象副本。先返回“代码检查点”记录已有提交并明确保留，不自动提交或丢弃用户修改。
                </p>
              )}
              {options.value && !options.value.canInspect && (
                <p role="status">{options.value.unavailableReason}</p>
              )}
              {unavailable && !command.uncertain && (
                <p role="status">已有原移出请求或已完成保留，请查看原记录，不能创建重复移动。</p>
              )}
            </>
          )}
          {read.error && <p role="alert">{read.error}。原输入保留，暂不提交。</p>}
          {stale && !command.uncertain && (
            <p className="work-branch-notice">
              原请求、方案、任务或副本已变化，原选择未被替换；请明确重新核对范围并再次确认。
            </p>
          )}
          <label className="work-branch-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {draft.cancel
              ? '我确认只取消尚未开始的原请求，不回滚文件'
              : '我确认请求移出完整原目录并保留.git和所有内容，不永久删除或自动开始新执行'}
          </label>
          {!command.uncertain && (
            <div className="work-branch-actions">
              <Button type="button" disabled={locked} onClick={read.retry}>
                重读移出条件
              </Button>
              <Button
                type="button"
                disabled={locked || !read.value || !!read.error}
                onClick={() => {
                  if (draft.cancel && record.value)
                    setCancelBaseline(structuredClone(record.value));
                  else if (options.value) {
                    if (
                      !options.value.materials.some((m) => m.retention.request.id === retentionId)
                    )
                      setRetentionId('');
                    setBaseline(structuredClone(options.value));
                  }
                  setConfirmed(false);
                }}
              >
                重新核对移出范围
              </Button>
            </div>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section aria-label="移出请求待确认" className="work-branch-notice">
              <p>
                结果尚未确认，原请求可能已保存。只会重发原正文和操作标识；关闭不撤回请求，也不意味着本机已移动。
              </p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                确认上次移出操作
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={() => close(!!command.uncertain)}>
            返回方案记录
          </Button>
          <Button type="submit" variant="primary" busy={command.busy} disabled={!!disabled}>
            {draft.cancel ? '确认取消原移出请求' : '保存移出保留请求'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function BranchPreservationRecords({
  branch,
  editable,
  disabled,
  edit,
  focusId,
}: {
  branch: WorkBranch;
  editable: boolean;
  disabled: boolean;
  edit(draft: BranchPreservationDraft): void;
  focusId: string | null;
}) {
  const { data } = useApp(),
    read = useAssistanceRead<{ items: BranchPreservationView[] }>(path(branch) + '/preservations'),
    [selected, setSelected] = useState<string | null>(focusId);
  useEffect(() => {
    if (focusId) setSelected(focusId);
  }, [focusId]);
  useEffect(() => {
    if (!selected && read.value?.items.length) setSelected(read.value.items[0]!.request.id);
  }, [selected, read.value]);
  if (read.denied) return <p role="alert">移出记录读取权限已失效。</p>;
  const view = read.value?.items.find((v) => v.request.id === selected),
    latest = read.value?.items[0],
    mine = editable && branch.workspace?.ticket.ownerId === data.user.id,
    canCreate = mine && (!latest || ['failed', 'cancelled'].includes(latest.state));
  return (
    <section aria-label="方案移出保留" className="work-branch-workspace">
      {canCreate && (
        <Button disabled={disabled || !read.value || !!read.error} onClick={() => edit({ branch })}>
          移出并保留完整现场
        </Button>
      )}
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读移出记录</Button>
        </p>
      )}
      {!!read.value?.items.length && (
        <label className="field">
          固定移出记录
          <select
            aria-label="移出保留记录"
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            {read.value.items.map((v) => (
              <option key={v.request.id} value={v.request.id}>
                {v.request.id.slice(0, 8)} · {labels[v.state]}
              </option>
            ))}
          </select>
        </label>
      )}
      {latest && view && latest.request.id !== view.request.id && (
        <p>有更新的移出记录；当前仍查看所选原记录，不自动替换。</p>
      )}
      {view && (
        <article aria-label="固定移出保留记录" className="work-branch-notice">
          <strong>{labels[view.state]}</strong>
          <p>
            请求 <code>{view.request.id}</code> · {time(view.request.requestedAt)}
            <br />
            固定提交 <code>{view.request.scope.material.checkpoint.manifest.commit}</code>
          </p>
          <p>历史依据与当前文件可用性分开；原Task、Run、成果版本和节点/材料权限保留。</p>
          {view.state === 'preserved' && (
            <p>
              原路径执行登记已关闭；完整原目录与.git已移出保留。不是永久删除，保留位置未自动登记；该报告不证明用户之后没有编辑或再移动。
            </p>
          )}
          {view.state === 'needs_attention' && (
            <p>
              目录可能已移动。保留原位置、新位置、日志、凭证和占用，不能猜测成功或重新发起同一次移动。
            </p>
          )}
          {view.unavailableReason && <p>{view.unavailableReason}</p>}
          {!!view.reports.length && (
            <ol aria-label="移出观察历史">
              {view.reports.map(({ report, hash }) => (
                <li key={hash}>
                  {labels[report.stage]} · 本机观察 {time(report.observedAt)}
                  <br />
                  保留位置记录 <code>{report.destinationRef}</code>，具体绝对路径只在原节点。
                </li>
              ))}
            </ol>
          )}
          {mine && view.state !== 'cancelled' && (
            <>
              <pre aria-label="完整移出保留命令">{`npm run runner:branch-preserve -- --preservation ${quoteShellArgument(view.request.id)} --state ${quoteShellArgument('<原方案节点状态目录>')} --target ${quoteShellArgument('<全新私有保留绝对目录>')}`}</pre>
              <p>
                本机核对实际路径后逐次输入 STOPPED_AND_PRESERVE 和
                PRESERVE。重复原命令只核对原记录/待发包，不重放移动；原不确定位置不能换成另一个目标。
              </p>
            </>
          )}
          {mine && view.canCancel && (
            <Button
              disabled={disabled || !!read.error}
              onClick={() => edit({ branch, cancel: view })}
            >
              取消未开始的移出请求
            </Button>
          )}
        </article>
      )}
    </section>
  );
}
