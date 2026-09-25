import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Run } from '../../contracts/src/index.js';
import type { NativeRunInput } from '../../contracts/src/native.js';
import {
  isPendingContinuation,
  type ContinuationInput,
  type ContinuationOperation,
  type ContinuationState,
} from '../../contracts/src/continuation.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';

type Row = { body: string };
const stamp = () => new Date().toISOString();

export function humanContextHash(store: Store, taskId: string): string {
  const task = store.getTask(taskId);
  return createHash('sha256')
    .update(
      canonicalJson({
        title: task.title,
        description: task.description,
        // New source-agent output is expected while waiting. New human requirements are not.
        messages: store
          .messages(taskId)
          .filter((m) => m.actorType === 'human')
          .slice(-6)
          .map((m) => [m.id, m.body]),
      }),
    )
    .digest('hex');
}

/** Called inside the existing Run transaction, also for direct and mock start routes. */
export function assertNoPendingContinuation(
  store: Store,
  taskId: string,
  workingCopyId: string | null = null,
  allowedId?: string,
) {
  const rows = store.db
    .prepare(
      "SELECT body FROM continuation_operations WHERE state IN ('waiting_for_stop','preparing') AND (task_id=? OR working_copy_id=?)",
    )
    .all(taskId, workingCopyId) as Row[];
  if (rows.some((r) => (JSON.parse(r.body) as ContinuationOperation).id !== allowedId))
    throw new DomainError(
      'CONTINUATION_PENDING',
      '任务或目录已有待接续操作，请先取消或等待；不会重复启动',
      409,
    );
}

