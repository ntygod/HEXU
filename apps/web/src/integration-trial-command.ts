import {
  parseIntegrationConflictSelection,
  type IntegrationConflictChoice,
} from '../../../packages/contracts/src/integration-conflict-selection.js';

/** Keep every argument literal, including JSON, apostrophes and placeholder brackets. */
export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function sortTrialPaths(paths: readonly string[]): string[] {
  const encoder = new TextEncoder();
  return [...paths].sort((a, b) => {
    const left = encoder.encode(a),
      right = encoder.encode(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const difference = left[index]! - right[index]!;
      if (difference) return difference;
    }
    return left.length - right.length;
  });
}

export function integrationTrialCommand(
  operationId: string,
  paths: readonly string[],
  conflictChoices: readonly IntegrationConflictChoice[] = [],
): string {
  const selection = conflictChoices.length
    ? parseIntegrationConflictSelection({
        version: 2,
        kind: 'explicit_conflict_choices',
        selectedPaths: sortTrialPaths([
          ...new Set([
            ...paths,
            ...conflictChoices
              .filter((item) => item.choice === 'take_source')
              .map((item) => item.path),
          ]),
        ]),
        conflictChoices,
      })
    : null;
  const argument = selection
    ? `--selection ${quoteShellArgument(JSON.stringify(selection))}`
    : `--files ${quoteShellArgument(JSON.stringify(sortTrialPaths(paths)))}`;
  return `npm run runner:integration-trial -- --operation ${quoteShellArgument(operationId)} --state ${quoteShellArgument('<原节点状态目录>')} --target ${quoteShellArgument('<新的绝对目录>')} ${argument}`;
}

export function integrationTrialDifferenceCommand(operationId: string): string {
  return `npm run runner:integration-trial-diff -- --operation ${quoteShellArgument(operationId)} --state ${quoteShellArgument('<原节点状态目录>')} --trial ${quoteShellArgument('<本机 ready 候选的 trialId>')}`;
}

export function integrationCandidateApplicationCommand(operationId: string): string {
  return `npm run runner:integration-apply -- --operation ${quoteShellArgument(operationId)} --state ${quoteShellArgument('<原节点状态目录>')} --backup ${quoteShellArgument('<全新私有备份绝对目录>')}`;
}
