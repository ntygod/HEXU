import { DomainError, enumValue, record, revision } from './index.js';
import { parseAssistanceRange, type AssistanceRange, type AssistanceState } from './assistance.js';

export const AGENT_ASSISTANCE_PROJECT_TEXT_LIMIT = 16;
export const AGENT_ASSISTANCE_PROJECT_TEXT_BUDGET = 10000;
export const AGENT_ASSISTANCE_INPUT_BUDGET = 20000;
export const AGENT_ASSISTANCE_BODY_LIMIT = 65536;
export type AgentAssistanceResponseType =
  | 'accept'
  | 'decline'
  | 'request_input'
  | 'propose_scope'
  | 'answer';
export type AgentAssistancePhase =
  | 'awaiting_acceptance'
  | 'accepted'
  | 'waiting_input'
  | 'answered'
  | 'terminal';
export type AgentAssistanceTerminalReason =
  | 'declined'
  | 'requester_closed'
  | 'cancelled'
  | 'access_revoked';
export type AgentAssistanceActor =
  | { kind: 'human'; userId: string }
  | {
      kind: 'agent';
      participantId: string;
      ownerUserId: string;
      connectionId: string;
      connectionRevision: number;
    }
  | { kind: 'policy'; ownerUserId: string; grantRevision: number };
export interface AgentAssistanceTarget {
  participantId: string;
  capabilityId: string;
  capabilityVersion: number;
  endpointRevision: number;
  grantId: string;
  grantRevision: number;
}
export interface AgentAssistanceInputSelection {
  question: string;
  clarification: string | null;
  message: { sourceMessageId: string; expectedSourceHash: string; range: AssistanceRange };
  projectTexts: {
    items: Array<{ id: string; revision: number; contentHash: string; maxChars: number }>;
    expectedHash: string;
  };
}
export interface AgentAssistancePreviewCommand {
  target: AgentAssistanceTarget;
  requesterParticipantId: string | null;
  input: AgentAssistanceInputSelection;
}
export interface AgentAssistanceCreate extends AgentAssistancePreviewCommand {
  expectedTaskRevision: number;
  expectedInputHash: string;
  shareConfirmed: true;
}
export interface AgentAssistanceResponseBase {
  expectedRevision: number;
  inputRevision: number;
  expectedInputHash: string;
  expectedAccessRevision: number;
}
export interface AgentAssistanceScope {
  question: string;
  materialIds: string[];
}
export type AgentAssistanceResponse = AgentAssistanceResponseBase &
  (
    | { type: 'accept' }
    | { type: 'decline' | 'request_input' | 'answer'; body: string }
    | { type: 'propose_scope'; body: string; scope: AgentAssistanceScope }
  );
export interface AgentAssistanceReviseInput {
  expectedRevision: number;
  expectedInputRevision: number;
  expectedAccessRevision: number;
  expectedTaskRevision: number;
  causeResponseId: string | null;
  input: AgentAssistanceInputSelection;
  expectedInputHash: string;
  shareConfirmed: true;
}
export interface AgentAssistanceEnd {
  expectedRevision: number;
  action: 'close' | 'cancel';
}
export interface AgentAssistanceMaterial {
  id: string;
  label: string;
  text: string;
}
export interface AgentAssistanceResponseRecord {
  id: string;
  type: AgentAssistanceResponseType;
  body: string;
  scope: AgentAssistanceScope | null;
  actor: AgentAssistanceActor;
  inputRevision: number;
  inputHash: string;
  accessRevision: number;
  createdAt: string;
}
export interface AgentAssistanceCredential {
  id: string;
  revision: number;
  scopes: AgentAssistanceCredentialScope[];
  expiresAt: string;
  revokedAt: string | null;
}
/** token is returned once by issuance; never part of list/detail metadata. */
export interface AgentAssistanceCredentialIssued {
  credential: AgentAssistanceCredential;
  token: string | null;
}
export interface AgentAssistanceMetadata {
  capacityBlocked?: boolean;
  clarification: string | null;
  canIssueCredential?: boolean;
  credential?: AgentAssistanceCredential | null;
  requestId: string;
  requesterParticipantId: string | null;
  recipientParticipantId: string;
  capabilityId: string;
  capabilityVersion: number;
  endpointRevision: number;
  grantId: string;
  grantRevision: number;
  currentInputRevision: number;
  accessRevision: number;
  inputHash: string;
  phase: AgentAssistancePhase;
  terminalReason: AgentAssistanceTerminalReason | null;
  materials: AgentAssistanceMaterial[];
  responses: AgentAssistanceResponseRecord[];
  pendingResponseId: string | null;
  editInput?: AgentAssistanceInputSelection;
}
export interface AgentAssistancePreview {
  expectedTaskRevision: number;
  inputHash: string;
  materials: AgentAssistanceMaterial[];
  input: AgentAssistanceInputSelection;
  target: AgentAssistanceTarget;
  requesterParticipantId: string | null;
  question: string;
  clarification: string | null;
}
/** The bearer projection deliberately has no parent IDs, source IDs, or owner principal. */
export interface AgentAssistanceRequestView {
  requestId: string;
  revision: number;
  state: AssistanceState;
  inputRevision: number;
  inputHash: string;
  accessRevision: number;
  phase: AgentAssistancePhase;
  terminalReason: AgentAssistanceTerminalReason | null;
  question?: string;
  clarification?: string | null;
  materials?: AgentAssistanceMaterial[];
  responses?: AgentAssistanceResponseRecord[];
}
export type AgentAssistanceCredentialScope = 'material_read' | 'respond';
export interface AgentAssistanceCredentialIssue {
  expectedRevision: number;
  scopes: AgentAssistanceCredentialScope[];
  expiresAt: string;
}
export type AgentAssistanceCredentialManagement =
  | ({ action: 'rotate' } & AgentAssistanceCredentialIssue)
  | { action: 'revoke'; expectedRevision: number };

