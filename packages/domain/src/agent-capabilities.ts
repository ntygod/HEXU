import type {
  AgentCapabilityListing,
  AgentParticipant,
  AgentCapability,
  DelegationGrant,
} from '../../contracts/src/agent-capabilities.js';
import { DomainError } from '../../contracts/src/index.js';
/** Enrollment is a declaration, never evidence that a remote receiver can be invoked. */
export function capabilityListing(
  agent: AgentParticipant,
  capability: AgentCapability,
  grant: DelegationGrant,
): AgentCapabilityListing {
  return {
    participantId: agent.id,
    participantName: agent.name,
    ownerUserId: agent.ownerUserId,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    endpointRevision: grant.endpointRevision,
    title: capability.title,
    description: capability.description,
    kind: 'text_expertise',
    providerSupport: 'unverified',
    hexuIntegration: 'not_integrated',
    authorizationEnvironment: grant.request ? 'unverified' : 'request_not_granted',
    canRequest: grant.request,
    autoAccept: grant.autoAccept,
    callable: false,
    blocker: grant.request
      ? '独立连接仅支持项目能力只读访问；接收适配与运行环境尚未验证，当前仅可选择准备'
      : '此授权仅允许发现；尚未授予请求权限',
    grantId: grant.id,
    grantRevision: grant.revision,
    expiresAt: grant.expiresAt,
    maxConcurrent: grant.maxConcurrent,
    costBearerUserId: grant.costBearerUserId,
  };
}
export function assertGrantExpiry(expiresAt: string, now: number) {
  const delta = Date.parse(expiresAt) - now;
  if (delta <= 0 || delta > 30 * 24 * 3600_000)
    throw new DomainError('INVALID_INPUT', '预授权需在未来 30 天内到期');
}
