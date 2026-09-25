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
  const { value: context } = useLoad<{ text: string }>(`/tasks/${task.id}/native-context`);
  const { refresh, notice } = useApp();
  const [workingCopyId, setWorkingCopyId] = useState(lastRun?.native?.workingCopyId ?? '');
  const [mode, setMode] = useState<NativeMode>('read-only');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState(1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const chosen = workingCopyId || native?.workspaces[0]?.id || '';
  return (
    <Dialog title="使用本机 Claude Code" drawer onClose={() => !busy && onClose()}>
      <form
        className="drawer-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await request(`/tasks/${task.id}/runs`, {
              method: 'POST',
              body: {
                provider: 'native',
                requestedTool: 'claude-code',
                workingCopyId: chosen,
                mode,
                prompt,
                model,
                maxBudgetUsd: budget,
                confirmExecution: consent,
                expectedRevision: task.revision,
                reopenTask: task.status === 'done',
              },
            });
            await refresh();
            onClose();
            notice('已派发本机原生执行；不是模拟输出');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <div className="native-mode-heading">
            <span className="badge status-in_progress">原生执行 · 实验接入</span>
            <Button type="button" onClick={onMock} disabled={busy}>
              返回模拟体验
            </Button>
          </div>
          <div className="notice-box">
            <Icon name="monitor" />
            <div>
              <strong>实际访问所选目录，使用本机 API key</strong>
              <p>
                只提供文件工具，不提供 Shell、MCP 或仓库 Hooks。当前只支持本机 Claude Code；Codex
                尚未接入。
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
          ) : !native.claude.available ? (
            <div className="context-card">
              <div>
                <strong>尚不能开始原生执行</strong>
                <p>{native.claude.reason}</p>
                <p>
                  在本机 .env 配置 HEXU_NATIVE_ENABLED、HEXU_NATIVE_ROOTS 与 ANTHROPIC_API_KEY
                  后重启。不要把密钥输入任务或提交到仓库。
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex-line">
                <ToolMark tool="claude-code" />
                <strong>Claude Code</strong>
                <span className="muted">{native.claude.version}</span>
              </div>
              <label className="field">
                工作目录
                <select
                  aria-label="工作目录"
                  value={chosen}
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
                  <option value="read-only">只读分析 · 读取、查找文件</option>
                  <option value="edit">允许文件编辑 · 不提供 Shell</option>
                </select>
              </label>
              <label className="field">
                接下来做什么
                <textarea
                  aria-label="接下来做什么"
                  autoFocus
                  rows={4}
                  required
                  maxLength={12000}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例如：阅读当前分页实现，说明筛选变化后的问题"
                />
              </label>
              <label className="field">
                模型名称 <span>可选，留空使用工具默认值</span>
                <input
                  maxLength={100}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="使用本机支持的模型别名或 ID"
                />
              </label>
              <label className="field">
                本次预算上限（USD）
                <input
                  type="number"
                  min="0.01"
                  max="10"
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </label>
              <details className="native-details">
                <summary>查看将提供的任务上下文</summary>
                <pre>{context?.text ?? '正在整理…'}</pre>
                <p>本次要求会一并发送；不恢复模型内部状态，不自动上传全部仓库。</p>
              </details>
              <p className="hint">
                最多 8 轮、5
                分钟；遇到需要额外授权的动作会拒绝，不自动扩权。预算由工具执行，不是实际账单保证。
              </p>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                我允许本次工具访问以上目录与上下文，并使用本机 API key 产生模型费用。
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
            disabled={!native?.claude.available || !chosen || !consent || !prompt.trim()}
          >
            <Icon name="play" />
            {task.status === 'done' ? '重新打开并执行' : '开始原生执行'}
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
            <p>原生适配器</p>
          </div>
          <span className="badge neutral">待接入</span>
          <p className="full-row">模拟器中的 Codex 仅用于交互演示，不会调用真实工具。</p>
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
              'HEXU_NATIVE_ENABLED=1\nHEXU_NATIVE_ROOTS=["/absolute/path/to/repo"]\n# ANTHROPIC_API_KEY 在本机环境设置，不提交仓库'
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
                ? '费用估算'
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
