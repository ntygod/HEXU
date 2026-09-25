import { useState } from 'react';
import {
  continuationLabels,
  isPendingContinuation,
  type ContinuationOperation,
} from '../../../packages/contracts/src/continuation.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { time, useApp, useLoad } from './state.js';

export function ContinuationStatus({
  taskId,
  onConfigure,
}: {
  taskId: string;
  onConfigure(): void;
}) {
  const { value, error } = useLoad<{ items: ContinuationOperation[] }>(
    `/tasks/${taskId}/continuations`,
  );
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false);
  const op = value?.items.find((item) => item.taskId === taskId);
  if (error)
    return (
      <p className="form-error" role="alert">
        无法读取接续状态：{error}。请刷新核对，不要重复启动。
      </p>
    );
  if (!op) return null;
  const pending = isPendingContinuation(op.state);
  const attention = op.state === 'needs_attention' || op.state === 'failed';
  const label = op.input.run.requestedTool === 'codex' ? 'Codex' : 'Claude Code';
  return (
    <section
      className={`continuation-status ${attention ? 'needs-attention' : ''}`}
      aria-label="接续进度"
    >
      <div className="continuation-status-heading">
        <ToolMark tool={op.input.run.requestedTool} />
        <div className="continuation-status-title" aria-live="polite">
          <strong>{continuationLabels[op.state]}</strong>
          <p>
            {pending
              ? op.input.onActiveRun === 'request_stop'
                ? `确认原进程停止后，自动用 ${label} 继续。关闭页面不会取消。`
                : `原执行自然结束并释放目录后，自动用 ${label} 继续。`
              : op.state === 'succeeded'
                ? `已创建 ${label} 执行；模型结果和任务状态请查看执行记录。`
                : op.state === 'cancelled'
                  ? '不会因此启动新执行；已发送的停止请求和已有文件修改不会撤销。'
                  : '没有自动重试或强行释放目录。原要求与配置已保留。'}
          </p>
        </div>
        <span
          className={`badge ${attention ? 'amber' : pending ? 'status-in_progress' : 'neutral'}`}
        >
          {pending ? '接续处理中' : continuationLabels[op.state]}
        </span>
      </div>
      {pending && (
        <ol className="continuation-steps" aria-label="接续步骤">
          <li className={op.state === 'waiting_for_stop' ? 'current' : 'passed'}>等待原执行结束</li>
          <li className={op.state === 'preparing' ? 'current' : ''}>整理并核对现场</li>
          <li>创建新执行</li>
        </ol>
      )}
      {op.blockers.map((blocker) => (
        <p className="continuation-blocker" role="status" key={blocker.code}>
          <Icon name="warning" size={16} /> {blocker.message}
        </p>
      ))}
      <div className="continuation-status-actions">
        <span className="muted">
          {time(op.createdAt)} · {op.input.run.mode === 'edit' ? '文件编辑' : '只读分析'} · 同一目录
        </span>
        {pending && (
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await request(`/operations/${op.id}/cancel`, {
                  method: 'POST',
                  body: { expectedRevision: op.revision },
                });
                await refresh();
                notice('接续已取消；已发出的停止请求不会撤销');
              } catch (e) {
                notice((e as Error).message, true);
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            取消接续
          </Button>
        )}
        {!pending && op.state !== 'succeeded' && (
          <Button onClick={onConfigure}>重新配置继续</Button>
        )}
      </div>
      <details className="continuation-records">
        <summary>查看接续记录与保留的要求（{value?.items.length ?? 0}）</summary>
        {value?.items
          .filter((item) => item.taskId === taskId)
          .map((item) => (
            <article key={item.id}>
              <strong>
                {continuationLabels[item.state]} ·{' '}
                {item.input.run.requestedTool === 'codex' ? 'Codex' : 'Claude Code'}
              </strong>
              <span className="muted"> {time(item.createdAt)}</span>
              <p className="continuation-prompt">{item.input.run.prompt}</p>
              <small>
                来源 {item.sourceRunId} {item.runId ? `→ 新执行 ${item.runId}` : '· 尚未创建新执行'}
              </small>
            </article>
          ))}
      </details>
    </section>
  );
}
