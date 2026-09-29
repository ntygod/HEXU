import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseWorkBranchCreate,
  parseWorkBranchDiscard,
  type WorkBranch,
  type WorkBranchGroup,
  type WorkBranchView,
  type WorkBranchPage,
  type WorkBranchOptions,
  type WorkBranchEvent,
} from '../../contracts/src/work-branches.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { CheckpointStore } from './checkpoints.js';
import type { Store } from './store.js';

type Row = { rowid: number; body: string };
export class WorkBranchStore {
  private readonly checkpoints: CheckpointStore;
  constructor(readonly store: Store) {
    this.checkpoints = new CheckpointStore(store);
  }
  private task(taskId: string, write = false) {
    const task = this.store.getTask(taskId, write);
    if (!this.store.teamMode || task.visibility !== 'project' || !task.projectId)
      throw new DomainError(
        'WORK_BRANCH_UNAVAILABLE',
        '当前方案定义使用真实账号的项目任务与提交引用',
        422,
      );
    return task;
  }
  private group(taskId: string, groupId: string): WorkBranchGroup {
    const row = this.store.db
      .prepare('SELECT body FROM work_branch_groups WHERE task_id=? AND id=?')
      .get(taskId, groupId) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案组不存在或不属于此任务', 404);
    return JSON.parse(row.body) as WorkBranchGroup;
  }
  private branch(taskId: string, id: string): WorkBranch {
    const row = this.store.db
      .prepare('SELECT body FROM work_branches WHERE task_id=? AND id=?')
      .get(taskId, id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案不存在或不属于此任务', 404);
    return JSON.parse(row.body) as WorkBranch;
  }
  private view(task: Task, group: WorkBranchGroup): WorkBranchView {
    return {
      group,
      branches: (
        this.store.db
          .prepare('SELECT body FROM work_branches WHERE group_id=? ORDER BY rowid')
          .all(group.id) as Row[]
      ).map((r) => JSON.parse(r.body) as WorkBranch),
      taskChanged: task.revision !== group.start.taskRevision,
    };
  }
  options(taskId: string): WorkBranchOptions {
    const task = this.task(taskId, true);
    const ids = this.store.db
      .prepare('SELECT id FROM commit_checkpoints WHERE task_id=? ORDER BY rowid DESC LIMIT 50')
      .all(taskId) as { id: string }[];
    return {
      taskRevision: task.revision,
      taskTitle: task.title,
      taskDescription: task.description,
      checkpoints: ids.map((r) => this.checkpoints.get(taskId, r.id)),
    };
  }
  private event(task: Task, b: WorkBranch, action: WorkBranchEvent['action']) {
    const event: WorkBranchEvent = {
      revision: b.revision,
      action,
      actor: { id: this.store.actorId, name: this.store.actorName() },
      at: b.updatedAt,
    };
    this.store.db
      .prepare('INSERT INTO work_branch_events(branch_id,revision,body) VALUES(?,?,?)')
      .run(b.id, b.revision, JSON.stringify(event));
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(task.id, `work_branch.${action}`, b.updatedAt, task.spaceId);
  }
  create(taskId: string, input: unknown, key: string): WorkBranchView {
    this.task(taskId, true); // Current authority applies before idempotent receipt replay.
    const data = parseWorkBranchCreate(input);
    const result = this.store.mutate(`work_branches.create:${taskId}`, key, data, () => {
      const task = this.task(taskId, true);
      assertRevision(task.revision, data.expectedTaskRevision);
      const checkpoint = this.checkpoints.get(taskId, data.checkpointId);
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM work_branch_groups WHERE task_id=?')
        .get(taskId)!.n;
      if (Number(count) >= 200)
        throw new DomainError('WORK_BRANCH_LIMIT', '此任务方案组已达记录上限', 409);
      const at = new Date().toISOString();
      const start = {
        taskRevision: task.revision,
        taskTitle: task.title,
        taskDescription: task.description,
        checkpoint,
      };
      const group: WorkBranchGroup = {
        id: randomUUID(),
        taskId,
        projectId: task.projectId!,
        spaceId: task.spaceId,
        start,
        startHash: createHash('sha256').update(canonicalJson(start)).digest('hex'),
        createdBy: { id: this.store.actorId, name: this.store.actorName() },
        createdAt: at,
      };
      this.store.db
        .prepare('INSERT INTO work_branch_groups(id,task_id,checkpoint_id,body) VALUES(?,?,?,?)')
        .run(group.id, taskId, checkpoint.id, JSON.stringify(group));
      for (const spec of data.branches) {
        const b: WorkBranch = {
          id: randomUUID(),
          groupId: group.id,
          taskId,
          ...spec,
          revision: 1,
          state: 'planned',
          workingCopyId: null,
          runId: null,
          resultId: null,
          createdAt: at,
          updatedAt: at,
        };
        this.store.db
          .prepare(
            'INSERT INTO work_branches(id,task_id,group_id,state,revision,body) VALUES(?,?,?,?,?,?)',
          )
          .run(b.id, taskId, group.id, b.state, b.revision, JSON.stringify(b));
        this.event(task, b, 'plan');
      }
      return { id: group.id };
    });
    return this.get(taskId, result.id);
  }
  list(taskId: string, cursor: number | null = null): WorkBranchPage {
    const task = this.task(taskId);
    const rows = this.store.db
      .prepare(
        'SELECT rowid,body FROM work_branch_groups WHERE task_id=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT 11',
      )
      .all(taskId, cursor, cursor) as Row[];
    return {
      items: rows.slice(0, 10).map((r) => this.view(task, JSON.parse(r.body) as WorkBranchGroup)),
      nextCursor: rows.length > 10 ? rows[9]!.rowid : null,
    };
  }
  get(taskId: string, groupId: string) {
    return this.view(this.task(taskId), this.group(taskId, groupId));
  }
  history(taskId: string, id: string) {
    this.task(taskId);
    this.branch(taskId, id);
    return {
      items: (
        this.store.db
          .prepare('SELECT body FROM work_branch_events WHERE branch_id=? ORDER BY revision')
          .all(id) as Row[]
      ).map((r) => JSON.parse(r.body) as WorkBranchEvent),
    };
  }
  discard(taskId: string, id: string, input: unknown, key: string): WorkBranchView {
    this.task(taskId, true);
    this.branch(taskId, id);
    const data = parseWorkBranchDiscard(input);
    const result = this.store.mutate(`work_branches.discard:${id}`, key, data, () => {
      const task = this.task(taskId, true),
        b = this.branch(taskId, id);
      assertRevision(b.revision, data.expectedRevision);
      if (b.state !== 'planned' || b.runId || b.workingCopyId || b.resultId)
        throw new DomainError(
          'WORK_BRANCH_NOT_PLANNED',
          '只有尚未准备或执行的方案可由此入口放弃',
          409,
        );
      const next: WorkBranch = {
        ...b,
        state: 'discarded',
        revision: b.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.db
        .prepare('UPDATE work_branches SET state=?,revision=?,body=? WHERE id=?')
        .run(next.state, next.revision, JSON.stringify(next), id);
      this.event(task, next, 'discard');
      return { id: b.groupId };
    });
    return this.get(taskId, result.id);
  }
}
