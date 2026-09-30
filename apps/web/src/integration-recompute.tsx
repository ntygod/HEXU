import { useEffect, useState } from 'react';
import type { IntegrationView } from '../../../packages/contracts/src/integrations.js';
import type { IntegrationRecomputeOptions } from '../../../packages/contracts/src/integration-recompute.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { Link, time, useApp } from './state.js';

/** A new read-only operation, never a reset of the old report or its choices. */
export function IntegrationRecomputeEditor({
  initial,
  open,
  close,
  saved,
  denied,
}: {
  initial: IntegrationView;
  open: boolean;
  close(keepPending: boolean): void;
  saved(view: IntegrationView): void;
  denied(): void;
}) {
  const { data } = useApp(),
    o = initial.operation;
  const url = `/tasks/${encodeURIComponent(o.taskId)}/integrations/${encodeURIComponent(o.id)}`;
  const read = useAssistanceRead<IntegrationRecomputeOptions>(`${url}/recompute-options`, 5000);
  const [baseline, setBaseline] = useState<IntegrationRecomputeOptions | null>(null),
    [targetId, setTargetId] = useState(''),
    [materialId, setMaterialId] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const command = useAssistanceCommand<IntegrationView>(saved);
  useEffect(() => {
    if (!baseline && read.value) setBaseline(structuredClone(read.value));
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied || command.denied) denied();
  }, [read.denied, command.denied]);
  const target = baseline?.targets.find((t) => t.target.retentionId === targetId),
    material = target?.materials.find((m) => `${m.kind}:${m.id}` === materialId),
    currentTarget = read.value?.targets.find((t) => t.target.retentionId === targetId),
    currentMaterial = currentTarget?.materials.find((m) => `${m.kind}:${m.id}` === materialId),
    task = data.tasks.find((t) => t.id === o.taskId),
    locked = command.busy || !!command.uncertain,
    stale =
      !!baseline &&
      ((!!task && task.revision > baseline.taskRevision) ||
        (!!read.value &&
          (baseline.taskRevision !== read.value.taskRevision ||
            baseline.originalRevision !== read.value.originalRevision ||
            baseline.reportHash !== read.value.reportHash ||
            JSON.stringify(baseline.source) !== JSON.stringify(read.value.source) ||
            JSON.stringify(baseline.originalTarget) !== JSON.stringify(read.value.originalTarget) ||
            (!!target && JSON.stringify(target.target) !== JSON.stringify(currentTarget?.target)) ||
            (!!material && JSON.stringify(material) !== JSON.stringify(currentMaterial))))),
    disabled =
      !baseline ||
      !target ||
      !material ||
      !confirmed ||
      locked ||
      stale ||
      !read.value ||
      !!read.error;
  const refreshBaseline = () => {
    if (!read.value || read.error || locked) return;
    const newer = read.value.targets.find((t) => t.target.retentionId === targetId);
    if (!newer) {
      setTargetId('');
      setMaterialId('');
    } else if (!newer.materials.some((m) => `${m.kind}:${m.id}` === materialId)) setMaterialId('');
    setBaseline(structuredClone(read.value));
    setConfirmed(false);
  };
  if (!open || read.denied || command.denied) return null;
  return (
    <Dialog
      title="使用新目标重新预检"
      drawer
      onClose={() => !command.busy && close(!!command.uncertain)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !baseline || !target || !material) return;
          void command.send(`${url}/recompute`, {
            expectedRevision: baseline.originalRevision,
            expectedTaskRevision: baseline.taskRevision,
            reportHash: baseline.reportHash,
            targetCheckpointId: target.target.checkpoint.id,
            targetRetentionId: targetId,
            sourceMaterial: { kind: material.kind, id: material.id },
            confirmPreflight: true,
          });
        }}
      >
        <div className="dialog-body integration-form">
          <section aria-label="重新预检固定来源">
            <strong>
              {o.source.title} · v{o.source.revision}
            </strong>
            <p>
              继续使用这条记录的原成果版本和共同起点，不跟随最新版本。原报告、候选、冲突选择、应用与恢复记录保持不变。
            </p>
            <dl className="integration-baseline">
              <dt>原预检</dt>
              <dd>
                <code>{o.id}</code>
              </dd>
              <dt>固定成果版本</dt>
              <dd>
                <code>{o.source.revisionId}</code>
              </dd>
              <dt>来源提交</dt>
              <dd>
                <code>{o.source.code.checkpoint.manifest.commit}</code>
              </dd>
              <dt>共同起点</dt>
              <dd>
                <code>{o.source.code.base.commit}</code>
              </dd>
              <dt>原本人节点与目录</dt>
              <dd>
                {o.target.checkpoint.request.nodeName} / {o.target.checkpoint.request.workspaceName}
              </dd>
              <dt>原目标提交（历史）</dt>
              <dd>
                <code>{o.target.manifest.commit}</code>
              </dd>
              <dt>原恢复副本（历史）</dt>
              <dd>
                <code>{o.target.retentionId}</code>
              </dd>
            </dl>
            <Link to={`/results/${o.source.resultId}/versions/${o.source.revisionId}`}>
              查看原固定成果版本
            </Link>
          </section>
          <p className="work-branch-notice">
            新目标只限同一本人节点、目录和仓库身份。请先明确处理现场，并为已有提交记录新检查点、保留完整对象；来源在其他节点时需另行传输并确认接收。不自动提交、重置、暂存或清理用户修改。
          </p>
          {!baseline && !read.error && <p role="status">正在读取同目录的新目标…</p>}
          {baseline && !baseline.targets.length && (
            <p role="status">
              尚无可用的新目标与来源副本。请通过现有检查点和保留/传输入口准备材料，再重读选项并重新核对。
            </p>
          )}
          {!!baseline?.targets.length && (
            <>
              <label className="field">
                同目录的新检查点与恢复副本
                <select
                  aria-label="同目录的新检查点与恢复副本"
                  value={targetId}
                  disabled={locked}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setMaterialId('');
                    setConfirmed(false);
                  }}
                >
                  <option value="">请选择新目标，不沿用原目标</option>
                  {baseline.targets.map(({ target: t }) => (
                    <option key={t.retentionId} value={t.retentionId}>
                      {t.checkpoint.request.label} · {t.manifest.commit.slice(0, 12)} · 副本{' '}
                      {t.retentionId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              {target && (
                <section aria-label="新目标固定范围">
                  <dl className="integration-baseline">
                    <dt>新检查点</dt>
                    <dd>
                      <code>{target.target.checkpoint.id}</code>
                    </dd>
                    <dt>新目标提交</dt>
                    <dd>
                      <code>{target.target.manifest.commit}</code>
                    </dd>
                    <dt>新恢复副本</dt>
                    <dd>
                      <code>{targetId}</code> · 到期 {time(target.target.manifest.expiresAt)}
                    </dd>
                  </dl>
                  <label className="field">
                    原来源版本的完整对象
                    <select
                      aria-label="原来源版本的完整对象"
                      value={materialId}
                      disabled={locked}
                      onChange={(e) => {
                        setMaterialId(e.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">请选择当前有效副本</option>
                      {target.materials.map((m) => (
                        <option key={`${m.kind}:${m.id}`} value={`${m.kind}:${m.id}`}>
                          {m.kind === 'transfer' ? '已确认接收' : '本节点保留'} · {m.id.slice(0, 8)}{' '}
                          · 到期 {time(m.manifest.expiresAt)}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
              )}
              <label className="integration-consent">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对固定原来源、同目录的新目标与恢复副本，仅创建另一条只读预检
              </label>
            </>
          )}
          <p>
            保存后仍需本人在原 Linux
            节点重新确认读取和共享预检。试应用、冲突处理与写回都需在新报告中重新选择并确认。
          </p>
          {stale && (
            <p className="work-branch-notice">
              原记录、任务修订或所选材料已变化，原选择已保留。明确重新核对后才能创建新预检。
            </p>
          )}
          {read.error && <p role="alert">{read.error}。选项暂不用于新提交，已输入内容保留。</p>}
          {!command.uncertain && (
            <div className="inline-actions">
              <Button type="button" disabled={locked} onClick={read.retry}>
                重读重新预检选项
              </Button>
              <Button
                type="button"
                disabled={locked || !read.value || !!read.error}
                onClick={refreshBaseline}
              >
                重新核对新目标基线
              </Button>
            </div>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section className="work-branch-notice" aria-label="重新预检请求待确认">
              <p>
                保存结果尚未确认。只确认上次相同来源、新目标、请求体与操作标识；关闭不会撤回已保存记录。
              </p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                确认上次重新预检请求
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={command.busy} onClick={() => close(!!command.uncertain)}>
            关闭
          </Button>
          <Button type="submit" variant="primary" busy={command.busy} disabled={disabled}>
            创建新的只读预检
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
