import { useEffect, useState } from 'react';
import type {
  AgentAssistanceCredentialIssued,
  AgentAssistanceMetadata,
} from '../../../packages/contracts/src/agent-assistance.js';
import { Button } from '../../../packages/ui/src/index.js';
import { AgentAssistanceFeedback, useAgentAssistanceCommand } from './agent-assistance-state.js';
/** Token is held only by this mounted component, never the recovery Provider. */
export function AgentAssistanceCredentials({
  id,
  agent,
  onSaved,
  onBusy,
}: {
  id: string;
  agent: AgentAssistanceMetadata;
  onSaved(): void;
  onBusy?(busy: boolean): void;
}) {
  const [issuedRevision, setIssuedRevision] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null),
    [lost, setLost] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [respond, setRespond] = useState(false),
    [expires, setExpires] = useState('');
  const command = useAgentAssistanceCommand<AgentAssistanceCredentialIssued>(
    `credential:${id}`,
    (result) => {
      setIssuedRevision(result.credential.revision);
      setToken(result.token);
      setLost(!result.token);
      setConfirmed(false);
      onSaved();
    },
  );
  const revoke = useAgentAssistanceCommand<unknown>(`credential-revoke:${id}`, () => {
    setToken(null);
    setLost(false);
    setConfirmed(false);
    onSaved();
  });
  const locked = command.busy || !!command.pending || revoke.busy || !!revoke.pending;
  useEffect(() => {
    onBusy?.(command.busy || revoke.busy);
    return () => onBusy?.(false);
  }, [command.busy, revoke.busy, onBusy]);
  useEffect(() => {
    setToken(null);
  }, [id]);
  useEffect(() => {
    if (
      issuedRevision !== null &&
      agent.credential &&
      (agent.credential.revision > issuedRevision ||
        (agent.credential.revision === issuedRevision && !!agent.credential.revokedAt))
    )
      setToken(null);
  }, [agent.credential?.revision, agent.credential?.revokedAt, issuedRevision]);
  useEffect(() => {
    if (!agent.canIssueCredential) {
      setToken(null);
      command.revoke();
      revoke.revoke();
    }
  }, [agent.canIssueCredential]);
  if (!agent.canIssueCredential || command.denied || revoke.denied) return null;
  return (
    <section className="assistance-snapshot" aria-label="请求限定 Agent 凭据">
      <h3>所有者显式开通本请求连接</h3>
      <p>
        仅为本请求签发读取材料的有限凭据，可另勾选回应。不会升级原 capability_read
        连接，也不会安装原生客户端、取件进程或启动模型。
      </p>
      {agent.credential && (
        <p>
          凭据版本 {agent.credential.revision} ·{' '}
          {agent.credential.revokedAt ? '已撤销' : `到期 ${agent.credential.expiresAt}`}
        </p>
      )}
      <label className="field">
        凭据到期时间（UTC）
        <input
          aria-label="凭据到期时间 UTC"
          type="datetime-local"
          value={expires}
          disabled={locked}
          onChange={(e) => {
            setExpires(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label className="assistance-consent">
        <input
          type="checkbox"
          checked={respond}
          disabled={locked}
          onChange={(e) => {
            setRespond(e.target.checked);
            setConfirmed(false);
          }}
        />
        另授予本请求 typed 回应权限
      </label>
      <label className="assistance-consent">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={locked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我作为此 Agent 所有者，明确开通以上范围与到期时间
      </label>
      <Button
        type="button"
        disabled={locked || !confirmed || !expires || !Number.isFinite(Date.parse(expires + 'Z'))}
        onClick={() => {
          setToken(null);
          setLost(false);
          void command.send(`/assistances/${id}/credentials`, {
            expectedRevision: agent.credential?.revision ?? 0,
            scopes: respond ? ['material_read', 'respond'] : ['material_read'],
            expiresAt: new Date(expires + 'Z').toISOString(),
          });
        }}
      >
        {agent.credential ? '轮换本请求凭据' : '开通本请求凭据'}
      </Button>
      {agent.credential && !agent.credential.revokedAt && (
        <Button
          type="button"
          disabled={locked || !confirmed}
          onClick={() =>
            void revoke.send(`/assistances/${id}/credentials/revoke`, {
              action: 'revoke',
              expectedRevision: agent.credential!.revision,
            })
          }
        >
          撤销本请求凭据
        </Button>
      )}
      {token && (
        <div role="status">
          <p>仅本次显示。请保存在你控制的安全客户端中；关闭后不再展示。</p>
          <pre>{token}</pre>
          <Button type="button" onClick={() => setToken(null)}>
            隐藏一次性凭据
          </Button>
        </div>
      )}
      {lost && (
        <p role="alert">
          签发回执已确认，但密钥不会再次返回。如首次响应丢失或已关闭，请读取最新凭据版本后明确轮换，不要重复创建或使用旧凭据。
        </p>
      )}
      <AgentAssistanceFeedback command={command} />
      <AgentAssistanceFeedback command={revoke} />
    </section>
  );
}
