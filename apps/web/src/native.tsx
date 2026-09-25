import { useEffect, useState } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type {
  NativeEvent,
  NativeMode,
  NativeOverview,
  WorkingCopySnapshot,
} from '../../../packages/contracts/src/native.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Empty, Icon, ToolMark } from '../../../packages/ui/src/index.js';
import { useApp, useLoad } from './state.js';

export function NativeContinue({
  task,
  lastRun,
  onClose,
  onMock,
}: {
  task: Task;
  lastRun?: Run;
  onClose(): void;
  onMock(): void;
}) {
  const { value: native, error: loadError } = useLoad<NativeOverview>('/native');
  const source = lastRun?.provider === 'native' && lastRun.native ? lastRun : undefined;
  const { value: context, error: contextError } = useLoad<{
    text?: string;
    contextText?: string;
    canContinue?: boolean;
    reason?: string;
  }>(
    source
      ? `/tasks/${task.id}/continuation-preview?sourceRunId=${encodeURIComponent(source.id)}`
      : `/tasks/${task.id}/native-context`,
  );
  const { refresh, notice } = useApp();
  const [tool, setTool] = useState<'claude-code' | 'codex'>(source?.requestedTool ?? 'claude-code');
  const [workingCopyId, setWorkingCopyId] = useState(source?.native?.workingCopyId ?? '');
  const [mode, setMode] = useState<NativeMode>('read-only');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [budget, setBudget] = useState(1);
  const [consent, setConsent] = useState(false);
  const [onActiveRun, setOnActiveRun] = useState<'wait' | 'request_stop'>('request_stop');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const chosen = source?.native?.workingCopyId || workingCopyId || native?.workspaces[0]?.id || '';
  const capability = tool === 'codex' ? native?.codex : native?.claude;
  const label = tool === 'codex' ? 'Codex' : 'Claude Code';
  const awaitingStop = source && context?.canContinue === false;
  return (
    <Dialog
      title={source ? '接着当前工作继续' : '使用本机原生工具'}
      drawer
      onClose={() => !busy && onClose()}
    >
      <form
        className="drawer-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await request(`/tasks/${task.id}/${source ? 'continuations' : 'runs'}`, {
              method: 'POST',
              body: {
                provider: 'native',
                requestedTool: tool,
                workingCopyId: chosen,
                ...(source ? { sourceRunId: source.id, onActiveRun } : {}),
                mode,
                prompt,
                model,
                ...(tool === 'claude-code' ? { maxBudgetUsd: budget } : {}),
                confirmExecution: consent,
                expectedRevision: task.revision,
                reopenTask: task.status === 'done',
              },
            });
            await refresh();
            onClose();
            notice(
              source ? `已保存 ${label} 接续安排；进度会保留在任务中` : `已派发 ${label} 原生执行`,
            );
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          {contextError && (
            <p role="alert" className="form-error">
              {contextError}
            </p>
          )}
          <div className="native-mode-heading">
            <span className="badge status-in_progress">原生执行 · 实验接入</span>
            <Button type="button" onClick={onMock} disabled={busy}>
              返回模拟体验
            </Button>
          </div>
          {source && (
            <div className="continuation-source">
              <div className="flex-line">
                <ToolMark tool={source.requestedTool} />
                <strong>{source.requestedTool === 'codex' ? 'Codex' : 'Claude Code'}</strong>
                <Icon name="arrow-right" />
                <ToolMark tool={tool} />
                <strong>{label}</strong>
              </div>
              <p>同一任务 · 沿用目录和未提交修改 · 创建新会话</p>
            </div>
          )}
          <fieldset className="tool-choice-field">
            <legend>接下来使用</legend>
            <div className="native-tool-choice">
              {(['claude-code', 'codex'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tool === value}
                  className={tool === value ? 'selected' : ''}
                  disabled={busy}
                  onClick={() => {
                    setTool(value);
                    setModel('');
                    setConsent(false);
                    setError('');
                  }}
                >
                  <ToolMark tool={value} />
                  <strong>{value === 'codex' ? 'Codex' : 'Claude Code'}</strong>
                  <small>
                    {value === 'codex' ? 'App Server · 独立 API 配置' : 'CLI · 受限文件工具'}
                  </small>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="notice-box">
            <Icon name="monitor" />
            <div>
              <strong>实际访问授权目录，使用所选工具的 API 账户</strong>
              <p>
                不开放 Shell、MCP
                或额外插件。不会把一个工具的凭证转给另一个工具；请使用不含敏感资料的独立仓库副本。
              </p>
            </div>
          </div>
          {loadError && (
            <p role="alert" className="form-error">
              {loadError}
            </p>
          )}
          {!native ? (
            <p>正在读取本机能力…</p>
          ) : !capability?.available ? (
            <div className="context-card">
              <div>
                <strong>当前工具尚不能开始</strong>
                <p>{capability?.reason}</p>
                <p>
                  在本机设置{' '}
                  {tool === 'codex'
                    ? 'OPENAI_API_KEY / HEXU_CODEX_BIN'
                    : 'ANTHROPIC_API_KEY / HEXU_CLAUDE_BIN'}{' '}
                  后重启；密钥不输入任务或提交仓库。
                </p>
              </div>
            </div>
          ) : (
            <>
              <label className="field">
                工作目录
                <select
                  aria-label="工作目录"
                  value={chosen}
                  disabled={!!source || busy}
                  onChange={(e) => {
                    setWorkingCopyId(e.target.value);
                    setConsent(false);
                  }}
                >
                  {native.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.root}
                    </option>
                  ))}
                </select>
              </label>
              {awaitingStop && (
                <div className="notice-box">
                  <div>
                    <strong>原执行尚未确认结束</strong>
                    <p>接续安排会保存。只有确认原进程停止、目录释放后，才会开始新执行。</p>
                    <label className="field">
                      如何处理原执行
                      <select
                        aria-label="如何处理原执行"
                        value={onActiveRun}
                        disabled={busy}
                        onChange={(e) => {
                          setOnActiveRun(e.target.value as 'wait' | 'request_stop');
                          setConsent(false);
                        }}
                      >
                        <option value="request_stop">请求停止原执行，然后继续</option>
                        <option value="wait">不打断，等原执行自然结束</option>
                      </select>
                    </label>
                    <p>关闭页面不会取消接续；取消接续也不会撤销已发送的停止请求。</p>
                  </div>
                </div>
              )}
              <label className="field">
                本次能力
                <select
                  aria-label="本次能力"
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as NativeMode);
                    setConsent(false);
                  }}
                >
                  <option value="read-only">只读分析</option>
                  <option value="edit">允许文件编辑 · 不提供 Shell</option>
                </select>
              </label>
              <label className="field">
                接下来做什么
                <textarea
                  aria-label="接下来做什么"
                  rows={4}
                  required
                  maxLength={12000}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setConsent(false);
                  }}
                  placeholder="例如：保留已完成的页面，继续处理大数据量导出"
                />
              </label>
              <label className="field">
                模型名称 <span>可选，留空使用工具默认值</span>
                <input
                  aria-label="模型名称"
                  list={tool === 'codex' ? 'native-codex-models' : undefined}
                  maxLength={100}
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setConsent(false);
                  }}
                  placeholder="模型别名或 ID"
                />
              </label>
              {tool === 'codex' && (
                <>
                  <datalist id="native-codex-models">
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                  <Button
                    type="button"
                    busy={loadingModels}
                    onClick={async () => {
                      setLoadingModels(true);
                      setError('');
                      try {
                        const response = await request<{ items: { id: string; name: string }[] }>(
                          '/native/codex/models',
                          { method: 'POST', body: {} },
                        );
                        setModels(response.items);
                        notice(
                          `已读取 ${response.items.length} 个模型配置，不代表账户都有调用权限`,
                        );
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setLoadingModels(false);
                      }
                    }}
                  >
                    从 Codex 读取模型
                  </Button>
                  <p className="hint">
                    使用本机 API 配置读取目录，不开始模型生成。Codex 本轮最长 5
                    分钟；暂无美元硬预算，费用由提供方计费。
                  </p>
                </>
              )}
              {tool === 'claude-code' && (
                <>
                  <label className="field">
                    本次预算上限（USD）
                    <input
                      type="number"
                      min="0.01"
                      max="10"
                      step="0.01"
                      value={budget}
                      onChange={(e) => {
                        setBudget(Number(e.target.value));
                        setConsent(false);
                      }}
                    />
                  </label>
                  <p className="hint">最多 8 轮、5 分钟；预算由原生工具处理，不是实际账单保证。</p>
                </>
              )}
              <details className="native-details">
                <summary>查看接续上下文与代码来源</summary>
                <pre>{context?.contextText ?? context?.text ?? '正在整理…'}</pre>
                <p>
                  本次要求会一并发送。等待原执行结束时，会在同一授权目录内重新整理最新输出和部分变更摘录；人工说明变化将暂停接续。
                </p>
              </details>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                我允许本次 {label} 访问以上目录与上下文，并使用其本机 API key 产生模型费用。
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={
              !capability?.available ||
              !chosen ||
              !consent ||
              !prompt.trim() ||
              (!!source && !context)
            }
          >
            <Icon name="play" />
            {awaitingStop
              ? onActiveRun === 'request_stop'
                ? `停止后用 ${label} 继续`
                : '原执行结束后继续'
              : task.status === 'done'
                ? '重新打开并继续'
                : source
                  ? `用 ${label} 继续`
                  : '开始原生执行'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function NativeResources() {
  const { value, error } = useLoad<NativeOverview>('/native');
  return (
    <>
      <h3 className="settings-heading">执行工具与授权目录</h3>
      {error && <p role="alert">{error}</p>}
      <div className="tool-resource-grid">
        <div className="panel tool-resource">
          <ToolMark tool="claude-code" />
          <div>
            <h3>Claude Code</h3>
            <p>本机原生 CLI · 受限文件工具</p>
          </div>
          <span className={`badge ${value?.claude.available ? 'status-done' : 'neutral'}`}>
            {value?.claude.available ? '已检测 · 原生可用' : '未启用或不可用'}
          </span>
          <p className="full-row">{value?.claude.reason ?? '读取能力中…'}</p>
        </div>
        <div className="panel tool-resource">
          <ToolMark tool="codex" />
          <div>
            <h3>Codex</h3>
            <p>本机 App Server · 独立 API 配置</p>
          </div>
          <span className={`badge ${value?.codex.available ? 'status-done' : 'neutral'}`}>
            {value?.codex.available ? '已检测 · 原生可用' : '未启用或不可用'}
          </span>
          <p className="full-row">{value?.codex.reason ?? '读取能力中…'}</p>
        </div>
      </div>
      {value?.workspaces.map((w) => (
        <div className="panel settings-line" key={w.id}>
          <div>
            <strong>{w.name}</strong>
            <p className="native-path">{w.root}</p>
          </div>
          <span className="badge neutral">本机显式授权</span>
        </div>
      ))}
      {!value?.enabled && (
        <div className="panel native-help">
          <h3>开启真实文件工作</h3>
          <p>在本机 .env 设置授权仓库根目录和 API key，然后重启服务。目录不能在网页里任意扩展。</p>
          <pre>
            {
              'HEXU_NATIVE_ENABLED=1\nHEXU_NATIVE_ROOTS=["/absolute/path/to/repo"]\n# ANTHROPIC_API_KEY / OPENAI_API_KEY 在本机环境设置，不提交仓库'
            }
          </pre>
          <p>只读与文件编辑均不提供 Shell；完整终端、远程节点和多人身份尚未接入。</p>
        </div>
      )}
    </>
  );
}

export function NativeCode({ run }: { run?: Run }) {
  const { version } = useApp();
  const [snapshot, setSnapshot] = useState<WorkingCopySnapshot | null>(null);
  const [path, setPath] = useState(''),
    [diff, setDiff] = useState(''),
    [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const id = run?.native?.workingCopyId;
  useEffect(() => {
    setError('');
    if (!id) {
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    request<WorkingCopySnapshot>(`/native/workspaces/${id}`, { signal: controller.signal })
      .then(setSnapshot)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [id, version, refreshKey]);
  useEffect(() => {
    setDiff('');
    if (!id || !path) return;
    const controller = new AbortController();
    request<{ text: string }>(`/native/workspaces/${id}/diff?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then((v) => setDiff(v.text || '当前文件没有可显示的文本差异'))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [id, path, version, refreshKey]);
  if (!id)
    return (
      <Empty
        title="先连接一个真实工作目录"
        description="在继续面板选择原生执行；工作目录来自本机显式配置。模拟运行不会生成代码差异。"
      />
    );
  return (
    <div className="native-code">
      <div className="flex-line">
        <strong>{snapshot?.workingCopy.name ?? '工作目录'}</strong>
        <span className="spacer" />
        <Button onClick={() => setRefreshKey((v) => v + 1)}>刷新变更</Button>
      </div>
      <p className="muted">
        {snapshot?.branch ?? '未命名分支'} · {snapshot?.head?.slice(0, 8) ?? '尚无提交'} ·
        当前活动现场
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!!snapshot?.omitted && (
        <p className="hint">{snapshot.omitted} 项敏感路径、符号链接、大目录或超额项目未显示。</p>
      )}
      <div className="native-changes">
        {snapshot?.changes.map((change) => (
          <button
            key={change.path}
            className={path === change.path ? 'selected' : ''}
            onClick={() => {
              setError('');
              setPath(change.path);
            }}
          >
            <code>{change.status}</code>
            <span>{change.path}</span>
          </button>
        ))}
      </div>
      {snapshot && !snapshot.changes.length && (
        <p className="muted">没有可显示的文件变更。只读分析不会修改代码。</p>
      )}
      {diff && <pre className="native-diff">{diff}</pre>}
      <p className="hint">
        差异包含该目录内已有及外部修改，不自动归因于 AI。不会自动提交、暂存或重置文件。
      </p>
    </div>
  );
}
export function NativeEvents({ run }: { run: Run }) {
  const { value, error } = useLoad<{ items: NativeEvent[] }>(`/runs/${run.id}/native-events`);
  return (
    <details
      className="native-details"
      open={run.state === 'running' || run.observation === 'unknown'}
    >
      <summary>原生输出与状态</summary>
      {run.observation === 'unknown' && (
        <p className="form-error">
          无法确认旧进程已停止。目录保持占用；请退出 HEXU，在系统中检查后使用 native:recover。执行
          ID：{run.id}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {value?.items.map((e) => (
        <div className={`native-event ${e.kind}`} key={e.sequence}>
          <small>
            {e.kind === 'tool'
              ? '工具'
              : e.kind === 'usage'
                ? '用量报告'
                : e.kind === 'warning'
                  ? '提示'
                  : '原生输出'}
          </small>
          <p>{e.body}</p>
        </div>
      ))}
      {value?.items.length === 200 && (
        <p className="hint">当前显示前 200 条事件；完整分页记录保存在本地 API。</p>
      )}
    </details>
  );
}
