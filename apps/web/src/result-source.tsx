import type { ResultCodeFeedbackAnchor } from '../../../packages/contracts/src/result-code-feedback.js';
import type { BranchResultSource } from '../../../packages/contracts/src/results.js';
import type {
  ResultCodeEvidence,
  CodeFileDifference,
} from '../../../packages/contracts/src/result-code.js';
import { ResultCodePanel } from './result-code.js';
import { time } from './state.js';
import './result-versions.css';

export function ResultSource({
  source,
  evidence,
  revisionId,
  onCodeFeedback,
  focusAnchor,
}: {
  source: BranchResultSource;
  evidence?: ResultCodeEvidence;
  revisionId?: string;
  onCodeFeedback?: (file: CodeFileDifference) => void;
  focusAnchor?: ResultCodeFeedbackAnchor;
}) {
  const run = source.run;
  return (
    <section className="result-provenance" aria-label="固定成果来源">
      <div className="flex-line">
        <strong>{source.branchName}</strong>
        <span className="badge neutral">{run.tool === 'codex' ? 'Codex' : 'Claude Code'}</span>
        <span className={`badge ${run.state === 'succeeded' ? 'success' : 'warning'}`}>
          {
            {
              succeeded: '执行成功',
              failed: '执行失败 · 保留部分成果',
              cancelled: '执行已取消 · 保留已有内容',
            }[run.state]
          }
        </span>
      </div>
      <p>
        {run.model ? `模型 ${run.model}` : '模型由工具默认配置决定'} · {time(run.finishedAt)} 结束
      </p>
      {!run.startedAt && <p>未收到实际启动记录，人工说明不代表工具已执行。</p>}
      {source.code === 'not_captured' ? (
        <p className="work-branch-notice">
          本版本固定文字与来源。代码文件尚未固定，共同起点提交不是本轮代码产物。
        </p>
      ) : (
        <ResultCodePanel
          code={source.code}
          evidence={evidence}
          revisionId={revisionId}
          onFeedback={onCodeFeedback}
          focusAnchor={focusAnchor}
        />
      )}
      <details>
        <summary>查看来源执行与实际输入</summary>
        <p>
          Run <code>{run.id}</code> · 修订 {run.revision}
        </p>
        <p>
          共同起点 <code>{source.start.checkpoint.manifest.commit}</code>
        </p>
        <p>任务说明来自修订 {source.start.taskRevision}，后续任务改动不影响此版本。</p>
        {run.continueFrom && (
          <p>
            此次接续沿用前一Run {run.continueFrom.sourceRunId}，代码起点为{' '}
            <code>{run.continueFrom.code.commit}</code>；选择记录修订{' '}
            {run.continueFrom.selectionRevision}。
          </p>
        )}
        <pre>{run.context}</pre>
      </details>
      <details>
        <summary>查看已固定的共享输出{source.output.truncated ? '（有截取）' : ''}</summary>
        <p>终态文本优先，最多6000字符；这是已收到的共享文本，不是完整终端日志。</p>
        {source.output.availability === 'legacy_unavailable' ? (
          <p>旧执行没有可靠的输出截止记录，本版本仅固定人工说明与来源。</p>
        ) : (
          <pre>{source.output.text || '来源执行没有可固定的共享文本。'}</pre>
        )}
        {source.output.truncated && (
          <p>
            已截取 {source.output.text.length} / {source.output.totalChars} 字符。
          </p>
        )}
      </details>
    </section>
  );
}
