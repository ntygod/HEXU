import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../../packages/contracts/src/results.js';
import type {
  IntegrationView,
  IntegrationOptions,
  IntegrationReason,
  IntegrationFile,
  IntegrationApplicationReport,
} from '../../../packages/contracts/src/integrations.js';
import type { IntegrationTrialDifferenceDetail } from '../../../packages/contracts/src/integration-trial.js';
import { integrationCandidateApplicationCommand } from './integration-trial-command.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { Link, canEditTask, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import {
  IntegrationConflictDecisions,
  IntegrationTrialEditor,
  IntegrationTrialHistory,
} from './integration-trials.js';
import {
  FileRestorationEditor,
  FileRestorationStatus,
  type FileRestorationAction,
  type FileRestorationEditorState,
} from './integration-restorations.js';
import { IntegrationRecomputeEditor } from './integration-recompute.js';
import './integrations.css';

const path = (taskId: string) => `/tasks/${taskId}/integrations`;
const stateLabels = {
  queued: '等待本人预检',
  awaiting_choice: '预检已记录 · 尚未应用',
  conflict: '有冲突或清单省略',
  failed: '预检受阻',
  cancelled: '已取消预检',
  applying: '应用进行中 · 等待节点结算',
  completed: '所选文件已应用',
  needs_attention: '应用需要本机处理',
};
const reasons: Record<IntegrationReason, string> = {
  target_changed: '目标HEAD、索引或文件与固定提交不一致',
  workspace_busy: '目录仍有活动或未知写入',
  objects_unavailable: '完整对象缺失、损坏或到期',
  unsupported_snapshot: '包含不支持的文件类型或路径',
  budget_exceeded: '完整对象超过本轮预检预算',
  preflight_failed: '本机预检未完成，请核对材料与连接',
};
const fileLabels = {
  add: '新增',
  modify: '修改',
  delete: '删除',
  already_present: '目标已有',
  conflict: '冲突',
};
const selectable = (file: IntegrationFile) =>
  file.action === 'add' && !!file.source && !file.base && !file.target && !file.conflict;
