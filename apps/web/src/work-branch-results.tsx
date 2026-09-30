import { useEffect, useState } from 'react';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import {
  parseBranchResult,
  type BranchResultPreview,
} from '../../../packages/contracts/src/results.js';
import { Button } from '../../../packages/ui/src/index.js';
import { Link, time } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { ResultSource } from './result-source.js';

function Editor({
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
  const read = useAssistanceRead<BranchResultPreview>(path + '/result-preview');
  const [baseline, setBaseline] = useState<BranchResultPreview | null>(null);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [limitations, setLimitations] = useState('');
  const [codeCheckpointId, setCodeCheckpointId] = useState(''),
    [codeRetentionId, setCodeRetentionId] = useState('');
  const command = useAssistanceCommand(saved);
  useEffect(() => {
    if (!baseline && read.value) {
      setBaseline(structuredClone(read.value));
      setTitle(read.value.previous?.title ?? `${read.value.source.branchName} · 成果说明`);
      setBody(read.value.previous?.body ?? '');
      setLimitations(read.value.previous?.limitations ?? '');
    }
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied || command.denied) denied();
  }, [read.denied, command.denied]);
  if (read.denied || command.denied) return null;
  const stale =
    !!baseline &&
    !!read.value &&
    (baseline.branchRevision !== read.value.branchRevision ||
      baseline.source.run.revision !== read.value.source.run.revision);
  const locked = !baseline || command.busy || !!command.uncertain || !!read.error;
  const codeOptions = read.value?.codeOptions ?? baseline?.codeOptions ?? [];
  const codeOption = codeOptions.find((v) => v.checkpoint.id === codeCheckpointId);
  const invalidCode =
    !!codeCheckpointId &&
    (!codeOption ||
      (!!codeRetentionId && !codeOption.retentions.some((v) => v.request.id === codeRetentionId)));
  let payload: ReturnType<typeof parseBranchResult> | null = null,
    validation = '';
  if (baseline && title.trim() && body.trim()) {
    try {
      payload = parseBranchResult({
        expectedRevision: baseline.branchRevision,
        expectedResultRevision: baseline.resultRevision,
        sourceRunId: baseline.source.run.id,
        expectedRunRevision: baseline.source.run.revision,
        title,
        body,
        limitations,
        ...(codeCheckpointId
          ? { codeCheckpointId, ...(codeRetentionId ? { codeRetentionId } : {}) }
          : {}),
      });
    } catch (e) {
      validation = (e as Error).message;
    }
  }
  return (
    <form
      className="work-branch-editor"
      aria-label="保存方案成果版本"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && !invalidCode && payload)
          void command.send(path + '/results', payload);
      }}
    >
      <h3>保存固定版本</h3>
      {baseline ? (
        <ResultSource source={baseline.source} />
      ) : (
        <p role="status">正在读取来源执行…</p>
      )}
      <label className="field">
        成果标题
        <input
          aria-label="方案成果标题"
          value={title}
          maxLength={160}
          required
          disabled={locked}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        成果说明
        <textarea
          aria-label="方案成果说明"
          value={body}
          maxLength={6000}
          required
          rows={5}
          disabled={locked}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="field">
        已知限制（可选）
        <textarea
          aria-label="方案成果已知限制"
          value={limitations}
          maxLength={2000}
          rows={2}
          disabled={locked}
          onChange={(e) => setLimitations(e.target.value)}
        />
      </label>
      <section className="branch-code-selection" aria-label="成果代码来源">
        <label className="field">
          固定代码引用（可选）
          <select
            aria-label="成果代码引用"
            value={codeCheckpointId}
            disabled={locked}
            onChange={(e) => {
              setCodeCheckpointId(e.target.value);
              setCodeRetentionId('');
            }}
          >
            <option value="">仅保存文字与执行来源</option>
            {codeCheckpointId && !codeOption && (
              <option value={codeCheckpointId}>原选择已不可用，请重新核对</option>
            )}
            {codeOptions.map((v) => (
              <option key={v.checkpoint.id} value={v.checkpoint.id}>
                {v.checkpoint.request.label} · {v.checkpoint.manifest.commit.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <p>
          只列出本人在此方案节点、此Run结束后明确记录的提交。未提交文件不包含；没有引用时，可先回「代码检查点」记录，再重新打开成果编辑。
        </p>
        {codeOption && (
          <>
            <code>{codeOption.checkpoint.manifest.commit}</code>
            <p>这是保存者选择的提交，可能包含执行结束后的人工修改，不代表全部由该Run生成。</p>
            <label className="field">
              关联对象副本（可选）
              <select
                aria-label="成果对象副本"
                value={codeRetentionId}
                disabled={locked}
                onChange={(e) => setCodeRetentionId(e.target.value)}
              >
                <option value="">仅记录提交引用，不声明备份</option>
                {codeRetentionId &&
                  !codeOption.retentions.some((v) => v.request.id === codeRetentionId) && (
                    <option value={codeRetentionId}>原副本已不可用</option>
                  )}
                {codeOption.retentions.map((v) => (
                  <option key={v.request.id} value={v.request.id}>
                    保留至 {time(v.manifest!.expiresAt)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {invalidCode && <p role="alert">所选引用或副本已变化，请重新核对代码来源。</p>}
      </section>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button type="button" onClick={read.retry}>
            重读成果来源
          </Button>
        </p>
      )}
      {stale && (
        <section className="work-branch-notice" aria-label="成果版本变化">
          <p>
            此方案已有变化，当前填写保留。最新成果为 v{read.value?.resultRevision}：
            {read.value?.previous?.title ?? '尚未保存'}。
          </p>
          {read.value?.previous && <p className="work-branch-text">{read.value.previous.body}</p>}
          <Button
            type="button"
            disabled={locked}
            onClick={() => setBaseline(structuredClone(read.value))}
          >
            已核对，基于最新版本保存
          </Button>
        </section>
      )}
      {(validation || command.error) && <p role="alert">{validation || command.error}</p>}
      {command.uncertain && (
        <section className="work-branch-notice" aria-label="成果保存待确认">
          <p>保存结果尚未确认。确认将重发原说明、来源、修订和操作标识。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次成果保存
          </Button>
        </section>
      )}
      <p>保存后可查看和讨论此版本，不会选中方案、整合代码或完成任务。</p>
      <div className="work-branch-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || stale || invalidCode || !payload}
        >
          保存成果版本
        </Button>
        <Button type="button" disabled={command.busy} onClick={close}>
          关闭成果编辑
        </Button>
      </div>
    </form>
  );
}
export function BranchResult({
  branch,
  path,
  editable,
  saved,
}: {
  branch: WorkBranch;
  path: string;
  editable: boolean;
  saved(): void;
}) {
  const [editing, setEditing] = useState(false),
    [revoked, setRevoked] = useState(false);
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  const run = branch.run;
  const terminal =
    run &&
    ['succeeded', 'failed', 'cancelled'].includes(run.state) &&
    run.observation === 'fresh' &&
    run.node?.terminationConfirmed;
  return (
    <section className="branch-result" aria-label="方案成果">
      {branch.result && branch.resultId && (
        <>
          <Link
            className="branch-result-link"
            to={`/results/${branch.resultId}/versions/${branch.result.id}`}
          >
            {branch.result.title} · v{branch.result.revision}
          </Link>
          <p>
            {time(branch.result.createdAt)} 固定 · {branch.result.createdBy?.name ?? '来源未记录'} ·
            {branch.result.codeKind ? '提交引用已固定' : '文字成果，代码未固定'}
          </p>
        </>
      )}
      {revoked && <p role="alert">成果编辑权限已失效，临时内容已清除。</p>}
      {editable && terminal && !editing && (
        <Button disabled={revoked} onClick={() => setEditing(true)}>
          {branch.result ? '保存新成果版本' : '保存方案成果'}
        </Button>
      )}
      {editable && editing && (
        <Editor
          path={path}
          close={() => setEditing(false)}
          denied={() => {
            setEditing(false);
            setRevoked(true);
          }}
          saved={() => {
            setEditing(false);
            saved();
          }}
        />
      )}
    </section>
  );
}
