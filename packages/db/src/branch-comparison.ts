import { DomainError } from '../../contracts/src/index.js';
import {
  parseBranchChoice,
  type BranchChoice,
  type BranchComparison,
} from '../../contracts/src/branch-comparison.js';
import { assertRevision } from '../../domain/src/index.js';
import type { Store } from './store.js';
import { WorkBranchStore } from './work-branches.js';
import { ResultRevisions } from './result-revisions.js';

export class BranchComparisons {
  private readonly branches: WorkBranchStore;
  private readonly versions: ResultRevisions;
  constructor(readonly store: Store) {
    this.branches = new WorkBranchStore(store);
    this.versions = new ResultRevisions(store);
  }
  get(taskId: string, groupId: string): BranchComparison {
    const work = this.branches.get(taskId, groupId);
    return {
      work,
      versions: Object.fromEntries(
        work.branches.map((b) => [b.id, b.resultId ? this.versions.list(b.resultId) : []]),
      ),
      choices: (
        this.store.db
          .prepare(
            'SELECT body FROM work_branch_choices WHERE group_id=? ORDER BY revision DESC LIMIT 100',
          )
          .all(groupId) as { body: string }[]
      ).map((row) => JSON.parse(row.body) as BranchChoice),
    };
  }
  choose(taskId: string, groupId: string, input: unknown, key: string): BranchChoice {
    const task = this.store.getTask(taskId, true);
    this.branches.group(taskId, groupId);
    const data = parseBranchChoice(input);
    return this.store.mutate(`work_branch.choose:${groupId}`, key, data, () => {
      const previous = this.branches.selection(taskId, groupId);
      assertRevision(previous?.revision ?? 0, data.expectedSelectionRevision);
      if ((previous?.revision ?? 0) >= 100)
        throw new DomainError('BRANCH_CHOICE_LIMIT', '此方案组已达100次选择记录', 409);
      const branch = data.branchId ? this.branches.branch(taskId, data.branchId) : null;
      if (
        branch &&
        (branch.groupId !== groupId ||
          !['ready', 'active'].includes(branch.state) ||
          !branch.resultId)
      )
        throw new DomainError('BRANCH_CHOICE_UNAVAILABLE', '只能选择本组已保存成果的方案', 409);
      const version = branch?.resultId
        ? this.versions.get(branch.resultId, data.resultRevisionId!)
        : null;
      if (
        version &&
        (version.source.kind !== 'work_branch' ||
          version.source.branchId !== branch?.id ||
          version.source.groupId !== groupId)
      )
        throw new DomainError('BRANCH_CHOICE_SOURCE_MISMATCH', '固定成果版本不属于本方案组', 409);
      if (!branch && !previous?.branchId)
        throw new DomainError('BRANCH_CHOICE_EMPTY', '尚无选择需要取消', 409);
      const choice: BranchChoice = {
        groupId,
        revision: (previous?.revision ?? 0) + 1,
        branchId: branch?.id ?? null,
        branchName: branch?.name ?? null,
        resultId: version?.resultId ?? null,
        resultRevisionId: version?.id ?? null,
        resultRevision: version?.revision ?? null,
        title: version?.title ?? null,
        note: data.note,
        actor: { id: this.store.actorId, name: this.store.actorName() },
        createdAt: new Date().toISOString(),
      };
      this.store.db
        .prepare(
          'INSERT INTO work_branch_choices(group_id,revision,branch_id,result_revision_id,body) VALUES(?,?,?,?,?)',
        )
        .run(
          groupId,
          choice.revision,
          choice.branchId,
          choice.resultRevisionId,
          JSON.stringify(choice),
        );
      if (previous?.branchId && previous.branchId !== branch?.id)
        this.branches.change(
          task,
          this.branches.branch(taskId, previous.branchId),
          'selection_cleared',
        );
      if (branch) this.branches.change(task, branch, 'result_selected');
      // Selection has no execution, task-completion, filesystem or merge side effects.
      return choice;
    });
  }
}
