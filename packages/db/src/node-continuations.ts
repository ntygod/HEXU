import { randomUUID } from 'node:crypto';
import { DomainError, type Run } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type {
  NodeContinuationInput,
  NodeContinuationOperation,
} from '../../contracts/src/node-continuation.js';
import { isPendingContinuation } from '../../contracts/src/continuation.js';
import { nodeContinuationContext } from '../../contracts/src/next-input.js';
import { assertRevision, canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { NextInputs } from './next-inputs.js';
import { executionHash, type NodeExecution } from './node-execution.js';
import type { Store } from './store.js';

type Row = { body: string };
const stamp = () => new Date().toISOString();

/** Enforced inside ALL Run creation transactions, not just the Operation route. */
export function assertNoPendingNodeContinuation(
  store: Store,
  taskId: string,
  nodeId: string | null = null,
  allowedId?: string,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM node_continuation_operations WHERE state IN ('waiting_for_stop','preparing') AND (task_id=? OR node_id=?)",
    )
    .all(taskId, nodeId) as { id: string }[];
  if (rows.some((r) => r.id !== allowedId))
    throw new DomainError(
      'CONTINUATION_PENDING',
      '任务或节点已有接续安排，请等待或先取消；不会重复派发',
      409,
    );
}

/** No model calls and no host-process access. Every advance re-enters the owner's current
 * project permissions; stored identity is not a substitute for membership or node grants. */
