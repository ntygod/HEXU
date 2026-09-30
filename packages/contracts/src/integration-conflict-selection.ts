import { DomainError, enumValue } from './index.js';
import { exact } from './nodes.js';
import { integrationPaths, INTEGRATION_LIMITS } from './integrations.js';

export interface IntegrationConflictChoice {
  path: string;
  choice: 'take_source' | 'keep_target';
}
/** Version 2 explicitly records choices. It cannot be mistaken for the old
 * nonempty source-only file list, and does not itself authorize any write. */
export interface IntegrationConflictSelection {
  version: 2;
  kind: 'explicit_conflict_choices';
  selectedPaths: string[];
  conflictChoices: IntegrationConflictChoice[];
}
const bytes = (s: string) => new TextEncoder().encode(s);
export function compareIntegrationPath(a: string, b: string) {
  const x = bytes(a),
    y = bytes(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function parseIntegrationConflictSelection(value: unknown): IntegrationConflictSelection {
  const b = exact(value, ['version', 'kind', 'selectedPaths', 'conflictChoices']);
  if (
    b.version !== 2 ||
    b.kind !== 'explicit_conflict_choices' ||
    !Array.isArray(b.conflictChoices) ||
    !b.conflictChoices.length ||
    b.conflictChoices.length > INTEGRATION_LIMITS.files
  )
    throw new DomainError('INVALID_INPUT', '需明确记录1–80项整文件冲突选择；不能沿用旧文件许可');
  const selectedPaths = integrationPaths(b.selectedPaths, true).sort(compareIntegrationPath),
    conflictChoices = b.conflictChoices
      .map((value) => {
        const item = exact(value, ['path', 'choice']),
          path = integrationPaths([item.path], false)[0]!;
        return {
          path,
          choice: enumValue(item.choice, ['take_source', 'keep_target'] as const, '冲突选择'),
        };
      })
      .sort((a, b) => compareIntegrationPath(a.path, b.path));
  if (
    new Set(conflictChoices.map((c) => c.path)).size !== conflictChoices.length ||
    new Set([...selectedPaths, ...conflictChoices.map((c) => c.path)]).size >
      INTEGRATION_LIMITS.files ||
    [...selectedPaths, ...conflictChoices.map((c) => c.path)].some(
      (p) => new TextDecoder().decode(bytes(p)) !== p,
    )
  )
    throw new DomainError(
      'INVALID_INPUT',
      '冲突与实际选定文件合计最多80项，文件名必须完整且选择不可重复',
    );
  for (const choice of conflictChoices) {
    if (selectedPaths.includes(choice.path) !== (choice.choice === 'take_source'))
      throw new DomainError('INVALID_INPUT', '实际写入路径须包含采用来源项，且不得包含保留目标项');
  }
  const result: IntegrationConflictSelection = {
    version: 2,
    kind: 'explicit_conflict_choices',
    selectedPaths,
    conflictChoices,
  };
  if (bytes(JSON.stringify(result)).length > INTEGRATION_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '完整文件选择与冲突决策合计超过48 KiB');
  return result;
}
