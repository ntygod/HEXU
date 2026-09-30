import { DomainError, text, type Run } from '../../contracts/src/index.js';
import type { WorkBranch } from '../../contracts/src/work-branches.js';
import {
  branchContext,
  type BranchContinuationBinding,
  type BranchContinuationPreview,
  type BranchExecutionBinding,
  type parseBranchRunSelection,
} from '../../contracts/src/work-branch-workspaces.js';
import { assertRevision, canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { WorkBranchStore } from './work-branches.js';
import { ResultRevisions } from './result-revisions.js';
import { CheckpointStore } from './checkpoints.js';
import type { Store } from './store.js';
import { NextInputs } from './next-inputs.js';

type Selection = NonNullable<ReturnType<typeof parseBranchRunSelection>['continueFrom']>;
export class BranchContinuations {
  constructor(readonly store: Store) {}
  resolve(taskId: string, branch: WorkBranch, selected: Selection, allowReceipt = false) {
    const task = this.store.getTask(taskId, true),
      branches = new WorkBranchStore(this.store);
    const group = branches.group(taskId, branch.groupId);
    if (!branch.resultId)
      throw new DomainError('BRANCH_RESULT_REQUIRED', '请先保存并选择带固定代码引用的成果', 409);
    const version = new ResultRevisions(this.store).get(branch.resultId, selected.resultRevisionId),
      source = version.source;
    if (
      source.kind !== 'work_branch' ||
      source.branchId !== branch.id ||
      source.groupId !== group.id ||
      source.code === 'not_captured'
    )
      throw new DomainError(
        'BRANCH_CODE_REQUIRED',
        '此方案接续需要本组所选成果的固定提交引用',
        409,
      );
    const code = source.code,
      cp = new CheckpointStore(this.store);
    const run = this.store.run(selected.sourceRunId),
      node = cp.nodes.ownedExecutionNode(source.run.nodeId);
    if (
      run.taskId !== taskId ||
      run.provider !== 'node' ||
      run.purpose ||
      run.node?.nodeId !== node.id ||
      run.node.workingCopyId !== branch.workingCopyId ||
      run.node.workBranch?.branchId !== branch.id ||
      run.node.workBranch.groupId !== group.id ||
      source.run.workingCopyId !== branch.workingCopyId ||
      task.projectId !== node.project_id ||
      task.spaceId !== node.space_id ||
      code.checkpoint.request.nodeId !== node.id ||
      code.checkpoint.request.workspaceId !== branch.workingCopyId ||
      code.checkpoint.request.nodeRevision !== node.revision ||
      code.checkpoint.request.requestedBy.id !== node.owner_id ||
      canonicalJson(cp.get(taskId, code.checkpoint.id)) !== canonicalJson(code.checkpoint)
    )
      throw new DomainError(
        'BRANCH_CONTINUATION_SCOPE_CHANGED',
        '方案、来源执行、代码引用或本人目录授权不一致',
        409,
      );
    if (!allowReceipt) {
      const choice = branches.selection(taskId, group.id);
      if (choice?.branchId !== branch.id || choice.resultRevisionId !== version.id)
        throw new DomainError(
          'BRANCH_SELECTION_CHANGED',
          '当前所选方案或成果版本已变化，请重新核对',
          409,
        );
      assertRevision(choice.revision, selected.expectedSelectionRevision);
      assertRevision(run.revision, selected.expectedRunRevision);
      if (branch.runId !== run.id)
        throw new DomainError(
          'BRANCH_SOURCE_CHANGED',
          '本方案已有更新执行，不能重复使用旧接续基线',
          409,
        );
      if (
        isActiveRun(run.state) ||
        run.observation !== 'fresh' ||
        !run.node.terminationConfirmed ||
        run.node.phase !== 'terminal' ||
        this.store.db
          .prepare('SELECT stage FROM node_dispatches WHERE id=?')
          .get(run.node.dispatchId)?.stage !== 'terminal'
      )
        throw new DomainError(
          'BRANCH_SOURCE_ACTIVE',
          '先等待本方案原执行确认结束，未知现场不能继续',
          409,
        );
    }
    const binding: BranchContinuationBinding = {
      ...(selected.inputs === undefined ? {} : { inputs: selected.inputs }),
      sourceRunId: run.id,
      sourceRunRevision: run.revision,
      resultRevisionId: version.id,
      selectionRevision: selected.expectedSelectionRevision,
      code: {
        objectFormat: code.checkpoint.manifest.objectFormat,
        commit: code.checkpoint.manifest.commit,
        tree: code.checkpoint.manifest.tree,
        repositoryIdentity: code.checkpoint.manifest.repositoryIdentity,
        nodeRevision: node.revision,
      },
    };
    const contextText = text(
      `${branchContext(group.start.taskTitle, group.start.taskDescription, group.start.checkpoint.manifest.commit, branch.name, branch.goal)}\n\n# 明确选用的成果 v${version.revision}\n${version.title}\n${version.body}\n\n# 已知限制\n${version.limitations || '未填写；不代表没有限制'}\n\n# 本次代码起点\n${binding.code.commit}\n成果原来源Run：${source.run.id}（${source.run.state}）；接续前一轮Run：${run.id}（${run.state}）。\n只带入上述固定材料与本次要求，不自动采用其他方案、后来输出、讨论或反馈。`,
      '所选方案材料',
      19000,
    );
    if (selected.inputs !== undefined)
      new NextInputs(this.store).branchSelected(
        taskId,
        branch,
        version.id,
        selected.inputs,
        allowReceipt,
      );
    return { binding, contextText, version, sourceRun: run };
  }
  preview(taskId: string, branchId: string): BranchContinuationPreview {
    const branches = new WorkBranchStore(this.store),
      b = branches.branch(taskId, branchId),
      group = branches.group(taskId, b.groupId);
    const choice = branches.selection(taskId, group.id);
    if (!b.runId || choice?.branchId !== b.id || !choice.resultRevisionId)
      throw new DomainError('BRANCH_SELECTION_REQUIRED', '请先明确选择本方案的固定成果版本', 409);
    const run = this.store.run(b.runId);
    const selection = {
      branchId,
      expectedRevision: b.revision,
      startHash: group.startHash,
      continueFrom: {
        sourceRunId: run.id,
        expectedRunRevision: run.revision,
        resultRevisionId: choice.resultRevisionId,
        expectedSelectionRevision: choice.revision,
      },
    };
    const value = this.resolve(taskId, b, selection.continueFrom);
    return {
      selection,
      nodeId: run.node!.nodeId,
      workingCopyId: b.workingCopyId!,
      resultTitle: value.version.title,
      resultRevision: value.version.revision,
      commit: value.binding.code.commit,
      contextText: value.contextText,
      inputOptions: new NextInputs(this.store).branchOptions(taskId, b, value.version.id),
    };
  }
  /** Internal permit barrier; bearer ownership is checked by NodeExecution. Selection
   * changes invalidate only unpermitted dispatches, never an already started Run. */
  current(taskId: string, binding: BranchExecutionBinding, pendingRunId: string) {
    const from = binding.continueFrom;
    if (!from) return true;
    const branchRow = this.store.db
      .prepare('SELECT body FROM work_branches WHERE task_id=? AND id=?')
      .get(taskId, binding.branchId) as { body: string } | undefined;
    const choiceRow = this.store.db
      .prepare(
        'SELECT body FROM work_branch_choices WHERE group_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(binding.groupId) as { body: string } | undefined;
    const runRow = this.store.db
      .prepare('SELECT body FROM runs WHERE task_id=? AND id=?')
      .get(taskId, from.sourceRunId) as { body: string } | undefined;
    if (!branchRow || !choiceRow || !runRow) return false;
    const branch = JSON.parse(branchRow.body) as WorkBranch,
      choice = JSON.parse(choiceRow.body),
      run = JSON.parse(runRow.body) as Run;
    return (
      (!from.inputs ||
        new NextInputs(this.store).attachedCurrent(taskId, pendingRunId, from.inputs)) &&
      branch.runId === pendingRunId &&
      choice.revision === from.selectionRevision &&
      choice.branchId === binding.branchId &&
      choice.resultRevisionId === from.resultRevisionId &&
      run.revision === from.sourceRunRevision &&
      !isActiveRun(run.state) &&
      run.observation === 'fresh' &&
      !!run.node?.terminationConfirmed &&
      this.store.db.prepare('SELECT stage FROM node_dispatches WHERE id=?').get(run.node.dispatchId)
        ?.stage === 'terminal' &&
      this.store.db.prepare('SELECT revision FROM runner_nodes WHERE id=?').get(run.node.nodeId)
        ?.revision === from.code.nodeRevision
    );
  }
}
