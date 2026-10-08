import { DomainError, record } from './index.js';
import { parseAssistanceList, type AssistancePerson, type AssistanceState } from './assistance.js';
import type {
  AgentAssistancePhase,
  AgentAssistanceResponseType,
  AgentAssistanceTerminalReason,
} from './agent-assistance.js';

/** Parent-Task-only display identity. Never includes endpoint or native connection references. */
export interface TaskAgentCollaborationParty {
  participantId: string | null;
  name: string;
  owner: AssistancePerson;
}
export interface TaskAgentCollaborationActor extends TaskAgentCollaborationParty {
  kind: 'human' | 'agent' | 'policy';
}
export type TaskAgentCollaborationWaitingFor =
  | 'acceptance'
  | 'capacity'
  | 'clarification'
  | 'scope_decision'
  | 'answer'
  | 'continuation'
  | 'continuation_confirmation'
  | null;
export interface TaskAgentCollaborationDelivery {
  source: 'agent_events';
  /** Aggregate of callbacks for the latest saved Assistance event, not Agent acceptance. */
  state:
    | 'not_observed'
    | 'pending'
    | 'inflight'
    | 'delivered'
    | 'unknown'
    | 'failed'
    | 'suppressed'
    | 'mixed';
  inputRevision: number;
  /** Existing Events subscriptions notify the request's receiving Agent. */
  recipient: 'receiver';
  eventType: string | null;
  eventOccurredAt: string | null;
  /** Existing delivery storage has no receipt timestamp. Never substitute event creation time. */
  confirmedAt: null;
}
export interface TaskAgentCollaborationConsumption {
  status: 'unbound' | 'waiting_answer' | 'answer_available' | 'claimed' | 'reported';
  bindingId: string | null;
  responseId: string | null;
  inputRevision: number | null;
  claimedAt: string | null;
  acknowledgement: {
    evidence: 'external_self_report';
    observedAt: string;
    late: boolean;
    cancelled: boolean;
  } | null;
  /** Cancels future delivery only; says nothing about termination of external work. */
  futureContinuationCancelledAt: string | null;
}
/** Read projection only. Assistance remains the sole collaboration business state. */
export interface TaskAgentCollaboration {
  assistanceId: string;
  requestId: string;
  revision: number;
  currentInputRevision: number;
  accessRevision: number;
  purpose: string;
  requester: TaskAgentCollaborationParty;
  recipient: TaskAgentCollaborationParty;
  initiatedBy: TaskAgentCollaborationActor;
  state: AssistanceState;
  phase: AgentAssistancePhase;
  terminalReason: AgentAssistanceTerminalReason | null;
  accessEnded: boolean;
  canManage: boolean;
  waitingFor: TaskAgentCollaborationWaitingFor;
  latestResponse: {
    id: string;
    type: AgentAssistanceResponseType;
    inputRevision: number;
    createdAt: string;
    actor: TaskAgentCollaborationActor;
  } | null;
  latestConfirmation: {
    source:
      | 'assistance'
      | 'consumption_claim'
      | 'external_self_report'
      | 'future_continuation_cancelled';
    at: string;
  };
  delivery: TaskAgentCollaborationDelivery;
  consumption: TaskAgentCollaborationConsumption;
}
export interface TaskAgentCollaborationList {
  items: TaskAgentCollaboration[];
  nextCursor: string | null;
}
export function parseTaskAgentCollaborationList(value: unknown) {
  const body = record(value);
  if (Object.keys(body).some((key) => !['cursor', 'limit'].includes(key)))
    throw new DomainError('INVALID_INPUT', '协作列表包含不支持的字段');
  const { cursor, limit } = parseAssistanceList(body);
  return { cursor, limit };
}
