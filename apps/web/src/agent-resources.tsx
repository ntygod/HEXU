import { useEffect, useRef, useState } from 'react';
import type {
  AgentParticipantView,
  DelegationGrant,
} from '../../../packages/contracts/src/agent-capabilities.js';
import {
  parseAgentConnection,
  parseAgentRegistration,
  parseAgentUpdate,
  parseAgentEndpoint,
  parseAgentCapability,
  parseDelegationGrant,
} from '../../../packages/contracts/src/agent-capabilities.js';
import {
  myAgents,
  type AgentWriteResult,
  type AgentWriteBody,
} from '../../../packages/client/src/agent-capabilities.js';
import { request } from '../../../packages/client/src/index.js';
import type { SpaceMember } from '../../../packages/contracts/src/identity.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
import { useAgentRead, useAgentWrite } from './agent-resource-state.js';
import './agent-resources.css';
type Mode =
  | 'register'
  | 'rename'
  | 'endpoint'
  | 'capability'
  | 'grant'
  | 'revoke'
  | 'revoke-grant'
  | 'connection'
  | 'revoke-connection';
type Editor = {
  mode: Mode;
  agent?: AgentParticipantView;
  grant?: DelegationGrant;
};
const labels: Record<Mode, string> = {
  register: '登记我的 Agent',
  rename: '修改 Agent 名称',
  endpoint: '登记独立端点',
  capability: '编辑文本专业能力',
  grant: '开放项目能力',
  revoke: '撤销 Agent',
  'revoke-grant': '撤销项目授权',
  connection: '开通或轮换只读连接',
  'revoke-connection': '撤销只读连接',
};
export function AgentResources() {
  const { data, version } = useApp();
  if (data.mode !== 'team-local')
    return (
      <section className="preferences-surface">
        <h2>我的 Agent</h2>
        <p>示例身份不能登记真实 Agent。请在本机团队模式登录本人账号后使用。</p>
      </section>
    );
  return (
    <OwnedAgents key={`${data.user.id}:${data.projects[0]?.spaceId ?? ''}`} version={version} />
  );
}
function OwnedAgents({ version }: { version: number }) {
  const { data } = useApp();
  const read = useAgentRead(myAgents, version);
  const [secret, setSecret] = useState<string | null>(null);
  const secretOwner = useRef<{ id: string; revision: number } | null>(null);
  const showConnection = (result: AgentWriteResult) => {
    if ('token' in result) {
      secretOwner.current = result.agent.connection
        ? { id: result.agent.id, revision: result.agent.connection.revision }
        : null;
      setSecret(result.token);
      setMessage(
        result.token
          ? '只读连接已开通。凭据仅此次展示，请保存到你控制的 Agent 端。'
          : '原开通请求已确认，但一次性凭据不可再次读取。如未保存，请显式轮换。',
      );
    }
  };
  const recovery = useAgentWrite(
    (result) => {
      setMessage('原请求已确认保存。');
      showConnection(result);
      read.refresh();
    },
    () => {
      setMessage('当前权限或资源已失效，已清除原请求。');
      read.refresh();
    },
  );
  const [editor, setEditor] = useState<Editor | null>(null),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (read.denied) {
      setEditor(null);
      setSecret(null);
      recovery.clear();
    }
  }, [read.denied]);
  useEffect(() => {
    if (!secret || !secretOwner.current || !read.value || read.error) return;
    const owner = read.value.items.find((a) => a.id === secretOwner.current!.id);
    if (
      !owner ||
      owner.revokedAt ||
      !owner.connection ||
      owner.connection.revokedAt ||
      owner.connection.revision !== secretOwner.current.revision ||
      Date.parse(owner.connection.expiresAt) <= Date.now() ||
      !data.projects.some(
        (p) =>
          p.id === owner.connection!.projectId &&
          !p.archivedAt &&
          ['edit', 'manage'].includes(p.access ?? ''),
      )
    )
      setSecret(null);
  }, [read.value, read.error, data.projects]);
  const previousPending = useRef(recovery.pending);
  useEffect(() => {
    if (previousPending.current && !recovery.pending && !editor) read.refresh();
    previousPending.current = recovery.pending;
  }, [recovery.pending, editor]);
  useEffect(() => {
    const pending = recovery.pending;
    if (!pending || !read.value || read.error) return;
    const id = pending.path.split('/')[2];
    const target = id ? read.value.items.find((a) => a.id === decodeURIComponent(id)) : null;
    const projectId = 'projectId' in pending.body ? pending.body.projectId : null;
    const lostProject =
      projectId &&
      !data.projects.some(
        (p) => p.id === projectId && !p.archivedAt && ['edit', 'manage'].includes(p.access ?? ''),
      );
    if ((id && (!target || target.revokedAt)) || lostProject) {
      recovery.clear();
      setEditor(null);
      setSecret(null);
      setMessage('当前 Agent 或项目编辑权限已失效，已清除原请求。');
    }
  }, [read.value, read.error, data.projects, recovery.pending]);
  const open = (value: Editor) => {
    setMessage('');
    setSecret(null);
    setEditor(structuredClone(value));
  };
  return (
    <section className="agent-resources" aria-label="我的 Agent">
      <header className="node-section-heading">
        <div>
          <span className="eyebrow">真实所有者 · {data.user.name}</span>
          <h2>我的 Agent</h2>
          <p>身份、端点、专业能力分别登记。这里只保存配置，不连接外部端点、不调用模型。</p>
        </div>
        <Button
          disabled={!!editor || !!recovery.pending || read.denied}
          onClick={() => open({ mode: 'register' })}
        >
          登记 Agent
        </Button>
        <Button onClick={read.refresh}>刷新我的 Agent</Button>
      </header>
      {read.error && (
        <p role="alert">
          {read.error} <Button onClick={read.refresh}>重新读取</Button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!editor && recovery.error && <p role="alert">{recovery.error}</p>}
      {secret && (
        <div className="preferences-surface">
          <h3>一次性只读连接凭据</h3>
          <p>
            仅向你控制的 Agent 配置此凭据。仅可读取指定项目的能力目录，最长 24
            小时；不能执行任务或写入。此页关闭后不可再次显示。
          </p>
          <label className="field">
            连接凭据（敏感信息）
            <textarea readOnly value={secret} spellCheck={false} autoComplete="off" rows={3} />
          </label>
          <Button onClick={() => setSecret(null)}>隐藏并清除凭据</Button>
        </div>
      )}
      {!editor && recovery.pending && (
        <div className="preferences-surface" role="status">
          <h3>有一项原请求等待确认</h3>
          <p>离开页面没有撤回已提交操作。请先核对原请求，再登记新的配置。</p>
          <p className="native-path">{recovery.pending.path}</p>
          <p className="native-path">{JSON.stringify(recovery.pending.body)}</p>
          {recovery.error && <p role="alert">{recovery.error}</p>}
          <Button disabled={recovery.busy} onClick={() => void recovery.submit(recovery.pending!)}>
            {recovery.busy ? '正在确认原请求…' : '核对原请求'}
          </Button>
        </div>
      )}
      {!read.value && !read.error && <p role="status">正在读取我的 Agent…</p>}
      {read.value?.items.length === 0 && (
        <div className="node-empty">
          <h3>还没有登记 Agent</h3>
          <p>一个所有者可以登记多个独立 Agent；名称不代表真人成员或模型可用性。</p>
        </div>
      )}
      <div className="agent-grid">
        {read.value?.items.map((agent) => (
          <article className="node-card" key={agent.id} aria-label={agent.name}>
            <header className="node-card-heading">
              <div>
                <h3>{agent.name}</h3>
                <p>
                  所有者：{data.user.name} · 修订 {agent.revision}
                </p>
                <p>{agent.nativeInstanceRef || '未填写原生实例引用'}</p>
              </div>
              <span className="badge neutral">{agent.revokedAt ? '已撤销' : '已登记'}</span>
            </header>
            <dl className="agent-facts">
              <div>
                <dt>端点</dt>
                <dd>
                  {agent.endpoint
                    ? `${agent.endpoint.protocol} · ${agent.endpoint.implementation} ${agent.endpoint.implementationVersion}`
                    : '尚未登记'}
                </dd>
              </div>
              <div>
                <dt>专业能力</dt>
                <dd>{agent.capability?.title ?? '尚未登记'}</dd>
              </div>
              <div>
                <dt>提供方支持</dt>
                <dd>待验证</dd>
              </div>
              <div>
                <dt>HEXU 接入</dt>
                <dd>尚未接入</dd>
              </div>
              <div>
                <dt>当前授权与环境</dt>
                <dd>{agent.revokedAt ? '身份已撤销' : '端点身份与运行环境未验证'} · 不可调用</dd>
              </div>
            </dl>
            {agent.endpoint && (
              <p className="native-path">{agent.endpoint.address} · 仅端点元数据，无凭证</p>
            )}
            {agent.capability && <p>{agent.capability.description}</p>}
            {!agent.revokedAt && (
              <div className="agent-actions">
                {(['rename', 'endpoint', 'capability', 'grant', 'revoke'] as Mode[]).map((mode) => (
                  <Button
                    key={mode}
                    disabled={
                      !!editor ||
                      !!recovery.pending ||
                      (mode === 'capability' && !agent.endpoint) ||
                      ((mode === 'grant' || mode === 'connection') &&
                        (!agent.endpoint || !agent.capability))
                    }
                    onClick={() => open({ mode, agent })}
                  >
                    {labels[mode]}
                  </Button>
                ))}
              </div>
            )}
            {!agent.revokedAt && (
              <details className="agent-grants">
                <summary>独立 Agent 的短期只读连接</summary>
                <p>
                  显式开通后生成独立凭据。仅可读取所选项目的能力目录，不使用浏览器会话，不调用模型。修改端点或撤权会使旧凭据失效。
                </p>
                {agent.connection && (
                  <p>
                    项目：
                    {data.projects.find((p) => p.id === agent.connection?.projectId)?.name ??
                      '当前不可见'}{' '}
                    · 修订 {agent.connection.revision} ·{' '}
                    {agent.connection.revokedAt
                      ? '已撤销'
                      : Date.parse(agent.connection.expiresAt) <= Date.now()
                        ? '已到期'
                        : '已登记'}{' '}
                    · 到期 {new Date(agent.connection.expiresAt).toLocaleString()}
                  </p>
                )}
                <div className="agent-actions">
                  <Button
                    disabled={!!editor || !!recovery.pending || !agent.endpoint}
                    onClick={() => open({ mode: 'connection', agent })}
                  >
                    开通或轮换只读连接
                  </Button>
                  {agent.connection && !agent.connection.revokedAt && (
                    <Button
                      disabled={!!editor || !!recovery.pending}
                      onClick={() => open({ mode: 'revoke-connection', agent })}
                    >
                      撤销只读连接
                    </Button>
                  )}
                </div>
              </details>
            )}
            {agent.grants.length > 0 && (
              <div className="agent-grants">
                <h4>项目预授权</h4>
                {agent.grants.map((grant) => (
                  <div key={grant.id} className="agent-grant">
                    <p>
                      <strong>
                        {data.projects.find((p) => p.id === grant.projectId)?.name ??
                          '项目当前不可见'}
                      </strong>{' '}
                      ·{' '}
                      {grant.revokedAt
                        ? '已撤销'
                        : Date.parse(grant.expiresAt) <= Date.now()
                          ? '已到期'
                          : grant.capabilityVersion !== agent.capability?.version ||
                              grant.endpointRevision !== agent.endpoint?.revision
                            ? '配置已变化，需重新授权'
                            : '已登记授权'}
                    </p>
                    <p>
                      {grant.audience === 'project_members'
                        ? '项目全体成员（随成员变化）'
                        : grant.requesterUserIds
                            .map((id) => data.members.find((m) => m.id === id)?.name ?? id)
                            .join('、')}{' '}
                      · {grant.request ? '允许请求' : '仅可发现'} ·{' '}
                      {grant.autoAccept ? '允许有限自动接受' : '不自动接受'}
                    </p>
                    <p>
                      到期：{new Date(grant.expiresAt).toLocaleString()} · 并发上限{' '}
                      {grant.maxConcurrent} · 费用：所有者 {data.user.name}
                    </p>
                    <p>仅明确文本快照与文本回答；不授予执行、目录写入或外部影响权限。</p>
                    {!grant.revokedAt && !agent.revokedAt && (
                      <Button
                        disabled={!!editor || !!recovery.pending}
                        onClick={() => open({ mode: 'revoke-grant', agent, grant })}
                      >
                        撤销授权
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {editor && (
        <AgentEditor
          key={`${editor.mode}:${editor.agent?.id ?? 'new'}:${editor.grant?.id ?? ''}`}
          editor={editor}
          current={read.value?.items.find((a) => a.id === editor.agent?.id)}
          onClose={() => setEditor(null)}
          onDenied={() => {
            setEditor(null);
            setMessage('当前权限或资源已失效，已清除编辑内容。');
            setSecret(null);
            read.refresh();
          }}
          onAccepted={(result) => {
            setEditor(null);
            setMessage('配置已保存。正在重新读取最新状态；不会连接端点或启动协作。');
            showConnection(result);
            read.refresh();
          }}
        />
      )}
    </section>
  );
}
function AgentEditor({
  editor,
  current,
  onClose,
  onAccepted,
  onDenied,
}: {
  editor: Editor;
  current?: AgentParticipantView;
  onClose: () => void;
  onAccepted: (result: AgentWriteResult) => void;
  onDenied: () => void;
}) {
  const { data, version } = useApp();
  const { mode, agent, grant } = editor;
  const [projectId, setProjectId] = useState(''),
    [audience, setAudience] = useState('selected_members'),
    [allowRequest, setAllowRequest] = useState(false),
    [validation, setValidation] = useState('');
  const write = useAgentWrite(onAccepted, onDenied);
  const projects = data.projects.filter(
    (p) => !p.archivedAt && ['edit', 'manage'].includes(p.access ?? ''),
  );
  const denied =
    (!!agent && (!current || !!current.revokedAt)) ||
    ((mode === 'grant' || mode === 'connection') &&
      !!projectId &&
      !projects.some((p) => p.id === projectId));
  useEffect(() => {
    if (denied) {
      write.clear();
      onClose();
    }
  }, [denied]);
  const changed =
    !!agent &&
    !!current &&
    (agent.revision !== current.revision ||
      agent.endpoint?.revision !== current.endpoint?.revision ||
      agent.capability?.version !== current.capability?.version ||
      agent.connection?.revision !== current.connection?.revision);
  if (denied) return null;
  return (
    <form
      className="agent-editor preferences-surface"
      aria-label={labels[mode]}
      onSubmit={(event) => {
        event.preventDefault();
        setValidation('');
        if (write.pending) {
          void write.submit(write.pending);
          return;
        }
        const form = new FormData(event.currentTarget),
          get = (key: string) => String(form.get(key) ?? '');
        let body: AgentWriteBody,
          path = '/agent-participants',
          method: 'POST' | 'PATCH' = 'POST';
        try {
          if (mode === 'register')
            body = parseAgentRegistration({
              name: get('name'),
              nativeInstanceRef: get('nativeInstanceRef') || null,
            });
          else {
            path += `/${encodeURIComponent(agent!.id)}`;
            if (mode === 'rename') {
              method = 'PATCH';
              body = parseAgentUpdate({
                name: get('name'),
                nativeInstanceRef: get('nativeInstanceRef') || null,
                expectedRevision: agent!.revision,
              });
            } else if (mode === 'endpoint') {
              path += '/endpoint';
              body = parseAgentEndpoint({
                expectedRevision: agent!.endpoint?.revision ?? 0,
                protocol: get('protocol'),
                address: get('address'),
                implementation: get('implementation'),
                implementationVersion: get('implementationVersion'),
                receiveMode: get('receiveMode'),
              });
            } else if (mode === 'capability') {
              path += '/capability';
              body = parseAgentCapability({
                expectedRevision: agent!.capability?.version ?? 0,
                title: get('title'),
                description: get('description'),
              });
            } else if (mode === 'connection') {
              path += '/connection';
              body = parseAgentConnection({
                expectedRevision: agent!.connection?.revision ?? 0,
                projectId,
                expiresAt: new Date(get('expiresAt')).toISOString(),
              });
            } else if (mode === 'grant') {
              path += '/grants';
              body = parseDelegationGrant({
                projectId,
                audience,
                requesterUserIds:
                  audience === 'selected_members' ? form.getAll('requesterUserIds') : [],
                request: allowRequest,
                autoAccept: allowRequest && form.has('autoAccept'),
                expiresAt: new Date(get('expiresAt')).toISOString(),
                maxConcurrent: Number(get('maxConcurrent')),
                costBearer: 'owner',
                expectedCapabilityVersion: agent!.capability!.version,
                expectedEndpointRevision: agent!.endpoint!.revision,
              });
            } else {
              path +=
                mode === 'revoke'
                  ? '/revoke'
                  : mode === 'revoke-connection'
                    ? '/connection/revoke'
                    : `/grants/${encodeURIComponent(grant!.id)}/revoke`;
              body = {
                expectedRevision:
                  mode === 'revoke'
                    ? agent!.revision
                    : mode === 'revoke-connection'
                      ? agent!.connection!.revision
                      : grant!.revision,
              };
            }
          }
          void write.submit({ path, method, body });
        } catch (e) {
          setValidation(e instanceof Error ? e.message : '请检查输入');
        }
      }}
    >
      <h3>
        {labels[mode]}
        {agent ? ` · ${agent.name}` : ''}
      </h3>
      {changed && (
        <p role="alert">
          配置已发生变化。当前输入和编辑基线保持不变；请关闭后重新打开以使用最新版本。
        </p>
      )}
      {(validation || write.error) && <p role="alert">{validation || write.error}</p>}
      {write.pending && (
        <p role="status">
          {write.busy ? '正在确认原请求…' : '请求内容已固定，尚未取得明确回执。不能换内容另发。'}
        </p>
      )}
      <fieldset disabled={!!write.pending || write.busy}>
        {(mode === 'register' || mode === 'rename') && (
          <>
            <label className="field">
              Agent 名称
              <input name="name" required maxLength={80} defaultValue={agent?.name} />
            </label>
            <label className="field">
              原生实例引用（可选，不含凭证）
              <input
                name="nativeInstanceRef"
                maxLength={160}
                defaultValue={agent?.nativeInstanceRef ?? ''}
              />
            </label>
          </>
        )}
        {mode === 'endpoint' && (
          <>
            <p>
              只保存独立端点元数据。不得填写令牌、密码或带凭证的
              URL；不会登录、探测或授予持续访问。修改端点后旧预授权需重新登记。
            </p>
            <label className="field">
              协议
              <select name="protocol" defaultValue={agent?.endpoint?.protocol ?? 'custom'}>
                <option value="custom">自建 Agent</option>
                <option value="mcp">MCP</option>
                <option value="a2a">A2A</option>
              </select>
            </label>
            <label className="field">
              HTTPS 端点地址
              <input
                name="address"
                type="url"
                required
                maxLength={500}
                defaultValue={agent?.endpoint?.address}
              />
            </label>
            <label className="field">
              实现名称
              <input
                name="implementation"
                required
                maxLength={100}
                defaultValue={agent?.endpoint?.implementation}
              />
            </label>
            <label className="field">
              实现版本
              <input
                name="implementationVersion"
                required
                maxLength={80}
                defaultValue={agent?.endpoint?.implementationVersion}
              />
            </label>
            <label className="field">
              接收方式
              <select name="receiveMode" defaultValue={agent?.endpoint?.receiveMode ?? 'manual'}>
                <option value="manual">手动接收（元数据）</option>
                <option value="poll">取件（尚未接入）</option>
                <option value="push">推送（尚未接入）</option>
              </select>
            </label>
          </>
        )}
        {mode === 'capability' && (
          <>
            <p>固定文本输入、文本回答，不执行命令或调用工具。修改能力版本后需重新登记预授权。</p>
            <label className="field">
              专业能力名称
              <input
                name="title"
                required
                maxLength={100}
                defaultValue={agent?.capability?.title}
              />
            </label>
            <label className="field">
              有限服务说明
              <textarea
                name="description"
                required
                maxLength={2000}
                rows={4}
                defaultValue={agent?.capability?.description}
              />
            </label>
          </>
        )}
        {mode === 'grant' && (
          <>
            <p>只开放指定项目中的有限文本协助。当前尚未接入真实调用；预授权不代表已可执行。</p>
            <label className="field">
              项目
              <select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">选择本人可编辑的项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              参与成员范围
              <select value={audience} onChange={(e) => setAudience(e.target.value)}>
                <option value="selected_members">指定项目成员</option>
                <option value="project_members">项目全体成员（包括未来加入者）</option>
              </select>
            </label>
            {projectId && audience === 'selected_members' && (
              <GrantMembers key={projectId} projectId={projectId} version={version} />
            )}
            <label>
              <input
                type="checkbox"
                checked={allowRequest}
                onChange={(e) => setAllowRequest(e.target.checked)}
              />{' '}
              允许这些成员请求文本专业协助（不勾选则仅可发现）
            </label>
            <label>
              <input name="autoAccept" type="checkbox" disabled={!allowRequest} />{' '}
              在已授权范围内自动接受（接入后才可能使用）
            </label>
            <label className="field">
              到期时间（本地时间）
              <input name="expiresAt" type="datetime-local" required />
            </label>
            <label className="field">
              并发上限
              <input name="maxConcurrent" type="number" min={1} max={4} required defaultValue={1} />
            </label>
            <p>
              费用由 Agent 所有者 {data.user.name}{' '}
              承担；只读明确提供的文本快照、返回文本回答，不授予执行、目录写入或任何外部影响权限。
            </p>
          </>
        )}
        {mode === 'connection' && (
          <>
            <p>
              确认开通一个有期限的独立只读身份。轮换将立即使旧凭据失效；新凭据只在本次成功响应中展示，不会保存在浏览器存储。请勿把它发给其他成员或公开服务。
            </p>
            <label className="field">
              只读连接项目
              <select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">选择本人可编辑的项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              到期时间（本地时间，未来 24 小时内）
              <input name="expiresAt" type="datetime-local" required />
            </label>
            <p>
              允许：验证自身连接身份、读取所选项目中有权发现的能力。禁止：创建求助、模型调用、材料读取、任务执行及任何写入。
            </p>
          </>
        )}
        {mode === 'revoke-connection' && (
          <p>确认立即撤销当前只读连接凭据。已复制的旧凭据将无法继续读取能力目录。</p>
        )}
        {mode === 'revoke' && (
          <p>撤销这个 Agent 后，其能力和所有项目预授权将不可继续使用。登记历史保留。</p>
        )}
        {mode === 'revoke-grant' && (
          <p>撤销此项目预授权后，对方不能再凭此授权发现或选择该能力。历史保留。</p>
        )}
      </fieldset>
      <div className="agent-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={write.busy || (changed && !write.pending)}
        >
          {write.pending
            ? '核对原请求'
            : mode.startsWith('revoke')
              ? '确认撤销'
              : mode === 'connection'
                ? '确认开通或轮换'
                : '保存配置'}
        </Button>
        <Button disabled={!!write.pending || write.busy} onClick={onClose}>
          取消编辑
        </Button>
      </div>
    </form>
  );
}
function GrantMembers({ projectId, version }: { projectId: string; version: number }) {
  const read = useAgentRead(
    (signal) =>
      request<{ items: SpaceMember[] }>(`/projects/${encodeURIComponent(projectId)}/members`, {
        signal,
      }),
    version,
  );
  return (
    <fieldset className="agent-member-options">
      <legend>明确选择可参与的成员</legend>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.refresh}>重新读取成员</Button>
        </p>
      )}
      {!read.value && !read.error && <p>正在读取成员…</p>}
      {read.value?.items.map((member) => (
        <label key={member.id}>
          <input type="checkbox" name="requesterUserIds" value={member.id} />
          {member.name} · {member.email}
        </label>
      ))}
    </fieldset>
  );
}
