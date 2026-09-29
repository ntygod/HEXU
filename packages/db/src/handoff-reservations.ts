import { DomainError } from '../../contracts/src/index.js';
import type { HandoffAcceptance } from '../../contracts/src/handoff-acceptance.js';
import type { Store } from './store.js';

export function assertNoPendingHandoff(store: Store, taskId: string) {
  if (
    store.db
      .prepare("SELECT 1 FROM handoff_acceptances WHERE task_id=? AND state='waiting_local'")
      .get(taskId)
  )
    throw new DomainError(
      'HANDOFF_PENDING',
      '任务已有接手确认，请先完成或取消；不会同时开始新的执行',
      409,
    );
}
/** Within the invitation transaction; never releases local writer claims. */
export function cancelHandoffAcceptances(store: Store, handoffId: string, at: string) {
  const rows = store.db
    .prepare("SELECT body FROM handoff_acceptances WHERE handoff_id=? AND state='waiting_local'")
    .all(handoffId) as { body: string }[];
  for (const row of rows) {
    const old = JSON.parse(row.body) as HandoffAcceptance;
    const op = {
      ...old,
      state: 'cancelled' as const,
      revision: old.revision + 1,
      updatedAt: at,
      reason: '原邀请已经关闭，未接受接手',
    };
    store.db
      .prepare('UPDATE handoff_acceptances SET state=?,body=? WHERE id=?')
      .run(op.state, JSON.stringify(op), op.ticket.id);
    store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(op.ticket.taskId, 'handoff.acceptance_updated', at, op.ticket.spaceId);
  }
}