export class ContinuationStore {
  constructor(readonly store: Store) {}
  get(id: string): ContinuationOperation {
    const row = this.store.db
      .prepare('SELECT body FROM continuation_operations WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '接续操作不存在或不可访问', 404);
    const op = JSON.parse(row.body) as ContinuationOperation;
    this.store.getTask(op.taskId);
    return op;
  }
  list(taskId: string): ContinuationOperation[] {
    this.store.getTask(taskId);
    return (
      this.store.db
        .prepare(
          'SELECT body FROM continuation_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 20',
        )
        .all(taskId) as Row[]
    ).map((r) => JSON.parse(r.body) as ContinuationOperation);
  }
  pending(): ContinuationOperation[] {
    return (
      this.store.db
        .prepare(
          "SELECT body FROM continuation_operations WHERE state IN ('waiting_for_stop','preparing') ORDER BY rowid",
        )
        .all() as Row[]
    )
      .map((r) => JSON.parse(r.body) as ContinuationOperation)
      .filter((op) => {
        try {
          this.store.getTask(op.taskId);
          return true;
        } catch {
          return false;
        }
      });
  }
  private write(op: ContinuationOperation) {
    this.store.db
      .prepare('UPDATE continuation_operations SET state=?,body=? WHERE id=?')
      .run(op.state, JSON.stringify(op), op.id);
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at) VALUES(?,?,?)')
      .run(op.taskId, 'continuation.updated', stamp());
    return op;
  }
  assertSource(taskId: string, input: NativeRunInput) {
    const task = this.store.getTask(taskId);
    assertRevision(task.revision, input.expectedRevision);
    if (task.status === 'cancelled' || (task.status === 'done' && !input.reopenTask))
      throw new DomainError('TASK_REOPEN_REQUIRED', '请重新打开任务后继续', 409);
    const source = input.sourceRunId ? this.store.run(input.sourceRunId) : undefined;
    if (
      !source ||
      source.taskId !== taskId ||
      source.provider !== 'native' ||
      !source.native ||
      source.native.workingCopyId !== input.workingCopyId
    )
      throw new DomainError('INVALID_CONTINUATION', '来源执行与当前任务或目录不一致', 409);
    if (
      this.store
        .runs(taskId)
        .filter((r) => r.provider === 'native')
        .at(-1)?.id !== source.id
    )
      throw new DomainError('CONTINUATION_CHANGED', '任务已有更新的原生执行，请重新配置继续', 409);
    return source;
  }
  create(taskId: string, input: ContinuationInput, key: string): ContinuationOperation {
    this.store.getTask(taskId);
    const result = this.store.mutate(`continuation.create:${taskId}`, key, input, () => {
      this.assertSource(taskId, input.run);
      assertNoPendingContinuation(this.store, taskId, input.run.workingCopyId);
      const at = stamp();
      const op: ContinuationOperation = {
        id: randomUUID(),
        kind: 'continue',
        taskId,
        sourceRunId: input.run.sourceRunId!,
        workingCopyId: input.run.workingCopyId,
        input,
        humanContextHash: humanContextHash(this.store, taskId),
        state: 'waiting_for_stop',
        runId: null,
        blockers: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(
          Date.now() + (input.onActiveRun === 'wait' ? 31 * 60_000 : 60_000),
        ).toISOString(),
      };
      this.store.db
        .prepare(
          'INSERT INTO continuation_operations(id,task_id,working_copy_id,state,body) VALUES(?,?,?,?,?)',
        )
        .run(op.id, taskId, op.workingCopyId, op.state, JSON.stringify(op));
      this.store.db
        .prepare('INSERT INTO outbox(task_id,kind,created_at) VALUES(?,?,?)')
        .run(taskId, 'continuation.created', at);
      return op;
    });
    // Replays return the current operation, not the original waiting snapshot.
    return this.get(result.id);
  }
  transition(
    id: string,
    state: ContinuationState,
    blockers: ContinuationOperation['blockers'] = [],
  ) {
    const before = this.get(id);
    if (!isPendingContinuation(before.state)) return before;
    return this.store.mutate(
      `continuation.transition:${id}`,
      `${before.revision}:${state}`,
      { blockers },
      () => {
        const current = this.get(id);
        if (current.revision !== before.revision || !isPendingContinuation(current.state))
          return current;
        return this.write({
          ...current,
          state,
          blockers,
          revision: current.revision + 1,
          updatedAt: stamp(),
        });
      },
    );
  }
  cancel(id: string, expectedRevision: number, key: string) {
    this.get(id);
    this.store.mutate(`continuation.cancel:${id}`, key, { expectedRevision }, () => {
      const current = this.get(id);
      if (current.state === 'succeeded')
        throw new DomainError('RUN_ALREADY_STARTED', '新执行已经创建，请使用执行的停止按钮', 409);
      assertRevision(current.revision, expectedRevision);
      if (current.state === 'cancelled') return current;
      return this.write({
        ...current,
        state: 'cancelled',
        blockers: [],
        revision: current.revision + 1,
        updatedAt: stamp(),
      });
    });
    return this.get(id);
  }
  recover() {
    for (const op of this.pending())
      this.transition(op.id, 'needs_attention', [
        {
          code: 'SERVICE_RESTARTED',
          message:
            '服务已重启，接续没有自动重试。请核对原进程与目录后重新配置；原停止请求不会被撤销。',
        },
      ]);
  }
  /** No await: used immediately before Run creation in the same SQLite transaction. */
  assertStart(id: string, taskId: string, input: NativeRunInput) {
    const op = this.get(id);
    if (
      op.taskId !== taskId ||
      op.state !== 'preparing' ||
      canonicalJson(op.input.run) !== canonicalJson(input)
    )
      throw new DomainError('CONTINUATION_INACTIVE', '接续已取消或状态改变，没有启动新执行', 409);
    if (Date.parse(op.expiresAt) <= Date.now())
      throw new DomainError('CONTINUATION_EXPIRED', '接续等待已超时，请重新配置', 409);
    this.assertSource(taskId, input);
    if (humanContextHash(this.store, taskId) !== op.humanContextHash)
      throw new DomainError(
        'CONTEXT_CHANGED',
        '等待期间工作说明或人工讨论已变化，请重新查看上下文后继续',
        409,
      );
  }
  /** Must run inside Store.createNativeRun's transaction; linkage and Run cannot split on crash. */
  attachRun(id: string, run: Run) {
    const op = this.get(id);
    return this.write({
      ...op,
      state: 'succeeded',
      runId: run.id,
      blockers: [],
      revision: op.revision + 1,
      updatedAt: stamp(),
    });
  }
}
