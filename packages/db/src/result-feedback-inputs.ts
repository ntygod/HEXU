import { createHash } from 'node:crypto';
import { DomainError, type Message, type Run } from '../../contracts/src/index.js';
import {
  parseResultFeedbackInput,
  type ResultFeedbackInputOrigin,
  type ResultFeedbackInputPreview,
} from '../../contracts/src/result-feedback-inputs.js';
import type { ResultRevision } from '../../contracts/src/results.js';
import type { WorkBranch, WorkBranchGroup } from '../../contracts/src/work-branches.js';
import type { BranchWorkspaceOperation } from '../../contracts/src/work-branch-workspaces.js';
import type { DispatchCommand } from '../../contracts/src/node-execution.js';
import { ResultRevisions } from './result-revisions.js';
import { NextInputs } from './next-inputs.js';
import type { Store } from './store.js';

type Row = { body: string };
const unavailable = '此反馈没有可核对的独立节点方案来源，暂不能整理为下一轮要求';

/** Stored records only. Historical source evidence does not grant current node execution. */
export function feedbackInputSourceRun(store: Store, version: ResultRevision): Run | null {
  const source = version.source;
  if (source.kind !== 'work_branch') return null;
  const runRow = store.db
    .prepare('SELECT body FROM runs WHERE id=? AND task_id=?')
    .get(source.run.id, version.taskId) as Row | undefined;
  const branchRow = store.db
    .prepare('SELECT body FROM work_branches WHERE id=? AND task_id=?')
    .get(source.branchId, version.taskId) as Row | undefined;
  const groupRow = store.db
    .prepare('SELECT body FROM work_branch_groups WHERE id=? AND task_id=?')
    .get(source.groupId, version.taskId) as Row | undefined;
  const workspaceRow = store.db
    .prepare(
      "SELECT body FROM work_branch_workspaces WHERE branch_id=? AND task_id=? AND state='bound'",
    )
    .get(source.branchId, version.taskId) as Row | undefined;
  if (!runRow || !branchRow || !groupRow || !workspaceRow) return null;
  const run = JSON.parse(runRow.body) as Run,
    branch = JSON.parse(branchRow.body) as WorkBranch,
    group = JSON.parse(groupRow.body) as WorkBranchGroup,
    workspace = JSON.parse(workspaceRow.body) as BranchWorkspaceOperation;
  const dispatch = store.db
    .prepare('SELECT * FROM node_dispatches WHERE id=? AND run_id=? AND task_id=?')
    .get(source.run.dispatchId, run.id, version.taskId) as
    | {
        node_id: string;
        workspace_id: string;
        owner_id: string;
        space_id: string;
        command: string;
      }
    | undefined;
  const node = store.db
    .prepare('SELECT project_id,space_id,owner_id FROM runner_nodes WHERE id=?')
    .get(source.run.nodeId) as
    | { project_id: string; space_id: string; owner_id: string }
    | undefined;
  const task = store.getTask(version.taskId);
  const command = dispatch ? (JSON.parse(dispatch.command) as DispatchCommand) : undefined;
  if (
    run.id !== source.run.id ||
    run.taskId !== version.taskId ||
    run.provider !== 'node' ||
    run.purpose ||
    run.node?.nodeId !== source.run.nodeId ||
    run.node.workingCopyId !== source.run.workingCopyId ||
    run.node.dispatchId !== source.run.dispatchId ||
    run.node.workBranch?.branchId !== source.branchId ||
    run.node.workBranch.groupId !== source.groupId ||
    branch.id !== source.branchId ||
    branch.taskId !== version.taskId ||
    branch.groupId !== source.groupId ||
    branch.resultId !== version.resultId ||
    branch.workingCopyId !== source.run.workingCopyId ||
    group.id !== source.groupId ||
    group.taskId !== version.taskId ||
    group.startHash !== source.startHash ||
    workspace.ticket.branchId !== branch.id ||
    workspace.ticket.groupId !== group.id ||
    workspace.ticket.taskId !== version.taskId ||
    workspace.nodeId !== source.run.nodeId ||
    workspace.workingCopyId !== source.run.workingCopyId ||
    !dispatch ||
    !node ||
    dispatch.node_id !== source.run.nodeId ||
    dispatch.workspace_id !== source.run.workingCopyId ||
    dispatch.owner_id !== node.owner_id ||
    workspace.ticket.ownerId !== node.owner_id ||
    task.projectId !== node.project_id ||
    task.spaceId !== node.space_id ||
    dispatch.space_id !== task.spaceId ||
    command?.id !== source.run.dispatchId ||
    command.runId !== run.id ||
    command.taskId !== version.taskId ||
    command.projectId !== task.projectId ||
    command.workspaceId !== source.run.workingCopyId ||
    command.workBranch?.branchId !== branch.id ||
    command.workBranch.groupId !== group.id ||
    command.workBranch.operationId !== workspace.ticket.id ||
    run.node.workBranch.operationId !== workspace.ticket.id
  )
    return null;
  return run;
}

