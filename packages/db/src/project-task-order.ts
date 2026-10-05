import { createHash } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseProjectTaskMove,
  type ProjectTaskMoveReceipt,
  type ProjectTaskOrder,
} from '../../contracts/src/project-task-order.js';
import type { Store } from './store.js';

const GAP = 1024;
type RankRow = { task_id: string; rank: number };

/** Project planning metadata only. Does not decorate or modify a Task or Store.tasks(). */
export class ProjectTaskOrderStore {
  constructor(private readonly store: Store) {}

  private revision(projectId: string): number {
    return (
      (
        this.store.db
          .prepare('SELECT revision FROM project_task_order_sets WHERE project_id=?')
          .get(projectId) as { revision: number } | undefined
      )?.revision ?? 1
    );
  }

  private ranks(projectId: string): Map<string, number> {
    const rows = this.store.db
      .prepare('SELECT task_id,rank FROM project_task_ranks WHERE project_id=?')
      .all(projectId) as RankRow[];
    return new Map(rows.map((row) => [row.task_id, row.rank]));
  }

  private ordered<T extends { id: string }>(items: T[], ranks: Map<string, number>): T[] {
    // Stable sort retains Store.tasks()'s rowid DESC order for all unranked tasks.
    return [...items].sort((a, b) => {
      const left = ranks.get(a.id),
        right = ranks.get(b.id);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      return left - right;
    });
  }

  private projection(projectId: string, tasks: Task[]): ProjectTaskOrder {
    const ordered = this.ordered(tasks, this.ranks(projectId));
    return {
      projectId,
      revision: this.revision(projectId),
      baseline: createHash('sha256')
        .update(JSON.stringify([projectId, ordered.map((task) => [task.id, task.status])]))
        .digest('hex'),
      taskIds: ordered.map((task) => task.id),
    };
  }

  view(projectId: string): ProjectTaskOrder {
    // One read snapshot for access, membership, ranks and revision, including when another
    // connection commits a move between these SELECTs. A savepoint also works inside a caller's
    // transaction and neither materializes ranks nor acquires an immediate writer lock.
    this.store.db.exec('SAVEPOINT project_task_order_read');
    try {
      this.store.project(projectId);
      // Only the existing authorized collection may supply IDs, including in empty projects.
      const result = this.projection(
        projectId,
        this.store.tasks().filter((task) => task.projectId === projectId),
      );
      this.store.db.exec('RELEASE project_task_order_read');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO project_task_order_read; RELEASE project_task_order_read');
      throw error;
    }
  }

  move(projectId: string, input: unknown, key: string): ProjectTaskMoveReceipt {
    const data = parseProjectTaskMove(input);
    const check = () => {
      this.store.project(projectId);
      if (this.store.teamMode) this.store.permissions.project(projectId, 'edit');
      const task = this.store.getTask(data.taskId, true);
      if (task.projectId !== projectId)
        throw new DomainError('NOT_FOUND', '任务当前不在此项目或不可访问', 404);
    };
    check();
    return this.store.mutate(
      `project.task-order:${projectId}`,
      key,
      input, // Validate above, but fingerprint the original decoded body rather than trimmed IDs.
      () => {
        const task = this.store.getTask(data.taskId, true);
        const anchor = this.store.getTask(data.anchorTaskId);
        if (anchor.projectId !== projectId)
          throw new DomainError('NOT_FOUND', '参照任务当前不在此项目或不可访问', 404);
        if (task.status === 'cancelled')
          throw new DomainError('TASK_ORDER_UNAVAILABLE', '已取消任务不能调整排序', 422);
        const visible = this.store.tasks().filter((item) => item.projectId === projectId);
        const before = this.projection(projectId, visible);
        if (before.revision !== data.expectedRevision || before.baseline !== data.expectedBaseline)
          throw new DomainError(
            'PROJECT_TASK_ORDER_CONFLICT',
            '项目任务顺序或状态已变化，请刷新后重新选择位置',
            409,
          );

        // Read only IDs/ranks for placement. Non-readable Task bodies are never loaded here or
        // returned. Keeping their ranks in the sequence preserves every other task's relative
        // order even when some tasks are hidden by the caller's permissions or UI filters.
        const ranks = this.ranks(projectId);
        const rows = this.store.db
          .prepare('SELECT id FROM tasks WHERE space_id=? AND project_id=? ORDER BY rowid DESC')
          .all(this.store.spaceId, projectId) as { id: string }[];
        const ordered = this.ordered(rows, ranks).map((item) => item.id);
        const next = ordered.filter((id) => id !== data.taskId);
        const anchorIndex = next.indexOf(data.anchorTaskId);
        if (!ordered.includes(data.taskId) || anchorIndex < 0)
          throw new DomainError('NOT_FOUND', '任务或参照任务当前不在此项目', 404);
        const position = anchorIndex + (data.placement === 'after' ? 1 : 0);
        next.splice(position, 0, data.taskId);
        const changed = next.some((id, index) => id !== ordered[index]);
        if (changed) {
          this.saveMove(projectId, ordered, next, data.taskId, ranks);
          this.store.db
            .prepare(
              `INSERT INTO project_task_order_sets(project_id,revision) VALUES(?,?)
              ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision`,
            )
            .run(projectId, before.revision + 1);
          this.store.db
            .prepare(
              'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(NULL,?,?,?,?)',
            )
            .run(
              'project.task_order_changed',
              new Date().toISOString(),
              this.store.spaceId,
              projectId,
            );
        }
        const after = changed ? this.projection(projectId, visible) : before;
        return {
          projectId,
          taskId: data.taskId,
          anchorTaskId: data.anchorTaskId,
          placement: data.placement,
          revision: after.revision,
          baseline: after.baseline,
          changed,
        };
      },
      check, // Runs after BEGIN, before looking up even an original successful receipt.
    );
  }

  private saveMove(
    projectId: string,
    ordered: string[],
    next: string[],
    taskId: string,
    ranks: Map<string, number>,
  ) {
    const save = this.store.db
      .prepare(`INSERT INTO project_task_ranks(project_id,task_id,rank) VALUES(?,?,?)
      ON CONFLICT(project_id,task_id) DO UPDATE SET rank=excluded.rank`);
    const write = (id: string, rank: number) => {
      save.run(projectId, id, rank);
      ranks.set(id, rank);
    };
    const rebalance = () => {
      // Deliberate gap exhaustion recovery in this same revision-checked transaction.
      // Renumber the complete sequence, preserving all relative positions.
      ordered.forEach((id, index) => write(id, (index + 1) * GAP));
    };
    let tail = [...ranks.values()].reduce((maximum, rank) => Math.max(maximum, rank), 0);
    for (const id of ordered) {
      if (ranks.has(id)) continue;
      tail += GAP;
      if (!Number.isSafeInteger(tail)) {
        rebalance();
        break;
      }
      write(id, tail);
    }
    const index = next.indexOf(taskId);
    const between = () => {
      const left = index === 0 ? undefined : ranks.get(next[index - 1]!)!;
      const right = index === next.length - 1 ? undefined : ranks.get(next[index + 1]!)!;
      if (left === undefined) return right! - GAP;
      if (right === undefined) return left + GAP;
      return left + Math.floor((right - left) / 2);
    };
    let rank = between();
    const hasGap = () =>
      Number.isSafeInteger(rank) &&
      (index === 0 || rank > ranks.get(next[index - 1]!)!) &&
      (index === next.length - 1 || rank < ranks.get(next[index + 1]!)!);
    if (!hasGap()) {
      rebalance();
      rank = between();
    }
    write(taskId, rank);
  }
}
