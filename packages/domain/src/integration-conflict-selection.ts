import { DomainError } from '../../contracts/src/index.js';
import type { IntegrationPlan, IntegrationFile } from '../../contracts/src/integrations.js';
import {
  parseIntegrationConflictSelection,
  type IntegrationConflictSelection,
} from '../../contracts/src/integration-conflict-selection.js';
export interface EffectiveIntegrationChange {
  path: string;
  action: 'add' | 'modify' | 'delete';
  before: IntegrationFile['target'];
  after: IntegrationFile['source'];
  decision: 'selected_source' | 'explicit_take_source';
}
/** Rules over an already recomputed complete report. This does not validate
 * objects, create material or authorize writes; the trial planner verifies the
 * original three snapshots and the final union before returning actual bytes. */
export function evaluateIntegrationConflictSelection(
  plan: IntegrationPlan,
  input: IntegrationConflictSelection,
) {
  const selection = parseIntegrationConflictSelection(input);
  const unsupported = () =>
    new DomainError(
      'INTEGRATION_CONFLICT_SELECTION_INVALID',
      '只能明确选择both_changed整文件来源/目标；路径结构冲突仍未处理',
    );
  if (plan.omittedFiles || plan.changedFiles !== plan.files.length) throw unsupported();
  const files = new Map(plan.files.map((f) => [f.path, f])),
    choices = new Map(selection.conflictChoices.map((c) => [c.path, c.choice]));
  if (files.size !== plan.files.length) throw unsupported();
  for (const choice of selection.conflictChoices) {
    const file = files.get(choice.path);
    if (!file || file.action !== 'conflict' || file.conflict !== 'both_changed')
      throw unsupported();
  }
  const changes: EffectiveIntegrationChange[] = selection.selectedPaths.map((path) => {
    const file = files.get(path);
    if (!file) throw unsupported();
    const explicit = choices.get(path) === 'take_source';
    if (
      file.conflict
        ? file.conflict !== 'both_changed' || file.action !== 'conflict' || !explicit
        : !['add', 'modify', 'delete'].includes(file.action) || choices.has(path)
    )
      throw unsupported();
    if (!file.source && !file.target) throw unsupported();
    if (
      file.source &&
      file.target &&
      file.source.objectId === file.target.objectId &&
      file.source.mode === file.target.mode
    )
      throw unsupported();
    return {
      path,
      action: !file.source ? 'delete' : !file.target ? 'add' : 'modify',
      before: file.target && { ...file.target },
      after: file.source && { ...file.source },
      decision: explicit ? 'explicit_take_source' : 'selected_source',
    };
  });
  return {
    selection,
    changes,
    keptTargetPaths: selection.conflictChoices
      .filter((c) => c.choice === 'keep_target')
      .map((c) => c.path),
    unresolvedConflicts: plan.files
      .filter((f) => f.conflict === 'both_changed' && !choices.has(f.path))
      .map((f) => f.path),
    unsupportedConflicts: plan.files
      .filter((f) => f.conflict === 'path_collision')
      .map((f) => f.path),
    writeAuthorized: false as const,
  };
}
