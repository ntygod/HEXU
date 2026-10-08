import { DomainError, record, revision, text } from './index.js';
import { parseAgentRequesterCreate } from './agent-requester.js';
import type { AgentAssistanceActor } from './agent-assistance.js';

export interface AgentOriginalWorkOrigin {
  provider: 'codex' | 'external';
  threadRef: string;
  sessionRef: string;
}
export interface AgentOriginalWorkBinding {
  source: 'host_reported';
  id: string;
  requestId: string;
  requesterParticipantId: string;
  requesterConnectionId: string;
  origin: AgentOriginalWorkOrigin;
  createdAt: string;
  cancelledAt: string | null;
}
/** External observation only: neither a provider receipt nor verified execution. */
export interface AgentConsumptionAcknowledgement {
  evidence: 'external_self_report';
  turnRef: string;
  output: string;
  outputHash: string;
  observedAt: string;
  late: boolean;
  cancelled: boolean;
}
/** A claim reserves delivery once. Absence of ACK means unknown, never safe to restart. */
export interface AgentResultConsumption {
  id: string;
  requestId: string;
  bindingId: string;
  responseId: string;
  inputRevision: number;
  inputHash: string;
  accessRevision: number;
  answerHash: string;
  answer: string;
  sourceActor: AgentAssistanceActor;
  materialIds: string[];
  claimedAt: string;
  acknowledgement: AgentConsumptionAcknowledgement | null;
}
export interface AgentConsumptionView {
  binding: AgentOriginalWorkBinding | null;
  consumption: AgentResultConsumption | null;
}
export interface AgentConsumptionDelivery extends AgentConsumptionView {
  delivery: 'first' | 'replay';
}
export interface AgentTaskConsumption {
  requestId: string;
  binding: Pick<
    AgentOriginalWorkBinding,
    'id' | 'requesterParticipantId' | 'createdAt' | 'cancelledAt'
  > & { provider: AgentOriginalWorkOrigin['provider'] };
  consumption: AgentResultConsumption | null;
}
export interface AgentConsumeCommand {
  responseId: string;
  inputRevision: number;
  inputHash: string;
  accessRevision: number;
  bindingId: string;
}
export interface AgentConsumptionAckCommand {
  consumptionId: string;
  bindingId: string;
  threadRef: string;
  sessionRef: string;
  turnRef: string;
  output: string;
}
function exact(value: unknown, keys: string[]) {
  const b = record(value);
  if (Object.keys(b).length !== keys.length || Object.keys(b).some((k) => !keys.includes(k)))
    throw new DomainError('INVALID_INPUT', '包含无效或不支持的消费字段');
  return b;
}
/** Native references are opaque IDs, never filesystem paths, URLs or commands. */
function opaque(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,149}$/.test(value) ||
    value.includes('..')
  )
    throw new DomainError('INVALID_INPUT', '原工作引用必须是有限的不透明标识');
  return value;
}
export function parseAgentOriginalWorkBinding(value: unknown) {
  const b = exact(value, ['origin']),
    o = exact(b.origin, ['provider', 'threadRef', 'sessionRef']);
  if (o.provider !== 'codex' && o.provider !== 'external')
    throw new DomainError('INVALID_INPUT', '不支持的原工作提供方');
  return {
    origin: {
      provider: o.provider,
      threadRef: opaque(o.threadRef),
      sessionRef: opaque(o.sessionRef),
    } as AgentOriginalWorkOrigin,
  };
}
export function parseAgentConsume(value: unknown): AgentConsumeCommand {
  const b = exact(value, [
    'responseId',
    'inputRevision',
    'inputHash',
    'accessRevision',
    'bindingId',
  ]);
  if (typeof b.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.inputHash))
    throw new DomainError('INVALID_INPUT', '输入指纹无效');
  return {
    responseId: text(b.responseId, '回应', 150),
    inputRevision: revision(b.inputRevision),
    inputHash: b.inputHash,
    accessRevision: revision(b.accessRevision),
    bindingId: text(b.bindingId, '原工作绑定', 150),
  };
}
export function parseAgentConsumptionAck(value: unknown): AgentConsumptionAckCommand {
  const b = exact(value, [
    'consumptionId',
    'bindingId',
    'threadRef',
    'sessionRef',
    'turnRef',
    'output',
  ]);
  if (typeof b.output !== 'string' || !b.output.trim() || b.output.length > 6000)
    throw new DomainError('INVALID_INPUT', '后续输出为空或超过6000字符');
  return {
    consumptionId: text(b.consumptionId, '消费记录', 150),
    bindingId: text(b.bindingId, '原工作绑定', 150),
    threadRef: opaque(b.threadRef),
    sessionRef: opaque(b.sessionRef),
    turnRef: opaque(b.turnRef),
    output: b.output,
  };
}
export function parseAgentConsumptionCancel(value: unknown) {
  const b = exact(value, ['bindingId']);
  return { bindingId: text(b.bindingId, '原工作绑定', 150) };
}

/** New opt-in endpoint leaves the existing create-request schema unchanged. */
export function parseAgentBoundRequest(value: unknown) {
  const b = exact(value, ['request', 'origin']);
  return {
    request: parseAgentRequesterCreate(b.request),
    ...parseAgentOriginalWorkBinding({ origin: b.origin }),
  };
}
