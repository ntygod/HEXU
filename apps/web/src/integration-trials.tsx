import { useEffect, useState } from 'react';
import type {
  IntegrationFile,
  IntegrationView,
} from '../../../packages/contracts/src/integrations.js';
import type {
  IntegrationTrialDifferenceDetail,
  IntegrationTrialDifferenceSummary,
} from '../../../packages/contracts/src/integration-trial.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { CodeDifferencePanel } from './result-code.js';
import { time } from './state.js';
import {
  integrationTrialCommand,
  integrationTrialDifferenceCommand,
  sortTrialPaths,
} from './integration-trial-command.js';
import './integration-trials.css';

const integrationPath = (view: IntegrationView) =>
  `/tasks/${encodeURIComponent(view.operation.taskId)}/integrations/${encodeURIComponent(view.operation.id)}`;
const actionLabels = {
  add: '新增',
  modify: '修改',
  delete: '删除',
  already_present: '目标已有',
  conflict: '冲突',
};
const selectable = (file: IntegrationFile) =>
  !file.conflict && ['add', 'modify', 'delete'].includes(file.action);

export function IntegrationTrialEditor({
  initial,
  close,
  denied,
}: {
  initial: IntegrationView;
  close(): void;
  denied(): void;
}) {
  const [baseline, setBaseline] = useState(() => structuredClone(initial));
  const [paths, setPaths] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const read = useAssistanceRead<IntegrationView>(integrationPath(initial), 5000);
  const o = baseline.operation;
  useEffect(() => {
    if (read.denied) denied();
  }, [read.denied]);
  const stale =
    !!read.value &&
    (read.value.taskRevision !== baseline.taskRevision ||
      read.value.operation.revision !== o.revision ||
      read.value.reportHash !== baseline.reportHash ||
      read.value.canTrial !== baseline.canTrial ||
      read.value.available !== baseline.available);
  const usable =
    !!read.value && !read.error && !stale && !!baseline.canTrial && !!baseline.reportHash;
  if (read.denied) return null;
  return (
    <Dialog title="准备独立试应用" drawer onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (usable && paths.length && confirmed) setCommand(integrationTrialCommand(o.id, paths));
        }}
      >
        <div className="dialog-body integration-form">
          <section aria-label="固定试应用基线">
            <strong>
              {o.source.title} · v{o.source.revision}
            </strong>
            <p>
              所选文件固定到此预检；候选在新的独立目录组合完整目标与所选来源，原目标目录保持不变。
            </p>
            <dl className="integration-baseline">
              <dt>来源提交</dt>
              <dd>
                <code>{o.material.manifest.commit}</code>
              </dd>
              <dt>目标节点与目录</dt>
              <dd>
                {o.target.checkpoint.request.nodeName} / {o.target.checkpoint.request.workspaceName}
              </dd>
              <dt>原目标提交</dt>
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
            试应用可选择无冲突的新增、修改和删除；未选文件保留目标内容。冲突、目标已有文件及有省略的预检不能选择，不自动合并文本。
          </p>
          <fieldset className="integration-selection">
            <legend>选择试应用文件</legend>
            <ul className="integration-files">
              {o.report?.plan?.files.map((file) => (
                <li key={file.path}>
                  <label className="integration-consent">
                    <input
                      type="checkbox"
                      aria-label={`试应用 ${file.path}`}
                      checked={paths.includes(file.path)}
                      disabled={!selectable(file) || !!o.report?.plan?.omittedFiles}
                      onChange={(event) => {
                        setPaths((old) =>
                          event.target.checked
                            ? sortTrialPaths([...old, file.path])
                            : old.filter((name) => name !== file.path),
                        );
                        setConfirmed(false);
                        setCommand(null);
                      }}
                    />
                    <span>
                      <span className="badge neutral">{actionLabels[file.action]}</span>{' '}
                      <code>{file.path}</code>
                      {!selectable(file) && <span> · 不可试应用</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <p role="status">
            本次明确选择 {paths.length} 个文件；这里只生成本机命令，尚未执行或共享。
          </p>
          <label className="integration-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!paths.length}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                setCommand(null);
              }}
            />
            我已核对固定来源、原目标与所选路径，仅生成独立试应用命令
          </label>
          {stale && (
            <p className="work-branch-notice">
              任务修订、预检状态或可用权限已变化，选择已保留。明确重新核对后才能生成命令。
            </p>
          )}
          {stale && read.value && (
            <Button
              type="button"
              disabled={!!read.error}
              onClick={() => {
                const next = structuredClone(read.value!);
                setBaseline(next);
                setPaths((old) =>
                  old.filter((name) =>
                    next.operation.report?.plan?.files.some(
                      (file) => file.path === name && selectable(file),
                    ),
                  ),
                );
                setConfirmed(false);
                setCommand(null);
              }}
            >
              重新核对试应用基线
            </Button>
          )}
          {!baseline.canTrial && (
            <p role="status">
              当前不可生成新候选，请核对操作状态与材料权限。已共享的候选历史仍可查看。
            </p>
          )}
          {read.error && (
            <p role="alert">
              {read.error}
              <Button type="button" onClick={read.retry}>
                重读试应用状态
              </Button>
            </p>
          )}
          {command && (
            <section className="integration-trial-command" aria-label="本机试应用命令">
              <strong>在原目标 Linux 节点执行</strong>
              {!usable && (
                <p role="alert">
                  当前基线尚未重新确认。保留的命令仅供核对，请先恢复读取并重新核对。
                </p>
              )}
              <p>
                先替换带单引号的目录占位符：使用原节点状态目录，以及尚不存在的新的绝对目录。相对文件路径已作为完整
                JSON 参数进行 shell 转义。
              </p>
              <pre>{command}</pre>
              <ol>
                <li>
                  在终端核对固定材料和路径，再输入 TRIAL {o.id}
                  确认创建私有候选。页面没有创建服务端试应用请求。
                </li>
                <li>
                  仅本机明确返回 ready 的候选可继续；失败、中断或未知状态不能根据目录存在推断成功。
                </li>
                <li>
                  使用本机返回的 trialId 执行差异命令；先确认 DIFF_TRIAL
                  读取并比较，再查看有界内容并确认 SHARE_TRIAL_DIFF 共享到当前任务。
                </li>
              </ol>
              <pre aria-label="本机候选差异命令">{integrationTrialDifferenceCommand(o.id)}</pre>
              <p>
                试应用与共享均不写回原目录，不自动应用、提交代码、调用模型或完成任务。关闭此页不会停止你已在终端启动的动作。
              </p>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={close}>
            取消并返回
          </Button>
          <Button type="submit" variant="primary" disabled={!usable || !paths.length || !confirmed}>
            生成本机试应用命令
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function IntegrationTrialHistory({
  view,
  selectedTrialId,
  selectTrial,
  applyCandidate,
  denied,
}: {
  view: IntegrationView;
  selectedTrialId?: string;
  selectTrial?(id: string): void;
  applyCandidate?(candidate: IntegrationTrialDifferenceDetail): void;
  denied?(): void;
}) {
  const base = `${integrationPath(view)}/trials`;
  const list = useAssistanceRead<{ items: IntegrationTrialDifferenceSummary[] }>(base, 5000);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = selectedTrialId ?? localSelected;
  const choose = (id: string) => {
    setLocalSelected(id);
    selectTrial?.(id);
  };
  const detail = useAssistanceRead<IntegrationTrialDifferenceDetail>(
    selected ? `${base}/${encodeURIComponent(selected)}` : null,
    5000,
  );
  useEffect(() => {
    if (!selected && list.value?.items[0]) choose(list.value.items[0].trialId);
  }, [selected, list.value]);
  useEffect(() => {
    if (list.denied || detail.denied) {
      setLocalSelected(null);
      denied?.();
    }
  }, [list.denied, detail.denied]);
  if (list.denied || detail.denied)
    return <p role="alert">读取权限已失效，候选选择与差异内容已清除。</p>;
  const latest = list.value?.items[0];
  const report = detail.value?.report;
  const selectedSummary = list.value?.items.find((item) => item.trialId === selected);
  return (
    <section className="integration-trial-history" aria-label="试应用候选差异">
      <header>
        <strong>试应用候选差异</strong>
        <span className="badge neutral">独立候选 · 不授权写回</span>
      </header>
      <p>
        每个候选按 trialId
        固定保存共享内容；这是当时的有界文本记录，不表示目录现在仍存在或材料仍有效。
      </p>
      {list.error && (
        <p role="alert">
          {list.error}
          <Button onClick={list.retry}>重读候选历史</Button>
        </p>
      )}
      {!list.value && !list.error && <p role="status">正在读取候选历史…</p>}
      {list.value && !list.value.items.length && (
        <p>尚无已共享候选。本机试应用完成后，需要另行明确确认共享差异才会出现在这里。</p>
      )}
      {!!list.value?.items.length && (
        <>
          <label className="field">
            查看固定候选
            <select
              aria-label="查看固定候选"
              value={selected ?? ''}
              onChange={(event) => choose(event.target.value)}
            >
              {!selected && (
                <option value="" disabled>
                  选择候选
                </option>
              )}
              {selected && !selectedSummary && (
                <option value={selected}>正在查看的历史候选 · {selected}</option>
              )}
              {list.value.items.map((item) => (
                <option key={item.trialId} value={item.trialId}>
                  {item.trialId} · {item.changedFiles} 个文件 · 共享 {time(item.receivedAt)}
                </option>
              ))}
            </select>
          </label>
          {latest && selected && latest.trialId !== selected && (
            <div className="work-branch-notice" role="status">
              <p>有更新的已共享候选，当前仍固定查看所选 trialId。</p>
              <Button onClick={() => choose(latest.trialId)}>查看最新候选</Button>
            </div>
          )}
        </>
      )}
      {selected && detail.error && (
        <p role="alert">
          {detail.error}
          <Button onClick={detail.retry}>重读所选候选</Button>
        </p>
      )}
      {selected && !detail.value && !detail.error && <p role="status">正在读取所选候选…</p>}
      {report && (
        <section className="integration-trial-detail" aria-label="固定候选详情">
          <dl className="integration-baseline">
            <dt>候选 trialId</dt>
            <dd>
              <code>{report.trialId}</code>
            </dd>
            <dt>本机生成 / 比较</dt>
            <dd>
              {time(report.materializedAt)} / {time(report.comparedAt)}
            </dd>
            <dt>共享收到时间</dt>
            <dd>{time(detail.value!.receivedAt)}</dd>
            <dt>原目标提交 → 候选所选来源</dt>
            <dd>
              <code>{view.operation.target.manifest.commit}</code> →{' '}
              <code>{view.operation.material.manifest.commit}</code>
            </dd>
            <dt>固定清单指纹</dt>
            <dd>
              <code>{report.manifestHash}</code>
            </dd>
            <dt>共享内容指纹</dt>
            <dd>
              <code>{detail.value!.hash}</code>
            </dd>
          </dl>
          <details>
            <summary>完整选择范围（{report.selectedPaths.length}个文件）</summary>
            <ul>
              {report.selectedPaths.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </details>
          {applyCandidate && view.canTrial && (
            <Button
              variant="primary"
              disabled={!!list.error || !!detail.error || report.trialId !== selected}
              onClick={() => applyCandidate(structuredClone(detail.value!))}
            >
              确认写回此候选
            </Button>
          )}
          <CodeDifferencePanel
            key={report.trialId}
            difference={report.difference}
            title="查看原目标与候选差异"
            beforeLabel="原目标文件"
            afterLabel="候选文件"
            emptyLabel="此候选没有普通文件变化。"
          >
            <p>
              节点当时核对完整固定对象及 ready 候选后明确共享。最多展示40个文件、24 KiB差异及单侧8
              KiB正文；内容不执行，也不能作为完整补丁或写入授权。
            </p>
          </CodeDifferencePanel>
        </section>
      )}
    </section>
  );
}
