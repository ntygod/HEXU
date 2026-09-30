import {
  DomainError,
  revision,
  text,
  type Message,
  type Result,
  type Task,
  type Tool,
} from './index.js';
import { exact, nodeId } from './nodes.js';
import type { WorkBranchStart } from './work-branches.js';

export const RESULT_OUTPUT_LIMIT = 6000;
export interface BranchResultSource {
  kind: 'work_branch';
  branchId: string;
  groupId: string;
  branchName: string;
  goal: string;
  startHash: string;
  start: WorkBranchStart;
  run: {
    id: string;
    revision: number;
    state: 'succeeded' | 'failed' | 'cancelled';
    tool: Tool;
    model: string | null;
    mode: 'read-only' | 'edit';
    nodeId: string;
    workingCopyId: string;
    dispatchId: string;
    startedAt: string | null;
    finishedAt: string;
    context: string;
    continueFrom?: import('./work-branch-workspaces.js').BranchContinuationBinding;
  };
  output: {
    text: string;
    truncated: boolean;
    totalChars: number;
    throughSequence: number | null;
    availability: 'captured' | 'legacy_unavailable';
  };
  // A fixed input commit is never evidence of the code produced by this Run.
  code: 'not_captured' | import('./result-code.js').ResultCodeReference;
}
export interface ResultRevision {
  id: string;
  resultId: string;
  taskId: string;
  revision: number;
  title: string;
  body: string;
  kind: Result['kind'];
  limitations: string;
  source: BranchResultSource | { kind: 'member' | 'legacy' };
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export type ResultRevisionSummary = Pick<
  ResultRevision,
  'id' | 'revision' | 'title' | 'createdAt' | 'createdBy'
> & { codeKind?: 'commit_reference' };
export interface ResultDetail {
  result: Result;
  task: Task;
  version: ResultRevision;
  revisions: ResultRevisionSummary[];
  messages: Message[];
  unversionedMessages: Message[];
  code?: import('./result-code.js').ResultCodeEvidence;
}
export interface BranchResultPreview {
  branchRevision: number;
  resultRevision: number;
  source: BranchResultSource;
  previous: Pick<ResultRevision, 'title' | 'body' | 'limitations'> | null;
  codeOptions: import('./result-code.js').ResultCodeOption[];
}
export function parseBranchResult(input: unknown) {
  const b = exact(input, [
    'expectedRevision',
    'expectedResultRevision',
    'sourceRunId',
    'expectedRunRevision',
    'title',
    'body',
    'limitations',
    'codeCheckpointId',
    'codeRetentionId',
  ]);
  if (!Number.isSafeInteger(b.expectedResultRevision) || (b.expectedResultRevision as number) < 0)
    throw new DomainError('INVALID_INPUT', '成果版本应为非负整数');
  if (b.codeRetentionId !== undefined && b.codeCheckpointId === undefined)
    throw new DomainError('INVALID_INPUT', '对象保留必须属于明确选择的代码引用');
  const result = {
    expectedRevision: revision(b.expectedRevision),
    expectedResultRevision: b.expectedResultRevision as number,
    sourceRunId: nodeId(b.sourceRunId),
    expectedRunRevision: revision(b.expectedRunRevision),
    title: text(b.title, '成果标题', 160),
    body: text(b.body, '成果说明', 6000),
    limitations: text(b.limitations, '已知限制', 2000, true),
    ...(b.codeCheckpointId === undefined ? {} : { codeCheckpointId: nodeId(b.codeCheckpointId) }),
    ...(b.codeRetentionId === undefined ? {} : { codeRetentionId: nodeId(b.codeRetentionId) }),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 24 * 1024)
    throw new DomainError('INVALID_INPUT', '成果内容超过24 KiB，请缩短说明');
  return result;
}
