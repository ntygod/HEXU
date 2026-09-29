import { DomainError, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import { retentionDate } from './checkpoint-retention.js';
import type { Handoff } from './handoffs.js';

export type HandoffAcceptanceState =
  | 'waiting_local'
  | 'needs_attention'
  | 'succeeded'
  | 'cancelled';
export interface HandoffAcceptanceTicket {
  version: 1;
  id: string;
  handoffId: string;
  handoffRevision: number;
  handoffHash: string;
  taskId: string;
  taskRevision: number;
  contextHash: string;
  projectId: string;
  spaceId: string;
  recipientId: string;
  nodeId: string;
  transferId: string;
  transferHash: string;
  snapshotHash: string;
  ownerUserId: string;
  transferOwner: boolean;
  createdAt: string;
  expiresAt: string;
  requestHash: string;
}
export interface HandoffAcceptanceProof {
  restoreId: string;
  planHash: string;
  snapshotHash: string;
  workspaceRef: string;
  verifiedAt: string;
  files: number;
  bytes: number;
}
export interface HandoffAcceptance {
  ticket: HandoffAcceptanceTicket;
  snapshot: Handoff;
  revision: number;
  state: HandoffAcceptanceState;
  updatedAt: string;
  reason: string | null;
  proof: HandoffAcceptanceProof | null;
  proofHash: string | null;
  acceptedAt: string | null;
}
export interface HandoffAcceptancePreview {
  handoffRevision: number;
  taskRevision: number;
  contextHash: string;
  taskTitle: string;
  taskDescription: string;
  ownerUserId: string;
  transferOwnerRequested: boolean;
}
export function parseHandoffAcceptance(input: unknown) {
  const b = exact(input, [
    'expectedHandoffRevision',
    'expectedTaskRevision',
    'contextHash',
    'transferOwner',
  ]);
  if (typeof b.transferOwner !== 'boolean')
    throw new DomainError('INVALID_INPUT', '需明确是否同时接受负责人职责');
  return {
    expectedHandoffRevision: revision(b.expectedHandoffRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    contextHash: checkpointHash(b.contextHash),
    transferOwner: b.transferOwner,
  };
}
export function parseHandoffAcceptanceProof(input: unknown): HandoffAcceptanceProof {
  const b = exact(input, [
    'restoreId',
    'planHash',
    'snapshotHash',
    'workspaceRef',
    'verifiedAt',
    'files',
    'bytes',
  ]);
  const bounded = (v: unknown, max: number) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max)
      throw new DomainError('INVALID_INPUT', '接手核验数量超出边界');
    return v;
  };
  return {
    restoreId: nodeId(b.restoreId),
    planHash: checkpointHash(b.planHash),
    snapshotHash: checkpointHash(b.snapshotHash),
    workspaceRef: nodeId(b.workspaceRef),
    verifiedAt: retentionDate(b.verifiedAt),
    files: bounded(b.files, 50000),
    bytes: bounded(b.bytes, 64 * 1024 * 1024),
  };
}
export function parseHandoffNodeCommand(input: unknown) {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (action === 'inspect') {
    const b = exact(input, ['action', 'operationId']);
    return { action, operationId: nodeId(b.operationId) } as const;
  }
  if (action === 'commit') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'proof']);
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      proof: parseHandoffAcceptanceProof(b.proof),
    } as const;
  }
  if (action === 'fail') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'reason']);
    if (
      typeof b.reason !== 'string' ||
      !['files_changed', 'workspace_busy', 'cancelled', 'local_check_failed'].includes(b.reason)
    )
      throw new DomainError('INVALID_INPUT', '不支持的本机接手失败类别');
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      reason: b.reason as 'files_changed' | 'workspace_busy' | 'cancelled' | 'local_check_failed',
    } as const;
  }
  throw new DomainError('INVALID_INPUT', '只接受接手核对或提交，不接受目录/模型命令');
}
