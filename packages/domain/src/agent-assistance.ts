import { DomainError } from '../../contracts/src/index.js';
import type { AssistanceState } from '../../contracts/src/assistance.js';
import type {
  AgentAssistanceMetadata,
  AgentAssistancePhase,
  AgentAssistanceResponse,
  AgentAssistanceResponseRecord,
  AgentAssistanceScope,
} from '../../contracts/src/agent-assistance.js';

/** Derived from immutable response facts, never a second writable lifecycle. */
export function agentAssistancePhase(
  state: AssistanceState,
  inputRevision: number,
  responses: readonly AgentAssistanceResponseRecord[],
): AgentAssistancePhase {
  if (state === 'closed' || state === 'cancelled') return 'terminal';
  if (state === 'responded') return 'answered';
  const current = responses.filter((response) => response.inputRevision === inputRevision);
  if (
    current.some(
      (response) => response.type === 'request_input' || response.type === 'propose_scope',
    )
  )
    return 'waiting_input';
  if (current.some((response) => response.type === 'accept')) return 'accepted';
  return 'awaiting_acceptance';
}
export function agentAssistancePendingResponse(
  inputRevision: number,
  responses: readonly AgentAssistanceResponseRecord[],
): AgentAssistanceResponseRecord | null {
  return (
    responses.find(
      (response) =>
        response.inputRevision === inputRevision &&
        (response.type === 'request_input' || response.type === 'propose_scope'),
    ) ?? null
  );
}
export function assertAgentAssistanceScope(
  scope: AgentAssistanceScope,
  materialIds: readonly string[],
) {
  if (
    !scope.materialIds.includes(materialIds[0]!) ||
    scope.materialIds.some((id) => !materialIds.includes(id))
  )
    throw new DomainError('SCOPE_EXPANSION_DENIED', '范围提案只能选择本请求已有材料', 422);
}
export function assertAgentAssistanceResponseAllowed(
  state: AssistanceState,
  metadata: Pick<AgentAssistanceMetadata, 'currentInputRevision' | 'responses' | 'materials'>,
  response: AgentAssistanceResponse,
) {
  if (state !== 'open') throw new DomainError('ASSISTANCE_NOT_OPEN', '协助已结束或已有回答', 409);
  const phase = agentAssistancePhase(state, metadata.currentInputRevision, metadata.responses);
  if (response.type === 'decline') return;
  if (phase === 'waiting_input')
    throw new DomainError('ASSISTANCE_INPUT_PENDING', '请等待发起者确认新输入', 409);
  if (response.type === 'accept' && phase === 'accepted')
    throw new DomainError('ASSISTANCE_ALREADY_ACCEPTED', '当前输入已经接受', 409);
  if (response.type === 'answer' && phase !== 'accepted')
    throw new DomainError('ASSISTANCE_ACCEPT_REQUIRED', '回答前必须接受当前输入', 409);
  if (response.type === 'propose_scope')
    assertAgentAssistanceScope(
      response.scope,
      metadata.materials.map((material) => material.id),
    );
}
export function assertAgentAssistanceRevisionCause(
  state: AssistanceState,
  pendingResponseId: string | null,
  causeResponseId: string | null,
) {
  if (state !== 'open') throw new DomainError('ASSISTANCE_NOT_OPEN', '当前协助不能再补充输入', 409);
  if (pendingResponseId !== causeResponseId)
    throw new DomainError('ASSISTANCE_CAUSE_CHANGED', '补充输入必须对应当前待处理协商回应', 409);
}
export function assertAgentAssistanceCredentialExpiry(expiresAt: string, now: number) {
  const delta = Date.parse(expiresAt) - now;
  if (!Number.isFinite(delta) || delta <= 0 || delta > 24 * 3600_000)
    throw new DomainError('INVALID_INPUT', '请求凭证必须在未来 24 小时内到期');
}
export function assertAgentAssistanceInputBudget(
  projectTexts: readonly string[],
  completeInput: string,
) {
  if (
    projectTexts.reduce((sum, value) => sum + value.length, 0) > 10000 ||
    completeInput.length > 20000
  )
    throw new DomainError('INPUT_BUDGET_EXCEEDED', '分享材料超过本次输入预算', 422);
}
