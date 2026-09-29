import { DomainError, revision, text } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid } from './checkpoints.js';
import { retentionDate, type RetentionManifest } from './checkpoint-retention.js';

export interface BranchWorkspaceTicket {
  id: string;
  taskId: string;
  branchId: string;
  branchRevision: number;
  groupId: string;
  startHash: string;
  ownerId: string;
  projectId: string;
  spaceId: string;
  sourceNodeId: string;
  retentionId: string;
  checkpointId: string;
  manifest: RetentionManifest;
  createdAt: string;
  expiresAt: string;
  requestHash: string;
}
export interface BranchWorkspaceProof {
  originHash: string;
  workspaceRef: string;
  restoreId: string;
  planHash: string;
  snapshotHash: string;
  verifiedAt: string;
}
export interface BranchWorkspaceOperation {
  ticket: BranchWorkspaceTicket;
  state: 'waiting_local' | 'prepared' | 'bound' | 'cancelled' | 'needs_attention';
  revision: number;
  proof: BranchWorkspaceProof | null;
  proofHash: string | null;
  nodeId: string | null;
  workingCopyId: string | null;
  updatedAt: string;
  reason: string | null;
}
export interface BranchExecutionBinding {
  branchId: string;
  groupId: string;
  operationId: string;
  startHash: string;
  originHash: string;
  commit: string;
}
export function parseBranchExecutionBinding(input: unknown): BranchExecutionBinding {
  const b = exact(input, [
    'branchId',
    'groupId',
    'operationId',
    'startHash',
    'originHash',
    'commit',
  ]);
  return {
    branchId: nodeId(b.branchId),
    groupId: nodeId(b.groupId),
    operationId: nodeId(b.operationId),
    startHash: checkpointHash(b.startHash),
    originHash: checkpointHash(b.originHash),
    commit: commitOid(b.commit),
  };
}
export function parseBranchWorkspaceCreate(input: unknown) {
  const b = exact(input, ['expectedRevision', 'retentionId', 'snapshotHash']);
  return {
    expectedRevision: revision(b.expectedRevision),
    retentionId: nodeId(b.retentionId),
    snapshotHash: checkpointHash(b.snapshotHash),
  };
}
export function parseBranchWorkspaceProof(input: unknown): BranchWorkspaceProof {
  const b = exact(input, [
    'originHash',
    'workspaceRef',
    'restoreId',
    'planHash',
    'snapshotHash',
    'verifiedAt',
  ]);
  return {
    originHash: checkpointHash(b.originHash),
    workspaceRef: checkpointHash(b.workspaceRef),
    restoreId: nodeId(b.restoreId),
    planHash: checkpointHash(b.planHash),
    snapshotHash: checkpointHash(b.snapshotHash),
    verifiedAt: retentionDate(b.verifiedAt),
  };
}
export function parseBranchWorkspaceCommand(input: unknown) {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (action === 'inspect') {
    const b = exact(input, ['action', 'operationId']);
    return { action, operationId: nodeId(b.operationId) } as const;
  }
  if (action === 'prepare') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'proof']);
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      proof: parseBranchWorkspaceProof(b.proof),
    } as const;
  }
  if (action === 'bind') {
    const b = exact(input, ['action', 'operationId', 'requestHash', 'originHash', 'workspaceId']);
    return {
      action,
      operationId: nodeId(b.operationId),
      requestHash: checkpointHash(b.requestHash),
      originHash: checkpointHash(b.originHash),
      workspaceId: nodeId(b.workspaceId),
    } as const;
  }
  throw new DomainError('INVALID_INPUT', '不支持的方案现场命令');
}
export function parseBranchRunSelection(input: unknown) {
  const b = exact(input, ['branchId', 'expectedRevision', 'startHash']);
  return {
    branchId: nodeId(b.branchId),
    expectedRevision: revision(b.expectedRevision),
    startHash: checkpointHash(b.startHash),
  };
}
/** Fixed shared input, intentionally excludes later discussion and sender sessions. */
export function branchContext(
  title: string,
  description: string,
  commit: string,
  name: string,
  goal: string,
) {
  return text(
    `# 共同任务\n${title}\n\n${description}\n\n# 共同代码提交\n${commit}\n\n# 当前方案：${name}\n${goal}`,
    '方案固定上下文',
    18000,
  );
}
