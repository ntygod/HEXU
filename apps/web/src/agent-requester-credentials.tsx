import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { AgentAssistancePreview } from '../../../packages/contracts/src/agent-assistance.js';
import type {
  AgentRequesterCredential,
  AgentRequesterCredentialIssue,
  AgentRequesterCredentialIssued,
} from '../../../packages/contracts/src/agent-requester.js';
import {
  agentRequesterCredentialsPath,
  agentRequesterCredentialRevokePath,
} from '../../../packages/client/src/agent-requester.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { AgentAssistanceFeedback, useAgentAssistanceCommand } from './agent-assistance-state.js';
import { canEditTask, useApp } from './state.js';

interface Props {
  task: Task;
  messageId: string;
  preview: AgentAssistancePreview | null;
  requesterName: string;
  requesterEndpointReady: boolean;
  recipientName: string;
  grantExpiresAt?: string;
  shareConfirmed: boolean;
  disabled: boolean;
  onBusy?(busy: boolean): void;
  onLocked?(locked: boolean): void;
}

export function AgentRequesterCredentials(props: Props) {
  const { data } = useApp();
  // Secret and confirmation state never crosses an identity, space or task boundary.
  return (
    <RequesterCredentials
      key={`${data.user.id}:${props.task.spaceId}:${props.task.id}:${props.messageId}`}
      {...props}
    />
  );
}

