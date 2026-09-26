import {
  nodeContinuationContext,
  type NextInput,
  type NodeContinuationPreview,
} from '../../../packages/contracts/src/next-input.js';
import { useEffect, useState } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type { NodeExecutionOption } from '../../../packages/contracts/src/node-execution.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon, RunBadge, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';

export function NodeRunPanel({
  task,
  onClose,
  source,
}: {
  task: Task;
  onClose(): void;
  source?: Run;
}) {
  const { refresh, notice } = useApp();
  const [options, setOptions] = useState<NodeExecutionOption[]>([]),
    [context, setContext] = useState(''),
    [error, setError] = useState('');
  const [nodeId, setNode] = useState(''),
    [workspaceId, setWorkspace] = useState(''),
    [mode, setMode] = useState<'read-only' | 'edit'>('read-only');
  const [prompt, setPrompt] = useState(''),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  const [continuation, setContinuation] = useState<NodeContinuationPreview | null>(null);
  const [notes, setNotes] = useState<NextInput[]>([]),
    [chosen, setChosen] = useState<string[]>([]);
  const selected = options.find((n) => n.nodeId === nodeId);
  const selectedNotes = chosen
    .map((id) => notes.find((n) => n.id === id))
    .filter((n): n is NextInput => !!n);
  let materialError = '',
    fullContext = context;
  if (source && continuation) {
    try {
      fullContext = nodeContinuationContext(continuation.contextText, prompt, selectedNotes);
    } catch (e) {
      materialError = (e as Error).message;
    }
  }
  const selectionVersion = selectedNotes.map((n) => `${n.id}:${n.revision}:${n.state}`).join(',');
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await request<{ items: NodeExecutionOption[]; contextText: string }>(
          `/tasks/${task.id}/node-options`,
        );
        const preview = source
          ? await request<NodeContinuationPreview>(
              `/tasks/${task.id}/node-continuation-preview?sourceRunId=${source.id}`,
            )
          : null;
        const queue = source
          ? await request<{ items: NextInput[] }>(`/tasks/${task.id}/next-inputs`)
          : { items: [] };
        if (!disposed) {
          setContinuation(preview);
          setNotes(queue.items);
          if (preview) {
            setNode(preview.nodeId);
            setWorkspace(preview.workingCopyId);
          }
          setOptions(preview ? next.items.filter((n) => n.nodeId === preview.nodeId) : next.items);
          setContext(next.contextText);
          setError('');
        }
      } catch (e) {
        if (!disposed) {
          setOptions([]);
          setContinuation(null);
          setNotes([]);
          setConsent(false);
          setError((e as Error).message);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [task.id, source?.id]);
  useEffect(() => {
    setConsent(false);
  }, [
    selected?.policyHash,
    context,
    task.revision,
    mode,
    workspaceId,
    prompt,
    continuation?.contextHash,
    selectionVersion,
  ]);
  return (
    <Dialog title={source ? '沿原目录继续' : '在我的节点上执行'} onClose={onClose} drawer>
      <form
        className="form-stack node-execution-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!selected || busy) return;
          setBusy(true);
          setError('');
          try {
            await request(`/tasks/${task.id}/runs`, {
              method: 'POST',
              body: {
                provider: 'node',
                nodeId,
                workingCopyId: workspaceId,
                policyHash: selected.policyHash,
                mode,
                prompt,
                expectedRevision: task.revision,
                reopenTask: task.status === 'done',
                confirmExecution: consent,
                ...(source && continuation
                  ? {
                      continuation: {
                        sourceRunId: source.id,
                        expectedContextHash: continuation.contextHash,
                        inputs: selectedNotes.map((n) => ({ id: n.id, revision: n.revision })),
                      },
                    }
                  : {}),
              },
            });
            await refresh();
            notice(
              source
                ? '接续派发已保存；保留同一目录，新会话不会自动完成任务'
                : '节点派发已保存；接单和实际启动会分别显示',
            );
            onClose();
          } catch (e) {
            setError((e as Error).message);
            await refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="notice-box">
          <Icon name="monitor" />
          <p>
            只列出你拥有且已在本机明确启用执行的节点。代码留在授权目录，模型输出会共享到当前项目任务；在线不代表模型账户已验证。
          </p>
        </div>
        {source && (
          <div className="node-source-summary">
            <strong>保留原任务和目录 · 新建工具会话</strong>
            <p>
              {source.requestedTool === 'codex' ? 'Codex' : 'Claude Code'} →{' '}
              {selected?.policy.tool === 'codex'
                ? 'Codex'
                : selected
                  ? 'Claude Code'
                  : '等待当前本机授权'}{' '}
              · {source.node?.workingCopyName}
            </p>
            <small>
              来源 {source.id}
              。保留未提交修改；不恢复原生会话，不迁移到另一台电脑。工具来自节点当前明确授权，网页不能代为更换账户或工具路径。
            </small>
            {continuation?.blockers.map((b) => (
              <p role="status" key={b.code} className="form-error">
                {b.message}
              </p>
            ))}
          </div>
        )}
        {!task.projectId ? (
          <p>请先使用项目任务；本轮不把私有任务发送到项目节点。</p>
        ) : options.length === 0 && !error ? (
          <div className="node-execution-empty">
            <h3>还没有启用执行的节点</h3>
            <p>
              先在“空间与账号”配对节点，然后在节点本机运行 enable-execution
              并确认范围。摘要配对不会自动开放执行。
            </p>
            <code>npm run runner -- enable-execution --config /path/execution.json</code>
          </div>
        ) : null}
        <label className="field">
          执行节点
          <select
            aria-label="执行节点"
            required
            value={nodeId}
            disabled={busy || !!source}
            onChange={(e) => {
              setNode(e.target.value);
              setWorkspace('');
              setMode('read-only');
              setConsent(false);
            }}
          >
            <option value="">选择我的节点</option>
            {options.map((n) => (
              <option key={n.nodeId} value={n.nodeId} disabled={!n.available}>
                {n.name} · {n.policy.tool === 'codex' ? 'Codex' : 'Claude Code'}
                {n.available ? '' : ' · 暂不可用'}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <div className="node-policy-summary">
              <ToolMark tool={selected.policy.tool} />
              <div>
                <strong>
                  {selected.policy.tool === 'codex' ? 'Codex' : 'Claude Code'} · 本机 API 账户
                </strong>
                <p>{selected.reason}</p>
                <small>
                  {selected.policy.timeoutSeconds} 秒上限 ·{' '}
                  {selected.policy.maxBudgetUsd === null
                    ? '不支持美元硬预算'
                    : `预算参数 USD ${selected.policy.maxBudgetUsd}`}{' '}
                  · {selected.policy.model ?? '工具默认模型'}
                </small>
              </div>
            </div>
            <label className="field">
              授权工作目录
              <select
                aria-label="授权工作目录"
                required
                value={workspaceId}
                disabled={busy || !!source}
                onChange={(e) => setWorkspace(e.target.value)}
              >
                <option value="">选择已授权目录</option>
                {selected.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              本次执行模式
              <select
                aria-label="本次执行模式"
                value={mode}
                disabled={busy}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="read-only">只读分析</option>
                {selected.policy.mode === 'edit' && (
                  <option value="edit">修改授权目录内的文件</option>
                )}
              </select>
            </label>
          </>
        )}
        {source && (
          <fieldset className="node-input-selection">
            <legend>选择本次带入的要求（不会自动全选）</legend>
            {notes.filter((n) => n.state === 'queued' || chosen.includes(n.id)).length === 0 && (
              <p className="muted">没有待选择要求，也可以直接填写本次要求。</p>
            )}
            {notes
              .filter((n) => n.state === 'queued' || chosen.includes(n.id))
              .map((n) => (
                <label key={n.id} className="check-field">
                  <input
                    type="checkbox"
                    aria-label={`带入：${n.body}`}
                    disabled={busy || (n.state !== 'queued' && !chosen.includes(n.id))}
                    checked={chosen.includes(n.id)}
                    onChange={(e) => {
                      setConsent(false);
                      setChosen(
                        e.target.checked ? [...chosen, n.id] : chosen.filter((id) => id !== n.id),
                      );
                    }}
                  />
                  <span>
                    <strong>{n.authorName}</strong>
                    <p>{n.body}</p>
                    {n.state !== 'queued' && <small>此要求状态已变化，请取消选择</small>}
                  </span>
                </label>
              ))}
          </fieldset>
        )}
        <label className="field">
          本次要求
          <textarea
            aria-label="本次要求"
            required
            maxLength={6000}
            rows={5}
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要完成的工作或需要分析的问题"
          />
        </label>
        <details className="node-context-preview">
          <summary>查看本次发送的任务材料</summary>
          <pre>{source ? fullContext : context}</pre>
          <p>
            {source
              ? '上方为完整发送文本。来源输出与人工讨论为有界摘录，仅供参考；没有隐藏会话或远程 diff 迁移。'
              : '本次要求会一并发送。没有跨工具历史迁移；节点按授权读取目录。'}
            排队期间人工讨论或任务说明变化会阻止启动，新保存的下一轮要求不会悄悄加入当前派发。
          </p>
        </details>
        <label className="check-field">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(e) => setConsent(e.target.checked)}
          />
          我确认本次目录与模式，允许把任务材料发送给所选工具，使用本机 API
          账户计费，并把输出共享到项目任务。
        </label>
        {materialError && (
          <p className="form-error" role="alert">
            {materialError}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={onClose} disabled={busy}>
            返回
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={
              !consent ||
              !!materialError ||
              chosen.length > 6 ||
              selectedNotes.some((n) => n.state !== 'queued') ||
              !selected?.available ||
              !workspaceId ||
              !prompt.trim() ||
              (!!source && !continuation?.ready)
            }
          >
            {source
              ? task.status === 'done'
                ? '重开任务并接续'
                : '确认同目录接续'
              : task.status === 'done'
                ? '重新打开并派发'
                : '在节点上开始'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function NodeRunStatus({ run }: { run: Run }) {
  const n = run.node;
  if (!n) return null;
  const reached = [true, !!n.acceptedAt, !!n.permittedAt, !!n.startedAt, n.terminationConfirmed];
  return (
    <section className="node-run-status" aria-label="独立节点执行进度">
      {run.previousRunId && (
        <p className="node-continuation-origin">
          接续来源：{run.previousRunId} · 同目录新会话 · 带入 {n.continuationInputIds?.length ?? 0}{' '}
          条要求
        </p>
      )}
      <div className="node-policy-summary">
        <ToolMark tool={run.requestedTool} />
        <div>
          <strong>
            {n.nodeName} · {n.workingCopyName}
          </strong>
          <p>{n.mode === 'edit' ? '文件编辑' : '只读分析'} · 新原生会话 · 输出对当前项目可见</p>
        </div>
        <RunBadge run={run} />
      </div>
      <ol className="node-run-steps">
        {['已保存派发', '节点已接单', '准备启动', '进程已启动', '已确认结束'].map((label, i) => (
          <li key={label} className={reached[i] ? 'reached' : ''}>
            {label}
          </li>
        ))}
      </ol>
      {run.observation === 'unknown' && (
        <p role="status">
          连接或原进程状态未确认，目录仍保留占用。不会自动重试；请在节点本机核对旧进程后使用
          recover-execution。
        </p>
      )}
      {run.state === 'stopping' && (
        <p role="status">停止请求已保存，正在等待节点确认；关闭页面不会替代停止确认。</p>
      )}
      <details>
        <summary>查看执行标识与限制</summary>
        <p>
          派发 ID：<code>{n.dispatchId}</code>
        </p>
        <p>
          新派发不会恢复旧会话，也不会自动完成任务。本轮不提供运行中输入、远程 diff 或通用终端。
        </p>
      </details>
    </section>
  );
}
