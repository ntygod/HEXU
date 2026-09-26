import { randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { NextInput, NodeContinuationSelection } from '../../contracts/src/next-input.js';
import { assertRevision } from '../../domain/src/index.js';
import type { Store } from './store.js';
const stamp = () => new Date().toISOString();
type Row = { body: string };

/** Task-scoped notes, never a live provider-input channel or an automatic dispatch. */
export class NextInputs {
  constructor(readonly store: Store) {}
  private read(id: string): NextInput {
    const row = this.store.db.prepare('SELECT body FROM task_next_inputs WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '下一轮要求不存在或不可访问', 404);
    return JSON.parse(row.body) as NextInput;
  }
  private write(input: NextInput) {
    this.store.db
      .prepare(
        'INSERT INTO task_next_inputs(id,task_id,state,target_run_id,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,target_run_id=excluded.target_run_id,body=excluded.body',
      )
      .run(input.id, input.taskId, input.state, input.targetRunId, JSON.stringify(input));
    // Internal dispatch settlement has no browser principal. Derive scope from the task.
    const task = this.store.db
      .prepare('SELECT body FROM tasks WHERE id=?')
      .get(input.taskId) as Row;
    const spaceId = JSON.parse(task.body).spaceId as string;
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(input.taskId, 'next_input.updated', stamp(), spaceId);
    return input;
  }
  list(taskId: string) {
    this.store.getTask(taskId);
    // Pending items always remain visible; terminal history has a bounded last 30 window.
    return (
      this.store.db
        .prepare(
          "SELECT body FROM task_next_inputs WHERE task_id=? ORDER BY CASE WHEN state IN ('queued','attached') THEN 0 ELSE 1 END, rowid DESC LIMIT 50",
        )
        .all(taskId) as Row[]
    ).map((r) => JSON.parse(r.body) as NextInput);
  }
  create(sourceRunId: string, body: string, key: string) {
    const source = this.store.run(sourceRunId);
    this.store.getTask(source.taskId, true); // Authorization before idempotent replay.
    if (source.provider !== 'node')
      throw new DomainError('CAPABILITY_UNAVAILABLE', '此队列只用于独立节点任务', 422);
    const result = this.store.mutate(`next_input.create:${sourceRunId}`, key, { body }, () => {
      const count = this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM task_next_inputs WHERE task_id=? AND state IN ('queued','attached')",
        )
        .get(source.taskId)!.n as number;
      if (count >= 20)
        throw new DomainError('INPUT_QUEUE_FULL', '最多保留 20 条待使用要求，请先处理或撤回');
      const now = stamp();
      return this.write({
        id: randomUUID(),
        taskId: source.taskId,
        sourceRunId,
        body,
        authorId: this.store.actorId,
        authorName: this.store.actorName(),
        revision: 1,
        state: 'queued',
        targetRunId: null,
        createdAt: now,
        updatedAt: now,
      });
    });
    return this.read(result.id);
  }
  edit(id: string, expectedRevision: number, body: string | null, key: string) {
    const input = this.read(id);
    this.store.getTask(input.taskId, true);
    if (input.authorId !== this.store.actorId)
      throw new DomainError('INPUT_AUTHOR_REQUIRED', '只能修改或撤回自己保存的要求', 403);
    const result = this.store.mutate(
      `next_input.edit:${id}`,
      key,
      { expectedRevision, body },
      () => {
        const current = this.read(id);
        assertRevision(current.revision, expectedRevision);
        if (current.state !== 'queued')
          throw new DomainError('INPUT_BOUND', '该要求已绑定派发或已撤回；不会修改已发送材料', 409);
        return this.write({
          ...current,
          body: body ?? current.body,
          state: body === null ? 'cancelled' : 'queued',
          revision: current.revision + 1,
          updatedAt: stamp(),
        });
      },
    );
    return this.read(result.id);
  }
  selected(taskId: string, selection: NodeContinuationSelection) {
    this.store.getTask(taskId, true);
    return selection.inputs.map((ref) => {
      const input = this.read(ref.id);
      if (input.taskId !== taskId)
        throw new DomainError('INVALID_CONTINUATION', '所选要求不属于当前任务', 409);
      assertRevision(input.revision, ref.revision);
      if (input.state !== 'queued')
        throw new DomainError('INPUT_BOUND', '所选要求已使用或撤回，请重新选择', 409);
      return input;
    });
  }
  /** Inside NodeExecution.create's existing transaction, never start another transaction here. */
  attach(taskId: string, selection: NodeContinuationSelection, runId: string) {
    for (const input of this.selected(taskId, selection))
      this.write({
        ...input,
        state: 'attached',
        targetRunId: runId,
        revision: input.revision + 1,
        updatedAt: stamp(),
      });
  }
  /** Actual spawn is not proof the model read the prompt. UI says started, never delivered. */
  started(runId: string) {
    this.transitionForRun(runId, 'started');
  }
  notStarted(runId: string) {
    this.transitionForRun(runId, 'queued');
  }
  private transitionForRun(runId: string, state: 'started' | 'queued') {
    const rows = this.store.db
      .prepare("SELECT body FROM task_next_inputs WHERE target_run_id=? AND state='attached'")
      .all(runId) as Row[];
    for (const row of rows) {
      const input = JSON.parse(row.body) as NextInput;
      this.write({
        ...input,
        state,
        targetRunId: state === 'queued' ? null : runId,
        revision: input.revision + 1,
        updatedAt: stamp(),
      });
    }
  }
}
