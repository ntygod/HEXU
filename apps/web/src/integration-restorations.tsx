import { useEffect, useState } from 'react';
import type { IntegrationView } from '../../../packages/contracts/src/integrations.js';
import type {
  IntegrationFileRestorationCancel,
  IntegrationFileRestorationCreate,
  IntegrationFileRestorationReport,
} from '../../../packages/contracts/src/integration-restorations.js';
import { integrationFileRestorationPath } from '../../../packages/client/src/index.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { quoteShellArgument } from './integration-trial-command.js';
import { time, useApp } from './state.js';
import './integration-restorations.css';

export type FileRestorationAction = 'create' | 'cancel';
export interface FileRestorationEditorState {
  view: IntegrationView;
  action: FileRestorationAction;
}
const labels = {
  queued: '等待本人本机确认文件恢复',
  restoring: '文件恢复进行中 · 等待节点结算',
  completed: '原应用文件已恢复',
  failed: '文件恢复失败',
  needs_attention: '文件恢复需要本机处理',
  cancelled: '已取消文件恢复请求',
};
const reasons: Record<NonNullable<IntegrationFileRestorationReport['reason']>, string> = {
  target_changed: '目标现场已变化，不能覆盖后来的用户修改',
  workspace_busy: '目录仍有活动或未知写入',
  backup_unavailable: '原本机备份缺失、损坏或与原记录不符',
  unsupported_snapshot: '文件类型、路径或本机能力不支持本轮文件恢复',
  restoration_failed: '本机文件恢复未完成，请保留全部现场',
  interrupted: '文件恢复被中断或上次结果不明',
};
function localCommand(view: IntegrationView, kind: 'restore' | 'recover' | 'status') {
  const operation = quoteShellArgument(view.operation.id),
    state = quoteShellArgument('<原节点状态目录>'),
    restoration = quoteShellArgument(view.restoration!.id);
  if (kind === 'restore')
    return `npm run runner:integration-restore -- --operation ${operation} --restoration ${restoration} --state ${state} --backup ${quoteShellArgument('<全新私有备份绝对目录>')}`;
  if (kind === 'recover')
    return `npm run runner:integration-recover -- --operation ${operation} --restoration ${restoration} --state ${state}`;
  return `npm run runner:integration-status -- --operation ${operation} --state ${state}`;
}
export function FileRestorationStatus({ view }: { view: IntegrationView }) {
  const r = view.restoration;
  if (!r) return null;
  const latest = r.reports.at(-1),
    recovery = r.recovery;
  return (
    <>
      <section className="integration-application-status" aria-label="文件恢复状态">
        <strong>{labels[r.state]}</strong>
        <p>
          恢复请求 <code>{r.id}</code> · {r.requestedBy.name} · {time(r.requestedAt)}
        </p>
        <p>原应用状态与完成报告仍为历史事实；文件恢复单独记录，不自动提交代码或改变任务状态。</p>
        <p>
          恢复范围是文件内容与Git可执行位，不承诺原inode、全部权限、ACL或扩展属性的还原，也不回滚原应用创建的空目录。
        </p>
        <ul aria-label="固定文件恢复范围">
          {r.paths.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        {r.state === 'queued' && (
          <>
            <p>
              {recovery
                ? '原文件恢复请求仍为排队状态，服务端尚无文件恢复终态；下方保留结算观察不证明文件已恢复。'
                : '请求已保存，尚未收到恢复阶段声明。仍需本人在原Linux节点明确确认全部写入者已停止、核对原备份和当前现场。'}
            </p>
            {!recovery && (
              <section className="integration-restoration-command" aria-label="本机文件恢复命令">
                <pre>{localCommand(view, 'restore')}</pre>
                <p>
                  先替换带引号的目录占位符。新备份须在同一文件系统，且位于代码、候选、原备份和节点状态之外；本机绝对路径不上传。
                </p>
              </section>
            )}
          </>
        )}
        {r.state === 'restoring' && (
          <p className="work-branch-notice">
            节点已进入文件恢复阶段，可能已部分恢复；尚无完成报告。不能取消、重复写入或自动回滚。
          </p>
        )}
        {r.state === 'completed' && (
          <p>
            节点已报告原应用全部所选文件恢复完成。当前新增/修改文件保留在新的本机私有备份；原应用创建的空目录仍保留。这是当时的完成报告，不代表目录现在仍未变化。
          </p>
        )}
        {r.state === 'failed' && (
          <p>
            节点报告文件恢复失败；不能据此推断现场没有变化。保留原目录、原备份（若有）与本次备份，在原节点核对记录，不自动重试写入。
          </p>
        )}
        {r.state === 'needs_attention' && (
          <p className="work-branch-notice">
            可能已部分恢复或仍有未决写入意图。保留原目录、原备份（若有）与本次备份；文件计数不能代表全部现场，即使0个文件也可能已建立备份材料。不要自动回滚或清理。
          </p>
        )}
        {r.state === 'cancelled' && (
          <p>
            {recovery
              ? '保留原文件恢复取消记录；不能据此断言本机未开始恢复。保留结算观察单独列出。'
              : '服务端已取消尚未声明恢复阶段的请求；不能据此断言本机从未开始写入，请在原节点核对。'}
            同一原应用不提供第二次文件恢复请求。
          </p>
        )}
        {latest && (
          <>
            <p>
              节点最新报告：{time(latest.observedAt)} · 已记录恢复 {latest.restoredPaths.length}{' '}
              个文件
            </p>
            {latest.reason && <p role="status">{reasons[latest.reason]}</p>}
            {!!latest.restoredPaths.length && (
              <ul aria-label="已记录恢复路径">
                {latest.restoredPaths.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <details>
          <summary>在原节点核对文件恢复状态</summary>
          <section className="integration-restoration-command" aria-label="本机文件恢复状态命令">
            <pre>{localCommand(view, 'status')}</pre>
          </section>
          <p>
            重复恢复命令仅对账原记录，不重新执行写入。检测到后来的修改会停止，不提供强制覆盖；原应用部分写入或结果未知时不支持新文件恢复。
          </p>
          {(r.state === 'queued' ||
            r.state === 'restoring' ||
            r.state === 'needs_attention' ||
            r.state === 'failed' ||
            r.state === 'cancelled') &&
            !recovery && (
              <section
                className="integration-restoration-command"
                aria-label="文件恢复保留结算命令"
              >
                <p>
                  只有本人明确确认本次文件恢复进程及全部子进程、遗留孤儿进程均已停止后，才可在原节点进行保留结算。它仅释放本次恢复的占用，保留全部文件，不证明文件已恢复。
                </p>
                <pre>{localCommand(view, 'recover')}</pre>
              </section>
            )}
        </details>
        {!!r.reports.length && (
          <details>
            <summary>文件恢复报告历史（{r.reports.length}）</summary>
            <ol>
              {r.reports.map((report) => (
                <li key={report.sequence}>
                  {labels[report.stage]} · {time(report.observedAt)} · 已记录恢复{' '}
                  {report.restoredPaths.length} 个文件
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
      {recovery && (
        <section className="work-branch-notice" aria-label="文件恢复保留结算观察">
          <strong>本次文件恢复占用已在本机明确结算 · 历史观察</strong>
          <p>
            原目标节点所有者当时明确确认本次文件恢复进程及全部子进程、遗留孤儿进程均已停止：
            {time(recovery.report.stoppedConfirmedAt)}
          </p>
          <p>仅本次文件恢复的占用已释放：{time(recovery.report.releasedAt)}</p>
          <p>
            保留全部文件，未重新核验文件内容或恢复成功。原应用与文件恢复报告保持不变；此历史观察不代表目录当前可用，也不授权再次写入。
          </p>
          <p>
            原本机记录含 {recovery.report.recordedRestoredCount} 个恢复文件记录；
            {recovery.report.unresolvedWriteIntent ? '仍有未决写入意图' : '原记录未含未决写入意图'}
            。这些数量不是当前文件验证结果。
          </p>
          <p>服务端收到此观察：{time(recovery.receivedAt)}</p>
        </section>
      )}
    </>
  );
}

/** Compare only original target/application and restoration authority, not source retention. */
function fixedEvidence(view: IntegrationView) {
  return JSON.stringify({
    operationId: view.operation.id,
    inputHash: view.operation.inputHash,
    revision: view.operation.revision,
    taskRevision: view.taskRevision,
    target: view.operation.target,
    application: view.operation.application,
    completedReportHash: view.completedReportHash,
    restoration: view.restoration,
    canRestoreFiles: view.canRestoreFiles,
    canCancelFileRestoration: view.canCancelFileRestoration,
  });
}
export function FileRestorationEditor({
  initial,
  action,
  open,
  close,
  saved,
  denied,
}: {
  initial: IntegrationView;
  action: FileRestorationAction;
  open: boolean;
  close(keepPending: boolean): void;
  saved(): void;
  denied(): void;
}) {
  const { data } = useApp(),
    [baseline, setBaseline] = useState(() => structuredClone(initial)),
    [confirmed, setConfirmed] = useState(false),
    o = baseline.operation,
    a = o.application,
    r = baseline.restoration,
    cancelling = action === 'cancel',
    read = useAssistanceRead<IntegrationView>(
      `/tasks/${encodeURIComponent(o.taskId)}/integrations/${encodeURIComponent(o.id)}`,
      5000,
    ),
    command = useAssistanceCommand<IntegrationView>(saved),
    task = data.tasks.find((item) => item.id === o.taskId),
    stale =
      (!!task && task.revision > baseline.taskRevision) ||
      (!!read.value && fixedEvidence(read.value) !== fixedEvidence(baseline)),
    allowed = cancelling
      ? !!baseline.canCancelFileRestoration && !!r
      : !!baseline.canRestoreFiles && !!a && !!baseline.completedReportHash,
    locked = command.busy || !!command.uncertain,
    disabled =
      !allowed || (!cancelling && !confirmed) || locked || stale || !read.value || !!read.error;
  useEffect(() => {
    if (command.denied || read.denied) denied();
  }, [command.denied, read.denied]);
  if (!open || command.denied || read.denied) return null;
  return (
    <Dialog
      title={cancelling ? '确认取消文件恢复' : '确认恢复原应用文件'}
      drawer
      onClose={() => !command.busy && close(!!command.uncertain)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !a) return;
          const body: IntegrationFileRestorationCreate | IntegrationFileRestorationCancel =
            cancelling
              ? {
                  restorationId: r!.id,
                  expectedRevision: r!.revision,
                  expectedTaskRevision: baseline.taskRevision,
                }
              : {
                  applicationId: a.id,
                  applicationInputHash: a.inputHash,
                  completedReportHash: baseline.completedReportHash!,
                  paths: [...a.paths],
                  expectedRevision: o.revision,
                  expectedTaskRevision: baseline.taskRevision,
                  confirmFileRestoration: true,
                };
          void command.send(integrationFileRestorationPath(o.taskId, o.id, action), body);
        }}
      >
        <div className="dialog-body integration-form">
          <section aria-label="固定文件恢复基线">
            <strong>{cancelling ? '取消这次文件恢复请求' : '恢复原应用的完整文件范围'}</strong>
            <dl className="integration-baseline">
              <dt>原应用</dt>
              <dd>
                <code>{a?.id}</code>
              </dd>
              <dt>原应用输入指纹</dt>
              <dd>
                <code>{a?.inputHash}</code>
              </dd>
              <dt>原完成报告</dt>
              <dd>
                <code>{baseline.completedReportHash}</code>
              </dd>
              <dt>原目标节点与目录</dt>
              <dd>
                {o.target.checkpoint.request.nodeName} / {o.target.checkpoint.request.workspaceName}
              </dd>
              <dt>原目标提交</dt>
              <dd>
                <code>{o.target.manifest.commit}</code>
              </dd>
              {r && (
                <>
                  <dt>文件恢复请求</dt>
                  <dd>
                    <code>{r.id}</code> · 修订 {r.revision}
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section aria-label="原应用完整恢复路径">
            <strong>固定原应用全部 {a?.paths.length ?? 0} 个文件，不改变子集</strong>
            <ul>
              {a?.paths.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </section>
          {cancelling ? (
            <p className="work-branch-notice">
              仅取消尚未声明恢复阶段的服务端请求；不停止本机进程，不回滚任何文件，不删除原应用或恢复历史。同一原应用不提供第二次恢复请求。
            </p>
          ) : (
            <>
              <p className="work-branch-notice">
                仅支持已明确完成的原应用全部文件。原有文件内容从原应用的精确本机备份恢复；当前新增/修改文件保留到本人另行指定的全新私有备份，原应用创建的空目录保留。恢复范围是文件内容与Git可执行位，不承诺原inode、全部权限、ACL或扩展属性的还原。不能强制覆盖后来的用户修改；部分写入或未知结果不支持本轮恢复。
              </p>
              <p>
                保存后还需本人在原Linux节点明确确认所有其他写入者已停止，核对原记录、备份与当前现场并取得目录锁。来源材料到期或不可用不替代目标恢复权限；不重读来源、不自动提交或改变原应用结论。
              </p>
              <label className="integration-consent">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对原应用、完成报告、目标与全部路径，另行确认恢复全部文件，并在本人节点指定新的私有备份
              </label>
            </>
          )}
          {stale && !command.uncertain && (
            <>
              <p className="work-branch-notice">
                任务修订、原应用、目标或文件恢复状态已变化，原基线已保留。明确重新核对后才能提交。
              </p>
              {read.value && (
                <Button
                  type="button"
                  disabled={locked || !!read.error}
                  onClick={() => {
                    setBaseline(structuredClone(read.value!));
                    setConfirmed(false);
                  }}
                >
                  重新核对文件恢复基线
                </Button>
              )}
            </>
          )}
          {!allowed && !command.uncertain && (
            <p role="status">
              当前记录不能{cancelling ? '取消文件恢复' : '创建文件恢复'}
              ，请核对最新目标权限与独立文件恢复状态。
            </p>
          )}
          {read.error && (
            <p role="alert">
              {read.error}
              <Button type="button" onClick={read.retry}>
                重读文件恢复状态
              </Button>
            </p>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section
              className="work-branch-notice"
              aria-label={cancelling ? '取消文件恢复请求待确认' : '文件恢复请求待确认'}
            >
              <p>
                请求可能已保存。确认只会重发原应用、原完整路径、原修订和同一操作标识；关闭不会撤回请求，重新打开后可继续确认。
              </p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                {cancelling ? '确认上次取消文件恢复请求' : '确认上次文件恢复请求'}
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={() => close(!!command.uncertain)}>
            关闭
          </Button>
          <Button type="submit" variant="primary" busy={command.busy} disabled={disabled}>
            {cancelling ? '确认取消文件恢复请求' : '确认全部文件恢复'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
