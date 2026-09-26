import { useEffect, useState } from 'react';
import type {
  PairingView,
  RunnerNode,
  NodePresence,
} from '../../../packages/contracts/src/nodes.js';
import { request } from '../../../packages/client/src/index.js';
import { Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { useApp, time } from './state.js';
const presence: Record<NodePresence, string> = {
  paired: '已配对 · 尚未同步',
  online: '在线',
  stale: '心跳陈旧',
  offline: '离线',
  unknown: '连接待确认',
  revoked: '已撤销',
};
interface NodeData {
  items: RunnerNode[];
  pairings: PairingView[];
}
export function NodeResources() {
  const { data, version, notice } = useApp();
  const [value, setValue] = useState<NodeData | null>(null),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [revision, setRevision] = useState(0),
    [revoke, setRevoke] = useState<RunnerNode | null>(null),
    [busy, setBusy] = useState(false);
  const projects = data.projects.filter((p) => p.access === 'edit' || p.access === 'manage');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [pairing, setPairing] = useState<(PairingView & { code: string | null }) | null>(null),
    [showCode, setShowCode] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const result = await request<NodeData>('/nodes', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setValue(result);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setValue(null);
          setError((e as Error).message);
        }
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [data.space?.id, version, revision]);
  const reload = () => setRevision((v) => v + 1);
  const pending = value?.pairings.filter((p) => p.state === 'pending') ?? [];
  return (
    <section className="node-resources" aria-label="独立节点与授权目录">
      <div className="node-section-heading">
        <div>
          <span className="eyebrow">让环境属于它的使用者</span>
          <h2>独立节点与授权目录</h2>
          <p>在自己的终端确认项目与目录；网页只查看明确分享的 Git 数量摘要。</p>
        </div>
        <Button
          variant="primary"
          disabled={!projects.length}
          onClick={() => {
            setPairing(null);
            setShowCode(false);
            setProjectId(projects[0]?.id ?? '');
            setOpen(true);
          }}
        >
          <Icon name="plus" />
          连接我的节点
        </Button>
      </div>
      <div className="node-boundary">
        <Icon name="monitor" size={18} />
        <p>
          <strong>独立节点 · 默认目录摘要</strong>
          　当前只支持回环服务上的独立进程。在线不代表任务正在运行；执行需要本人在节点单独授权，跨电脑连接尚未开放。
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}。旧节点数据已隐藏，重新连接后再查看。
        </p>
      )}
      {!error && value && !value.items.length && (
        <div className="panel node-empty">
          <Icon name="monitor" size={30} />
          <h3>把你的工作环境接进来</h3>
          <p>一次性配对码只负责连接身份；目录必须由本机操作者另行确认。不会扫描或共享整个电脑。</p>
          {!projects.length && <p>先创建项目或取得项目编辑权限，再为该项目连接节点。</p>}
        </div>
      )}
      <div className="node-grid">
        {value?.items.map((node) => (
          <article className="panel node-card" key={node.id} data-node-id={node.id}>
            <div className="node-card-heading">
              <span className="system-avatar">
                <Icon name="monitor" />
              </span>
              <div>
                <h3>{node.name}</h3>
                <p>
                  {node.ownerName} · {node.platform} / {node.arch}
                </p>
              </div>
              <span
                className={`badge ${node.presence === 'online' ? 'status-done' : node.presence === 'stale' || node.presence === 'unknown' ? 'amber' : 'neutral'}`}
              >
                {presence[node.presence]}
              </span>
            </div>
            <div className="node-scope">
              <Icon name="folder" size={15} />
              <strong>{node.projectName}</strong>
              <span>项目成员可见 · 不含执行权</span>
            </div>
            <div className="node-directory-list">
              {node.workspaces.map((w) => {
                const snapshot = node.snapshot?.workspaces.find((s) => s.id === w.id);
                return (
                  <div className="node-directory" key={w.id}>
                    <strong>{w.name}</strong>
                    {!snapshot ? (
                      <p>等待本机首次上报，尚无目录状态。</p>
                    ) : snapshot.state !== 'available' ? (
                      <p className="node-directory-warning">
                        {snapshot.state === 'authorization_changed'
                          ? '目录身份已变化，请在本机重新授权。'
                          : '本机暂时无法读取此目录，未伪造变更数量。'}
                      </p>
                    ) : (
                      <dl className="node-counts">
                        <div>
                          <dt>已暂存</dt>
                          <dd>{snapshot.staged}</dd>
                        </div>
                        <div>
                          <dt>工作区修改</dt>
                          <dd>{snapshot.modified}</dd>
                        </div>
                        <div>
                          <dt>未跟踪条目</dt>
                          <dd>{snapshot.untracked}</dd>
                        </div>
                        <div>
                          <dt>冲突</dt>
                          <dd>{snapshot.conflicts}</dd>
                        </div>
                      </dl>
                    )}
                    {snapshot && (
                      <small className="muted">
                        采集于 {time(snapshot.capturedAt)} · 节点上报，不是不可变成果快照
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="node-card-footer">
              <small>
                最后心跳：{node.lastSeenAt ? time(node.lastSeenAt) : '尚未收到'} · 已确认序号{' '}
                {node.acknowledgedSequence}
              </small>
              {node.canRevoke && node.presence !== 'revoked' && (
                <Button onClick={() => setRevoke(node)}>撤销节点</Button>
              )}
            </div>
            {node.presence === 'revoked' && (
              <p className="muted node-history-note">
                仅保留此前已分享的历史摘要；凭证不能通过重新登录或重新入组恢复。
              </p>
            )}
          </article>
        ))}
      </div>
      {!!pending.length && (
        <div className="panel node-pairings">
          <h3>待连接的配对码</h3>
          {pending.map((p) => (
            <div key={p.id}>
              <span>
                {p.projectName} · 到期 {new Date(p.expiresAt).toLocaleTimeString()}
              </span>
              <Button
                onClick={async () => {
                  try {
                    await request(`/nodes/pairings/${p.id}/cancel`, { method: 'POST', body: {} });
                    if (pairing?.id === p.id) setPairing(null);
                    reload();
                  } catch (e) {
                    notice((e as Error).message, true);
                  }
                }}
              >
                取消配对
              </Button>
            </div>
          ))}
        </div>
      )}
      <details className="node-help">
        <summary>本机连接方式与共享范围</summary>
        <p>使用 Node 24，在仓库外保存 runner.json；示例路径由本机操作者替换，不在网页填写路径。</p>
        <pre>
          {
            '{\n  "controlUrl": "http://127.0.0.1:4310",\n  "name": "我的开发电脑",\n  "workspaces": [{"name": "项目工作副本", "path": "/absolute/git-root"}]\n}\n\nnpm run build\nnpm run runner -- connect --config /path/runner.json\nnpm run runner -- start'
          }
        </pre>
        <p>
          配对码在终端隐藏粘贴，不放入命令参数。节点凭证和目录路径仅保存在本机；发送目录别名、采集时间、变更数量，不发送文件名、代码、分支名、Git
          远程地址或模型密钥。未跟踪目录按一个条目计数，不递归枚举其文件。
        </p>
      </details>
      {open && (
        <Dialog
          title="连接我的节点"
          onClose={() => {
            if (!busy) {
              setOpen(false);
              setPairing(null);
            }
          }}
        >
          <div className="node-connect">
            <p>
              选择本次分享目录摘要的项目。配对码有效期 10
              分钟；本机仍需确认你的身份、项目和具体目录。
            </p>
            <label className="field">
              共享到项目
              <select
                aria-label="共享到项目"
                value={projectId}
                disabled={busy || !!pairing}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {!pairing ? (
              <Button
                variant="primary"
                busy={busy}
                disabled={!projectId}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await request<PairingView & { code: string | null }>(
                      '/nodes/pairings',
                      { method: 'POST', body: { projectId } },
                    );
                    setPairing(result);
                    reload();
                  } catch (e) {
                    notice((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                生成一次性配对码
              </Button>
            ) : (
              <>
                <p>
                  <strong>{pairing.ownerName}</strong> · {pairing.spaceName} · {pairing.projectName}
                </p>
                {pairing.code ? (
                  <>
                    <label className="field">
                      一次性配对码
                      <input
                        aria-label="一次性配对码"
                        type={showCode ? 'text' : 'password'}
                        readOnly
                        value={pairing.code}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <div className="node-pair-actions">
                      <Button onClick={() => setShowCode((v) => !v)}>
                        {showCode ? '隐藏配对码' : '显示配对码'}
                      </Button>
                      <Button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(pairing.code!);
                            notice('配对码已复制，请仅粘贴到你控制的本机终端');
                          } catch {
                            notice('复制失败，请显示配对码后手动复制', true);
                          }
                        }}
                      >
                        复制配对码
                      </Button>
                    </div>
                  </>
                ) : (
                  <p>出于安全原因，配对码不会重新显示。请取消此配对并重新生成。</p>
                )}
                <p className="muted">
                  关闭此面板不会撤销配对码，但之后无法再次显示。可在待连接列表中取消。
                </p>
              </>
            )}
            <div className="notice-box">
              <Icon name="warning" />
              <p>
                配对本身只连接与上报摘要，不授予代码执行或模型账户权限。启用执行必须由本人在节点本机另行确认。
              </p>
            </div>
          </div>
        </Dialog>
      )}
      {revoke && (
        <Dialog
          title="撤销节点连接"
          onClose={() => {
            if (!busy) setRevoke(null);
          }}
        >
          <p>
            撤销“{revoke.name}
            ”的节点凭证，阻止后续同步和任务派发。活动执行会请求停止，但仍须等待节点确认。不会删除本地代码，也不能追回已分享的内容。
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setRevoke(null)} disabled={busy}>
              返回
            </Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request(`/nodes/${revoke.id}/revoke`, {
                    method: 'POST',
                    body: { expectedRevision: revoke.revision },
                  });
                  setRevoke(null);
                  reload();
                  notice('节点已撤销');
                } catch (e) {
                  notice((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认撤销节点
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
