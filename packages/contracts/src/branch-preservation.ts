import { DomainError, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import { retentionDate } from './checkpoint-retention.js';
import type { BranchCleanupInspection, BranchCleanupSelection } from './branch-cleanup-check.js';

export interface BranchPreservationCreate {
  expectedRevision: number;
  expectedTaskRevision: number;
  retentionId: string;
  confirmMoveCompleteDirectory: true;
  confirmKeepGitAndContents: true;
}
export interface BranchPreservationRequest {
  version: 1;
  kind: 'preserve_complete_branch_directory';
  id: string;
  taskId: string;
  branchId: string;
  nodeId: string;
  ownerId: string;
  projectId: string;
  spaceId: string;
  selection: BranchCleanupSelection;
  scope: BranchCleanupInspection;
  inputHash: string;
  requestedAt: string;
  requestedBy: { id: string; name: string };
}
export type BranchPreservationStage = 'moving' | 'preserved' | 'failed' | 'needs_attention';
export type BranchPreservationReason =
  | 'move_prepared'
  | 'directory_preserved'
  | 'preconditions_changed'
  | 'move_refused'
  | 'move_unknown'
  | 'interrupted';
export interface BranchPreservationReport {
  version: 1;
  kind: 'branch_directory_preservation';
  preservationId: string;
  inputHash: string;
  sequence: 1 | 2;
  stage: BranchPreservationStage;
  reason: BranchPreservationReason;
  evidenceHash: string;
  destinationRef: string;
  observedAt: string;
  confirmPublication: true;
}
export interface BranchPreservationView {
  request: BranchPreservationRequest;
  state: 'requested' | 'cancelled' | BranchPreservationStage;
  revision: number;
  reports: { report: BranchPreservationReport; hash: string; receivedAt: string }[];
  canBegin: boolean;
  canCancel: boolean;
  unavailableReason: string | null;
  executionRegistrationClosed: boolean;
}
export interface BranchPreservationReceipt {
  preservationId: string;
  acceptedSequence: 1 | 2;
  reportHash: string;
}
export function parseBranchPreservationCreate(input: unknown): BranchPreservationCreate {
  const b = exact(input, [
    'expectedRevision',
    'expectedTaskRevision',
    'retentionId',
    'confirmMoveCompleteDirectory',
    'confirmKeepGitAndContents',
  ]);
  if (b.confirmMoveCompleteDirectory !== true || b.confirmKeepGitAndContents !== true)
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      '需明确确认移出完整原目录并保留Git及所有内容；不永久删除',
    );
  return {
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    retentionId: nodeId(b.retentionId),
    confirmMoveCompleteDirectory: true,
    confirmKeepGitAndContents: true,
  };
}
export function parseBranchPreservationReport(input: unknown): BranchPreservationReport {
  const b = exact(input, [
    'version',
    'kind',
    'preservationId',
    'inputHash',
    'sequence',
    'stage',
    'reason',
    'evidenceHash',
    'destinationRef',
    'observedAt',
    'confirmPublication',
  ]);
  if (
    b.version !== 1 ||
    b.kind !== 'branch_directory_preservation' ||
    b.confirmPublication !== true ||
    ![1, 2].includes(b.sequence as number)
  )
    throw new DomainError('INVALID_INPUT', '移出保留报告格式无效');
  const valid: Record<string, string[]> = {
    moving: ['move_prepared'],
    preserved: ['directory_preserved'],
    failed: ['preconditions_changed', 'move_refused'],
    needs_attention: ['move_unknown', 'interrupted'],
  };
  if (
    typeof b.stage !== 'string' ||
    typeof b.reason !== 'string' ||
    !valid[b.stage]?.includes(b.reason) ||
    (b.sequence === 1 && !['moving', 'failed'].includes(b.stage)) ||
    (b.sequence === 2 && b.stage === 'moving')
  )
    throw new DomainError('INVALID_INPUT', '移出保留阶段与证据原因不匹配');
  return {
    version: 1,
    kind: 'branch_directory_preservation',
    preservationId: nodeId(b.preservationId),
    inputHash: checkpointHash(b.inputHash),
    sequence: b.sequence as 1 | 2,
    stage: b.stage as BranchPreservationStage,
    reason: b.reason as BranchPreservationReason,
    evidenceHash: checkpointHash(b.evidenceHash),
    destinationRef: nodeId(b.destinationRef),
    observedAt: retentionDate(b.observedAt),
    confirmPublication: true,
  };
}
