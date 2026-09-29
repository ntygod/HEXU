import { DomainError, revision, text } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import type { SnapshotCoverage } from './checkpoint-retention.js';

// This slice publishes invitations. Acceptance requires a separate, fresh local
// handover check; a transfer receipt or a restore report cannot manufacture it.
export type HandoffState = 'offered' | 'rejected' | 'withdrawn' | 'expired';
export type HandoffAction = 'reject' | 'withdraw';
export interface HandoffMaterial {
  transferId: string;
  transferHash: string;
  checkpointId: string;
  retentionId: string;
  commit: string;
  snapshotHash: string;
  coverage: SnapshotCoverage;
  expiresAt: string;
  receivedAt: string;
  sourceNodeId: string;
  targetNodeId: string;
  targetNodeName: string;
  recipient: { id: string; name: string };
}
export interface Handoff {
  id: string;
  taskId: string;
  spaceId: string;
  projectId: string;
  revision: number;
  state: HandoffState;
  sender: { id: string; name: string };
  material: HandoffMaterial;
  taskRevision: number;
  taskTitle: string;
  summary: string;
  remainingWork: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface HandoffView {
  handoff: Handoff;
  taskChanged: boolean;
  materialAvailable: boolean;
  canReject: boolean;
  canWithdraw: boolean;
}
export interface HandoffList {
  items: HandoffView[];
  nextCursor: number | null;
}
export interface HandoffEvent {
  revision: number;
  action: 'offer' | 'reject' | 'withdraw' | 'expire';
  actor: { id: string; name: string } | null;
  at: string;
}
export interface HandoffOptions {
  taskRevision: number;
  materials: HandoffMaterial[];
}
export function parseHandoffOffer(input: unknown) {
  const b = exact(input, [
    'transferId',
    'transferHash',
    'expectedTaskRevision',
    'summary',
    'remainingWork',
    'environment',
    'hours',
  ]);
  if (b.hours !== 1 && b.hours !== 24 && b.hours !== 72)
    throw new DomainError('INVALID_INPUT', '邀请有效期只能为 1、24 或 72 小时');
  return {
    transferId: nodeId(b.transferId),
    transferHash: checkpointHash(b.transferHash),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    summary: text(b.summary, '工作摘要', 4000),
    remainingWork: text(b.remainingWork, '剩余工作', 4000, true),
    environment: text(b.environment, '环境说明', 2000, true),
    hours: b.hours as 1 | 24 | 72,
  };
}
export function parseHandoffClose(input: unknown) {
  const b = exact(input, ['expectedRevision']);
  return { expectedRevision: revision(b.expectedRevision) };
}
