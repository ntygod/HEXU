import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseTaskAssignment,
  type TaskAssignmentOptions,
  type TaskAssignmentHistory,
  type TaskAssignmentEvent,
} from '../../contracts/src/task-assignment.js';
import { assertRevision } from '../../domain/src/index.js';
import { demoMembers } from './seed.js';
import type { ContinuationOperation } from '../../contracts/src/continuation.js';
import type { NodeContinuationOperation } from '../../contracts/src/node-continuation.js';
import type { Store } from './store.js';

/** Human responsibility only. Never changes access, process ownership, credentials or code. */
export class TaskAssignmentStore {
  constructor(private readonly store: Store) {}

  private check(id: string, write = false) {
    const task = this.store.getTask(id, write);
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError(
        'ASSIGNMENT_UNAVAILABLE',
        '仅项目可见任务支持改派；私有任务不会因此公开',
        422,
      );
    this.store.project(task.projectId);
    return task;
  }
  options(id: string): TaskAssignmentOptions {
    const task = this.check(id);
    const members = this.store.teamMode
      ? (this.store.db
          .prepare(
            `SELECT p.id,p.name,pm.role FROM collab_project_members pm
          JOIN collab_memberships sm ON sm.user_id=pm.user_id AND sm.space_id=?
          JOIN collab_people p ON p.id=pm.user_id WHERE pm.project_id=? ORDER BY p.name,p.id`,
          )
          .all(task.spaceId, task.projectId) as { id: string; name: string; role: string }[])
      : demoMembers.map((person) => ({ ...person, role: 'edit' }));
    const member = members.find((person) => person.id === task.ownerUserId);
    // Only a previously recorded name may outlive membership. Never look up an arbitrary outsider.
    const historical = !member
      ? (this.store.db
          .prepare(
            'SELECT to_name AS name FROM task_assignment_events WHERE task_id=? AND to_user_id=? ORDER BY revision DESC LIMIT 1',
          )
          .get(id, task.ownerUserId) as { name: string } | undefined)
      : undefined;
    return {
      taskId: id,
      revision: task.revision,
      owner: {
        id: task.ownerUserId,
        name: member?.name ?? historical?.name ?? null,
        availability: !member ? 'removed' : member.role === 'view' ? 'read_only' : 'available',
      },
      candidates: members
        .filter((person) => ['edit', 'manage'].includes(person.role))
        .map(({ id, name }) => ({ id, name })),
    };
  }
  assign(id: string, input: unknown, key: string): Task {
    this.check(id, true); // Revalidate access even for an old idempotent receipt.
    const data = parseTaskAssignment(input);
    return this.store.mutate(`task.assignment:${id}`, key, data, () => {
      const task = this.check(id, true);
      assertRevision(task.revision, data.expectedRevision);
      const options = this.options(id);
      const target = options.candidates.find((person) => person.id === data.ownerUserId);
      if (!target)
        throw new DomainError(
          'ASSIGNEE_UNAVAILABLE',
          '该成员当前不能负责此项目任务，请重新选择有编辑权限的项目成员',
          409,
        );
      if (task.ownerUserId === target.id) return task;
      const at = new Date().toISOString();
      const next: Task = {
        ...task,
        ownerUserId: target.id,
        revision: task.revision + 1,
        updatedAt: at,
      };
      this.store.db
        .prepare('UPDATE tasks SET body=? WHERE id=? AND space_id=?')
        .run(JSON.stringify(next), id, task.spaceId);
      this.store.db
        .prepare(
          `INSERT INTO task_assignment_events
        (task_id,revision,from_user_id,from_name,to_user_id,to_name,actor_id,actor_name,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          next.revision,
          task.ownerUserId,
          options.owner.name,
          target.id,
          target.name,
          this.store.actorId,
          this.store.actorName(),
          at,
        );
      const notify = (kind: string) =>
        this.store.db
          .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
          .run(id, kind, at, task.spaceId);
      // Persist the pause now, including fast A -> B -> A changes before a coordinator tick.
      // Frozen input and existing stop requests remain intact; no source Run is stopped here.
      for (const table of ['continuation_operations', 'node_continuation_operations']) {
        const rows = this.store.db
          .prepare(
            `SELECT id,body FROM ${table} WHERE task_id=? AND state IN ('waiting_for_stop','preparing')`,
          )
          .all(id) as { id: string; body: string }[];
        for (const row of rows) {
          const op = JSON.parse(row.body) as ContinuationOperation | NodeContinuationOperation;
          const paused = {
            ...op,
            state: 'needs_attention',
            revision: op.revision + 1,
            updatedAt: at,
            blockers: [
              {
                code: 'TASK_ASSIGNMENT_CHANGED',
                message: '任务负责人已改变，请核对原材料后重新安排接续；已有执行未因改派停止。',
              },
            ],
          };
          this.store.db
            .prepare(`UPDATE ${table} SET state=?,body=? WHERE id=?`)
            .run(paused.state, JSON.stringify(paused), row.id);
          notify('continuation.updated');
        }
      }
      notify('task.assignment_changed');
      return next;
    });
  }
  history(id: string, query: { limit: number; before: number | null }): TaskAssignmentHistory {
    this.check(id);
    const rows = this.store.db
      .prepare(
        `SELECT task_id AS taskId,revision,from_user_id AS fromUserId,
      from_name AS fromName,to_user_id AS toUserId,to_name AS toName,actor_id AS actorId,
      actor_name AS actorName,created_at AS createdAt FROM task_assignment_events
      WHERE task_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, query.before, query.before, query.limit + 1) as unknown as TaskAssignmentEvent[];
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.revision : null };
  }
}
