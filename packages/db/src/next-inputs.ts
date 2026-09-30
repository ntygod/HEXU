import { randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type {
  NextInput,
  NextInputRef,
  NodeContinuationSelection,
} from '../../contracts/src/next-input.js';
import type { ResultFeedbackInputOrigin } from '../../contracts/src/result-feedback-inputs.js';
import type { WorkBranch } from '../../contracts/src/work-branches.js';
import { ResultRevisions } from './result-revisions.js';
import { feedbackInputSourceRun } from './result-feedback-inputs.js';
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
  get(id: string) {
    const input = this.read(id);
    this.store.getTask(input.taskId);
    return input;
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
      return this.insertQueued(source.taskId, sourceRunId, body);
    });
    return this.read(result.id);
  }
  /** Caller owns the transaction, receipt and source validation. Reuses the one queue. */
  insertQueued(
    taskId: string,
    sourceRunId: string,
    body: string,
    origin?: ResultFeedbackInputOrigin,
  ) {
    this.store.getTask(taskId, true);
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_next_inputs WHERE task_id=? AND state IN ('queued','attached')",
      )
      .get(taskId)!.n as number;
    if (count >= 20)
      throw new DomainError('INPUT_QUEUE_FULL', '最多保留 20 条待使用要求，请先处理或撤回');
    const now = stamp();
    return this.write({
      id: randomUUID(),
      taskId,
      sourceRunId,
      body,
      authorId: this.store.actorId,
      authorName: this.store.actorName(),
      revision: 1,
      state: 'queued',
      targetRunId: null,
      createdAt: now,
      updatedAt: now,
      ...(origin ? { origin } : {}),
    });
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
      () => {
        const current = this.read(id);
        this.store.getTask(current.taskId, true);
        if (current.authorId !== this.store.actorId)
          throw new DomainError('INPUT_AUTHOR_REQUIRED', '只能修改或撤回自己保存的要求', 403);
      },
    );
    return this.read(result.id);
  }
  private selectedQueued(taskId: string, refs: NextInputRef[]) {
    this.store.getTask(taskId, true);
    return refs.map((ref) => {
      const input = this.read(ref.id);
      if (input.taskId !== taskId)
        throw new DomainError('INVALID_CONTINUATION', '所选要求不属于当前任务', 409);
      assertRevision(input.revision, ref.revision);
      if (input.state !== 'queued')
        throw new DomainError('INPUT_BOUND', '所选要求已使用或撤回，请重新选择', 409);
      return input;
    });
  }
  selected(taskId: string, selection: Pick<NodeContinuationSelection, 'inputs'>) {
    const inputs = this.selectedQueued(taskId, selection.inputs);
    for (const input of inputs) {
      if (input.origin)
        throw new DomainError(
          'BRANCH_INPUT_SCOPE_CHANGED',
          '方案要求只能在对应方案的所选固定版本中明确选用',
          409,
        );
    }
    return inputs;
  }
  /** Inside NodeExecution.create's existing transaction, never start another transaction here. */
  attach(taskId: string, selection: Pick<NodeContinuationSelection, 'inputs'>, runId: string) {
    this.attachInputs(this.selected(taskId, selection), runId);
  }
  private attachInputs(inputs: NextInput[], runId: string) {
    for (const input of inputs)
      this.write({
        ...input,
        state: 'attached',
        targetRunId: runId,
        revision: input.revision + 1,
        updatedAt: stamp(),
      });
  }
  private branchScope(
    input: NextInput,
    taskId: string,
    branch: WorkBranch,
    resultRevisionId: string,
  ) {
    if (input.taskId !== taskId) return false;
    const source = this.store.run(input.sourceRunId);
    if (
      source.taskId !== taskId ||
      source.provider !== 'node' ||
      source.purpose ||
      source.node?.workBranch?.branchId !== branch.id ||
      source.node.workBranch.groupId !== branch.groupId ||
      source.node.workingCopyId !== branch.workingCopyId
    )
      return false;
    const version = new ResultRevisions(this.store).get(branch.resultId!, resultRevisionId);
    if (version.source.kind !== 'work_branch' || version.source.run.nodeId !== source.node.nodeId)
      return false;
    const origin = input.origin;
    if (!origin) return true;
    if (
      origin.kind !== 'result_feedback' ||
      origin.version !== 1 ||
      origin.branchId !== branch.id ||
      origin.groupId !== branch.groupId ||
      origin.sourceRunId !== source.id ||
      origin.resultId !== branch.resultId ||
      origin.resultRevisionId !== resultRevisionId
    )
      return false;
    return (
      version.taskId === taskId &&
      version.revision === origin.resultRevision &&
      feedbackInputSourceRun(this.store, version)?.id === source.id
    );
  }
  branchOptions(taskId: string, branch: WorkBranch, resultRevisionId: string) {
    return this.list(taskId).filter((input) => {
      try {
        return this.branchScope(input, taskId, branch, resultRevisionId);
      } catch {
        return false;
      }
    });
  }
  branchSelected(
    taskId: string,
    branch: WorkBranch,
    resultRevisionId: string,
    refs: NextInputRef[],
    allowReceipt = false,
  ) {
    this.store.getTask(taskId, true);
    const inputs = allowReceipt
      ? refs.map((ref) => this.read(ref.id))
      : this.selectedQueued(taskId, refs);
    for (const input of inputs) {
      if (!this.branchScope(input, taskId, branch, resultRevisionId))
        throw new DomainError(
          'BRANCH_INPUT_SCOPE_CHANGED',
          '所选要求不属于此方案及固定成果版本',
          409,
        );
    }
    return inputs;
  }
  attachBranch(
    taskId: string,
    branch: WorkBranch,
    resultRevisionId: string,
    refs: NextInputRef[],
    runId: string,
  ) {
    this.attachInputs(this.branchSelected(taskId, branch, resultRevisionId, refs), runId);
  }
  /** Internal permit barrier; queue edits cannot mutate an attached input. */
  attachedCurrent(taskId: string, runId: string, refs: NextInputRef[]) {
    return refs.every((ref) => {
      const row = this.store.db
        .prepare('SELECT body FROM task_next_inputs WHERE id=? AND task_id=? AND target_run_id=?')
        .get(ref.id, taskId, runId) as Row | undefined;
      if (!row) return false;
      const input = JSON.parse(row.body) as NextInput;
      return (
        input.taskId === taskId &&
        input.targetRunId === runId &&
        input.state === 'attached' &&
        input.revision === ref.revision + 1
      );
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
