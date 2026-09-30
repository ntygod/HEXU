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
import type { BranchWorkspaceOperation } from '../../contracts/src/work-branch-workspaces.js';
import { ResultRevisions } from './result-revisions.js';
import type { BranchChoice } from '../../contracts/src/branch-comparison.js';

import {
  parseWorkBranchDiscardPreserving,
  type WorkBranchDiscardPreview,
} from '../../contracts/src/work-branch-lifecycle.js';

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
  group(taskId: string, groupId: string): WorkBranchGroup {
    this.task(taskId);
    const row = this.store.db
      .prepare('SELECT body FROM work_branch_groups WHERE task_id=? AND id=?')
      .get(taskId, groupId) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案组不存在或不属于此任务', 404);
    return JSON.parse(row.body) as WorkBranchGroup;
  }
  branch(taskId: string, id: string): WorkBranch {
    this.task(taskId);
    const row = this.store.db
      .prepare('SELECT body FROM work_branches WHERE task_id=? AND id=?')
      .get(taskId, id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案不存在或不属于此任务', 404);
    return JSON.parse(row.body) as WorkBranch;
  }
  private view(task: Task, group: WorkBranchGroup): WorkBranchView {
    const selection = this.selection(task.id, group.id);
    return {
      group,
      selection,
      branches: (
        this.store.db
          .prepare('SELECT body FROM work_branches WHERE group_id=? ORDER BY rowid')
          .all(group.id) as Row[]
      ).map((r) => {
        const b = JSON.parse(r.body) as WorkBranch;
        const workspace = this.store.db
          .prepare(
            'SELECT body FROM work_branch_workspaces WHERE branch_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(b.id) as Row | undefined;
        return {
          ...b,
          state: selection?.branchId === b.id ? 'selected' : b.state,
          ...(workspace
            ? { workspace: JSON.parse(workspace.body) as BranchWorkspaceOperation }
            : {}),
          ...(b.runId ? { run: this.store.run(b.runId) } : {}),
          ...(b.resultId
            ? {
                result: (() => {
                  const v = new ResultRevisions(this.store).current(this.store.result(b.resultId!));
                  return {
                    id: v.id,
                    revision: v.revision,
                    title: v.title,
                    createdAt: v.createdAt,
                    createdBy: v.createdBy,
                    ...(v.source.kind === 'work_branch' && v.source.code !== 'not_captured'
                      ? { codeKind: v.source.code.kind }
                      : {}),
                  };
                })(),
              }
            : {}),
        };
      }),
      taskChanged: task.revision !== group.start.taskRevision,
    };
  }
  selection(taskId: string, groupId: string): BranchChoice | null {
    this.group(taskId, groupId);
    const row = this.store.db
      .prepare(
        'SELECT body FROM work_branch_choices WHERE group_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(groupId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as BranchChoice) : null;
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
  private event(
    task: Task,
    b: WorkBranch,
    action: WorkBranchEvent['action'],
    actor?: WorkBranchEvent['actor'],
  ) {
    const event: WorkBranchEvent = {
      revision: b.revision,
      action,
      actor: actor ?? { id: this.store.actorId, name: this.store.actorName() },
      at: b.updatedAt,
    };
    this.store.db
      .prepare('INSERT INTO work_branch_events(branch_id,revision,body) VALUES(?,?,?)')
      .run(b.id, b.revision, JSON.stringify(event));
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(task.id, `work_branch.${action}`, b.updatedAt, task.spaceId);
  }
  /** Caller owns the surrounding business transaction, including dispatch/receipt. */
  change(
    task: Task,
    branch: WorkBranch,
    action: WorkBranchEvent['action'],
    actor?: WorkBranchEvent['actor'],
  ) {
    const { workspace: _workspace, run: _run, result: _result, ...saved } = branch;
    const next = { ...saved, revision: saved.revision + 1, updatedAt: new Date().toISOString() };
    this.store.db
      .prepare('UPDATE work_branches SET state=?,revision=?,body=? WHERE id=? AND task_id=?')
      .run(next.state, next.revision, JSON.stringify(next), next.id, task.id);
    this.event(task, next, action, actor);
    return next;
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
  private assertPreservingDiscard(taskId: string, b: WorkBranch) {
    if (b.state === 'discarded')
      throw new DomainError('WORK_BRANCH_DISCARDED', '此方案已放弃，原现场与历史继续保留', 409);
    if (this.selection(taskId, b.groupId)?.branchId === b.id)
      throw new DomainError(
        'WORK_BRANCH_SELECTED',
        '此方案仍被选用；请先在比较中明确取消或替换选择，再放弃方案',
        409,
      );
    const rows = this.store.db
      .prepare(
        'SELECT body FROM work_branch_workspaces WHERE task_id=? AND branch_id=? ORDER BY rowid DESC',
      )
      .all(taskId, b.id) as Row[];
    const operations = rows.map((r) => JSON.parse(r.body) as BranchWorkspaceOperation);
    const bound = operations.filter((op) => op.state === 'bound');
    if (
      !b.workingCopyId ||
      bound.length !== 1 ||
      bound[0]!.workingCopyId !== b.workingCopyId ||
      operations.some((op) => ['waiting_local', 'prepared'].includes(op.state))
    )
      throw new DomainError(
        'WORK_BRANCH_WORKSPACE_PENDING',
        '此入口只放弃已登记独立现场的方案；未完成准备先按原准备流程处理，不清理材料',
        409,
      );
  }
  discardPreview(taskId: string, id: string): WorkBranchDiscardPreview {
    const task = this.task(taskId, true),
      b = this.branch(taskId, id);
    let canDiscard = true,
      unavailableReason: string | null = null;
    try {
      this.assertPreservingDiscard(taskId, b);
    } catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      canDiscard = false;
      unavailableReason = cause.message;
    }
    const branch = this.view(task, this.group(taskId, b.groupId)).branches.find(
      (item) => item.id === id,
    )!;
    return { branch, taskRevision: task.revision, canDiscard, unavailableReason };
  }
  discardPreserving(taskId: string, id: string, input: unknown, key: string): WorkBranchView {
    this.task(taskId, true);
    this.branch(taskId, id); // Current permission before old receipts.
    const data = parseWorkBranchDiscardPreserving(input);
    const result = this.store.mutate(`work_branches.discard_preserving:${id}`, key, data, () => {
      const task = this.task(taskId, true),
        b = this.branch(taskId, id);
      assertRevision(task.revision, data.expectedTaskRevision);
      assertRevision(b.revision, data.expectedRevision);
      this.assertPreservingDiscard(taskId, b);
      this.change(task, { ...b, state: 'discarded' }, 'discard_preserving');
      return { groupId: b.groupId };
    });
    return this.get(taskId, result.groupId);
  }
  discard(taskId: string, id: string, input: unknown, key: string): WorkBranchView {
    this.task(taskId, true);
    this.branch(taskId, id);
    const data = parseWorkBranchDiscard(input);
    const result = this.store.mutate(`work_branches.discard:${id}`, key, data, () => {
      const task = this.task(taskId, true),
        b = this.branch(taskId, id);
      assertRevision(b.revision, data.expectedRevision);
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM work_branch_workspaces WHERE branch_id=? AND state IN ('waiting_local','prepared','bound')",
          )
          .get(id)
      )
        throw new DomainError(
          'WORK_BRANCH_WORKSPACE_PENDING',
          '先处置此方案的现场准备，不能借放弃定义清除占用',
          409,
        );
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