export class ResultFeedbackInputs {
  constructor(readonly store: Store) {}
  preview(resultId: string, revisionId: string, messageId: string): ResultFeedbackInputPreview {
    const result = this.store.result(resultId);
    this.store.getTask(result.taskId, true);
    const version = new ResultRevisions(this.store).get(resultId, revisionId);
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
      .get(messageId, result.taskId) as Row | undefined;
    const message = row ? (JSON.parse(row.body) as Message) : undefined;
    if (
      version.id !== revisionId ||
      version.resultId !== resultId ||
      version.taskId !== result.taskId ||
      !message ||
      message.id !== messageId ||
      message.taskId !== result.taskId ||
      message.resultId !== resultId ||
      message.resultRevisionId !== revisionId ||
      message.actorType !== 'human'
    )
      throw new DomainError('NOT_FOUND', '反馈不存在或不属于此固定版本', 404);
    const run = feedbackInputSourceRun(this.store, version);
    if (!run || version.source.kind !== 'work_branch')
      return { available: false, reason: unavailable };
    if (typeof message.body !== 'string' || message.body.length > 12000)
      return { available: false, reason: '原反馈超出可保存来源预算，请保留原反馈并另行整理要求' };
    const origin: ResultFeedbackInputOrigin = {
      version: 1,
      kind: 'result_feedback',
      resultId,
      resultRevisionId: revisionId,
      resultRevision: version.revision,
      messageId,
      branchId: version.source.branchId,
      branchName: version.source.branchName,
      groupId: version.source.groupId,
      sourceRunId: run.id,
      authorName: message.actorName,
      ...(typeof message.createdByUserId === 'string' && message.createdByUserId
        ? { authorId: message.createdByUserId }
        : {}),
      body: message.body,
      bodyHash: createHash('sha256').update(message.body).digest('hex'),
      ...(message.codeAnchor ? { codeAnchor: message.codeAnchor } : {}),
    };
    return { available: true, taskId: result.taskId, origin };
  }
  create(resultId: string, revisionId: string, messageId: string, value: unknown, key: string) {
    const input = parseResultFeedbackInput(value);
    const resolve = () => {
      const preview = this.preview(resultId, revisionId, messageId);
      if (!preview.available) throw new DomainError('CAPABILITY_UNAVAILABLE', preview.reason, 422);
      return preview;
    };
    let source = resolve();
    const result = this.store.mutate(
      `result.feedback-input:${revisionId}:${messageId}`,
      key,
      input,
      () =>
        new NextInputs(this.store).insertQueued(
          source.taskId,
          source.origin.sourceRunId,
          input.body,
          source.origin,
        ),
      () => {
        source = resolve();
      },
    );
    // Preserve the original receipt but report this queue entry's current state/body.
    return new NextInputs(this.store).get(result.id);
  }
}
