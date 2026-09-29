import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { DispatchCommand, ExecutionEvent } from '../../contracts/src/node-execution.js';
import type { BranchWorkspaceOperation } from '../../contracts/src/work-branch-workspaces.js';
import type { WorkBranchResultSource } from '../../contracts/src/work-branch-result-source.js';
import { canonicalJson } from '../../domain/src/index.js';
import { boundedBranchOutput } from '../../domain/src/work-branch-result-source.js';
import { WorkBranchStore } from './work-branches.js';
import type { Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
type DispatchRow = {
  id: string;
  run_id: string;
  task_id: string;
  node_id: string;
  workspace_id: string;
  stage: string;
  command: string;
  last_sequence: number;
};
const mismatch = () =>
  new DomainError('WORK_BRANCH_RESULT_SOURCE_MISMATCH', '方案执行、现场或共同起点不一致', 409);

/** Reads only previously shared records. Never reads a live directory or starts a tool. */
export class WorkBranchResultSourceStore {
  constructor(readonly store: Store) {}

  get(taskId: string, branchId: string): WorkBranchResultSource {
    // One consistent SQLite snapshot, including current task permission. No business writes.
    return this.store.atomic(() => this.snapshot(taskId, branchId));
  }

  private snapshot(taskId: string, branchId: string): WorkBranchResultSource {
    const branches = new WorkBranchStore(this.store);
    const branch = branches.branch(taskId, branchId);
    const group = branches.group(taskId, branch.groupId);
    if (!branch.runId)
      throw new DomainError('WORK_BRANCH_RESULT_NO_RUN', '此方案尚未关联执行', 409);
    const run = this.store.run(branch.runId);
    const node = run.node;
    const binding = node?.workBranch;
    if (
      run.taskId !== taskId ||
      run.provider !== 'node' ||
      run.purpose === 'assist' ||
      !node ||
      !binding ||
      binding.branchId !== branch.id ||
      binding.groupId !== group.id ||
      binding.startHash !== group.startHash ||
      hash(group.start) !== group.startHash ||
      binding.commit !== group.start.checkpoint.manifest.commit ||
      branch.workingCopyId !== node.workingCopyId
    )
      throw mismatch();
    const state = run.state;
    if (
      (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') ||
      run.observation !== 'fresh' ||
      node.phase !== 'terminal' ||
      !node.terminationConfirmed
    )
      throw new DomainError(
        'WORK_BRANCH_RESULT_NOT_SETTLED',
        '执行仍活动或进程终止尚未确认，不能固定成果来源',
        409,
      );
    const dispatch = this.store.db
      .prepare('SELECT * FROM node_dispatches WHERE id=?')
      .get(node.dispatchId) as DispatchRow | undefined;
    const workspaceRow = this.store.db
      .prepare('SELECT body FROM work_branch_workspaces WHERE id=? AND branch_id=? AND task_id=?')
      .get(binding.operationId, branch.id, taskId) as { body: string } | undefined;
    const workspace = workspaceRow
      ? (JSON.parse(workspaceRow.body) as BranchWorkspaceOperation)
      : null;
    if (
      !dispatch ||
      dispatch.run_id !== run.id ||
      dispatch.task_id !== taskId ||
      dispatch.node_id !== node.nodeId ||
      dispatch.workspace_id !== node.workingCopyId ||
      dispatch.stage !== 'terminal' ||
      !workspace ||
      workspace.state !== 'bound' ||
      workspace.nodeId !== node.nodeId ||
      workspace.workingCopyId !== node.workingCopyId ||
      workspace.ticket.id !== binding.operationId ||
      workspace.ticket.taskId !== taskId ||
      workspace.ticket.projectId !== group.projectId ||
      workspace.ticket.spaceId !== group.spaceId ||
      workspace.ticket.branchId !== branch.id ||
      workspace.ticket.groupId !== group.id ||
      workspace.ticket.startHash !== group.startHash ||
      workspace.ticket.checkpointId !== group.start.checkpoint.id ||
      workspace.ticket.manifest.commit !== binding.commit ||
      workspace.proof?.originHash !== binding.originHash
    )
      throw mismatch();
    const command = JSON.parse(dispatch.command) as DispatchCommand;
    if (
      command.id !== dispatch.id ||
      command.runId !== run.id ||
      command.taskId !== taskId ||
      command.projectId !== group.projectId ||
      command.workspaceId !== node.workingCopyId ||
      command.purpose === 'assist' ||
      command.policy.tool !== run.requestedTool ||
      command.policy.model !== node.model ||
      canonicalJson(command.workBranch ?? null) !== canonicalJson(binding)
    )
      throw mismatch();
    const rows = this.store.db
      .prepare('SELECT sequence,body FROM node_run_events WHERE dispatch_id=? ORDER BY sequence')
      .all(dispatch.id) as { sequence: number; body: string }[];
    if (
      !Number.isSafeInteger(dispatch.last_sequence) ||
      dispatch.last_sequence < 0 ||
      dispatch.last_sequence > 128 ||
      rows.length !== dispatch.last_sequence
    )
      throw mismatch();
    const events = rows.map((row, index) => {
      const event = JSON.parse(row.body) as ExecutionEvent;
      if (row.sequence !== index + 1 || event.sequence !== row.sequence) throw mismatch();
      return event;
    });
    // The node protocol drains late events after settlement. They cannot extend this run's output.
    const terminalIndex = events.findIndex((e) => e.kind === 'terminal');
    const terminal = terminalIndex < 0 ? null : events[terminalIndex]!;
    if (terminal && (!terminal.terminationConfirmed || !terminal.result)) throw mismatch();
    if (!terminal && (node.startedAt || events.some((e) => e.kind === 'output'))) throw mismatch();
    if (state === 'succeeded' && (!node.startedAt || terminal?.result !== 'succeeded'))
      throw mismatch();
    const included = terminalIndex < 0 ? events : events.slice(0, terminalIndex + 1);
    const output = included
      .filter((e) => e.kind === 'output')
      .map((e) => ({ sequence: e.sequence, text: e.text }));
    const bounded = boundedBranchOutput(output.map((e) => e.text));
    const unsigned: Omit<WorkBranchResultSource, 'sourceHash'> = {
      schemaVersion: 1,
      taskId,
      branchId,
      branchRevision: branch.revision,
      groupId: group.id,
      start: group.start,
      startHash: group.startHash,
      binding,
      run: {
        id: run.id,
        revision: run.revision,
        state,
        tool: run.requestedTool,
        model: node.model,
        nodeId: node.nodeId,
        workingCopyId: node.workingCopyId,
        startedAt: node.startedAt ?? null,
        updatedAt: run.updatedAt,
      },
      input: { context: command.context, prompt: run.prompt },
      output: { ...bounded, eventCount: output.length, digest: hash(output) },
      evidence: {
        receivedThroughSequence: dispatch.last_sequence,
        includedThroughSequence: included.at(-1)?.sequence ?? 0,
        ignoredAfterTerminal: events.length - included.length,
        terminal: terminal
          ? { sequence: terminal.sequence, result: terminal.result!, text: terminal.text }
          : null,
        toolReportedSuccess: state === 'succeeded' && terminal?.result === 'succeeded',
      },
      code: { status: 'not_captured' },
      limitations: [
        '这是来源预览，不是已保存的不可变成果版本，也不改变方案或任务状态。',
        '只读取服务已接收的共享输出，不保证包含工具的全部输出。',
        '共同提交只是输入起点；本轮代码尚未固定，不读取活动目录或示例预览。',
        ...(bounded.truncated ? ['输出超过24 KiB，仅展示UTF-8完整前缀；摘要覆盖全部共享输出。'] : []),
        ...(state === 'succeeded' ? [] : ['执行未成功；已有内容可供查看，不代表工具成功。']),
      ],
    };
    return { ...unsigned, sourceHash: hash(unsigned) };
  }
}
