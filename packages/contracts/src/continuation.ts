import { DomainError, enumValue, record } from './index.js';
import { parseNativeRunCreate, type NativeRunInput } from './native.js';

export type ContinuationState =
  | 'waiting_for_stop'
  | 'preparing'
  | 'needs_attention'
  | 'succeeded'
  | 'cancelled'
  | 'failed';
export interface ContinuationInput {
  run: NativeRunInput;
  onActiveRun: 'wait' | 'request_stop';
}
export interface ContinuationOperation {
  id: string;
  kind: 'continue';
  taskId: string;
  sourceRunId: string;
  workingCopyId: string;
  state: ContinuationState;
  input: ContinuationInput;
  humanContextHash: string;
  runId: string | null;
  blockers: { code: string; message: string }[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export function parseContinuation(value: unknown): ContinuationInput {
  const body = record(value);
  const run = parseNativeRunCreate(body);
  if (!run.sourceRunId)
    throw new DomainError('INVALID_CONTINUATION', '继续需要明确来源执行');
  return {
    run,
    onActiveRun: enumValue(body.onActiveRun, ['wait', 'request_stop'] as const, '原执行处理方式'),
  };
}
export function isPendingContinuation(state: ContinuationState): boolean {
  return state === 'waiting_for_stop' || state === 'preparing';
}
// succeeded means a new Run was committed, never that the model or task succeeded.
export const continuationLabels: Record<ContinuationState, string> = {
  waiting_for_stop: '等待原执行结束',
  preparing: '正在准备接续',
  needs_attention: '需要处理',
  succeeded: '已创建新执行',
  cancelled: '接续已取消',
  failed: '接续未能开始',
};
