import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { DirectoryGrant } from '../../contracts/src/nodes.js';
import type { BranchWorkspaceOperation } from '../../contracts/src/work-branch-workspaces.js';
import {
  parseBranchCleanupSelection,
  type BranchCleanupOptions,
  type BranchCleanupInspection,
  type BranchCleanupMaterial,
} from '../../contracts/src/branch-cleanup-check.js';
import { assertRevision, isActiveRun } from '../../domain/src/index.js';
import { WorkBranchStore } from './work-branches.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import type { Store } from './store.js';

/** Read-only eligibility, not a cleanup request, lock or deletion permission. */
export class BranchCleanupChecks {
  readonly branches: WorkBranchStore;
  readonly retained: CheckpointRetentionStore;
  constructor(readonly store: Store) {
    this.branches = new WorkBranchStore(store);
    this.retained = new CheckpointRetentionStore(store);
  }
  private context(taskId: string, branchId: string) {
    const task = this.store.getTask(taskId, true),
      raw = this.branches.branch(taskId, branchId),
      branch = this.branches.get(taskId, raw.groupId).branches.find((b) => b.id === branchId)!;
    const rows = this.store.db
      .prepare(
        "SELECT body FROM work_branch_workspaces WHERE task_id=? AND branch_id=? AND state='bound'",
      )
      .all(taskId, branchId) as { body: string }[];
    const op = rows.length === 1 ? (JSON.parse(rows[0]!.body) as BranchWorkspaceOperation) : null;
    if (!op || !op.nodeId || !op.proof || op.workingCopyId !== branch.workingCopyId)
      throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '需要原方案唯一的已登记独立现场', 409);
    const node = this.retained.checkpoints.nodes.ownedExecutionNode(op.nodeId);
    if (
      op.ticket.ownerId !== this.store.actorId ||
      task.projectId !== node.project_id ||
      task.spaceId !== node.space_id ||
      op.ticket.projectId !== task.projectId ||
      op.ticket.spaceId !== task.spaceId ||
      !(JSON.parse(node.grants) as DirectoryGrant[]).some((w) => w.id === branch.workingCopyId)
    )
      throw new DomainError('BRANCH_CLEANUP_SCOPE_CHANGED', '原本人、方案或目录授权已变化', 409);
    return { task, branch, op, node };
  }
  private eligible(c: ReturnType<BranchCleanupChecks['context']>) {
    if (c.branch.state !== 'discarded')
      throw new DomainError(
        'BRANCH_NOT_DISCARDED',
        '先明确放弃方案并保留现场；当前选择须先取消或替换',
        409,
      );
    const run = c.branch.run;
    if (
      (run &&
        (isActiveRun(run.state) ||
          run.observation !== 'fresh' ||
          !run.node?.terminationConfirmed ||
          run.node.phase !== 'terminal')) ||
      this.store.db
        .prepare("SELECT 1 FROM node_dispatches WHERE node_id=? AND stage!='terminal'")
        .get(c.node.id)
    )
      throw new DomainError(
        'BRANCH_EXECUTION_UNSETTLED',
        '原节点仍有活动或未确认执行；先单独停止并等待真实终止，不能据放弃状态清理',
        409,
      );
  }
  private material(
    c: ReturnType<BranchCleanupChecks['context']>,
    checkpointId: string,
    retentionId: string,
  ): BranchCleanupMaterial {
    const checkpoint = this.retained.checkpoints.get(c.task.id, checkpointId, true),
      retention = this.retained.get(c.task.id, checkpointId, retentionId),
      r = checkpoint.request,
      m = retention.manifest;
    if (
      r.nodeId !== c.node.id ||
      r.workspaceId !== c.branch.workingCopyId ||
      r.nodeRevision !== c.node.revision ||
      r.requestedBy.id !== c.node.owner_id ||
      retention.request.nodeId !== c.node.id ||
      retention.request.workspaceId !== r.workspaceId ||
      retention.request.ownerId !== c.node.owner_id ||
      retention.request.nodeRevision !== c.node.revision ||
      !retention.nodeAuthorized ||
      retention.state !== 'retained' ||
      !m ||
      m.expiresAt <= new Date().toISOString() ||
      m.commit !== checkpoint.manifest.commit ||
      m.tree !== checkpoint.manifest.tree ||
      m.objectFormat !== checkpoint.manifest.objectFormat ||
      m.repositoryIdentity !== checkpoint.manifest.repositoryIdentity
    )
      throw new DomainError(
        'BRANCH_CLEANUP_MATERIAL_UNAVAILABLE',
        '请选择原本人同一现场当前有效的完整提交副本；原共同起点不能代替后来成果',
        409,
      );
    return { checkpoint, retention };
  }
  options(taskId: string, branchId: string): BranchCleanupOptions {
    const c = this.context(taskId, branchId);
    let canInspect = true,
      unavailableReason: string | null = null;
    try {
      this.eligible(c);
    } catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      canInspect = false;
      unavailableReason = cause.message;
    }
    const ids = this.store.db
      .prepare(
        `SELECT id FROM commit_checkpoints WHERE task_id=?
      AND json_extract(body,'$.request.nodeId')=? AND json_extract(body,'$.request.workspaceId')=?
      ORDER BY rowid DESC LIMIT 50`,
      )
      .all(taskId, c.node.id, c.branch.workingCopyId) as { id: string }[];
    const materials = ids
      .flatMap(({ id }) =>
        this.retained.list(taskId, id).items.flatMap((r) => {
          try {
            return [this.material(c, id, r.request.id)];
          } catch (cause) {
            if (cause instanceof DomainError) return [];
            throw cause;
          }
        }),
      )
      .slice(0, 50);
    return {
      branch: c.branch,
      taskRevision: c.task.revision,
      nodeId: c.node.id,
      originHash: c.op.proof!.originHash,
      canInspect,
      unavailableReason,
      materials,
      deletionAuthorized: false,
    };
  }
  inspect(token: string, input: unknown): BranchCleanupInspection {
    const data = parseBranchCleanupSelection(input),
      node = this.retained.checkpoints.nodes.settlementIdentity(token);
    if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '节点授权已撤销', 401);
    const row = this.store.db
      .prepare('SELECT task_id FROM work_branches WHERE id=?')
      .get(data.branchId) as { task_id: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案不存在或不可访问', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(node.owner_id) as unknown as IdentityUser;
    return this.store.as({ user, spaceId: node.space_id }, () => {
      const c = this.context(row.task_id, data.branchId);
      if (c.node.id !== node.id) throw new DomainError('NOT_FOUND', '不是原方案本人节点', 404);
      this.eligible(c);
      assertRevision(c.branch.revision, data.expectedRevision);
      assertRevision(c.task.revision, data.expectedTaskRevision);
      const r = this.store.db
        .prepare(
          'SELECT checkpoint_id FROM checkpoint_retentions WHERE id=? AND task_id=? AND node_id=?',
        )
        .get(data.retentionId, c.task.id, node.id) as { checkpoint_id: string } | undefined;
      if (!r) throw new DomainError('NOT_FOUND', '副本不属于原方案节点', 404);
      return {
        branch: {
          id: c.branch.id,
          taskId: c.branch.taskId,
          groupId: c.branch.groupId,
          name: c.branch.name,
          revision: c.branch.revision,
          state: c.branch.state,
          workingCopyId: c.branch.workingCopyId,
        },
        taskRevision: c.task.revision,
        nodeId: node.id,
        originHash: c.op.proof!.originHash,
        material: this.material(c, r.checkpoint_id, data.retentionId),
        deletionAuthorized: false,
      };
    });
  }
}
