import { DomainError, enumValue, type Run, type TaskStatus } from './index.js';
import { parseNodeRun, type NodeRunInput, type ExecutionPolicy } from './node-execution.js';
import type { ContinuationState } from './continuation.js';
import { exact } from './nodes.js';

export interface NodeContinuationInput {
  run: NodeRunInput;
  onActiveRun: 'wait' | 'request_stop';
}
/** A user-authorized, bounded plan. Success means Run creation, not model success. */
export interface NodeContinuationOperation {
  id: string;
  provider: 'node';
  kind: 'continue';
  taskId: string;
  spaceId: string;
  ownerId: string;
  ownerName: string;
  sourceRunId: string;
  nodeId: string;
  workingCopyId: string;
  state: ContinuationState;
  input: NodeContinuationInput;
  policy: ExecutionPolicy;
  contextText: string;
  humanContextHash: string;
  taskRevision: number;
  taskStatus: TaskStatus;
  sourceHadStarted: boolean;
  runId: string | null;
  blockers: { code: string; message: string }[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export function parseNodeContinuationOperation(value: unknown): NodeContinuationInput {
  const b = exact(value, [
    'provider',
    'nodeId',
    'workingCopyId',
    'policyHash',
    'mode',
    'prompt',
    'expectedRevision',
    'reopenTask',
    'confirmExecution',
    'continuation',
    'onActiveRun',
  ]);
  const { onActiveRun, ...runBody } = b;
  const run = parseNodeRun(runBody);
  if (!run.continuation)
    throw new DomainError('INVALID_CONTINUATION', '接续安排需要明确来源与所选材料');
  return {
    run,
    onActiveRun: enumValue(onActiveRun, ['wait', 'request_stop'] as const, '原执行处理方式'),
  };
}
/** Only supplied by the control-side coordinator, never parsed from a browser body. */
export interface NodeContinuationCommit {
  operationId: string;
  context(): string;
  attach(run: Run): void;
}
