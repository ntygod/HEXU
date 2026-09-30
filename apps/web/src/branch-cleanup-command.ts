import { parseBranchCleanupSelection } from '../../../packages/contracts/src/branch-cleanup-check.js';
import { quoteShellArgument } from './integration-trial-command.js';

export function branchCleanupCommand(input: unknown) {
  const s = parseBranchCleanupSelection(input);
  return `npm run runner:branch-cleanup-check -- --branch ${quoteShellArgument(s.branchId)} --revision ${s.expectedRevision} --task-revision ${s.expectedTaskRevision} --retention ${quoteShellArgument(s.retentionId)} --state ${quoteShellArgument('<原方案节点状态目录>')}`;
}
