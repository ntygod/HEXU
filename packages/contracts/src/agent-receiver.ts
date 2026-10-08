import { DomainError, record, revision, text } from './index.js';
import type { AgentAssistanceTarget } from './agent-assistance.js';
import { parseAgentRequesterCancel } from './agent-requester.js';
export const AGENT_RECEIVER_API_VERSION = '1';
export interface AgentReceiverCredential {
  id: string;
  revision: number;
  participantId: string;
  projectId: string;
  target: AgentAssistanceTarget;
  scopes: ('material_read' | 'respond')[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}
export function parseAgentReceiverIssue(value: unknown) {
  const b = record(value);
  const keys = [
    'projectId',
    'capabilityId',
    'capabilityVersion',
    'endpointRevision',
    'grantId',
    'grantRevision',
    'scopes',
    'expiresAt',
    'receiveConfirmed',
  ];
  if (Object.keys(b).length !== keys.length || Object.keys(b).some((k) => !keys.includes(k)))
    throw new DomainError('INVALID_INPUT', '接收连接包含未知字段');
  if (b.receiveConfirmed !== true)
    throw new DomainError(
      'SHARING_CONFIRMATION_REQUIRED',
      '需明确确认此预授权的新请求接收范围',
      422,
    );
  if (
    !Array.isArray(b.scopes) ||
    !b.scopes.includes('material_read') ||
    new Set(b.scopes).size !== b.scopes.length ||
    b.scopes.some((s) => !['material_read', 'respond'].includes(s))
  )
    throw new DomainError('INVALID_INPUT', '接收权限无效');
  if (
    typeof b.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.expiresAt) ||
    !Number.isFinite(Date.parse(b.expiresAt)) ||
    new Date(b.expiresAt).toISOString() !== b.expiresAt
  )
    throw new DomainError('INVALID_INPUT', '到期时间必须为 UTC ISO 时间');
  return {
    projectId: text(b.projectId, '项目', 150),
    capabilityId: text(b.capabilityId, '能力', 150),
    capabilityVersion: revision(b.capabilityVersion),
    endpointRevision: revision(b.endpointRevision),
    grantId: text(b.grantId, '授权', 150),
    grantRevision: revision(b.grantRevision),
    scopes: b.scopes as ('material_read' | 'respond')[],
    expiresAt: b.expiresAt,
    receiveConfirmed: true as const,
  };
}
export const parseAgentReceiverRevoke = parseAgentRequesterCancel;
