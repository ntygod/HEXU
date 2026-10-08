import { DomainError, record, revision, text } from './index.js';
import {
  parseAgentAssistancePreview,
  type AgentAssistancePreviewCommand,
  type AgentAssistanceTarget,
} from './agent-assistance.js';

export const AGENT_REQUESTER_API_VERSION = '1';
export interface AgentRequesterCredential {
  id: string;
  revision: number;
  participantId: string;
  taskId: string;
  target: AgentAssistanceTarget;
  inputHash: string;
  materialLabels: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}
export interface AgentRequesterCredentialIssue {
  participantId: string;
  preview: AgentAssistancePreviewCommand;
  expectedTaskRevision: number;
  expectedInputHash: string;
  shareConfirmed: true;
  expiresAt: string;
}
export interface AgentRequesterCredentialIssued {
  credential: AgentRequesterCredential;
  token: string | null;
}
export interface AgentRequesterInput {
  question: string;
  clarification: string | null;
  materialIds: string[];
}
export interface AgentRequesterCreate extends AgentRequesterInput {
  expectedTaskRevision: number;
  expectedInputHash: string;
}
export interface AgentRequesterReviseInput extends AgentRequesterCreate {
  expectedRevision: number;
  expectedInputRevision: number;
  expectedAccessRevision: number;
  causeResponseId: string | null;
}
function exact(value: unknown, keys: string[]) {
  const b = record(value);
  if (Object.keys(b).length !== keys.length || Object.keys(b).some((k) => !keys.includes(k)))
    throw new DomainError('INVALID_INPUT', '包含无效或不支持的请求字段');
  return b;
}
const fingerprint = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new DomainError('INVALID_INPUT', '输入指纹无效');
  return value;
};
const inputKeys = ['question', 'clarification', 'materialIds'];
function input(b: Record<string, unknown>): AgentRequesterInput {
  if (!Array.isArray(b.materialIds) || b.materialIds.length < 1 || b.materialIds.length > 17)
    throw new DomainError('INVALID_INPUT', '材料范围无效');
  const materialIds = b.materialIds.map((v) => text(v, '材料', 150));
  if (!materialIds.includes('message') || new Set(materialIds).size !== materialIds.length)
    throw new DomainError('INVALID_INPUT', '必须保留原消息摘录且材料不能重复');
  return {
    question: text(b.question, '问题', 2000),
    clarification: b.clarification === null ? null : text(b.clarification, '澄清', 6000),
    materialIds,
  };
}
export function parseAgentRequesterInput(value: unknown) {
  return input(exact(value, inputKeys));
}
export function parseAgentRequesterCreate(value: unknown): AgentRequesterCreate {
  const b = exact(value, [...inputKeys, 'expectedTaskRevision', 'expectedInputHash']);
  const result = input(b);
  if (result.clarification !== null)
    throw new DomainError('INVALID_INPUT', '首次请求不能含后续澄清');
  return {
    ...result,
    expectedTaskRevision: revision(b.expectedTaskRevision),
    expectedInputHash: fingerprint(b.expectedInputHash),
  };
}
export function parseAgentRequesterReviseInput(value: unknown): AgentRequesterReviseInput {
  const b = exact(value, [
    ...inputKeys,
    'expectedTaskRevision',
    'expectedInputHash',
    'expectedRevision',
    'expectedInputRevision',
    'expectedAccessRevision',
    'causeResponseId',
  ]);
  return {
    ...input(b),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    expectedInputHash: fingerprint(b.expectedInputHash),
    expectedRevision: revision(b.expectedRevision),
    expectedInputRevision: revision(b.expectedInputRevision),
    expectedAccessRevision: revision(b.expectedAccessRevision),
    causeResponseId: b.causeResponseId === null ? null : text(b.causeResponseId, '回应', 150),
  };
}
export function parseAgentRequesterCancel(value: unknown) {
  const b = exact(value, ['expectedRevision']);
  return { expectedRevision: revision(b.expectedRevision) };
}
export function parseAgentRequesterCredentialIssue(value: unknown): AgentRequesterCredentialIssue {
  const b = exact(value, [
    'participantId',
    'preview',
    'expectedTaskRevision',
    'expectedInputHash',
    'shareConfirmed',
    'expiresAt',
  ]);
  const preview = parseAgentAssistancePreview(b.preview);
  const participantId = text(b.participantId, '发起身份', 150);
  if (preview.requesterParticipantId !== participantId)
    throw new DomainError('INVALID_INPUT', '预览发起身份不一致');
  if (b.shareConfirmed !== true)
    throw new DomainError(
      'SHARING_CONFIRMATION_REQUIRED',
      '需明确确认此目标及固定材料的有限 Agent 授权',
      422,
    );
  if (
    typeof b.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(b.expiresAt) ||
    !Number.isFinite(Date.parse(b.expiresAt))
  )
    throw new DomainError('INVALID_INPUT', '到期时间必须为 UTC ISO 时间');
  const expiresAt = new Date(b.expiresAt).toISOString();
  if (expiresAt !== b.expiresAt && expiresAt !== b.expiresAt.replace(/Z$/, '.000Z'))
    throw new DomainError('INVALID_INPUT', '到期时间无效');
  return {
    participantId,
    preview,
    expectedTaskRevision: revision(b.expectedTaskRevision),
    expectedInputHash: fingerprint(b.expectedInputHash),
    shareConfirmed: true,
    expiresAt,
  };
}
