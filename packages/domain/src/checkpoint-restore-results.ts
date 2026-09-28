import { DomainError } from '../../contracts/src/index.js';
import type { RestoreResultReport } from '../../contracts/src/checkpoint-restore-results.js';

/** Observations advance; delayed acknowledgements never roll the latest projection back.
 * Once execution has stopped, only cleanup/interruption evidence may follow. */
export function assertRestoreResultTransition(old: RestoreResultReport, next: RestoreResultReport) {
  const conflict = () => {
    throw new DomainError(
      'RESTORE_REPORT_CONFLICT',
      '恢复观察不能换来源、回退或把未知结果改成成功',
      409,
    );
  };
  if (
    old.planHash !== next.planHash ||
    old.snapshotHash !== next.snapshotHash ||
    old.totalFiles !== next.totalFiles ||
    old.totalBytes !== next.totalBytes ||
    next.recordedAt < old.recordedAt ||
    next.completedFiles < old.completedFiles ||
    next.writtenBytes < old.writtenBytes ||
    (old.verifiedAt && old.verifiedAt !== next.verifiedAt)
  )
    conflict();
  if (old.state === 'restored' || old.cleanup === 'cleaned') conflict();
  const phases = ['preparing', 'writing', 'verified', 'publishing'];
  const terminal = ['cancelled', 'failed', 'interrupted'];
  if (terminal.includes(old.state)) {
    if (
      !terminal.includes(next.state) ||
      (next.state !== old.state && next.state !== 'interrupted') ||
      next.completedFiles !== old.completedFiles ||
      next.writtenBytes !== old.writtenBytes ||
      next.verifiedAt !== old.verifiedAt
    )
      conflict();
  } else if (phases.includes(next.state) && phases.indexOf(next.state) < phases.indexOf(old.state))
    conflict();
  if (
    old.materialState === 'unknown' &&
    next.materialState !== 'unknown' &&
    next.cleanup !== 'cleaned'
  )
    conflict();
  if (
    ['cleaning', 'needs_attention'].includes(old.cleanup) &&
    !['cleaning', 'needs_attention', 'cleaned'].includes(next.cleanup)
  )
    conflict();
}