const applicationReasons: Record<NonNullable<IntegrationApplicationReport['reason']>, string> = {
  target_changed: '目标现场已变化',
  workspace_busy: '目录仍有活动或未知写入',
  objects_unavailable: '完整对象缺失、损坏或到期',
  unsupported_snapshot: '文件类型、路径或新目录预算不支持本轮写入',
  application_failed: '本机应用未完成',
  interrupted: '应用被中断或上次结果不明',
};
function ApplicationStatus({ view }: { view: IntegrationView }) {
  const o = view.operation,
    a = o.application;
  if (!a) return null;
  const latest = a.reports.at(-1);
  return (
    <section className="integration-application-status" aria-label="文件应用状态">
      <strong>
        所选应用范围 · {a.paths.length} 个{a.candidate ? '候选文件' : '新增文件'}
      </strong>
      {a.candidate && (
        <p>
          固定候选 <code>{a.candidate.trialId}</code>
          ；原文件替换/移出会保留到本人另行指定的私有备份，备份路径不上传。
        </p>
      )}
      <ul>
        {a.paths.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <p>
        {a.requestedBy.name} · {time(a.requestedAt)}
      </p>
      {o.state === 'queued' && (
        <>
          <p>
            {view.recovery
              ? '原应用请求仍为排队状态，服务端尚未收到写入阶段声明；下方本机结算观察不改写原应用记录。'
              : '等待本人在目标节点确认应用。请求已保存，尚未收到写入阶段声明。'}
          </p>
          {view.available && !view.recovery && (
            <>
              {a.candidate ? (
                <section className="integration-trial-command" aria-label="本机候选写回命令">
                  <pre>{integrationCandidateApplicationCommand(o.id)}</pre>
                </section>
              ) : (
                <code>
                  npm run runner:integration-apply -- --operation {o.id} --state
                  &lt;节点状态目录&gt;
                </code>
              )}
              {a.candidate && (
                <p>
                  先替换带引号的目录占位符。在原节点确认全部写入者已停止后才可写回；备份须在同一文件系统且位于代码/候选/节点状态之外的新目录。重复命令只对账原记录，不能重新应用。
                </p>
              )}
              <p>
                仅在本人Linux节点执行；会再次核对所选路径、完整对象、目标现场与恢复点。必要的新父目录会排他创建，不接管后来出现的目录。
              </p>
            </>
          )}
        </>
      )}
      {o.state === 'applying' && (
        <p className="work-branch-notice">
          {view.recovery
            ? '原应用报告停留在应用阶段，可能已经写入；尚无原应用终态报告，不能据本机结算观察推断应用成功。'
            : '节点已进入应用阶段，可能已经写入。请等待或在原节点核对结果；不能取消、重复写入或自动回滚。'}
        </p>
      )}
      {o.state === 'completed' && (
        <p>
          {view.restoration
            ? '这是原应用当时的完成报告，后续文件恢复单独记录，不改写原应用结论。'
            : '节点已确认所选文件写入完成。'}
          未自动提交代码，也未标记任务完成；质量检查仍由你决定。
        </p>
      )}
      {o.state === 'needs_attention' && (
        <p className="work-branch-notice">
          {view.recovery
            ? '原应用报告仍为需要本机处理，可能已部分写入；原已确认路径不能代表全部现场。本机结算观察单独保留在下方。'
            : '可能已部分写入，目录锁仍需在原节点核对处理。不要重试写入或自动回滚；已确认的路径不能代表全部现场。'}
        </p>
      )}
      {(o.state === 'applying' || o.state === 'needs_attention') && (
        <p>
          文件计数不包含目录；即使已确认0个文件，也可能已创建父目录或保留未确认暂存。请在原节点核对本机状态，不自动清理。
        </p>
      )}
      {a.candidate && (o.state === 'applying' || o.state === 'needs_attention') && (
        <p>
          即使0个文件，也可能已创建私有备份目录或材料槽。不要删除它们；本机状态保留独立的备份位置与原文件证据。
        </p>
      )}
      {o.state === 'failed' && (
        <p>节点报告应用失败，未确认任何文件写入。请在原节点核对现场与记录。</p>
      )}
      {o.state === 'cancelled' && (
        <p>
          {view.recovery
            ? '此处保留原应用取消记录与历史；不能据此断言本机未开始写入。固定预检与所选范围保留，本机结算观察单独列出。'
            : '已在节点进入应用阶段前取消此应用请求，固定预检与所选范围保留。'}
        </p>
      )}
      {latest?.reason && <p role="status">{applicationReasons[latest.reason]}</p>}
      {latest && (
        <>
          <p>
            节点最新报告：{time(latest.observedAt)} · 已确认写入 {latest.appliedPaths.length} 个文件
          </p>
          {!!latest.appliedPaths.length && (
            <ul aria-label="已确认写入路径">
              {latest.appliedPaths.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
function RecoveryStatus({ view }: { view: IntegrationView }) {
  const recovery = view.recovery;
  if (!recovery) return null;
  const r = recovery.report;
  return (
    <section className="work-branch-notice" aria-label="本机保留文件结算观察">
      <strong>本次应用占用已在本机明确结算 · 历史观察</strong>
      <p>
        原目标节点所有者当时明确确认原应用进程及全部子进程、遗留孤儿进程均已停止：
        {time(r.stoppedConfirmedAt)}
      </p>
      <p>仅本次应用的占用已释放：{time(r.releasedAt)}</p>
      <p>
        本次结算保留全部文件，未重新核验文件内容或应用成功。原应用状态和报告保持不变；此历史观察不代表目录当前可用，也不授权再次应用。
      </p>
      <p>
        原本机记录含 {r.recordedAddedCount} 个新增文件记录；
        {r.unresolvedWriteIntent ? '仍有未决写入意图' : '原记录未含未决写入意图'}。
        这些数量不是当前文件验证结果，不包含已替换/移出文件或私有备份。
      </p>
      <p>服务端收到此观察：{time(recovery.receivedAt)}</p>
    </section>
  );
}
function Feedback({
  command,
  applicationCancel = false,
}: {
  command: ReturnType<typeof useAssistanceCommand>;
  applicationCancel?: boolean;
}) {
  return (
    <>
      {command.error && <p role="alert">{command.error}</p>}
      {command.uncertain && (
        <section
          className="work-branch-notice"
          aria-label={applicationCancel ? '取消应用请求待确认' : '整合预检请求待确认'}
        >
          <p>结果尚未确认。只会重发原来源、目标与操作标识；关闭窗口不会撤回已保存记录。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            {applicationCancel ? '确认上次取消请求' : '确认上次预检请求'}
          </Button>
        </section>
      )}
    </>
  );
}
function Record({
  view,
  saved,
  apply,
  pendingId,
  restoration,
  pendingRestoration,
  recompute,
  pendingRecomputeId,
  inspect,
  trial,
  selectedTrialId,
  selectTrial,
  denied,
}: {
  view: IntegrationView;
  saved(): void;
  apply?(view: IntegrationView, candidate?: IntegrationTrialDifferenceDetail): void;
  pendingId?: string;
  restoration?(view: IntegrationView, action: FileRestorationAction): void;
  pendingRestoration?: FileRestorationEditorState | null;
  recompute?(view: IntegrationView): void;
  pendingRecomputeId?: string;
  inspect?(id: string): void;
  trial?(view: IntegrationView): void;
  selectedTrialId?: string;
  selectTrial?(id: string): void;
  denied?(): void;
}) {
  const o = view.operation,
    report = o.report,
    plan = report?.plan;
  const command = useAssistanceCommand(saved);
  if (command.denied) return <p role="alert">操作权限已失效，整合内容已清除。</p>;
  return (
    <article className="integration-record" aria-label={`整合预检：${o.source.title}`}>
      <header>
        <strong>
          {o.source.title} · v{o.source.revision}
        </strong>
        <span
          className={`badge ${['conflict', 'failed', 'needs_attention'].includes(o.state) ? 'warning' : 'neutral'}`}
        >
          {o.application && o.state === 'queued'
            ? '等待本人本机确认应用'
            : o.application && o.state === 'cancelled'
              ? '已取消应用请求'
              : o.application && o.state === 'failed'
                ? '应用失败'
                : stateLabels[o.state]}
        </span>
      </header>
      <p>
        {o.source.branchName} → {o.target.checkpoint.request.nodeName} /{' '}
        {o.target.checkpoint.request.workspaceName}
      </p>
      <p>
        {o.createdBy.name} · {time(o.createdAt)}
      </p>
      {o.recomputedFrom && (
        <section aria-label="重新预检来源记录">
          <p>
            基于原预检 <code>{o.recomputedFrom}</code>{' '}
            创建；原来源版本保持，新目标独立确认，不继承原选择或候选。
          </p>
          {inspect && (
            <Button
              disabled={
                !!pendingId || !!pendingRestoration || !!pendingRecomputeId || !!pendingRecomputeId
              }
              onClick={() => inspect(o.recomputedFrom!)}
            >
              查看原预检记录
            </Button>
          )}
        </section>
      )}
      <details>
        <summary>固定来源、目标与恢复点</summary>
        <dl>
          <dt>共同起点</dt>
          <dd>
            <code>{o.source.code.base.commit}</code>
          </dd>
          <dt>来源提交</dt>
          <dd>
            <code>{o.material.manifest.commit}</code>
          </dd>
          <dt>目标提交</dt>
          <dd>
            <code>{o.target.manifest.commit}</code>
          </dd>
          <dt>恢复副本</dt>
          <dd>
            <code>{o.target.retentionId}</code> · 到期 {time(o.target.manifest.expiresAt)}
          </dd>
        </dl>
        <Link to={`/results/${o.source.resultId}/versions/${o.source.revisionId}`}>
          查看固定成果版本
        </Link>
      </details>
      {!view.available && (
        <p className="work-branch-notice">
          当前预检/候选材料不可继续核验：{view.unavailableReason}
          。原记录保留，文件恢复权限与状态单独核对。
        </p>
      )}
      {o.state === 'queued' && !o.application && view.available && (
        <details>
          <summary>在本人节点上生成预检</summary>
          <p>
            在目标Linux节点确认读取完整对象，并在本机查看后确认共享文件名。目标需是普通Git目录，HEAD、索引和全部文件与目标提交一致；额外或忽略文件也需先明确处理。
          </p>
          <code>
            npm run runner:integration-plan -- --operation {o.id} --state &lt;节点状态目录&gt;
          </code>
          <p>共同起点对象须仍在目标仓库。缺少材料会保留记录并阻止预检。</p>
        </details>
      )}
      {report?.reason && (
        <p role="status">{reasons[report.reason]}。未修改目标，可重新准备材料并创建另一条预检。</p>
      )}
      {plan && (
        <section aria-label="文件整合预检">
          <p>
            来源改变 {plan.changedFiles} 个文件 · 冲突 {plan.conflicts} · 目标已有{' '}
            {plan.alreadyPresent}
          </p>
          <p>
            基于 {time(report.observedAt)}{' '}
            的完整对象与目标现场。双方修改同一文件均列为冲突，不自动合并文本。
          </p>
          {!!plan.omittedFiles && (
            <p className="work-branch-notice">
              有 {plan.omittedFiles} 个文件因80项 / 48 KiB共享预算未展示，此计划不能用于应用。
            </p>
          )}
          <ul className="integration-files">
            {plan.files.map((f) => (
              <li key={f.path}>
                <div>
                  <span className={`badge ${f.action === 'conflict' ? 'warning' : 'neutral'}`}>
                    {fileLabels[f.action]}
                  </span>
                  <code>{f.path}</code>
                </div>
                {f.conflict && (
                  <p>
                    {f.conflict === 'path_collision'
                      ? '路径、大小写或文件/目录冲突'
                      : '来源与目标都修改了此文件'}
                  </p>
                )}
                <details>
                  <summary>文件对象</summary>
                  <dl>
                    {(['base', 'source', 'target'] as const).map((k) => (
                      <div key={k}>
                        <dt>{{ base: '共同起点', source: '来源', target: '目标' }[k]}</dt>
                        <dd>
                          {f[k] ? (
                            <>
                              <code>{f[k]!.objectId}</code> · {f[k]!.bytes}字节 · {f[k]!.mode}
                            </>
                          ) : (
                            '无此文件'
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          {!plan.changedFiles && <p>来源相对共同起点没有文件变化。</p>}
        </section>
      )}
      <p>
        {o.application
          ? '以上为历史只读预检；原计划保持不变，实际写入以独立应用报告为准。'
          : '仅记录只读预检，代码尚未应用。后续写入需要独立确认并重新核对现场。'}
      </p>
      <ApplicationStatus view={view} />
      <RecoveryStatus view={view} />
      <FileRestorationStatus view={view} />
      <IntegrationTrialHistory
        view={view}
        applyCandidate={
          apply && !pendingRestoration && !pendingRecomputeId
            ? (candidate) => apply(view, candidate)
            : undefined
        }
        selectedTrialId={selectedTrialId}
        selectTrial={selectTrial}
        denied={denied}
      />
      {trial && view.canTrial && (
        <Button
          disabled={
            command.busy ||
            !!command.uncertain ||
            !!pendingId ||
            !!pendingRestoration ||
            !!pendingRecomputeId
          }
          onClick={() => trial(view)}
        >
          选择文件试应用
        </Button>
      )}
      {apply && (view.canApply || pendingId === o.id) && (
        <Button
          disabled={
            command.busy ||
            !!command.uncertain ||
            !!pendingRestoration ||
            !!pendingRecomputeId ||
            (!!pendingId && pendingId !== o.id)
          }
          onClick={() => apply(view)}
        >
          {pendingId === o.id ? '继续确认应用请求' : '选择文件应用'}
        </Button>
      )}
      {restoration &&
        (view.canRestoreFiles ||
          (pendingRestoration?.view.operation.id === o.id &&
            pendingRestoration.action === 'create')) && (
          <Button
            disabled={
              command.busy ||
              !!command.uncertain ||
              !!pendingId ||
              !!pendingRecomputeId ||
              (!!pendingRestoration &&
                (pendingRestoration.view.operation.id !== o.id ||
                  pendingRestoration.action !== 'create'))
            }
            onClick={() => restoration(view, 'create')}
          >
            {pendingRestoration?.view.operation.id === o.id &&
            pendingRestoration.action === 'create'
              ? '继续确认文件恢复请求'
              : '恢复原应用文件'}
          </Button>
        )}
      {restoration &&
        (view.canCancelFileRestoration ||
          (pendingRestoration?.view.operation.id === o.id &&
            pendingRestoration.action === 'cancel')) &&
        !(pendingRestoration?.action === 'create') && (
          <Button
            disabled={
              command.busy ||
              !!command.uncertain ||
              !!pendingId ||
              !!pendingRecomputeId ||
              (!!pendingRestoration && pendingRestoration.view.operation.id !== o.id)
            }
            onClick={() => restoration(view, 'cancel')}
          >
            {pendingRestoration?.view.operation.id === o.id &&
            pendingRestoration.action === 'cancel'
              ? '继续确认取消文件恢复请求'
              : '取消文件恢复请求'}
          </Button>
        )}
      {recompute && (view.canRecompute || pendingRecomputeId === o.id) && (
        <Button
          disabled={
            command.busy ||
            !!command.uncertain ||
            !!pendingId ||
            !!pendingRestoration ||
            (!!pendingRecomputeId && pendingRecomputeId !== o.id)
          }
          onClick={() => recompute(view)}
        >
          {pendingRecomputeId === o.id ? '继续确认重新预检请求' : '使用新目标重新预检'}
        </Button>
      )}
      {recompute &&
        report &&
        !view.canRecompute &&
        !pendingRecomputeId &&
        view.recomputeUnavailableReason && (
          <p role="status">暂不能使用新目标重新预检：{view.recomputeUnavailableReason}</p>
        )}
      <details>
        <summary>操作历史（{o.history.length}）</summary>
        <ol>
          {o.history.map((e) => (
            <li key={e.revision}>
              {o.application && e.revision > 1 && e.state === 'queued'
                ? '等待本人本机确认应用'
                : o.application && e.state === 'cancelled'
                  ? '已取消应用请求'
                  : o.application && e.state === 'failed'
                    ? '应用失败'
                    : stateLabels[e.state]}{' '}
              · {time(e.at)}
            </li>
          ))}
        </ol>
      </details>
      {view.canCancel &&
        !pendingId &&
        !pendingRestoration &&
        !pendingRecomputeId &&
        !command.denied && (
          <Button
            disabled={command.busy || !!command.uncertain}
            onClick={() =>
              void command.send(`${path(o.taskId)}/${o.id}/cancel`, {
                expectedRevision: o.revision,
              })
            }
          >
            {o.application ? '取消应用请求' : '取消此预检'}
          </Button>
        )}
      <Feedback command={command} applicationCancel={!!o.application} />
    </article>
  );
}
function CreatedRecord({ created }: { created: IntegrationView }) {
  const o = created.operation,
    read = useAssistanceRead<IntegrationView>(`${path(o.taskId)}/${o.id}`, 5000);
  if (read.denied) return <p role="alert">读取权限已失效，预检内容已清除。</p>;
  return (
    <div className="dialog-body integration-form">
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读此预检</Button>
        </p>
      )}
      <Record view={read.value ?? created} saved={read.retry} />
      <Link to={`/tasks/${o.taskId}`}>回到任务查看全部预检</Link>
    </div>
  );
}
function Editor({
  version,
  close,
  denied,
}: {
  version: ResultRevision;
  close(): void;
  denied(): void;
}) {
  const url = path(version.taskId),
    read = useAssistanceRead<IntegrationOptions>(
      `${url}/options?resultId=${version.resultId}&revisionId=${version.id}`,
      5000,
    );
  const [baseline, setBaseline] = useState<IntegrationOptions | null>(null),
    [targetId, setTargetId] = useState(''),
    [materialId, setMaterialId] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [created, setCreated] = useState<IntegrationView | null>(null);
  const command = useAssistanceCommand<IntegrationView>((v) => setCreated(v));
  useEffect(() => {
    if (!baseline && read.value) setBaseline(read.value);
  }, [read.value, baseline]);
  useEffect(() => {
    if (command.denied || read.denied) denied();
  }, [command.denied, read.denied]);
  const target = baseline?.targets.find((t) => t.target.retentionId === targetId),
    material = target?.materials.find((m) => `${m.kind}:${m.id}` === materialId);
  const locked = command.busy || !!command.uncertain;
  const stale =
    !!baseline &&
    !!read.value &&
    (baseline.taskRevision !== read.value.taskRevision ||
      (!!target &&
        !read.value.targets.some(
          (t) =>
            t.target.retentionId === targetId &&
            t.materials.some((m) => `${m.kind}:${m.id}` === materialId),
        )));
  if (command.denied || read.denied) return null;
  return (
    <Dialog title="准备代码整合预检" drawer onClose={() => !command.busy && close()}>
      {created ? (
        <CreatedRecord created={created} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!baseline || !target || !material || !confirmed || stale || locked || read.error)
              return;
            void command.send(url, {
              resultId: version.resultId,
              resultRevisionId: version.id,
              targetCheckpointId: target.target.checkpoint.id,
              targetRetentionId: targetId,
              sourceMaterial: { kind: material.kind, id: material.id },
              expectedTaskRevision: baseline.taskRevision,
              confirmPreflight: true,
            });
          }}
        >
          <div className="dialog-body integration-form">
            <section aria-label="整合来源版本">
              <strong>
                {version.title} · v{version.revision}
              </strong>
              <p>来源固定到此成果版本，不跟随之后的方案选择或新版本变化。</p>
              {baseline && <code>{baseline.source.code.checkpoint.manifest.commit}</code>}
            </section>
            <p>
              选择本人目标目录的已保留提交作为恢复点。本步保存预检请求，之后在目标节点明确读取对象；不会启动模型或修改代码。
            </p>
            {!baseline && !read.error && <p role="status">正在读取可用目标…</p>}
            {baseline && !baseline.targets.length && (
              <p className="work-branch-notice">
                尚无可用目标。请先为目标提交记录检查点并保留对象；若来源在其他节点，先把来源提交副本明确传输到目标节点并确认接收。活动执行、到期或撤权的材料不会提供。
              </p>
            )}
            {!!baseline?.targets.length && (
              <>
                <label className="field">
                  目标目录与恢复副本
                  <select
                    aria-label="目标目录与恢复副本"
                    value={targetId}
                    disabled={locked}
                    onChange={(e) => {
                      setTargetId(e.target.value);
                      setMaterialId('');
                      setConfirmed(false);
                    }}
                  >
                    <option value="">请选择目标</option>
                    {baseline.targets.map((t) => (
                      <option key={t.target.retentionId} value={t.target.retentionId}>
                        {t.target.checkpoint.request.nodeName} /{' '}
                        {t.target.checkpoint.request.workspaceName} ·{' '}
                        {t.target.checkpoint.request.label} ·{' '}
                        {t.target.manifest.commit.slice(0, 12)} · 副本{' '}
                        {t.target.retentionId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                {target && (
                  <>
                    <code>{target.target.manifest.commit}</code>
                    <p>恢复副本到期：{time(target.target.manifest.expiresAt)}</p>
                    <label className="field">
                      来源完整对象
                      <select
                        aria-label="来源完整对象"
                        value={materialId}
                        disabled={locked}
                        onChange={(e) => {
                          setMaterialId(e.target.value);
                          setConfirmed(false);
                        }}
                      >
                        <option value="">请选择已核验副本</option>
                        {target.materials.map((m) => (
                          <option key={`${m.kind}:${m.id}`} value={`${m.kind}:${m.id}`}>
                            {m.kind === 'transfer' ? '已确认接收' : '本节点保留'} ·{' '}
                            {m.id.slice(0, 8)} · 到期 {time(m.manifest.expiresAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="integration-consent">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={locked}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已核对固定来源、目标提交与恢复点，仅创建只读预检
                </label>
              </>
            )}
            {stale && (
              <p className="work-branch-notice">
                任务修订或所选材料已变化，输入已保留。重新核对后才能创建。
              </p>
            )}
            {(stale || !baseline?.targets.length) && read.value && (
              <Button
                type="button"
                disabled={locked}
                onClick={() => {
                  setBaseline(read.value);
                  setConfirmed(false);
                }}
              >
                重新核对可用目标
              </Button>
            )}
            {read.error && (
              <p role="alert">
                {read.error}
                <Button type="button" onClick={read.retry}>
                  重读预检选项
                </Button>
              </p>
            )}
            <Feedback command={command} />
          </div>
          <div className="dialog-footer">
            <Button type="button" disabled={command.busy} onClick={close}>
              关闭
            </Button>
            <Button
              type="submit"
              variant="primary"
              busy={command.busy}
              disabled={!target || !material || !confirmed || locked || stale || !!read.error}
            >
              创建只读预检
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function PrepareIntegration({ version }: { version: ResultRevision }) {
  const { data } = useApp(),
    task = data.tasks.find((t) => t.id === version.taskId);
  const [fixed, setFixed] = useState<ResultRevision | null>(null),
    [revoked, setRevoked] = useState(false);
  const editable = !!task && canEditTask(data, task) && data.mode === 'team-local';
  useEffect(() => {
    if (!editable) setFixed(null);
  }, [editable]);
  if (!editable) return null;
  const eligible = version.source.kind === 'work_branch' && version.source.code !== 'not_captured';
  return (
    <>
      {eligible && (
        <Button disabled={revoked} onClick={() => setFixed(structuredClone(version))}>
          准备代码整合
        </Button>
      )}
      {fixed && (
        <Editor
          key={`${data.user.id}:${data.space?.id}:${fixed.id}`}
          version={fixed}
          close={() => setFixed(null)}
          denied={() => {
            setFixed(null);
            setRevoked(true);
          }}
        />
      )}
    </>
  );
}
function ApplicationEditor({
  initial,
  candidate,
  open,
  close,
  saved,
  denied,
}: {
  initial: IntegrationView;
  candidate?: IntegrationTrialDifferenceDetail | null;
  open: boolean;
  close(keepPending: boolean): void;
  saved(): void;
  denied(): void;
}) {
  const [baseline, setBaseline] = useState(() => structuredClone(initial)),
    [paths, setPaths] = useState<string[]>(() =>
      candidate ? [...candidate.report.selectedPaths].sort() : [],
    ),
    [confirmed, setConfirmed] = useState(false);
  const o = baseline.operation,
    read = useAssistanceRead<IntegrationView>(`${path(o.taskId)}/${o.id}`, 5000),
    command = useAssistanceCommand<IntegrationView>(saved),
    candidateRead = useAssistanceRead<IntegrationTrialDifferenceDetail>(
      candidate
        ? `${path(o.taskId)}/${o.id}/trials/${encodeURIComponent(candidate.report.trialId)}`
        : null,
      5000,
    );
  const canApply = candidate ? baseline.canTrial : baseline.canApply;
  const candidateUnavailable =
    !!candidate &&
    (!candidateRead.value || !!candidateRead.error || candidateRead.value.hash !== candidate.hash);
  useEffect(() => {
    if (command.denied || read.denied || candidateRead.denied) denied();
  }, [command.denied, read.denied, candidateRead.denied]);
  const locked = command.busy || !!command.uncertain,
    stale =
      !!read.value &&
      (read.value.taskRevision !== baseline.taskRevision ||
        read.value.operation.revision !== o.revision ||
        read.value.reportHash !== baseline.reportHash ||
        read.value.canApply !== baseline.canApply ||
        read.value.canTrial !== baseline.canTrial ||
        read.value.available !== baseline.available);
  if (!open || command.denied || read.denied || candidateRead.denied) return null;
  return (
    <Dialog
      title="确认选择性应用"
      drawer
      onClose={() => !command.busy && close(!!command.uncertain)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !paths.length ||
            !confirmed ||
            locked ||
            stale ||
            !read.value ||
            read.error ||
            !canApply ||
            !baseline.reportHash ||
            candidateUnavailable
          )
            return;
          void command.send(`${path(o.taskId)}/${o.id}/apply`, {
            expectedRevision: o.revision,
            expectedTaskRevision: baseline.taskRevision,
            reportHash: baseline.reportHash,
            paths,
            confirmApplication: true,
            ...(candidate
              ? {
                  candidate: {
                    trialId: candidate.report.trialId,
                    reportHash: candidate.hash,
                    manifestHash: candidate.report.manifestHash,
                    confirmExistingChanges: true,
                  },
                }
              : {}),
          });
        }}
      >
        <div className="dialog-body integration-form">
          <section aria-label="固定应用基线">
            <strong>
              {o.source.title} · v{o.source.revision}
            </strong>
            <p>此选择固定到当前预检报告，不跟随后续成果、任务修订或方案选择。</p>
            {candidate && (
              <section aria-label="固定写回候选">
                <strong>完整候选写回</strong>
                <p>
                  候选 <code>{candidate.report.trialId}</code>
                </p>
                <p>
                  共享差异 <code>{candidate.hash}</code>
                </p>
                <p>
                  本机清单 <code>{candidate.report.manifestHash}</code>
                </p>
                <IntegrationConflictDecisions
                  report={candidate.report}
                  plan={
                    candidate.report.preflightReportHash === baseline.reportHash
                      ? o.report?.plan
                      : null
                  }
                />
              </section>
            )}
            <dl className="integration-baseline">
              <dt>来源提交</dt>
              <dd>
                <code>{o.material.manifest.commit}</code>
              </dd>
              <dt>目标节点与目录</dt>
              <dd>
                {o.target.checkpoint.request.nodeName} / {o.target.checkpoint.request.workspaceName}
              </dd>
              <dt>目标提交</dt>
              <dd>
                <code>{o.target.manifest.commit}</code>
              </dd>
              <dt>恢复副本</dt>
              <dd>
                <code>{o.target.retentionId}</code> · 到期 {time(o.target.manifest.expiresAt)}
              </dd>
              <dt>固定预检报告</dt>
              <dd>
                <code>{baseline.reportHash}</code>
              </dd>
            </dl>
          </section>
          <p className="work-branch-notice">
            {candidate
              ? '另行授权此固定候选的完整新增、修改和删除范围；不能在此偷偷改变子集。原文件会保留在本人新指定的私有备份，候选不变。不自动合并冲突或清理现场；本机须确认其他写入者已停止，并重新核对完整材料与目标。'
              : '本轮支持无冲突的新增普通文件及必要的新父目录（最多256个）。修改、删除、冲突、目标已有文件与有省略的清单均不能选择；不覆盖或接管已有目录，不自动合并文本。'}
          </p>
          <fieldset className="integration-selection" disabled={locked}>
            <legend>{candidate ? '固定候选完整文件范围' : '选择新增文件'}</legend>
            <ul className="integration-files">
              {o.report?.plan?.files.map((file) => (
                <li key={file.path}>
                  <label className="integration-consent">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${file.path}`}
                      checked={paths.includes(file.path)}
                      disabled={
                        !!candidate || locked || !selectable(file) || !!o.report?.plan?.omittedFiles
                      }
                      onChange={(event) => {
                        setPaths((old) =>
                          event.target.checked
                            ? [...old, file.path].sort()
                            : old.filter((name) => name !== file.path),
                        );
                        setConfirmed(false);
                      }}
                    />
                    <span>
                      <span className="badge neutral">{fileLabels[file.action]}</span>{' '}
                      <code>{file.path}</code>
                      {!candidate && !selectable(file) && <span> · 本轮不可应用</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <section aria-label="本次应用路径">
            <strong>本次明确选择 {paths.length} 个文件</strong>
            <ul>
              {paths.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </section>
          <p>
            保存后仍需本人在目标节点确认，重新核对完整对象与目标现场并取得目录锁。不会自动提交代码、调用模型或标记任务完成。
          </p>
          <label className="integration-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || !paths.length}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {candidate
              ? '我已核对这个固定候选差异与完整路径，另行确认新增、替换和移出，并在本人节点指定私有备份'
              : '我已核对固定来源、目标、恢复点与所选路径，确认仅应用这些新增文件及必要的新父目录'}
          </label>
          {stale && !command.uncertain && (
            <p className="work-branch-notice">
              任务修订、预检状态或可用权限已变化，选择已保留。明确重新核对后才能提交。
            </p>
          )}
          {stale && read.value && !command.uncertain && (
            <Button
              type="button"
              disabled={locked || !!read.error}
              onClick={() => {
                const next = structuredClone(read.value!);
                setBaseline(next);
                if (!candidate)
                  setPaths((old) =>
                    old.filter((name) =>
                      next.operation.report?.plan?.files.some(
                        (file) => file.path === name && selectable(file),
                      ),
                    ),
                  );
                setConfirmed(false);
              }}
            >
              重新核对应用基线
            </Button>
          )}
          {!canApply && !command.uncertain && (
            <p role="status">当前记录不可提交应用，请查看最新操作状态和材料可用性。</p>
          )}
          {read.error && (
            <p role="alert">
              {read.error}
              <Button type="button" onClick={read.retry}>
                重读应用状态
              </Button>
            </p>
          )}
          {candidateRead.error && (
            <p role="alert">
              {candidateRead.error}
              <Button type="button" onClick={candidateRead.retry}>
                重读固定写回候选
              </Button>
            </p>
          )}
          {candidate && candidateRead.value && candidateRead.value.hash !== candidate.hash && (
            <p role="alert">候选证据与打开时不同，请关闭并从历史重新核对；不会替换原选择。</p>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section className="work-branch-notice" aria-label="应用请求待确认">
              <p>
                请求可能已保存。确认只会重发原报告、原路径、原修订和同一操作标识；关闭不会撤回请求，重新打开后可继续确认。
              </p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                确认上次应用请求
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={() => close(!!command.uncertain)}>
            关闭
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={command.busy}
            disabled={
              !paths.length ||
              !confirmed ||
              locked ||
              stale ||
              !read.value ||
              !!read.error ||
              !canApply ||
              !baseline.reportHash ||
              candidateUnavailable
            }
          >
            确认所选应用范围
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function Records({
  task,
  apply,
  pendingId,
  restoration,
  pendingRestoration,
  recompute,
  pendingRecomputeId,
  inspect,
  inspectId,
  denied,
  trial,
  selectedTrials,
  selectTrial,
}: {
  task: Task;
  apply(view: IntegrationView, candidate?: IntegrationTrialDifferenceDetail): void;
  pendingId?: string;
  restoration(view: IntegrationView, action: FileRestorationAction): void;
  pendingRestoration: FileRestorationEditorState | null;
  recompute(view: IntegrationView): void;
  pendingRecomputeId?: string;
  inspect(id: string | null): void;
  inspectId: string | null;
  denied(): void;
  trial(view: IntegrationView): void;
  selectedTrials: Record<string, string>;
  selectTrial(operationId: string, trialId: string): void;
}) {
  const read = useAssistanceRead<{ items: IntegrationView[] }>(
    inspectId ? null : path(task.id),
    5000,
  );
  const fixed = useAssistanceRead<IntegrationView>(
    inspectId ? `${path(task.id)}/${encodeURIComponent(inspectId)}` : null,
    5000,
  );
  const visible = inspectId
    ? { ...fixed, value: fixed.value ? { items: [fixed.value] } : null }
    : read;
  useEffect(() => {
    if (visible.denied) denied();
  }, [visible.denied]);
  if (visible.denied) return <p role="alert">读取权限已失效，预检内容已清除。</p>;
  return (
    <div className="dialog-body integration-form">
      {inspectId && <Button onClick={() => inspect(null)}>返回全部预检记录</Button>}
      <p>
        从固定成果版本的“准备代码整合”选择来源与目标。这里保留每次预检、独立应用、文件恢复与取消记录。
      </p>
      {visible.error && (
        <p role="alert">
          {visible.error}
          <Button onClick={visible.retry}>重读整合预检</Button>
        </p>
      )}
      {visible.value ? (
        visible.value.items.length ? (
          visible.value.items.map((v) => (
            <Record
              key={v.operation.id}
              view={v}
              saved={visible.retry}
              apply={apply}
              pendingId={pendingId}
              restoration={restoration}
              pendingRestoration={pendingRestoration}
              recompute={recompute}
              pendingRecomputeId={pendingRecomputeId}
              inspect={inspect}
              trial={trial}
              selectedTrialId={selectedTrials[v.operation.id]}
              selectTrial={(trialId) => selectTrial(v.operation.id, trialId)}
              denied={denied}
            />
          ))
        ) : (
          <p>尚无整合预检。</p>
        )
      ) : (
        <p role="status">正在读取预检…</p>
      )}
    </div>
  );
}
function Entry({ task }: { task: Task }) {
  const { data } = useApp();
  const [open, setOpen] = useState(false),
    [recompute, setRecompute] = useState<IntegrationView | null>(null),
    [recomputeOpen, setRecomputeOpen] = useState(false),
    [inspectId, setInspectId] = useState<string | null>(null),
    [application, setApplication] = useState<IntegrationView | null>(null),
    [applicationOpen, setApplicationOpen] = useState(false),
    [restoration, setRestoration] = useState<FileRestorationEditorState | null>(null),
    [restorationOpen, setRestorationOpen] = useState(false),
    [applicationCandidate, setApplicationCandidate] =
      useState<IntegrationTrialDifferenceDetail | null>(null),
    [trial, setTrial] = useState<IntegrationView | null>(null),
    [selectedTrials, setSelectedTrials] = useState<Record<string, string>>({}),
    [revoked, setRevoked] = useState(false);
  const editable = canEditTask(data, task);
  useEffect(() => {
    if (!editable) {
      setRecompute(null);
      setRecomputeOpen(false);
      setApplication(null);
      setApplicationCandidate(null);
      setApplicationOpen(false);
      setRestoration(null);
      setRestorationOpen(false);
      setTrial(null);
    }
  }, [editable]);
  const denied = () => {
    setRecompute(null);
    setRecomputeOpen(false);
    setInspectId(null);
    setApplication(null);
    setApplicationCandidate(null);
    setApplicationOpen(false);
    setRestoration(null);
    setRestorationOpen(false);
    setTrial(null);
    setSelectedTrials({});
    setRevoked(true);
    setOpen(true);
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>整合预检</Button>
      {open && (
        <Dialog title="任务整合预检" drawer onClose={() => setOpen(false)}>
          {revoked ? (
            <p role="alert" className="dialog-body">
              读取或操作权限已失效，整合内容已清除。
            </p>
          ) : (
            <Records
              task={task}
              pendingId={application?.operation.id}
              pendingRestoration={restoration}
              pendingRecomputeId={recompute?.operation.id}
              inspectId={inspectId}
              inspect={setInspectId}
              recompute={(view) => {
                if (
                  !editable ||
                  application ||
                  restoration ||
                  (recompute && recompute.operation.id !== view.operation.id)
                )
                  return;
                if (!recompute) setRecompute(structuredClone(view));
                setOpen(false);
                setRecomputeOpen(true);
              }}
              restoration={(view, action) => {
                if (
                  !editable ||
                  recompute ||
                  application ||
                  (restoration &&
                    (restoration.view.operation.id !== view.operation.id ||
                      restoration.action !== action))
                )
                  return;
                if (!restoration) setRestoration({ view: structuredClone(view), action });
                setOpen(false);
                setRestorationOpen(true);
              }}
              denied={denied}
              selectedTrials={selectedTrials}
              selectTrial={(operationId, trialId) =>
                setSelectedTrials((old) => ({ ...old, [operationId]: trialId }))
              }
              trial={(view) => {
                if (!editable || application || restoration || recompute) return;
                setTrial(structuredClone(view));
                setOpen(false);
              }}
              apply={(view, candidate) => {
                if (
                  !editable ||
                  recompute ||
                  restoration ||
                  (application && application.operation.id !== view.operation.id)
                )
                  return;
                if (!application) {
                  setApplication(structuredClone(view));
                  setApplicationCandidate(candidate ? structuredClone(candidate) : null);
                }
                setOpen(false);
                setApplicationOpen(true);
              }}
            />
          )}
        </Dialog>
      )}
      {recompute && (
        <IntegrationRecomputeEditor
          key={recompute.operation.id}
          initial={recompute}
          open={recomputeOpen}
          denied={denied}
          close={(keepPending) => {
            setRecomputeOpen(false);
            if (!keepPending) setRecompute(null);
            setOpen(true);
          }}
          saved={(created) => {
            setRecompute(null);
            setRecomputeOpen(false);
            setInspectId(created.operation.id);
            setOpen(true);
          }}
        />
      )}
      {application && (
        <ApplicationEditor
          key={application.operation.id}
          initial={application}
          candidate={applicationCandidate}
          open={applicationOpen}
          denied={denied}
          close={(keepPending) => {
            setApplicationOpen(false);
            if (!keepPending) {
              setApplication(null);
              setApplicationCandidate(null);
            }
            setOpen(true);
          }}
          saved={() => {
            setApplication(null);
            setApplicationCandidate(null);
            setApplicationOpen(false);
            setOpen(true);
          }}
        />
      )}
      {restoration && (
        <FileRestorationEditor
          key={`${restoration.view.operation.id}:${restoration.action}`}
          initial={restoration.view}
          action={restoration.action}
          open={restorationOpen}
          denied={denied}
          close={(keepPending) => {
            setRestorationOpen(false);
            if (!keepPending) setRestoration(null);
            setOpen(true);
          }}
          saved={() => {
            setRestoration(null);
            setRestorationOpen(false);
            setOpen(true);
          }}
        />
      )}
      {trial && (
        <IntegrationTrialEditor
          key={trial.operation.id}
          initial={trial}
          denied={denied}
          close={() => {
            setTrial(null);
            setOpen(true);
          }}
        />
      )}
    </>
  );
}
export function TaskIntegrations({ task }: { task: Task }) {
  const { data } = useApp();
  return data.mode === 'team-local' && task.projectId && task.visibility === 'project' ? (
    <Entry key={`${data.user.id}:${data.space?.id}:${task.id}`} task={task} />
  ) : null;
}