function invalid(message = 'Agent 协助请求包含无效或不支持的字段'): never {
  throw new DomainError('INVALID_INPUT', message);
}
function exact(value: unknown, fields: readonly string[]) {
  const b = record(value);
  if (
    Object.keys(b).length !== fields.length ||
    Object.keys(b).some((key) => !fields.includes(key))
  )
    invalid();
  return b;
}
function id(value: unknown, max = 150): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max)
    invalid('标识无效');
  return value;
}
function nullableId(value: unknown) {
  return value === null ? null : id(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('输入指纹无效');
  return value;
}
function body(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    invalid('文本为空或超出限制');
  return value;
}
function confirmed(value: unknown): true {
  if (value !== true)
    throw new DomainError('SHARING_CONFIRMATION_REQUIRED', '请确认接收者和本轮分享材料', 422);
  return true;
}
export function parseAgentAssistanceTarget(value: unknown): AgentAssistanceTarget {
  const b = exact(value, [
    'participantId',
    'capabilityId',
    'capabilityVersion',
    'endpointRevision',
    'grantId',
    'grantRevision',
  ]);
  return {
    participantId: id(b.participantId),
    capabilityId: id(b.capabilityId),
    capabilityVersion: revision(b.capabilityVersion),
    endpointRevision: revision(b.endpointRevision),
    grantId: id(b.grantId),
    grantRevision: revision(b.grantRevision),
  };
}
export function parseAgentAssistanceInputSelection(value: unknown): AgentAssistanceInputSelection {
  const b = exact(value, ['question', 'clarification', 'message', 'projectTexts']);
  const message = exact(b.message, ['sourceMessageId', 'expectedSourceHash', 'range']);
  const texts = exact(b.projectTexts, ['items', 'expectedHash']);
  if (!Array.isArray(texts.items) || texts.items.length > AGENT_ASSISTANCE_PROJECT_TEXT_LIMIT)
    invalid('最多选择 16 项项目文本');
  const items = texts.items.map((value) => {
    const item = exact(value, ['id', 'revision', 'contentHash', 'maxChars']);
    const maxChars = revision(item.maxChars);
    if (maxChars > 8000) invalid('单项文本预算最多 8000 字符');
    return {
      id: id(item.id, 100),
      revision: revision(item.revision),
      contentHash: hash(item.contentHash),
      maxChars,
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalid('不能重复选择同一项目文本');
  return {
    question: body(b.question, 2000),
    clarification: b.clarification === null ? null : body(b.clarification, 6000),
    message: {
      sourceMessageId: id(message.sourceMessageId, 100),
      expectedSourceHash: hash(message.expectedSourceHash),
      range: parseAssistanceRange(message.range),
    },
    projectTexts: { items, expectedHash: hash(texts.expectedHash) },
  };
}
export function parseAgentAssistancePreview(value: unknown): AgentAssistancePreviewCommand {
  const b = exact(value, ['target', 'requesterParticipantId', 'input']);
  return {
    target: parseAgentAssistanceTarget(b.target),
    requesterParticipantId: nullableId(b.requesterParticipantId),
    input: parseAgentAssistanceInputSelection(b.input),
  };
}
export function parseAgentAssistanceCreate(value: unknown): AgentAssistanceCreate {
  const b = exact(value, [
    'target',
    'requesterParticipantId',
    'expectedTaskRevision',
    'input',
    'expectedInputHash',
    'shareConfirmed',
  ]);
  const input = parseAgentAssistanceInputSelection(b.input);
  if (input.clarification !== null) invalid('首次请求不能包含后续澄清');
  return {
    target: parseAgentAssistanceTarget(b.target),
    requesterParticipantId: nullableId(b.requesterParticipantId),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    input,
    expectedInputHash: hash(b.expectedInputHash),
    shareConfirmed: confirmed(b.shareConfirmed),
  };
}
export function parseAgentAssistanceResponse(value: unknown): AgentAssistanceResponse {
  const candidate = record(value);
  const type = enumValue(
    candidate.type,
    ['accept', 'decline', 'request_input', 'propose_scope', 'answer'] as const,
    '协商回应',
  );
  const fields = [
    'expectedRevision',
    'inputRevision',
    'expectedInputHash',
    'expectedAccessRevision',
    'type',
  ];
  if (type !== 'accept') fields.push('body');
  if (type === 'propose_scope') fields.push('scope');
  const b = exact(value, fields);
  const base = {
    expectedRevision: revision(b.expectedRevision),
    inputRevision: revision(b.inputRevision),
    expectedInputHash: hash(b.expectedInputHash),
    expectedAccessRevision: revision(b.expectedAccessRevision),
  };
  if (type === 'accept') return { ...base, type };
  if (type !== 'propose_scope') return { ...base, type, body: body(b.body, 6000) };
  const scope = exact(b.scope, ['question', 'materialIds']);
  if (!Array.isArray(scope.materialIds) || scope.materialIds.length > 17) invalid('范围材料无效');
  const materialIds = scope.materialIds.map((value) => id(value));
  if (new Set(materialIds).size !== materialIds.length) invalid('范围材料不能重复');
  return {
    ...base,
    type,
    body: body(b.body, 6000),
    scope: { question: body(scope.question, 2000), materialIds },
  };
}
export function parseAgentAssistanceReviseInput(value: unknown): AgentAssistanceReviseInput {
  const b = exact(value, [
    'expectedRevision',
    'expectedInputRevision',
    'expectedAccessRevision',
    'expectedTaskRevision',
    'causeResponseId',
    'input',
    'expectedInputHash',
    'shareConfirmed',
  ]);
  return {
    expectedRevision: revision(b.expectedRevision),
    expectedInputRevision: revision(b.expectedInputRevision),
    expectedAccessRevision: revision(b.expectedAccessRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    causeResponseId: nullableId(b.causeResponseId),
    input: parseAgentAssistanceInputSelection(b.input),
    expectedInputHash: hash(b.expectedInputHash),
    shareConfirmed: confirmed(b.shareConfirmed),
  };
}
export function parseAgentAssistanceEnd(value: unknown): AgentAssistanceEnd {
  const b = exact(value, ['expectedRevision', 'action']);
  return {
    expectedRevision: revision(b.expectedRevision),
    action: enumValue(b.action, ['close', 'cancel'] as const, '协助操作'),
  };
}
function credentialRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalid('凭证修订无效');
  return value;
}
function issuance(b: Record<string, unknown>): AgentAssistanceCredentialIssue {
  if (!Array.isArray(b.scopes) || b.scopes.length < 1 || b.scopes.length > 2)
    invalid('凭证需要请求限定的 scope');
  const scopes = b.scopes.map((value) =>
    enumValue(value, ['material_read', 'respond'] as const, '凭证 scope'),
  );
  if (new Set(scopes).size !== scopes.length) invalid('凭证 scope 不能重复');
  if (
    typeof b.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(b.expiresAt) ||
    !Number.isFinite(Date.parse(b.expiresAt))
  )
    invalid('凭证到期时间必须为 UTC ISO 时间');
  const iso = new Date(b.expiresAt).toISOString();
  if (iso !== b.expiresAt && iso !== b.expiresAt.replace(/Z$/, '.000Z'))
    invalid('凭证到期时间无效');
  return {
    expectedRevision: credentialRevision(b.expectedRevision),
    scopes,
    expiresAt: iso,
  };
}
export function parseAgentAssistanceCredentialIssue(
  value: unknown,
): AgentAssistanceCredentialIssue {
  return issuance(exact(value, ['expectedRevision', 'scopes', 'expiresAt']));
}
export function parseAgentAssistanceCredentialManagement(
  value: unknown,
): AgentAssistanceCredentialManagement {
  const candidate = record(value);
  const action = enumValue(candidate.action, ['rotate', 'revoke'] as const, '凭证操作');
  const b = exact(
    value,
    action === 'rotate'
      ? ['action', 'expectedRevision', 'scopes', 'expiresAt']
      : ['action', 'expectedRevision'],
  );
  return action === 'rotate'
    ? { action, ...issuance(b), expectedRevision: revision(b.expectedRevision) }
    : { action, expectedRevision: revision(b.expectedRevision) };
}