export class NodeContinuations {
  private closing = false;
  constructor(
    readonly store: Store,
    readonly execution: NodeExecution,
  ) {
    this.recover();
  }
  private read(id: string): NodeContinuationOperation {
    const row = this.store.db
      .prepare('SELECT body FROM node_continuation_operations WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '接续安排不存在或不可访问', 404);
    return JSON.parse(row.body) as NodeContinuationOperation;
  }
  get(id: string) {
    const op = this.read(id);
    this.store.getTask(op.taskId);
    return op;
  }
  list(taskId: string) {
    this.store.getTask(taskId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM node_continuation_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 20',
        )
        .all(taskId) as Row[]
    ).map((r) => JSON.parse(r.body) as NodeContinuationOperation);
  }
  private pending() {
    return (
      this.store.db
        .prepare(
          "SELECT body FROM node_continuation_operations WHERE state IN ('waiting_for_stop','preparing') ORDER BY rowid",
        )
        .all() as Row[]
    ).map((r) => JSON.parse(r.body) as NodeContinuationOperation);
  }
  private write(op: NodeContinuationOperation) {
    this.store.db
      .prepare('UPDATE node_continuation_operations SET state=?,body=? WHERE id=?')
      .run(op.state, JSON.stringify(op), op.id);
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(op.taskId, 'continuation.updated', stamp(), op.spaceId);
    return op;
  }
  private transition(
    id: string,
    state: NodeContinuationOperation['state'],
    blockers: NodeContinuationOperation['blockers'] = [],
  ) {
    return this.store.atomic(() => {
      const op = this.read(id);
      if (!isPendingContinuation(op.state)) return op;
      return this.write({ ...op, state, blockers, revision: op.revision + 1, updatedAt: stamp() });
    });
  }
  private recover() {
    for (const op of this.pending())
      this.transition(op.id, 'needs_attention', [
        {
          code: 'SERVICE_RESTARTED',
          message:
            '控制服务已停止或重启，接续没有自动重试。已保存要求与材料；核对原执行后重新配置。',
        },
      ]);
  }
  create(taskId: string, input: NodeContinuationInput, key: string) {
    if (this.closing) throw new DomainError('SERVICE_CLOSING', '服务正在关闭，未接收接续安排', 503);
    this.store.projectLifecycle.assertExecution(taskId);
    this.execution.nodes.ownedExecutionNode(input.run.nodeId); // Before idempotent replay.
    const result = this.store.mutate(`node.continuation.create:${taskId}`, key, input, () => {
      const task = this.store.projectLifecycle.assertExecution(taskId),
        run = input.run;
      assertRevision(task.revision, run.expectedRevision);
      assertNoPendingNodeContinuation(this.store, taskId, run.nodeId);
      const selection = run.continuation;
      if (!selection) throw new DomainError('INVALID_CONTINUATION', '需要明确来源执行', 409);
      const preview = this.execution.continuationPreview(taskId, selection.sourceRunId, true);
      if (!preview.ready)
        throw new DomainError(preview.blockers[0]!.code, preview.blockers[0]!.message, 409);
      if (preview.nodeId !== run.nodeId || preview.workingCopyId !== run.workingCopyId)
        throw new DomainError('CONTINUATION_SCOPE_CHANGED', '必须沿用原节点和原目录', 409);
      if (preview.contextHash !== selection.expectedContextHash)
        throw new DomainError('CONTEXT_CHANGED', '来源材料已变化，请重新查看并确认接续安排', 409);
      if (task.status === 'cancelled' || (task.status === 'done' && !run.reopenTask))
        throw new DomainError('TASK_REOPEN_REQUIRED', '请明确重新打开任务后继续', 409);
      const option = this.execution
        .options(taskId, selection.sourceRunId)
        .items.find((n) => n.nodeId === run.nodeId);
      if (!option?.available || option.policyHash !== run.policyHash)
        throw new DomainError('EXECUTION_UNAVAILABLE', option?.reason ?? '没有本机执行授权', 409);
      if (
        !option.workspaces.some((w) => w.id === run.workingCopyId) ||
        (run.mode === 'edit' && option.policy.mode !== 'edit')
      )
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '目录或编辑范围超出当前本机授权', 409);
      const source = this.store.run(selection.sourceRunId),
        at = stamp();
      const op: NodeContinuationOperation = {
        id: randomUUID(),
        provider: 'node',
        kind: 'continue',
        taskId,
        spaceId: task.spaceId,
        ownerId: this.store.actorId,
        ownerName: this.store.actorName(),
        sourceRunId: source.id,
        nodeId: run.nodeId,
        workingCopyId: run.workingCopyId,
        input,
        policy: option.policy,
        // Freeze exactly what the user saw. Later model output is NOT silently added.
        contextText: nodeContinuationContext(
          preview.contextText,
          run.prompt,
          new NextInputs(this.store).selected(taskId, selection),
        ),
        humanContextHash: executionHash(this.execution.humanContext(task)),
        taskRevision: task.revision,
        taskStatus: task.status,
        sourceHadStarted: !!source.node?.startedAt,
        state: 'waiting_for_stop',
        runId: null,
        blockers: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(
          Date.now() + (input.onActiveRun === 'request_stop' ? 60_000 : 660_000),
        ).toISOString(),
      };
      this.store.db
        .prepare(
          'INSERT INTO node_continuation_operations(id,task_id,node_id,state,body) VALUES(?,?,?,?,?)',
        )
        .run(op.id, taskId, op.nodeId, op.state, JSON.stringify(op));
      this.store.db
        .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
        .run(taskId, 'continuation.created', at, task.spaceId);
      return { id: op.id };
    });
    return this.get(result.id); // Replays return current status, not the initial snapshot.
  }
  cancel(id: string, expectedRevision: number, key: string) {
    const op = this.get(id);
    this.store.getTask(op.taskId, true); // Any current project editor can stop a pending plan.
    this.store.mutate(`node.continuation.cancel:${id}`, key, { expectedRevision }, () => {
      const current = this.read(id);
      if (current.state === 'succeeded')
        throw new DomainError('RUN_ALREADY_STARTED', '新执行已创建，请使用该执行的停止按钮', 409);
      assertRevision(current.revision, expectedRevision);
      if (current.state === 'cancelled') return { id };
      this.write({
        ...current,
        state: 'cancelled',
        blockers: [],
        revision: current.revision + 1,
        updatedAt: stamp(),
      });
      return { id };
    });
    return this.get(id);
  }
  /** Rechecked again inside NodeExecution's final Run transaction. */
  private validate(op: NodeContinuationOperation, mustBeStopped = false) {
    if (this.closing || !isPendingContinuation(op.state))
      throw new DomainError('CONTINUATION_INACTIVE', '接续已取消或不再活动，没有创建新执行', 409);
    if (Date.parse(op.expiresAt) <= Date.now())
      throw new DomainError(
        'CONTINUATION_EXPIRED',
        '接续等待已超时；没有释放原进程占用或自动重试',
        409,
      );
    const task = this.store.projectLifecycle.assertExecution(op.taskId);
    const preview = this.execution.continuationPreview(op.taskId, op.sourceRunId, !mustBeStopped);
    if (!preview.ready)
      throw new DomainError(preview.blockers[0]!.code, preview.blockers[0]!.message, 409);
    const source = this.store.run(op.sourceRunId);
    const autoStart =
      op.taskStatus === 'todo' &&
      task.status === 'in_progress' &&
      !op.sourceHadStarted &&
      !!source.node?.startedAt;
    if (
      task.revision !== op.taskRevision + (autoStart ? 1 : 0) ||
      (task.status !== op.taskStatus && !autoStart) ||
      executionHash(this.execution.humanContext(task)) !== op.humanContextHash
    )
      throw new DomainError(
        'CONTEXT_CHANGED',
        '等待期间任务或人工讨论已变化，请重新查看材料后配置接续',
        409,
      );
    new NextInputs(this.store).selected(op.taskId, op.input.run.continuation!);
    const option = this.execution
      .options(op.taskId, op.sourceRunId, op.id)
      .items.find((n) => n.nodeId === op.nodeId);
    if (
      !option?.available ||
      option.policyHash !== op.input.run.policyHash ||
      canonicalJson(option.policy) !== canonicalJson(op.policy)
    )
      throw new DomainError(
        'EXECUTION_CHANGED',
        '节点连接或本机执行授权已变化；原配置保留，请重新确认',
        409,
      );
    if (
      !option.workspaces.some((w) => w.id === op.workingCopyId) ||
      preview.nodeId !== op.nodeId ||
      preview.workingCopyId !== op.workingCopyId
    )
      throw new DomainError('CONTINUATION_SCOPE_CHANGED', '目录或节点范围已变化，没有派发', 409);
    assertNoPendingNodeContinuation(this.store, op.taskId, op.nodeId, op.id);
    return { source, task };
  }
  private advance(op: NodeContinuationOperation) {
    const { source, task } = this.validate(op);
    if (isActiveRun(source.state)) {
      if (op.input.onActiveRun === 'request_stop' && source.state !== 'stopping') {
        this.store.stopRun(source.id, `node-continuation-stop:${op.id}`);
        this.execution.reconcile();
      }
      return; // Stop request is not evidence of process termination.
    }
    const preparing = this.transition(op.id, 'preparing');
    if (preparing.state !== 'preparing') return;
    this.execution.create(
      op.taskId,
      { ...op.input.run, expectedRevision: task.revision },
      `node-continuation-run:${op.id}`,
      {
        operationId: op.id,
        context: () => {
          const current = this.read(op.id);
          if (current.state !== 'preparing')
            throw new DomainError('CONTINUATION_INACTIVE', '接续已取消，没有创建新执行', 409);
          this.validate(current, true);
          return current.contextText;
        },
        attach: (run: Run) => {
          const current = this.read(op.id);
          this.write({
            ...current,
            state: 'succeeded',
            runId: run.id,
            blockers: [],
            revision: current.revision + 1,
            updatedAt: stamp(),
          });
        },
      },
    );
  }
  tick() {
    if (this.closing) return;
    for (const op of this.pending()) {
      try {
        const user = this.store.db
          .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
          .get(op.ownerId) as IdentityUser | undefined;
        if (!user) throw new DomainError('ACCESS_REVOKED', '安排者账号已不可用', 409);
        this.store.as({ user, spaceId: op.spaceId }, () => this.advance(op));
      } catch (error) {
        this.transition(op.id, error instanceof DomainError ? 'needs_attention' : 'failed', [
          {
            code: error instanceof DomainError ? error.code : 'CONTINUATION_FAILED',
            message:
              error instanceof DomainError
                ? error.message
                : '接续准备失败，原要求已保留；没有自动重试。',
          },
        ]);
      }
    }
  }
  close() {
    this.closing = true;
    this.recover(); // Mark pending plans before store close; never restart authorized paid work.
  }
}
