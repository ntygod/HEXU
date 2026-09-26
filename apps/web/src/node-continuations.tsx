import './execution.css';
import { useState } from 'react';
import {
  continuationLabels,
  isPendingContinuation,
} from '../../../packages/contracts/src/continuation.js';
import type { NodeContinuationOperation } from '../../../packages/contracts/src/node-continuation.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { time, useApp, useLoad } from './state.js';

export function NodeContinuationStatus({
  taskId,
  editable,
  executionDisabled = false,
  onConfigure,
}: {
  taskId: string;
  editable: boolean;
  executionDisabled?: boolean;
  onConfigure(): void;
}) {
  const { value, error } = useLoad<{ items: NodeContinuationOperation[] }>(
    `/tasks/${taskId}/continuations`,
  );
  const { refresh, notice } = useApp();
  const [busy, setBusy] = useState(false);
  const items = value?.items.filter((op) => op.taskId === taskId) ?? [];
  const op = items[0];
  if (error)
    return (
      <p className="form-error" role="alert">
        无法读取接续安排：{error}。请刷新核对，不要重复派发。
      </p>
    );
  if (!op) return null;
  const pending = isPendingContinuation(op.state);
  const attention = ['needs_attention', 'failed'].includes(op.state);
  return (
    <section
      className={`continuation-status node-continuation-status ${attention ? 'needs-attention' : ''}`}
      aria-label="节点接续安排"
    >
      <div className="continuation-status-heading">
        <ToolMark tool={op.policy.tool} />
        <div className="continuation-status-title" aria-live="polite">
          <strong>{continuationLabels[op.state]}</strong>
          <p>
            {pending
              ? op.input.onActiveRun === 'wait'
                ? '已保存安排；原执行自然结束并确认后，沿原目录派发新会话。'
                : '已保存安排；请求原执行停止，收到真实结束确认后再派发。'
              : op.state === 'succeeded'
                ? '新执行已创建；是否已启动或成功，请查看下方执行记录。'
                : op.state === 'cancelled'
                  ? '不会因此派发新执行。已经发出的停止请求和已有文件修改不会撤销。'
                  : '接续已暂停，原要求与材料仍保留；没有自动重试或释放原进程占用。'}
          </p>
        </div>
        <span
          className={`badge ${attention ? 'amber' : pending ? 'status-in_progress' : 'neutral'}`}
        >
          同目录新会话
        </span>
      </div>
      {pending && (
        <ol className="continuation-steps" aria-label="节点接续步骤">
          <li className={op.state === 'waiting_for_stop' ? 'current' : 'passed'}>等待结束确认</li>
          <li className={op.state === 'preparing' ? 'current' : ''}>核对授权与材料</li>
          <li>创建新执行</li>
        </ol>
      )}
      {op.blockers.map((b) => (
        <p className="continuation-blocker" role="status" key={b.code}>
          <Icon name="warning" size={16} />
          {b.message}
        </p>
      ))}
      <div className="continuation-status-actions">
        <span className="muted">
          {op.ownerName} · {time(op.createdAt)} · 已选{' '}
          {op.input.run.continuation?.inputs.length ?? 0} 条要求
          {pending ? ' · 关闭页面不会取消' : ''}
        </span>
        {pending && editable && (
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
                notice('接续已取消，已发出的停止请求不撤销');
              } catch (e) {
                notice((e as Error).message, true);
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            取消接续安排
          </Button>
        )}
        {!pending && op.state !== 'succeeded' && editable && (
          <Button disabled={executionDisabled} onClick={onConfigure}>
            重新配置接续
          </Button>
        )}
      </div>
      <details className="continuation-records">
        <summary>查看安排历史与已保存材料（{items.length}）</summary>
        {items.map((item) => (
          <article key={item.id}>
            <strong>
              {continuationLabels[item.state]} ·{' '}
              {item.policy.tool === 'codex' ? 'Codex' : 'Claude Code'}
            </strong>
            <span className="muted"> · {time(item.createdAt)}</span>
            <p className="continuation-prompt">{item.input.run.prompt}</p>
            <small>
              来源 {item.sourceRunId}
              {item.runId ? ` → 新执行 ${item.runId}` : ' · 尚未创建新执行'}
            </small>
            <details className="node-context-preview">
              <summary>本次确认的固定材料</summary>
              <pre>{item.contextText}</pre>
            </details>
          </article>
        ))}
      </details>
    </section>
  );
}