function RequesterCredentials({
  task,
  messageId,
  preview,
  requesterName,
  requesterEndpointReady,
  recipientName,
  grantExpiresAt,
  shareConfirmed,
  disabled,
  onBusy,
  onLocked,
}: Props) {
  const { data } = useApp();
  const read = useAssistanceRead<{ items: AgentRequesterCredential[] }>(
    agentRequesterCredentialsPath(task.id),
  );
  const [expires, setExpires] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [secret, setSecret] = useState<AgentRequesterCredentialIssued | null>(null),
    [lastIssued, setLastIssued] = useState<AgentRequesterCredential | null>(null),
    [revokeId, setRevokeId] = useState<string | null>(null);
  const issue = useAgentAssistanceCommand<AgentRequesterCredentialIssued>(
    `requester-issue:${data.user.id}:${task.spaceId}:${task.id}:${messageId}`,
    (result) => {
      setSecret(result);
      setLastIssued(result.credential);
      setConfirmed(false);
      read.retry();
    },
  );
  const revoke = useAgentAssistanceCommand<{ credential: AgentRequesterCredential }>(
    `requester-revoke:${data.user.id}:${task.spaceId}:${task.id}`,
    ({ credential: result }) => {
      setSecret((current) => (current?.credential.id === result.id ? null : current));
      setLastIssued((current) => (current?.id === result.id ? result : current));
      setRevokeId(null);
      read.retry();
    },
  );
  const allowed = canEditTask(data, task) && !read.denied && !issue.denied && !revoke.denied;
  const busy = issue.busy || revoke.busy;
  const pending = !!issue.pending || !!revoke.pending;
  const locked = busy || pending;
  const expiration = Date.parse(expires + 'Z');
  const expirationValid =
    Number.isFinite(expiration) &&
    expiration > Date.now() &&
    expiration <= Date.now() + 24 * 60 * 60 * 1000 &&
    (!grantExpiresAt || expiration <= Date.parse(grantExpiresAt));
  const canIssue =
    allowed &&
    !locked &&
    !disabled &&
    !read.error &&
    !!read.value &&
    !!preview?.requesterParticipantId &&
    requesterEndpointReady &&
    shareConfirmed &&
    confirmed &&
    expirationValid;
  useEffect(() => {
    setConfirmed(false);
  }, [preview, shareConfirmed, expires, grantExpiresAt]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  useEffect(() => {
    onLocked?.(locked);
    return () => onLocked?.(false);
  }, [locked, onLocked]);
  useEffect(() => {
    if (!allowed) {
      setSecret(null);
      setLastIssued(null);
      setConfirmed(false);
      setExpires('');
      setRevokeId(null);
      issue.revoke();
      revoke.revoke();
    }
  }, [allowed]);
  useEffect(() => {
    if (!secret) return;
    const current = read.value?.items.find((item) => item.id === secret.credential.id);
    if (current && (current.revokedAt || current.revision > secret.credential.revision)) {
      setSecret(null);
      return;
    }
    const remaining = Date.parse(secret.credential.expiresAt) - Date.now();
    if (remaining <= 0) {
      setSecret(null);
      return;
    }
    const timer = setTimeout(() => setSecret(null), remaining);
    return () => clearTimeout(timer);
  }, [secret, read.value]);

  if (!allowed) return <p role="alert">原生发起凭据权限已撤销，凭据与未保存授权已清除。</p>;
  const items = [...(read.value?.items ?? [])];
  if (lastIssued) {
    const index = items.findIndex((item) => item.id === lastIssued.id);
    if (index < 0) items.unshift(lastIssued);
    else if (items[index]!.revision < lastIssued.revision) items[index] = lastIssued;
  }
  return (
    <section className="assistance-snapshot" aria-label="原生 Agent 发起授权">
      <h3>让本人 Agent 从原生入口发起</h3>
      <p>
        独立的 requester 凭据仅限本 Task、所选固定材料和一个目标。不会升级 capability_read
        或接收方请求凭据；开通本身不创建协助、不启动模型、不连接外部客户端。
      </p>
      <p>
        允许：发现所选能力、读取固定材料、发起并查询此凭据关联的请求、在原材料内澄清或缩减范围、取消。
        不得增加资料、更换消息选区或目标，也不能执行任务或改写文件。
      </p>
      {preview?.requesterParticipantId ? (
        <p>
          发起 Agent：{requesterName || preview.requesterParticipantId}；唯一目标：
          {recipientName || preview.target.participantId}。固定材料：
          {preview.materials.map((material) => material.label).join('、')}。
        </p>
      ) : (
        <p className="hint">请关联本人 Agent，并预览、核对完整分享内容后再开通。</p>
      )}
      {preview?.requesterParticipantId && !requesterEndpointReady && (
        <p className="hint">
          此本人 Agent 尚未登记独立端点。请先在“我的 Agent”登记端点，再重新预览开通。
        </p>
      )}
      <label className="field">
        原生发起凭据到期时间（UTC）
        <input
          type="datetime-local"
          aria-label="原生发起凭据到期时间 UTC"
          value={expires}
          disabled={locked || disabled}
          onChange={(event) => setExpires(event.target.value)}
        />
      </label>
      <p className="hint">
        最长 24 小时，且不能晚于目标授权到期{grantExpiresAt ? ` ${grantExpiresAt}` : ''}。
        {expires && !expirationValid ? '请选择上述范围内的未来时间。' : ''}
      </p>
      <label className="assistance-consent">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={locked || disabled || !preview?.requesterParticipantId || !shareConfirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我明确授权本人 Agent 在以上固定范围和有效期内使用这些动作
      </label>
      <Button
        type="button"
        disabled={!canIssue}
        onClick={() => {
          if (!canIssue || !preview?.requesterParticipantId) return;
          setSecret(null);
          const body: AgentRequesterCredentialIssue = {
            participantId: preview.requesterParticipantId,
            preview: {
              requesterParticipantId: preview.requesterParticipantId,
              target: preview.target,
              input: preview.input,
            },
            expectedTaskRevision: preview.expectedTaskRevision,
            expectedInputHash: preview.inputHash,
            shareConfirmed: true,
            expiresAt: new Date(expiration).toISOString(),
          };
          void issue.send(agentRequesterCredentialsPath(task.id), body);
        }}
      >
        明确开通原生发起凭据
      </Button>
      {secret?.token && (
        <div role="status">
          <p>凭据仅本次显示。只保存到你控制的安全客户端；关闭此页后不可重新读取。</p>
          <p>
            此次凭据：{secret.credential.participantId} → {secret.credential.target.participantId}；
            固定材料 {secret.credential.materialLabels.join('、')}；到期{' '}
            {secret.credential.expiresAt}。
          </p>
          <label className="field">
            一次性原生发起凭据（敏感信息）
            <textarea
              aria-label="一次性原生发起凭据"
              value={secret.token}
              readOnly
              rows={3}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button type="button" onClick={() => setSecret(null)}>
            隐藏并清除原生发起凭据
          </Button>
        </div>
      )}
      {secret && !secret.token && (
        <p role="alert">
          原签发已确认，密钥不会再次返回。如首次响应丢失，请先撤销此凭据，再明确开通新凭据。
        </p>
      )}
      <AgentAssistanceFeedback command={issue} />
      <AgentAssistanceFeedback command={revoke} />
      <h4>本 Task 已签发的原生发起凭据</h4>
      {read.error && <p role="alert">{read.error}；授权输入已保留。</p>}
      {!read.value && !read.error && <p role="status">正在读取凭据范围…</p>}
      {read.value && items.length === 0 && <p className="hint">尚未签发。</p>}
      {items.map((item) => (
        <section
          className="assistance-warning"
          key={item.id}
          aria-label={`原生发起凭据 ${item.id}`}
        >
          <p>
            {item.participantId} → {item.target.participantId} · 版本 {item.revision} ·{' '}
            {item.revokedAt
              ? '已撤销'
              : Date.parse(item.expiresAt) <= Date.now()
                ? '已到期'
                : `到期 ${item.expiresAt}`}
          </p>
          <p>固定材料：{item.materialLabels.join('、')}</p>
          <details>
            <summary>查看固定范围标识</summary>
            <p>
              凭据 {item.id}；能力 {item.target.capabilityId}；授权 {item.target.grantId}
            </p>
            <p className="native-path">输入校验值 {item.inputHash}</p>
          </details>
          {!item.revokedAt &&
            Date.parse(item.expiresAt) > Date.now() &&
            (revokeId === item.id ? (
              <>
                <p>确认撤销此凭据？它将无法再取件、发起、补充或查询；已保存协助仍保留。</p>
                <Button
                  type="button"
                  disabled={locked || disabled || !!read.error}
                  onClick={() => {
                    if (locked || disabled || read.error) return;
                    setSecret((current) => (current?.credential.id === item.id ? null : current));
                    void revoke.send(agentRequesterCredentialRevokePath(task.id, item.id), {
                      expectedRevision: item.revision,
                    });
                  }}
                >
                  确认撤销原生发起凭据
                </Button>
                <Button type="button" disabled={locked} onClick={() => setRevokeId(null)}>
                  保留原生发起凭据
                </Button>
              </>
            ) : (
              <Button
                type="button"
                disabled={locked || disabled}
                onClick={() => setRevokeId(item.id)}
              >
                撤销原生发起凭据
              </Button>
            ))}
        </section>
      ))}
      <Button type="button" disabled={busy} onClick={read.retry}>
        刷新原生发起凭据
      </Button>
    </section>
  );
}
