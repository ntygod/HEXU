import { DomainError } from '../../contracts/src/index.js';
import type { TaskContentRevision } from '../../contracts/src/task-content-history.js';
import { compareTextLines } from './line-difference.js';

/** A display-only comparison of two already-readable immutable Task snapshots. */
export function compareTaskContent(
  taskId: string,
  before: TaskContentRevision,
  after: TaskContentRevision,
) {
  if (!taskId || before.taskId !== taskId || after.taskId !== taskId)
    throw new DomainError('INVALID_INPUT', '只能对照同一任务的工作说明版本');
  if (
    !Number.isSafeInteger(before.revision) ||
    before.revision < 1 ||
    !Number.isSafeInteger(after.revision) ||
    after.revision <= before.revision
  )
    throw new DomainError('INVALID_INPUT', '请选择两个不同版本，并将较早版本放在前面');
  // Later list refreshes or caller mutations must not change either displayed side.
  const left = structuredClone(before),
    right = structuredClone(after);
  return {
    taskId,
    before: left,
    after: right,
    titleChanged: left.title !== right.title,
    attentionChanged: (left.attention ?? '') !== (right.attention ?? ''),
    description: compareTextLines(left.description, right.description),
  };
}
export type TaskContentComparison = ReturnType<typeof compareTaskContent>;
