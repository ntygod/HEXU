import { DomainError, text } from './index.js';
import { exact, nodeId } from './nodes.js';
import type { WorkBranchView } from './work-branches.js';
import type { ResultRevisionSummary } from './results.js';

export interface BranchChoice {
  groupId: string;
  revision: number;
  branchId: string | null;
  branchName: string | null;
  resultId: string | null;
  resultRevisionId: string | null;
  resultRevision: number | null;
  title: string | null;
  note: string;
  actor: { id: string; name: string };
  createdAt: string;
}
export interface BranchComparison {
  work: WorkBranchView;
  versions: Record<string, ResultRevisionSummary[]>;
  choices: BranchChoice[];
}
export function parseBranchChoice(input: unknown) {
  const b = exact(input, ['expectedSelectionRevision', 'branchId', 'resultRevisionId', 'note']);
  if (
    !Number.isSafeInteger(b.expectedSelectionRevision) ||
    (b.expectedSelectionRevision as number) < 0
  )
    throw new DomainError('INVALID_INPUT', '选择记录修订应为非负整数');
  if ((b.branchId === null) !== (b.resultRevisionId === null))
    throw new DomainError('INVALID_INPUT', '选择必须同时指定方案与固定成果版本');
  return {
    expectedSelectionRevision: b.expectedSelectionRevision as number,
    branchId: b.branchId === null ? null : nodeId(b.branchId),
    resultRevisionId: b.resultRevisionId === null ? null : nodeId(b.resultRevisionId),
    note: text(b.note, '选择说明', 2000, true),
  };
}
