import { useEffect, useState } from 'react';
import type {
  BranchChoice,
  BranchComparison,
} from '../../../packages/contracts/src/branch-comparison.js';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type {
  ResultDetail,
  ResultRevisionSummary,
} from '../../../packages/contracts/src/results.js';
import { Button, Dialog, Empty } from '../../../packages/ui/src/index.js';
import { Link, canEditTask, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { ResultSource } from './result-source.js';
import { PrepareIntegration } from './integrations.js';
import { SelectedBranchContinue } from './branch-continuation.js';
import './branch-comparison.css';

type Candidate = { branchId: string; branchName: string; version: ResultRevisionSummary } | null;
function ChoiceEditor({
  path,
  candidate,
  selection,
  saved,
  close,
  denied,
}: {
  path: string;
  candidate: Candidate;
  selection: BranchChoice | null;
  saved(): void;
  close(): void;
  denied(): void;
}) {
  const [baseline, setBaseline] = useState(selection?.revision ?? 0),
    [note, setNote] = useState('');
  const command = useAssistanceCommand<BranchChoice>(saved);
  useEffect(() => {
    if (command.denied) denied();
  }, [command.denied]);
  const stale = baseline !== (selection?.revision ?? 0),
    locked = command.busy || !!command.uncertain;
  if (command.denied) return null;
  return (
    <Dialog title="记录方案选择" onClose={() => !command.busy && close()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!stale && !locked)
            void command.send(path + '/selection', {
              expectedSelectionRevision: baseline,
              branchId: candidate?.branchId ?? null,
              resultRevisionId: candidate?.version.id ?? null,
              note,
            });
        }}
      >
        <div className="dialog-body branch-choice-form">
          <strong>
            {candidate
              ? `${candidate.branchName} · ${candidate.version.title} · v${candidate.version.revision}`
              : '取消当前方案选择'}
          </strong>
          <p>
            选择固定到这个版本；之后的新成果不会替换它。此操作不会开始执行、整合代码、停止其他方案或完成任务。
            尚未取得启动许可的方案接续会重新核对选择，变化时取消该次排队。
          </p>
          <label className="field">
            选择说明（可选）
            <textarea
              aria-label="选择说明"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={locked}
            />
          </label>
          {stale && (
            <section className="work-branch-notice" aria-label="方案选择冲突">
              <p>
                其他编辑者已更新选择：
                {selection?.branchName
                  ? `${selection.branchName} · v${selection.resultRevision}`
                  : '未选择方案'}
                。说明已保留。
              </p>
              <Button
                type="button"
                disabled={locked}
                onClick={() => setBaseline(selection?.revision ?? 0)}
              >
                已核对最新选择
              </Button>
            </section>
          )}
          {command.error && <p role="alert">{command.error}</p>}
          {command.uncertain && (
            <section className="work-branch-notice" aria-label="方案选择待确认">
              <p>保存结果尚未确认，只会重发原选择、版本、说明与操作标识。</p>
              <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
                确认上次方案选择
              </Button>
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={close} disabled={command.busy}>
            关闭
          </Button>
          <Button type="submit" variant="primary" busy={command.busy} disabled={locked || stale}>
            {candidate ? '保存选择' : '确认取消选择'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function Column({
  branch,
  versions,
  selection,
  choose,
}: {
  branch: WorkBranch;
  versions: ResultRevisionSummary[];
  selection: BranchChoice | null;
  choose?: (candidate: Candidate) => void;
}) {
  const [versionId, setVersionId] = useState(
    selection?.branchId === branch.id ? selection.resultRevisionId! : (branch.result?.id ?? ''),
  );
  const read = useAssistanceRead<ResultDetail>(
    branch.resultId && versionId ? `/results/${branch.resultId}/versions/${versionId}` : null,
  );
  const v = read.value?.version;
  const selected = !!v && selection?.resultRevisionId === v.id;
  return (
    <article className="branch-compare-column" aria-label={`比较方案：${branch.name}`}>
      <header>
        <h2>{branch.name}</h2>
        <p>{branch.goal}</p>
      </header>
      {versions.length ? (
        <>
          <label className="field">
            对比版本
            <select
              aria-label={`${branch.name}对比版本`}
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {!versionId && <option value="">选择要查看的固定版本</option>}
              {versions.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.revision} · {r.title}
                </option>
              ))}
            </select>
          </label>
          {versionId && branch.result?.id !== versionId && (
            <p className="muted">正在看历史版本，最新为 v{branch.result?.revision}；可自行切换。</p>
          )}
          {read.error && (
            <p role="alert">
              {read.error}
              {!read.denied && <Button onClick={read.retry}>重读此成果</Button>}
            </p>
          )}
          {v ? (
            <>
              <section className="branch-compare-description">
                <h3>
                  {v.title} · v{v.revision}
                </h3>
                <p className="text-block">{v.body}</p>
                <h3>已知限制</h3>
                <p className="text-block">
                  {v.limitations || '保存者未填写限制，不代表没有风险。'}
                </p>
              </section>
              {v.source.kind === 'work_branch' && (
                <ResultSource source={v.source} evidence={read.value?.code} revisionId={v.id} />
              )}
              <div className="branch-compare-actions">
                <PrepareIntegration version={v} />
                <Link className="button secondary" to={`/results/${v.resultId}/versions/${v.id}`}>
                  查看此版本与反馈
                </Link>
                {selected ? (
                  <span className="badge active">已选用此版本</span>
                ) : (
                  choose && (
                    <Button
                      variant="primary"
                      disabled={!!read.error}
                      onClick={() =>
                        choose({ branchId: branch.id, branchName: branch.name, version: v })
                      }
                    >
                      选用这个版本
                    </Button>
                  )
                )}
              </div>
            </>
          ) : versionId && !read.error ? (
            <p role="status">正在读取固定成果…</p>
          ) : null}
        </>
      ) : (
        <p className="branch-compare-empty">
          尚无固定成果。
          {branch.run
            ? '执行状态与成果保存分别记录，请回任务查看运行或保存已有内容。'
            : '此方案尚未开始执行。'}
        </p>
      )}
    </article>
  );
}
export function BranchComparisonPage({ taskId, groupId }: { taskId: string; groupId: string }) {
  const path = `/tasks/${taskId}/work-branches/groups/${groupId}`;
  const read = useAssistanceRead<BranchComparison>(path + '/comparison');
  const { data } = useApp();
  const task = data.tasks.find((t) => t.id === taskId),
    editable = !!task && canEditTask(data, task);
  const [editing, setEditing] = useState<{ candidate: Candidate } | null>(null),
    [revoked, setRevoked] = useState(false);
  useEffect(() => {
    if (!editable || read.denied) setEditing(null);
  }, [editable, read.denied]);
  if (read.denied) return <Empty title="无法查看方案对比" description={read.error} />;
  if (!read.value)
    return (
      <Empty
        title={read.error ? '方案暂时无法读取' : '正在读取方案对比'}
        description={read.error}
        action={read.error ? <Button onClick={read.retry}>重读方案对比</Button> : undefined}
      />
    );
  const { work, versions, choices } = read.value,
    selection = work.selection;
  const choose =
    editable && !revoked && !read.error
      ? (candidate: Candidate) => setEditing({ candidate })
      : undefined;
  return (
    <div className="work-page branch-comparison-page">
      <header className="work-page-heading">
        <div>
          <span className="eyebrow">{work.group.start.taskTitle}</span>
          <h1>比较方案</h1>
          <p>比较各自保存的说明、实际输出和限制；缺少代码产物或预览时会直接标明。</p>
        </div>
        <Link className="button secondary" to={`/tasks/${taskId}`}>
          返回任务
        </Link>
      </header>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读方案对比</Button>
        </p>
      )}
      {revoked && <p role="alert">选择编辑权限已失效，临时说明已清除。</p>}
      <details className="branch-compare-origin">
        <summary>共同起点 · 任务修订 {work.group.start.taskRevision}</summary>
        <p className="text-block">{work.group.start.taskDescription || '当时没有补充说明。'}</p>
        <code>{work.group.start.checkpoint.manifest.commit}</code>
        <p>这是各方案的输入提交，不是本轮生成代码。</p>
      </details>
      <section className="branch-current-choice" aria-label="当前方案选择">
        {selection?.branchId ? (
          <>
            <strong>
              已选择 {selection.branchName} · v{selection.resultRevision}
            </strong>
            <Link to={`/results/${selection.resultId}/versions/${selection.resultRevisionId}`}>
              {selection.title}
            </Link>
            <p>
              {selection.actor.name} · {time(selection.createdAt)}
              {selection.note ? ` · ${selection.note}` : ''}
            </p>
            {choose && <Button onClick={() => choose(null)}>取消当前选择</Button>}
          </>
        ) : (
          <p>尚未选择方案。选择会保留具体成果版本与记录，不会自动执行或整合。</p>
        )}
      </section>
      {editable && task && (
        <SelectedBranchContinue
          task={task}
          branch={work.branches.find((b) => b.id === selection?.branchId) ?? null}
        />
      )}
      <div className="branch-compare-grid">
        {work.branches.map((b) => (
          <Column
            key={b.id}
            branch={b}
            versions={versions[b.id] ?? []}
            selection={selection}
            choose={choose}
          />
        ))}
      </div>
      {!!choices.length && (
        <details className="branch-choice-history">
          <summary>选择历史（{choices.length}）</summary>
          <ol>
            {choices.map((c) => (
              <li key={c.revision}>
                {c.branchId ? (
                  <Link to={`/results/${c.resultId}/versions/${c.resultRevisionId}`}>
                    {c.branchName} · v{c.resultRevision}
                  </Link>
                ) : (
                  '取消选择'
                )}{' '}
                · {c.actor.name} · {time(c.createdAt)}
                {c.note && <p className="text-block">{c.note}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {editable && editing && (
        <ChoiceEditor
          path={path}
          candidate={editing.candidate}
          selection={selection}
          close={() => setEditing(null)}
          denied={() => {
            setEditing(null);
            setRevoked(true);
          }}
          saved={() => {
            setEditing(null);
            read.retry();
          }}
        />
      )}
    </div>
  );
}
