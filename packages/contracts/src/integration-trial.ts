import { DomainError } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import { retentionDate } from './checkpoint-retention.js';
import { INTEGRATION_LIMITS } from './integrations.js';
import { parseCodeDifferenceSummary, type CodeDifferenceSummary } from './result-code.js';

export type { CodeDifferenceSummary } from './result-code.js';
export const INTEGRATION_TRIAL_DIFFERENCE_LIMITS = {
  reports: 100,
  reportBytes: 48 * 1024,
  differenceBytes: 24 * 1024,
  files: 40,
  textBytes: 8192,
} as const;
export interface IntegrationTrialDifferenceReport {
  version: 1;
  kind: 'integration_trial_difference';
  integrationId: string;
  trialId: string;
  integrationInputHash: string;
  preflightReportHash: string;
  manifestHash: string;
  selection: 'apply_source';
  selectedPaths: string[];
  materializedAt: string;
  comparedAt: string;
  difference: CodeDifferenceSummary;
  trialOnly: true;
  applied: false;
  writeAuthorized: false;
  confirmPublication: true;
}
export interface IntegrationTrialDifferenceReceipt {
  integrationId: string;
  trialId: string;
  hash: string;
  receivedAt: string;
}
export interface IntegrationTrialDifferenceSummary {
  trialId: string;
  hash: string;
  materializedAt: string;
  comparedAt: string;
  receivedAt: string;
  selectedPathCount: number;
  changedFiles: number;
  omittedFiles: number;
}
export interface IntegrationTrialDifferenceDetail {
  report: IntegrationTrialDifferenceReport;
  hash: string;
  receivedAt: string;
}
const bytes = (value: string) => new TextEncoder().encode(value);
const comparePath = (a: string, b: string) => {
  const left = bytes(a),
    right = bytes(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
};
/** Public evidence only. The manifest hash binds private local evidence; it does not
 * claim that the control service read or verified the candidate directory. */
export function parseIntegrationTrialDifference(input: unknown): IntegrationTrialDifferenceReport {
  const b = exact(input, [
    'version',
    'kind',
    'integrationId',
    'trialId',
    'integrationInputHash',
    'preflightReportHash',
    'manifestHash',
    'selection',
    'selectedPaths',
    'materializedAt',
    'comparedAt',
    'difference',
    'trialOnly',
    'applied',
    'writeAuthorized',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人明确确认共享候选文件名与有界代码正文');
  if (
    b.version !== 1 ||
    b.kind !== 'integration_trial_difference' ||
    b.selection !== 'apply_source' ||
    b.trialOnly !== true ||
    b.applied !== false ||
    b.writeAuthorized !== false
  )
    throw new DomainError('INVALID_INPUT', '只接受独立候选的只读差异，不授权写回原目录');
  if (
    !Array.isArray(b.selectedPaths) ||
    !b.selectedPaths.length ||
    b.selectedPaths.length > INTEGRATION_LIMITS.files
  )
    throw new DomainError('INVALID_INPUT', '需保留1–80个完整、明确选择的文件名');
  const selectedPaths = b.selectedPaths.map((path: unknown) => {
    if (
      typeof path !== 'string' ||
      bytes(path).length > 4096 ||
      new TextDecoder().decode(bytes(path)) !== path ||
      /^[a-z]:/i.test(path) ||
      /[\\\p{Cc}\p{Cf}]/u.test(path) ||
      path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
    )
      throw new DomainError('INVALID_INPUT', '候选选择文件名无效');
    return path;
  });
  if (selectedPaths.some((path, i) => i > 0 && comparePath(selectedPaths[i - 1]!, path) >= 0))
    throw new DomainError('INVALID_INPUT', '候选选择必须按UTF-8排序且完整、不重复');
  const difference = parseCodeDifferenceSummary(b.difference, 'sides');
  if (
    difference.changedFiles !== selectedPaths.length ||
    difference.files.some((file) => !selectedPaths.includes(file.path))
  )
    throw new DomainError('INVALID_INPUT', '候选差异只能展示原完整选择中的文件');
  const report: IntegrationTrialDifferenceReport = {
    version: 1,
    kind: 'integration_trial_difference',
    integrationId: nodeId(b.integrationId),
    trialId: nodeId(b.trialId),
    integrationInputHash: checkpointHash(b.integrationInputHash),
    preflightReportHash: checkpointHash(b.preflightReportHash),
    manifestHash: checkpointHash(b.manifestHash),
    selection: 'apply_source',
    selectedPaths,
    materializedAt: retentionDate(b.materializedAt),
    comparedAt: retentionDate(b.comparedAt),
    difference,
    trialOnly: true,
    applied: false,
    writeAuthorized: false,
    confirmPublication: true,
  };
  if (report.materializedAt > report.comparedAt)
    throw new DomainError('INVALID_INPUT', '候选对比时间不能早于生成时间');
  if (bytes(JSON.stringify(report)).length > INTEGRATION_TRIAL_DIFFERENCE_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '完整候选差异报告超出48 KiB');
  return report;
}
