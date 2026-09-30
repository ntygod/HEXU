import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../../packages/contracts/src/results.js';
import type {
  IntegrationView,
  IntegrationOptions,
  IntegrationReason,
} from '../../../packages/contracts/src/integrations.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { Link, canEditTask, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import './integrations.css';

const path = (taskId: string) => `/tasks/${taskId}/integrations`;
const stateLabels = {
  queued: '等待本人预检',
  awaiting_choice: '预检已记录 · 尚未应用',
  conflict: '有冲突或清单省略',
  failed: '预检受阻',
  cancelled: '已取消预检',
};
const reasons: Record<IntegrationReason, string> = {
  target_changed: '目标HEAD、索引或文件与固定提交不一致',
  workspace_busy: '目录仍有活动或未知写入',
  objects_unavailable: '完整对象缺失、损坏或到期',
  unsupported_snapshot: '包含不支持的文件类型或路径',
  budget_exceeded: '完整对象超过本轮预检预算',
  preflight_failed: '本机预检未完成，请核对材料与连接',
};
function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && <p role="alert">{command.error}</p>}
      {command.uncertain && (
        <section className="work-branch-notice" aria-label="整合预检请求待确认">
          <p>结果尚未确认。只会重发原来源、目标与操作标识；关闭窗口不会撤回已保存记录。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次预检请求
          </Button>
        </section>
      )}
    </>
  );
}
function Record({ view, saved }: { view: IntegrationView; saved(): void }) {
  const o = view.operation,
    report = o.report,
    plan = report?.plan;
  const command = useAssistanceCommand(saved);
  const labels = {
    add: '新增',
    modify: '修改',
    delete: '删除',
    already_present: '目标已有',
    conflict: '冲突',
  };
  return (
    <article className="integration-record" aria-label={`整合预检：${o.source.title}`}>
      <header>
        <strong>
          {o.source.title} · v{o.source.revision}
        </strong>
        <span
          className={`badge ${o.state === 'conflict' || o.state === 'failed' ? 'warning' : 'neutral'}`}
        >
          {stateLabels[o.state]}
        </span>
      </header>
      <p>
        {o.source.branchName} → {o.target.checkpoint.request.nodeName} /{' '}
        {o.target.checkpoint.request.workspaceName}
      </p>
      <p>
        {o.createdBy.name} · {time(o.createdAt)}
      </p>
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
          当前不可继续核验：{view.unavailableReason}。原记录保留。
        </p>
      )}
      {o.state === 'queued' && view.available && (
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
                    {labels[f.action]}
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
      <p>仅记录只读预检，代码尚未应用。后续写入需要独立确认并重新核对现场。</p>
      <details>
        <summary>操作历史（{o.history.length}）</summary>
        <ol>
          {o.history.map((e) => (
            <li key={e.revision}>
              {stateLabels[e.state]} · {time(e.at)}
            </li>
          ))}
        </ol>
      </details>
      {view.canCancel && !command.denied && (
        <Button
          disabled={command.busy || !!command.uncertain}
          onClick={() =>
            void command.send(`${path(o.taskId)}/${o.id}/cancel`, { expectedRevision: o.revision })
          }
        >
          取消此预检
        </Button>
      )}
      <Feedback command={command} />
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
function Records({ task }: { task: Task }) {
  const read = useAssistanceRead<{ items: IntegrationView[] }>(path(task.id), 5000);
  if (read.denied) return <p role="alert">读取权限已失效，预检内容已清除。</p>;
  return (
    <div className="dialog-body integration-form">
      <p>从固定成果版本的“准备代码整合”选择来源与目标。这里保留每次预检和取消记录。</p>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读整合预检</Button>
        </p>
      )}
      {read.value ? (
        read.value.items.length ? (
          read.value.items.map((v) => <Record key={v.operation.id} view={v} saved={read.retry} />)
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>整合预检</Button>
      {open && (
        <Dialog title="任务整合预检" drawer onClose={() => setOpen(false)}>
          <Records task={task} />
        </Dialog>
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
