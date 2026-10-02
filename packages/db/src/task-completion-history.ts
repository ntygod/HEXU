import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseTaskCompletionHistoryQuery,
  type TaskCompletionEvent,
  type TaskCompletionHistory,
} from '../../contracts/src/task-completion-history.js';
import { demoMembers } from './seed.js';
import type { Store } from './store.js';

/** Read the original completion_events only. No writes, inferred history or execution. */
export class TaskCompletionHistoryStore {
  constructor(private readonly store: Store) {}

  private actorName(task: Task, actorId: string): string | null {
    // Private Tasks only expose their current owner's name, never unrelated people.
    if (task.visibility === 'private' && actorId !== task.ownerUserId) return null;
    if (!this.store.teamMode)
      return demoMembers.find((member) => member.id === actorId)?.name ?? null;
    const person = this.store.db
      .prepare(
        `SELECT p.name FROM collab_people p
         JOIN collab_memberships sm ON sm.user_id=p.id AND sm.space_id=?
         WHERE p.id=? AND (? IS NULL OR EXISTS (
           SELECT 1 FROM collab_project_members pm WHERE pm.project_id=? AND pm.user_id=p.id
         ))`,
      )
      .get(task.spaceId, actorId, task.projectId, task.projectId) as { name: string } | undefined;
    return person?.name ?? null;
  }

  history(id: string, input: unknown = {}): TaskCompletionHistory {
    // A rejected parent must not reveal cursor existence, even for malformed queries.
    const task = this.store.getTask(id);
    const query = parseTaskCompletionHistoryQuery(input);
    const cursor = query.before
      ? (this.store.db
          .prepare(
            'SELECT task_revision AS revision,id FROM completion_events WHERE task_id=? AND id=?',
          )
          .get(id, query.before) as { revision: number; id: string } | undefined)
      : undefined;
    if (query.before && !cursor)
      throw new DomainError('INVALID_CURSOR', '完成记录位置已无效，请重新读取', 409);
    const rows = this.store.db
      .prepare(
        `SELECT id,task_id AS taskId,actor_id AS actorId,action,
         task_revision AS taskRevision,created_at AS createdAt
         FROM completion_events WHERE task_id=?
         ${cursor ? 'AND (task_revision,id)<(?,?)' : ''}
         ORDER BY task_revision DESC,id DESC LIMIT ?`,
      )
      .all(id, ...(cursor ? [cursor.revision, cursor.id] : []), query.limit + 1) as unknown as Omit<
      TaskCompletionEvent,
      'actorName'
    >[];
    const names = new Map<string, string | null>();
    const items = rows.slice(0, query.limit).map((row) => {
      if (!names.has(row.actorId)) names.set(row.actorId, this.actorName(task, row.actorId));
      return { ...row, actorName: names.get(row.actorId)! };
    });
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
}
