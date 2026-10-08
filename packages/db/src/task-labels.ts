import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseTaskLabelsChange,
  type TaskLabelsReceipt,
  type TaskLabelsView,
} from '../../contracts/src/task-labels.js';
import { assertRevision } from '../../domain/src/index.js';
import type { Store } from './store.js';

/** Task-owned collaboration metadata; never stored in Task JSON or execution material. */
export class TaskLabelsStore {
  constructor(private readonly store: Store) {}
  private check(id: string, write = false) {
    const task = this.store.getTask(id, write);
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError(
        'LABELS_UNAVAILABLE',
        '本轮标签仅用于项目可见任务，私有任务不会因此共享',
        422,
      );
    this.store.project(task.projectId);
    return task;
  }
  private read(id: string): TaskLabelsReceipt {
    const row = this.store.db
      .prepare('SELECT revision FROM task_label_sets WHERE task_id=?')
      .get(id) as { revision: number } | undefined;
    const labels = (
      this.store.db
        .prepare('SELECT name FROM task_labels WHERE task_id=? ORDER BY name')
        .all(id) as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    return { taskId: id, revision: row?.revision ?? 1, labels };
  }
  view(id: string): TaskLabelsView {
    const task = this.check(id);
    return {
      ...this.read(id),
      canEdit: !this.store.teamMode || this.store.permissions.canTask(task, true),
    };
  }
  /** Call only after parent access filtering, in human-facing read DTOs. */
  decorate(task: Task): Task {
    if (task.visibility !== 'project' || !task.projectId)
      return { ...task, labelNames: [], labelsRevision: 1 };
    const set = this.read(task.id);
    return { ...task, labelNames: set.labels, labelsRevision: set.revision };
  }
  change(id: string, input: unknown, key: string): TaskLabelsReceipt {
    const data = parseTaskLabelsChange(input);
    this.check(id, true);
    return this.store.mutate(
      `task.labels:${id}`,
      key,
      data,
      () => {
        const task = this.check(id, true);
        const previous = this.read(id);
        assertRevision(previous.revision, data.expectedRevision);
        if (JSON.stringify(previous.labels) === JSON.stringify(data.labels)) return previous;
        const next: TaskLabelsReceipt = {
          taskId: id,
          revision: previous.revision + 1,
          labels: data.labels,
        };
        const at = new Date().toISOString();
        this.store.db
          .prepare(
            'INSERT INTO task_label_sets VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision',
          )
          .run(id, next.revision);
        this.store.db.prepare('DELETE FROM task_labels WHERE task_id=?').run(id);
        for (const label of next.labels)
          this.store.db.prepare('INSERT INTO task_labels VALUES(?,?)').run(id, label);
        this.store.db.prepare('INSERT INTO task_label_events VALUES(?,?,?)').run(
          id,
          next.revision,
          JSON.stringify({
            ...next,
            previousLabels: previous.labels,
            actorId: this.store.actorId,
            actorName: this.store.actorName(),
            savedAt: at,
          }),
        );
        this.store.db
          .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
          .run(id, 'task.labels_changed', at, task.spaceId);
        return next;
      },
      () => {
        this.check(id, true);
      },
    );
  }
}
