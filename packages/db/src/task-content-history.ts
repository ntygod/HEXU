import { DomainError, type Task } from '../../contracts/src/index.js';
import type {
  TaskContentField,
  TaskContentHistory,
  TaskContentRevision,
} from '../../contracts/src/task-content-history.js';
import type { Store } from './store.js';

/** Content snapshots only. The existing caller owns the Task/outbox/receipt transaction. */
export class TaskContentHistoryStore {
  constructor(private readonly store: Store) {}

  record(
    task: Task,
    source: TaskContentRevision['source'],
    changedFields: TaskContentField[] = [],
  ) {
    const legacy = source === 'legacy';
    const item: TaskContentRevision = {
      taskId: task.id,
      revision: task.revision,
      title: task.title,
      description: task.description,
      attention: task.attention,
      actorId: legacy ? null : this.store.actorId,
      actorName: legacy ? null : this.store.actorName(),
      savedAt: legacy ? null : task.updatedAt,
      source,
      changedFields,
    };
    this.store.db
      .prepare('INSERT INTO task_content_revisions(task_id,revision,body) VALUES(?,?,?)')
      .run(task.id, task.revision, JSON.stringify(item));
  }

  changed(before: Task, next: Task, source: 'edited' | 'adopted' | 'status') {
    const fields: TaskContentField[] = ['title', 'description', 'attention'];
    const changed = fields.filter((field) => before[field] !== next[field]);
    if (changed.length) this.record(next, source, changed);
  }

  history(id: string, query: { limit: number; before: number | null }): TaskContentHistory {
    this.store.getTask(id); // Current parent permission precedes cursor lookup and all old text.
    if (
      query.before !== null &&
      !this.store.db
        .prepare('SELECT 1 FROM task_content_revisions WHERE task_id=? AND revision=?')
        .get(id, query.before)
    )
      throw new DomainError('INVALID_CURSOR', '工作说明历史位置已无效，请重新读取', 409);
    const rows = this.store.db
      .prepare(
        `SELECT body FROM task_content_revisions WHERE task_id=? AND (? IS NULL OR revision<?)
       ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, query.before, query.before, query.limit + 1) as { body: string }[];
    const items = rows
      .slice(0, query.limit)
      .map((row) => JSON.parse(row.body) as TaskContentRevision);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.revision : null };
  }
}
