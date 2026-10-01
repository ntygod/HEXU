import { DomainError } from '../../contracts/src/index.js';
import type { DraftTarget } from '../../contracts/src/ai-drafts.js';
import { assertRevision } from '../../domain/src/index.js';
import type { ContinuationOperation } from '../../contracts/src/continuation.js';
import type { NodeContinuationOperation } from '../../contracts/src/node-continuation.js';
import type { Store } from './store.js';

export function taskDescriptionTarget(store: Store, taskId: string, write = false): DraftTarget {
  const task = store.getTask(taskId, write);
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    content: task.description,
    revision: task.revision,
    limit: 12000,
  };
}
/** The caller owns the transaction containing provenance, outbox and its idempotent receipt.
 * Both draft and assistance adoption use this exact task/continuation boundary. */
export function applyTaskDescriptionAdoption(
  store: Store,
  taskId: string,
  expectedRevision: number,
  content: string,
  at: string,
): number {
  const task = store.getTask(taskId, true);
  assertRevision(task.revision, expectedRevision);
  if (content.length > 12000)
    throw new DomainError('DRAFT_TARGET_LIMIT', '任务说明不能超过 12000 字符', 422);
  if (task.description === content) return task.revision;
  const next = { ...task, description: content, revision: task.revision + 1, updatedAt: at };
  store.db
    .prepare('UPDATE tasks SET body=? WHERE id=? AND space_id=?')
    .run(JSON.stringify(next), taskId, task.spaceId);
  store.taskContentHistory.changed(task, next, 'adopted');
  const event = (kind: string) =>
    store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(taskId, kind, at, task.spaceId);
  for (const table of ['continuation_operations', 'node_continuation_operations']) {
    const rows = store.db
      .prepare(
        `SELECT id,body FROM ${table} WHERE task_id=? AND state IN ('waiting_for_stop','preparing')`,
      )
      .all(taskId) as { id: string; body: string }[];
    for (const row of rows) {
      const op = JSON.parse(row.body) as ContinuationOperation | NodeContinuationOperation;
      const paused = {
        ...op,
        state: 'needs_attention',
        revision: op.revision + 1,
        updatedAt: at,
        blockers: [
          {
            code: 'TASK_DESCRIPTION_CHANGED',
            message: '任务说明采用了新内容，请核对原材料后重新安排；已有执行未因此停止。',
          },
        ],
      };
      store.db
        .prepare(`UPDATE ${table} SET state=?,body=? WHERE id=?`)
        .run(paused.state, JSON.stringify(paused), row.id);
      event('continuation.updated');
    }
  }
  event('task.updated');
  return next.revision;
}
