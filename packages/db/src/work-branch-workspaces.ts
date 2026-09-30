import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Run, type Task } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { DirectoryGrant } from '../../contracts/src/nodes.js';
import type { NodeRunInput } from '../../contracts/src/node-execution.js';
import {
  branchContext,
  parseBranchWorkspaceCommand,
  parseBranchWorkspaceCreate,
  type BranchExecutionBinding,
  type BranchWorkspaceOperation,
} from '../../contracts/src/work-branch-workspaces.js';
import { assertRevision, canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import { WorkBranchStore } from './work-branches.js';
import { BranchContinuations } from './branch-continuation.js';
import type { Store } from './store.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
type Row = { body: string };
export class BranchWorkspaceStore {
  readonly branches: WorkBranchStore;
  readonly retained: CheckpointRetentionStore;
  constructor(readonly store: Store) {
    this.branches = new WorkBranchStore(store);
    this.retained = new CheckpointRetentionStore(store);
  }
  private record(id: string): BranchWorkspaceOperation {
    const row = this.store.db
      .prepare('SELECT body FROM work_branch_workspaces WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '方案现场请求不存在', 404);
    return JSON.parse(row.body) as BranchWorkspaceOperation;
  }
  get(taskId: string, branchId: string, id: string) {
    this.branches.branch(taskId, branchId);
    const op = this.record(id);
    if (op.ticket.taskId !== taskId || op.ticket.branchId !== branchId)
      throw new DomainError('NOT_FOUND', '现场请求不属于此方案', 404);
    return op;
  }
  private material(taskId: string, branchId: string, retentionId: string) {
    const task = this.store.getTask(taskId, true);
    const b = this.branches.branch(taskId, branchId),
      group = this.branches.group(taskId, b.groupId);
    const source = this.retained.get(taskId, group.start.checkpoint.id, retentionId),
      t = source.request;
    const node = this.retained.checkpoints.nodes.ownedExecutionNode(t.nodeId);
    if (
      task.projectId !== group.projectId ||
      node.project_id !== task.projectId ||
      node.space_id !== task.spaceId ||
      t.ownerId !== this.store.actorId ||
      !source.nodeAuthorized ||
      source.state !== 'retained' ||
      !source.manifest ||
      source.manifest.expiresAt <= new Date().toISOString() ||
      source.manifest.commit !== group.start.checkpoint.manifest.commit ||
      source.manifest.tree !== group.start.checkpoint.manifest.tree
    )
      throw new DomainError(
        'WORK_BRANCH_SOURCE_UNAVAILABLE',
        '需要原本人节点仍有授权的共同提交对象副本',
        409,
      );
    if (
      source.manifest.coverage.bytes > 16 * 1024 * 1024 ||
      source.manifest.coverage.objects > 2048
    )
      throw new DomainError(
        'WORK_BRANCH_SOURCE_LIMIT',
        '本轮Git现场支持16 MiB、2048对象以内的副本',
        409,
      );
    return { b, group, source, manifest: source.manifest };
  }
  options(taskId: string, branchId: string) {
    this.store.getTask(taskId, true);
    const b = this.branches.branch(taskId, branchId),
      group = this.branches.group(taskId, b.groupId);
    return {
      branchRevision: b.revision,
      startHash: group.startHash,
      items: this.retained.list(taskId, group.start.checkpoint.id).items.flatMap((v) => {
        try {
          this.material(taskId, branchId, v.request.id);
          return [v];
        } catch (e) {
          if (e instanceof DomainError) return [];
          throw e;
        }
      }),
    };
  }
  create(taskId: string, branchId: string, input: unknown, key: string) {
    const data = parseBranchWorkspaceCreate(input);
    this.material(taskId, branchId, data.retentionId);
    const result = this.store.mutate(`work_branch.workspace:${branchId}`, key, data, () => {
      const { b, group, source, manifest } = this.material(taskId, branchId, data.retentionId);
      assertRevision(b.revision, data.expectedRevision);
      if (
        b.state !== 'planned' ||
        b.runId ||
        b.workingCopyId ||
        this.store.db
          .prepare(
            "SELECT 1 FROM work_branch_workspaces WHERE branch_id=? AND state IN ('waiting_local','prepared','bound')",
          )
          .get(branchId)
      )
        throw new DomainError(
          'WORK_BRANCH_WORKSPACE_EXISTS',
          '方案已有现场准备或执行，请先核对原记录',
          409,
        );
      if (data.snapshotHash !== manifest.snapshotHash)
        throw new DomainError('WORK_BRANCH_SOURCE_CHANGED', '对象指纹已变化', 409);
      if (
        Number(
          this.store.db
            .prepare('SELECT count(*) AS n FROM work_branch_workspaces WHERE branch_id=?')
            .get(branchId)!.n,
        ) >= 20
      )
        throw new DomainError('WORK_BRANCH_LIMIT', '此方案现场请求达到上限', 409);
      const at = new Date().toISOString(),
        task = this.store.getTask(taskId, true);
      const ticket = {
        id: randomUUID(),
        taskId,
        branchId,
        branchRevision: b.revision + 1,
        groupId: b.groupId,
        startHash: group.startHash,
        ownerId: this.store.actorId,
        projectId: task.projectId!,
        spaceId: task.spaceId,
        sourceNodeId: source.request.nodeId,
        retentionId: data.retentionId,
        checkpointId: group.start.checkpoint.id,
        manifest,
        createdAt: at,
        expiresAt: new Date(
          Math.min(Date.now() + 30 * 60000, Date.parse(manifest.expiresAt)),
        ).toISOString(),
        requestHash: '',
      };
      ticket.requestHash = hash(ticket);
      const op: BranchWorkspaceOperation = {
        ticket,
        state: 'waiting_local',
        revision: 1,
        proof: null,
        proofHash: null,
        nodeId: null,
        workingCopyId: null,
        updatedAt: at,
        reason: null,
      };
      this.store.db
        .prepare(
          'INSERT INTO work_branch_workspaces(id,task_id,branch_id,state,body) VALUES(?,?,?,?,?)',
        )
        .run(ticket.id, taskId, branchId, op.state, JSON.stringify(op));
      this.branches.change(task, b, 'workspace_requested');
      return { id: ticket.id };
    });
    return this.get(taskId, branchId, result.id);
  }
  private save(op: BranchWorkspaceOperation) {
    const next = { ...op, revision: op.revision + 1, updatedAt: new Date().toISOString() };
    this.store.db
      .prepare(
        'UPDATE work_branch_workspaces SET state=?,node_id=?,workspace_id=?,body=? WHERE id=?',
      )
      .run(next.state, next.nodeId, next.workingCopyId, JSON.stringify(next), next.ticket.id);
    return next;
  }
  cancel(taskId: string, branchId: string, id: string, expectedRevision: number, key: string) {
    this.store.getTask(taskId, true);
    this.get(taskId, branchId, id);
    this.store.mutate(`work_branch.workspace.cancel:${id}`, key, { expectedRevision }, () => {
      const op = this.get(taskId, branchId, id);
      assertRevision(op.revision, expectedRevision);
      if (op.state === 'bound')
        throw new DomainError(
          'WORK_BRANCH_BOUND',
          '已经登记的现场不能通过取消准备解除绑定或删除',
          409,
        );
      if (op.state !== 'cancelled') {
        this.save({
          ...op,
          state: 'cancelled',
          reason: '已取消此准备请求；本机已有文件和记录仍需本人核对',
        });
        this.branches.change(
          this.store.getTask(taskId, true),
          this.branches.branch(taskId, branchId),
          'workspace_cancelled',
        );
      }
      return { id };
    });
    return this.get(taskId, branchId, id);
  }
  nodeCommand(token: string, input: unknown) {
    const data = parseBranchWorkspaceCommand(input),
      nodes = this.retained.checkpoints.nodes;
    const n = nodes.settlementIdentity(token),
      op = this.record(data.operationId),
      t = op.ticket;
    if (n.settlementOnly) throw new DomainError('NODE_REVOKED', '节点授权已撤销', 401);
    if (
      n.owner_id !== t.ownerId ||
      n.project_id !== t.projectId ||
      n.space_id !== t.spaceId ||
      (data.action !== 'bind' && n.id !== t.sourceNodeId)
    )
      throw new DomainError('NOT_FOUND', '现场请求不属于当前节点身份', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(t.ownerId) as unknown as IdentityUser;
    return this.store.as({ user, spaceId: t.spaceId }, () => {
      const task = this.store.getTask(t.taskId, true);
      if (
        task.visibility !== 'project' ||
        task.projectId !== t.projectId ||
        task.spaceId !== t.spaceId
      )
        throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '任务不再属于原准备的项目与空间', 409);
      if (data.action === 'inspect') {
        if (op.state === 'waiting_local') {
          const material = this.material(t.taskId, t.branchId, t.retentionId);
          if (
            t.expiresAt <= new Date().toISOString() ||
            material.manifest.snapshotHash !== t.manifest.snapshotHash
          )
            throw new DomainError(
              'WORK_BRANCH_PREPARATION_EXPIRED',
              '准备期限或来源已变化，请保留现场后取消原请求',
              409,
            );
        }
        return op;
      }
      return this.store.atomic(() => {
        const current = this.record(t.id),
          b = this.branches.branch(t.taskId, t.branchId);
        if (data.requestHash !== t.requestHash)
          throw new DomainError('WORK_BRANCH_PACKET_CHANGED', '请求指纹不一致', 409);
        if (current.state === 'cancelled' || current.state === 'needs_attention') return current;
        if (data.action === 'prepare') {
          const proofHash = hash(data.proof);
          if (current.proofHash) {
            if (current.proofHash !== proofHash)
              throw new DomainError('WORK_BRANCH_PACKET_CHANGED', '只能对账原现场核验包', 409);
            return current;
          }
          const { manifest } = this.material(t.taskId, t.branchId, t.retentionId);
          const verified = Date.parse(data.proof.verifiedAt);
          if (
            current.state !== 'waiting_local' ||
            b.state !== 'planned' ||
            b.runId ||
            t.expiresAt <= new Date().toISOString() ||
            data.proof.snapshotHash !== manifest.snapshotHash ||
            verified < Date.now() - 30000 ||
            verified > Date.now() + 5000
          )
            throw new DomainError(
              'WORK_BRANCH_PREPARATION_CHANGED',
              '现场核验已过期或准备条件已变化',
              409,
            );
          if (
            this.store.db
              .prepare(
                "SELECT 1 FROM work_branch_workspaces WHERE json_extract(body,'$.ticket.sourceNodeId')=? AND json_extract(body,'$.proof.workspaceRef')=?",
              )
              .get(t.sourceNodeId, data.proof.workspaceRef)
          )
            throw new DomainError('WORK_BRANCH_WORKSPACE_REUSED', '不同方案必须使用独立现场', 409);
          const next = this.save({ ...current, state: 'prepared', proof: data.proof, proofHash });
          this.branches.change(this.store.getTask(t.taskId), b, 'workspace_prepared');
          return next;
        }
        if (current.state === 'bound') {
          if (
            current.nodeId !== n.id ||
            current.workingCopyId !== data.workspaceId ||
            current.proof?.originHash !== data.originHash
          )
            throw new DomainError(
              'WORK_BRANCH_PACKET_CHANGED',
              '登记回执只能用于原节点和目录',
              409,
            );
          return current;
        }
        const node = nodes.ownedExecutionNode(n.id);
        if (
          current.state !== 'prepared' ||
          b.state !== 'planned' ||
          b.runId ||
          n.id === t.sourceNodeId ||
          current.proof?.originHash !== data.originHash ||
          t.expiresAt <= new Date().toISOString() ||
          !(JSON.parse(node.grants) as DirectoryGrant[]).some((w) => w.id === data.workspaceId)
        )
          throw new DomainError(
            'WORK_BRANCH_BINDING_CHANGED',
            '需要本人新节点的原独立现场，且准备请求仍有效',
            409,
          );
        if (
          this.store.db
            .prepare("SELECT 1 FROM node_dispatches WHERE node_id=? AND stage!='terminal'")
            .get(n.id)
        )
          throw new DomainError(
            'WORK_BRANCH_WRITER_ACTIVE',
            '新节点还有活动或未知执行，未登记',
            409,
          );
        const next = this.save({
          ...current,
          state: 'bound',
          nodeId: n.id,
          workingCopyId: data.workspaceId,
        });
        this.branches.change(
          this.store.getTask(t.taskId),
          { ...b, workingCopyId: data.workspaceId },
          'workspace_bound',
        );
        return next;
      });
    });
  }
  execution(taskId: string, input: NodeRunInput, allowExisting = false) {
    const selection = input.workBranch;
    if (!selection) {
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM work_branch_workspaces WHERE node_id=? AND workspace_id=? AND state='bound'",
          )
          .get(input.nodeId, input.workingCopyId)
      )
        throw new DomainError(
          'WORK_BRANCH_REQUIRED',
          '此目录已绑定方案，请从该方案执行入口开始',
          409,
        );
      return null;
    }
    const b = this.branches.branch(taskId, selection.branchId),
      group = this.branches.group(taskId, b.groupId);
    const row = this.store.db
      .prepare("SELECT body FROM work_branch_workspaces WHERE branch_id=? AND state='bound'")
      .get(b.id) as Row | undefined;
    const op = row && (JSON.parse(row.body) as BranchWorkspaceOperation);
    if (
      !op ||
      op.ticket.ownerId !== this.store.actorId ||
      op.nodeId !== input.nodeId ||
      op.workingCopyId !== input.workingCopyId ||
      group.startHash !== selection.startHash
    )
      throw new DomainError('WORK_BRANCH_BINDING_CHANGED', '方案与本人已登记现场不匹配', 409);
    if (!allowExisting) {
      assertRevision(b.revision, selection.expectedRevision);
      if (!selection.continueFrom && (b.state !== 'planned' || b.runId))
        throw new DomainError('WORK_BRANCH_ALREADY_RUN', '此方案首轮已创建，不能隐式重试', 409);
    }
    const binding: BranchExecutionBinding = {
      branchId: b.id,
      groupId: b.groupId,
      operationId: op.ticket.id,
      startHash: group.startHash,
      originHash: op.proof!.originHash,
      commit: op.ticket.manifest.commit,
    };
    const continuation = selection.continueFrom
      ? new BranchContinuations(this.store).resolve(
          taskId,
          b,
          selection.continueFrom,
          allowExisting,
        )
      : null;
    if (continuation) binding.continueFrom = continuation.binding;
    return {
      branch: b,
      binding,
      context:
        continuation?.contextText ??
        branchContext(
          group.start.taskTitle,
          group.start.taskDescription,
          binding.commit,
          b.name,
          b.goal,
        ),
    };
  }
  assertParallel(taskId: string, binding: BranchExecutionBinding | undefined) {
    const active = this.store
      .codingRuns(taskId)
      .filter((r) => isActiveRun(r.state) || (!!binding && r.observation === 'unknown'));
    if (
      active.some(
        (r) =>
          !binding ||
          !r.node?.workBranch ||
          r.node.workBranch.groupId !== binding.groupId ||
          r.node.workBranch.branchId === binding.branchId,
      )
    )
      throw new DomainError(
        'TASK_BUSY',
        '仅同组不同独立现场的方案可并行；任务仍有其他执行或未知现场',
        409,
      );
  }
  attach(task: Task, run: Run) {
    if (!run.node?.workBranch) return;
    const b = this.branches.branch(task.id, run.node.workBranch.branchId);
    this.branches.change(task, { ...b, runId: run.id }, 'run_created');
  }
  started(task: Task, run: Run) {
    if (!run.node?.workBranch) return;
    const row = this.store.db
      .prepare('SELECT body FROM work_branches WHERE id=? AND task_id=?')
      .get(run.node.workBranch.branchId, task.id) as Row | undefined;
    if (!row) throw new DomainError('WORK_BRANCH_BINDING_CHANGED', '方案关联丢失');
    const b = JSON.parse(row.body);
    if (b.runId !== run.id)
      throw new DomainError('WORK_BRANCH_BINDING_CHANGED', '方案执行关联不一致');
    if (b.state !== 'active')
      this.branches.change(task, { ...b, state: 'active' }, 'run_started', {
        id: run.createdByUserId!,
        name:
          (this.store.db
            .prepare('SELECT name FROM collab_people WHERE id=?')
            .get(run.createdByUserId!)?.name as string) ?? '原执行者',
      });
  }
}
