import { revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import type { WorkBranch } from './work-branches.js';
import type { CommitCheckpoint } from './checkpoints.js';
import type { RetentionView } from './checkpoint-retention.js';

export interface BranchCleanupMaterial {
  checkpoint: CommitCheckpoint;
  retention: RetentionView;
}
export interface BranchCleanupOptions {
  branch: WorkBranch;
  taskRevision: number;
  nodeId: string;
  originHash: string;
  canInspect: boolean;
  unavailableReason: string | null;
  materials: BranchCleanupMaterial[];
  deletionAuthorized: false;
}
export interface BranchCleanupSelection {
  branchId: string;
  expectedRevision: number;
  expectedTaskRevision: number;
  retentionId: string;
}
export interface BranchCleanupInspection {
  branch: Pick<
    WorkBranch,
    'id' | 'taskId' | 'groupId' | 'name' | 'revision' | 'state' | 'workingCopyId'
  >;
  taskRevision: number;
  nodeId: string;
  originHash: string;
  material: BranchCleanupMaterial;
  deletionAuthorized: false;
}
export function parseBranchCleanupSelection(input: unknown): BranchCleanupSelection {
  const b = exact(input, ['branchId', 'expectedRevision', 'expectedTaskRevision', 'retentionId']);
  return {
    branchId: nodeId(b.branchId),
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    retentionId: nodeId(b.retentionId),
  };
}
