import { DomainError, revision } from './index.js';
import { exact } from './nodes.js';
import type { WorkBranch } from './work-branches.js';
export interface WorkBranchDiscardPreserving {
  expectedRevision: number;
  expectedTaskRevision: number;
  confirmPreserveWorkspace: true;
  confirmExecutionContinues: true;
}
export interface WorkBranchDiscardPreview {
  branch: WorkBranch;
  taskRevision: number;
  canDiscard: boolean;
  unavailableReason: string | null;
}
/** This acknowledges a metadata transition, never stop/delete/unbind authority. */
export function parseWorkBranchDiscardPreserving(input: unknown): WorkBranchDiscardPreserving {
  const b = exact(input, [
    'expectedRevision',
    'expectedTaskRevision',
    'confirmPreserveWorkspace',
    'confirmExecutionContinues',
  ]);
  if (b.confirmPreserveWorkspace !== true || b.confirmExecutionContinues !== true)
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      '需明确确认只放弃方案并保留现场，原执行不会因此停止',
    );
  return {
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmPreserveWorkspace: true,
    confirmExecutionContinues: true,
  };
}
