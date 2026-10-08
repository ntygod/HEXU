import { useEffect, useRef, useState } from 'react';
import type {
  AgentCapabilityListing,
  AgentCapabilitySelection,
} from '../../../packages/contracts/src/agent-capabilities.js';
import {
  projectAgentCapabilities,
  selectAgentCapability,
} from '../../../packages/client/src/agent-capabilities.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
import { accessDenied, useAgentRead } from './agent-resource-state.js';
import './agent-resources.css';
export function ProjectAgentCapabilities({ projectId }: { projectId: string }) {
  const { data, version } = useApp();
  if (data.mode !== 'team-local') return <p>示例项目不提供真实账号的 Agent 能力目录。</p>;
  return (
    <CapabilityDirectory
      key={`${data.user.id}:${projectId}`}
      projectId={projectId}
      version={version}
    />
  );
}
function CapabilityDirectory({ projectId, version }: { projectId: string; version: number }) {
  const { data } = useApp();
  const read = useAgentRead((signal) => projectAgentCapabilities(projectId, signal), version);
  const [selection, setSelection] = useState<AgentCapabilitySelection | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    sending = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setSelection(null);
  }, [version]);
  useEffect(() => {
    if (read.denied) {
      generation.current++;
      setSelection(null);
    }
  }, [read.denied]);
  const select = async (item: AgentCapabilityListing) => {
    if (sending.current) return;
    const own = ++generation.current;
    sending.current = true;
    setBusy(true);
    setSelection(null);
    setError('');
    try {
      const next = await selectAgentCapability(
        projectId,
        item.capabilityId,
        item.capabilityVersion,
      );
      if (alive.current && generation.current === own) setSelection(next);
    } catch (e) {
      if (alive.current && generation.current === own) {
        setError(e instanceof Error ? e.message : '无法复核能力');
        if (accessDenied(e)) read.refresh();
      }
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="agent-resources" aria-label="项目 Agent 能力目录">
      <header className="node-section-heading">
        <div>
          <h2>项目 Agent 能力</h2>
          <p>
            仅显示当前账号有权发现的项目能力。选择只复核并准备固定标识，不创建求助、不发送材料、不调用模型。
          </p>
        </div>
        <Button
          onClick={() => {
            generation.current++;
            setSelection(null);
            read.refresh();
          }}
        >
          刷新目录
        </Button>
      </header>
      {(read.error || error) && <p role="alert">{read.error || error}</p>}
      {!read.value && !read.error && <p role="status">正在读取能力目录…</p>}
      {selection && (
        <div className="agent-selection" role="status">
          <strong>已准备能力标识，尚未发起协作</strong>
          <p>
            Agent：{selection.participantId} · 能力：{selection.capabilityId} · 版本{' '}
            {selection.capabilityVersion}
          </p>
          <p>
            授权：{selection.grantId} · 修订 {selection.grantRevision}
          </p>
          <p>不可调用：{selection.blocker}</p>
          <Button onClick={() => setSelection(null)}>清除选择</Button>
        </div>
      )}
      {read.value?.items.length === 0 && (
        <div className="node-empty">
          <h3>当前没有可发现的能力</h3>
          <p>由 Agent 所有者在资源与设置中登记端点、文本能力和项目预授权。</p>
        </div>
      )}
      <div className="agent-grid">
        {read.value?.items.map((item) => (
          <article className="node-card" key={item.capabilityId} aria-label={item.title}>
            <header className="node-card-heading">
              <div>
                <h3>{item.title}</h3>
                <p>
                  {item.participantName} · 所有者{' '}
                  {data.members.find((m) => m.id === item.ownerUserId)?.name ?? item.ownerUserId}
                </p>
              </div>
              <span className="badge neutral">不可调用</span>
            </header>
            <p>{item.description}</p>
            <dl className="agent-facts">
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
                <dd>{item.canRequest ? '已有请求预授权，环境未验证' : '仅可发现，未授权请求'}</dd>
              </div>
            </dl>
            <p>{item.blocker}</p>
            <p>
              到期：{new Date(item.expiresAt).toLocaleString()} · 并发上限 {item.maxConcurrent} ·
              费用由 Agent 所有者承担
            </p>
            <p>
              {item.autoAccept ? '已预授权有限自动接受' : '未授权自动接受'} · 仅文本快照与文本回答
            </p>
            <div className="agent-actions">
              <Button disabled={busy || !!read.error} onClick={() => void select(item)}>
                选择并准备标识
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
