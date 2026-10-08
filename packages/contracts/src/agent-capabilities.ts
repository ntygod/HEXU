import { DomainError, enumValue, record, revision, text } from './index.js';

export interface AgentParticipant {
  id: string;
  spaceId: string;
  ownerUserId: string;
  name: string;
  nativeInstanceRef: string | null;
  revision: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentEndpoint {
  id: string;
  participantId: string;
  revision: number;
  protocol: 'mcp' | 'a2a' | 'custom';
  address: string;
  implementation: string;
  implementationVersion: string;
  receiveMode: 'poll' | 'push' | 'manual';
  authentication: 'not_integrated';
  lastVerifiedAt: null;
}
export interface AgentCapability {
  id: string;
  participantId: string;
  endpointId: string;
  version: number;
  title: string;
  description: string;
  kind: 'text_expertise';
  input: 'text';
  output: 'text';
  providerSupport: 'unverified';
  hexuIntegration: 'not_integrated';
}
export interface DelegationGrant {
  id: string;
  participantId: string;
  capabilityId: string;
  capabilityVersion: number;
  endpointRevision: number;
  projectId: string;
  revision: number;
  audience: 'project_members' | 'selected_members';
  requesterUserIds: string[];
  discover: true;
  request: boolean;
  autoAccept: boolean;
  materialScope: 'explicit_text_snapshot';
  outputScope: 'text_answer';
  execution: false;
  externalEffects: false;
  costBearer: 'owner';
  costBearerUserId: string;
  expiresAt: string;
  maxConcurrent: number;
  revokedAt: string | null;
  createdAt: string;
}
export interface AgentConnection {
  id: string;
  participantId: string;
  projectId: string;
  revision: number;
  scope: 'capability_read';
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentConnectionIssue {
  agent: AgentParticipantView;
  /** Returned only on the first committed response; never stored in receipts or logs. */
  token: string | null;
}
export interface AgentParticipantView extends AgentParticipant {
  connection: AgentConnection | null;
  endpoint: AgentEndpoint | null;
  capability: AgentCapability | null;
  grants: DelegationGrant[];
}
export interface AgentCapabilityListing {
  endpointRevision: number;
  participantId: string;
  participantName: string;
  ownerUserId: string;
  capabilityId: string;
  capabilityVersion: number;
  title: string;
  description: string;
  kind: 'text_expertise';
  providerSupport: 'unverified';
  hexuIntegration: 'not_integrated';
  authorizationEnvironment: 'unverified' | 'request_not_granted';
  canRequest: boolean;
  autoAccept: boolean;
  callable: false;
  blocker: string;
  grantId: string;
  grantRevision: number;
  expiresAt: string;
  maxConcurrent: number;
  costBearerUserId: string;
}
export interface AgentCapabilitySelection {
  projectId: string;
  participantId: string;
  capabilityId: string;
  capabilityVersion: number;
  grantId: string;
  grantRevision: number;
  callable: false;
  blocker: string;
}
function strict(value: unknown, keys: string[]) {
  const body = record(value);
  if (Object.keys(body).some((k) => !keys.includes(k)))
    throw new DomainError('INVALID_INPUT', '包含不支持的字段；身份与能力状态由服务端确定');
  return body;
}
function clean(value: unknown, label: string, max: number) {
  const result = text(value, label, max);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(result))
    throw new DomainError('INVALID_INPUT', `${label}不能包含控制字符`);
  return result;
}
function multiline(value: unknown) {
  const result = text(value, '有限文本服务说明', 2000);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(result))
    throw new DomainError('INVALID_INPUT', '说明不能包含控制字符');
  return result;
}
function initialRevision(value: unknown) {
  return value === 0 ? 0 : revision(value);
}
export function parseAgentRegistration(value: unknown) {
  const b = strict(value, ['name', 'nativeInstanceRef']);
  return {
    name: clean(b.name, 'Agent 名称', 80),
    nativeInstanceRef:
      b.nativeInstanceRef == null ? null : clean(b.nativeInstanceRef, '原生实例引用', 160),
  };
}
export function parseAgentUpdate(value: unknown) {
  const b = strict(value, ['expectedRevision', 'name', 'nativeInstanceRef']);
  return {
    ...parseAgentRegistration({
      name: b.name,
      nativeInstanceRef: b.nativeInstanceRef,
    }),
    expectedRevision: revision(b.expectedRevision),
  };
}
export function parseAgentRevision(value: unknown) {
  const b = strict(value, ['expectedRevision']);
  return { expectedRevision: revision(b.expectedRevision) };
}
export function parseAgentEndpoint(value: unknown) {
  const b = strict(value, [
    'expectedRevision',
    'protocol',
    'address',
    'implementation',
    'implementationVersion',
    'receiveMode',
  ]);
  const address = clean(b.address, '端点地址', 500);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new DomainError('INVALID_INPUT', '端点需为有效 HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new DomainError('INVALID_INPUT', '端点仅保存 HTTPS 元数据，不能含账号、密码、查询或片段');
  return {
    expectedRevision: initialRevision(b.expectedRevision),
    protocol: enumValue(b.protocol, ['mcp', 'a2a', 'custom'] as const, '协议'),
    address: url.href,
    implementation: clean(b.implementation, '实现名称', 100),
    implementationVersion: clean(b.implementationVersion, '实现版本', 80),
    receiveMode: enumValue(b.receiveMode, ['poll', 'push', 'manual'] as const, '接收方式'),
  };
}
export function parseAgentCapability(value: unknown) {
  const b = strict(value, ['expectedRevision', 'title', 'description']);
  return {
    expectedRevision: initialRevision(b.expectedRevision),
    title: clean(b.title, '专业能力', 100),
    description: multiline(b.description),
  };
}
export function parseDelegationGrant(value: unknown) {
  const b = strict(value, [
    'projectId',
    'audience',
    'requesterUserIds',
    'request',
    'autoAccept',
    'expiresAt',
    'maxConcurrent',
    'costBearer',
    'expectedCapabilityVersion',
    'expectedEndpointRevision',
  ]);
  const audience = enumValue(
    b.audience,
    ['project_members', 'selected_members'] as const,
    '参与者范围',
  );
  if (!Array.isArray(b.requesterUserIds) || b.requesterUserIds.length > 50)
    throw new DomainError('INVALID_INPUT', '参与者列表最多 50 人');
  const requesterUserIds = b.requesterUserIds.map((v) => clean(v, '参与者', 150)).sort();
  if (
    new Set(requesterUserIds).size !== requesterUserIds.length ||
    (audience === 'selected_members' ? !requesterUserIds.length : requesterUserIds.length !== 0)
  )
    throw new DomainError('INVALID_INPUT', '指定成员需非空且不重复；项目成员范围需空列表');
  if (
    typeof b.request !== 'boolean' ||
    typeof b.autoAccept !== 'boolean' ||
    (b.autoAccept && !b.request)
  )
    throw new DomainError('INVALID_INPUT', '自动接受必须有明确请求预授权');
  const expiresAt = text(b.expiresAt, '有效期', 30);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt
  )
    throw new DomainError('INVALID_INPUT', '有效期需为 UTC ISO 时间');
  if (
    !Number.isSafeInteger(b.maxConcurrent) ||
    (b.maxConcurrent as number) < 1 ||
    (b.maxConcurrent as number) > 4
  )
    throw new DomainError('INVALID_INPUT', '并发上限需为 1–4');
  return {
    projectId: clean(b.projectId, '项目', 150),
    audience,
    requesterUserIds,
    request: b.request,
    autoAccept: b.autoAccept,
    expiresAt,
    maxConcurrent: b.maxConcurrent as number,
    costBearer: enumValue(b.costBearer, ['owner'] as const, '费用主体'),
    expectedCapabilityVersion: revision(b.expectedCapabilityVersion),
    expectedEndpointRevision: revision(b.expectedEndpointRevision),
  };
}
export function parseCapabilitySelection(value: unknown) {
  const b = strict(value, ['expectedVersion']);
  return { expectedVersion: revision(b.expectedVersion) };
}

export function parseAgentConnection(value: unknown) {
  const b = strict(value, ['expectedRevision', 'projectId', 'expiresAt']);
  const expiresAt = text(b.expiresAt, '凭据有效期', 30);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt
  )
    throw new DomainError('INVALID_INPUT', '凭据有效期需为 UTC ISO 时间');
  return {
    expectedRevision: initialRevision(b.expectedRevision),
    projectId: clean(b.projectId, '项目', 150),
    expiresAt,
  };
}
