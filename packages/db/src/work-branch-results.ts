import { randomUUID } from 'node:crypto';
import { DomainError, type Result } from '../../contracts/src/index.js';
import {
  parseBranchResult,
  RESULT_OUTPUT_LIMIT,
  type BranchResultPreview,
  type BranchResultSource,
} from '../../contracts/src/results.js';
import type { DispatchCommand, ExecutionEvent } from '../../contracts/src/node-execution.js';
import type { WorkBranch } from '../../contracts/src/work-branches.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';
import { WorkBranchStore } from './work-branches.js';
import { ResultRevisions } from './result-revisions.js';
import { ResultCodeStore } from './result-code.js';

export class WorkBranchResults {
  readonly branches: WorkBranchStore;
  readonly revisions: ResultRevisions;
  constructor(readonly store: Store) {
    this.branches = new WorkBranchStore(store);
    this.revisions = new ResultRevisions(store);
  }
  private source(taskId: string, b: WorkBranch): BranchResultSource {
    if (!b.runId || b.state === 'discarded')
      throw new DomainError('BRANCH_RESULT_UNAVAILABLE', '方案尚无可固定的来源执行', 409);
    const r = this.store.run(b.runId),
      n = r.node;
    if (
      !['succeeded', 'failed', 'cancelled'].includes(r.state) ||
      r.observation !== 'fresh' ||
      !n?.terminationConfirmed ||
      n.phase !== 'terminal'
    )
      throw new DomainError(
        'BRANCH_RESULT_NOT_TERMINAL',
        '先等待执行终止确认，未知现场不能固定为成果',
        409,
      );
    const group = this.branches.group(taskId, b.groupId);
    const d = this.store.db
      .prepare('SELECT * FROM node_dispatches WHERE id=?')
      .get(n.dispatchId) as
      | {
          task_id: string;
          run_id: string;
          node_id: string;
          workspace_id: string;
          stage: string;
          command: string;
          terminal_sequence: number | null;
        }
      | undefined;
    const command = d ? (JSON.parse(d.command) as DispatchCommand) : null;
    const binding = n.workBranch;
    const workspace =
      binding &&
      (this.store.db
        .prepare(
          "SELECT node_id,workspace_id FROM work_branch_workspaces WHERE id=? AND task_id=? AND branch_id=? AND state='bound'",
        )
        .get(binding.operationId, taskId, b.id) as
        | { node_id: string; workspace_id: string }
        | undefined);
    if (
      r.taskId !== taskId ||
      r.provider !== 'node' ||
      r.purpose ||
      !binding ||
      binding.branchId !== b.id ||
      binding.groupId !== b.groupId ||
      binding.startHash !== group.startHash ||
      binding.commit !== group.start.checkpoint.manifest.commit ||
      !workspace ||
      workspace.node_id !== n.nodeId ||
      workspace.workspace_id !== b.workingCopyId ||
      n.workingCopyId !== b.workingCopyId ||
      !d ||
      d.task_id !== taskId ||
      d.run_id !== r.id ||
      d.node_id !== n.nodeId ||
      d.workspace_id !== n.workingCopyId ||
      d.stage !== 'terminal' ||
      command?.runId !== r.id ||
      command.taskId !== taskId ||
      command.workspaceId !== n.workingCopyId ||
      command.workBranch?.branchId !== b.id ||
      command.workBranch.groupId !== b.groupId ||
      command.workBranch.startHash !== group.startHash ||
      command.workBranch.operationId !== binding.operationId ||
      canonicalJson(command.workBranch) !== canonicalJson(binding)
    )
      throw new DomainError('BRANCH_RESULT_SOURCE_MISMATCH', '来源执行、派发与方案现场不一致', 409);
    // Only already-shared evidence up to the actual settlement boundary. A late
    // terminal/output acknowledgement cannot become new result material.
    const events =
      d.terminal_sequence === null
        ? []
        : (
            this.store.db
              .prepare(
                'SELECT body FROM node_run_events WHERE dispatch_id=? AND sequence<=? ORDER BY sequence LIMIT 128',
              )
              .all(n.dispatchId, d.terminal_sequence) as { body: string }[]
          )
            .map((row) => JSON.parse(row.body) as ExecutionEvent & { shared?: boolean })
            .filter(
              (e) => e.shared !== false && (e.kind === 'output' || e.kind === 'terminal') && e.text,
            );
    // Put the final shared answer first so a long stream cannot hide its conclusion.
    const output = [
      ...events.filter((e) => e.kind === 'terminal'),
      ...events.filter((e) => e.kind === 'output'),
    ]
      .map((e) => e.text)
      .join('\n');
    let excerpt = output.slice(0, RESULT_OUTPUT_LIMIT);
    if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
    return {
      kind: 'work_branch',
      branchId: b.id,
      groupId: b.groupId,
      branchName: b.name,
      goal: b.goal,
      startHash: group.startHash,
      start: group.start,
      run: {
        id: r.id,
        revision: r.revision,
        state: r.state as BranchResultSource['run']['state'],
        tool: command.policy.tool,
        model: command.policy.model,
        mode: command.mode,
        nodeId: n.nodeId,
        workingCopyId: n.workingCopyId,
        dispatchId: n.dispatchId,
        startedAt: n.startedAt ?? null,
        finishedAt: r.updatedAt,
        context: command.context,
        ...(binding.continueFrom ? { continueFrom: binding.continueFrom } : {}),
      },
      output: {
        text: excerpt,
        truncated: excerpt.length < output.length,
        totalChars: output.length,
        throughSequence: d.terminal_sequence,
        availability: d.terminal_sequence === null ? 'legacy_unavailable' : 'captured',
      },
      code: 'not_captured',
    };
  }
  preview(taskId: string, branchId: string): BranchResultPreview {
    this.store.getTask(taskId, true);
    const b = this.branches.branch(taskId, branchId);
    const result = b.resultId ? this.store.result(b.resultId) : null;
    const previous = result ? this.revisions.current(result) : null;
    const source = this.source(taskId, b);
    return {
      branchRevision: b.revision,
      resultRevision: result?.revision ?? 0,
      source,
      codeOptions: new ResultCodeStore(this.store).options(taskId, source),
      previous: previous
        ? { title: previous.title, body: previous.body, limitations: previous.limitations }
        : null,
    };
  }
  save(taskId: string, branchId: string, input: unknown, key: string) {
    const task = this.store.getTask(taskId, true); // Authorize even a known old receipt.
    this.branches.branch(taskId, branchId);
    const data = parseBranchResult(input);
    // A code attachment adds an owner/node boundary, including on receipt replay.
    const codeStore = new ResultCodeStore(this.store);
    if (data.codeCheckpointId)
      codeStore.reference(
        taskId,
        this.source(taskId, this.branches.branch(taskId, branchId)),
        data.codeCheckpointId,
        data.codeRetentionId,
      );
    return this.store.mutate(`work_branch.result:${branchId}`, key, data, () => {
      const b = this.branches.branch(taskId, branchId);
      assertRevision(b.revision, data.expectedRevision);
      if (b.runId !== data.sourceRunId)
        throw new DomainError('BRANCH_RESULT_SOURCE_MISMATCH', '来源执行不属于此方案', 409);
      const source = this.source(taskId, b);
      if (data.codeCheckpointId)
        source.code = codeStore.reference(
          taskId,
          source,
          data.codeCheckpointId,
          data.codeRetentionId,
        );
      assertRevision(source.run.revision, data.expectedRunRevision);
      const old = b.resultId ? this.store.result(b.resultId) : null;
      assertRevision(old?.revision ?? 0, data.expectedResultRevision);
      if (old) {
        const previousSource = this.revisions.current(old).source;
        if (
          old.taskId !== taskId ||
          previousSource.kind !== 'work_branch' ||
          previousSource.branchId !== b.id ||
          previousSource.groupId !== b.groupId
        )
          throw new DomainError('BRANCH_RESULT_SOURCE_MISMATCH', '已有成果关联不一致', 409);
      }
      if ((old?.revision ?? 0) >= 100)
        throw new DomainError('RESULT_VERSION_LIMIT', '此方案已达100个固定版本', 409);
      const at = new Date().toISOString();
      const result: Result = {
        id: old?.id ?? randomUUID(),
        taskId,
        title: data.title,
        body: data.body,
        kind: 'text',
        revision: (old?.revision ?? 0) + 1,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
      };
      if (old)
        this.store.db
          .prepare('UPDATE results SET body=? WHERE id=?')
          .run(JSON.stringify(result), result.id);
      else
        this.store.db
          .prepare('INSERT INTO results VALUES(?,?,?)')
          .run(result.id, taskId, JSON.stringify(result));
      const version = this.revisions.append(result, source, data.limitations);
      this.branches.change(
        task,
        { ...b, state: 'ready', resultId: result.id, resultRevisionId: version.id },
        'result_saved',
      );
      this.store.db
        .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
        .run(taskId, old ? 'result.version_created' : 'result.created', at, task.spaceId);
      return { resultId: result.id, revisionId: version.id, revision: version.revision };
    });
  }
}
