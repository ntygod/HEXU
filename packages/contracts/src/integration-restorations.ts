import { DomainError, enumValue, revision } from './index.js';
import { checkpointHash } from './checkpoints.js';
import { retentionDate } from './checkpoint-retention.js';
import { exact, nodeId } from './nodes.js';
import { INTEGRATION_LIMITS, integrationPaths } from './integrations.js';

export interface IntegrationFileRestorationCreate {
  applicationId: string;
  applicationInputHash: string;
  completedReportHash: string;
  paths: string[];
  expectedRevision: number;
  expectedTaskRevision: number;
  confirmFileRestoration: true;
}
export interface IntegrationFileRestorationCancel {
  restorationId: string;
  expectedRevision: number;
  expectedTaskRevision: number;
}
export interface IntegrationFileRestorationInspect {
  integrationId: string;
  restorationId: string;
}
/** Frozen, one-shot permission to restore the entire original confirmed selection. */
export interface IntegrationFileRestorationRequest {
  version: 1;
  kind: 'restore_confirmed_integration_files';
  id: string;
  integrationId: string;
  applicationId: string;
  applicationInputHash: string;
  completedReportHash: string;
  paths: string[];
  inputHash: string;
  requestedAt: string;
  requestedBy: { id: string; name: string };
}
export type IntegrationFileRestorationState =
  | 'queued'
  | 'restoring'
  | 'completed'
  | 'failed'
  | 'needs_attention'
  | 'cancelled';
export interface IntegrationFileRestoration extends IntegrationFileRestorationRequest {
  revision: number;
  state: IntegrationFileRestorationState;
  reports: IntegrationFileRestorationReport[];
  recovery?: IntegrationFileRestorationRecoveryObservation | null;
}
export const integrationFileRestorationReasons = [
  'target_changed',
  'workspace_busy',
  'backup_unavailable',
  'unsupported_snapshot',
  'restoration_failed',
  'interrupted',
] as const;
export interface IntegrationFileRestorationReport {
  version: 1;
  kind: 'integration_file_restoration';
  integrationId: string;
  applicationId: string;
  restorationId: string;
  inputHash: string;
  originalApplicationEvidenceHash: string;
  sequence: 1 | 2;
  stage: 'restoring' | 'completed' | 'failed' | 'needs_attention';
  observedAt: string;
  restoredPaths: string[];
  reason: (typeof integrationFileRestorationReasons)[number] | null;
  confirmPublication: true;
}
export interface IntegrationFileRestorationReceipt {
  integrationId: string;
  applicationId: string;
  restorationId: string;
  hash: string;
  sequence: 1 | 2;
  state: IntegrationFileRestorationState;
  revision: number;
}
export function parseIntegrationFileRestorationCreate(
  input: unknown,
): IntegrationFileRestorationCreate {
  const b = exact(input, [
    'applicationId',
    'applicationInputHash',
    'completedReportHash',
    'paths',
    'expectedRevision',
    'expectedTaskRevision',
    'confirmFileRestoration',
  ]);
  if (b.confirmFileRestoration !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需另行明确确认恢复原应用的全部已确认文件');
  return {
    applicationId: nodeId(b.applicationId),
    applicationInputHash: checkpointHash(b.applicationInputHash),
    completedReportHash: checkpointHash(b.completedReportHash),
    paths: integrationPaths(b.paths, false),
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmFileRestoration: true,
  };
}
export function parseIntegrationFileRestorationCancel(
  input: unknown,
): IntegrationFileRestorationCancel {
  const b = exact(input, ['restorationId', 'expectedRevision', 'expectedTaskRevision']);
  return {
    restorationId: nodeId(b.restorationId),
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
  };
}
export function parseIntegrationFileRestorationInspect(
  input: unknown,
): IntegrationFileRestorationInspect {
  const b = exact(input, ['integrationId', 'restorationId']);
  return { integrationId: nodeId(b.integrationId), restorationId: nodeId(b.restorationId) };
}
export function parseIntegrationFileRestorationReport(
  input: unknown,
): IntegrationFileRestorationReport {
  const b = exact(input, [
    'version',
    'kind',
    'integrationId',
    'applicationId',
    'restorationId',
    'inputHash',
    'originalApplicationEvidenceHash',
    'sequence',
    'stage',
    'observedAt',
    'restoredPaths',
    'reason',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人明确确认共享本次文件恢复阶段与文件名');
  if (
    b.version !== 1 ||
    b.kind !== 'integration_file_restoration' ||
    (b.sequence !== 1 && b.sequence !== 2)
  )
    throw new DomainError('INVALID_INPUT', '文件恢复报告版本、类型或阶段序号无效');
  const stage = enumValue(
      b.stage,
      ['restoring', 'completed', 'failed', 'needs_attention'] as const,
      '文件恢复阶段',
    ),
    restoredPaths = integrationPaths(b.restoredPaths, true),
    reason =
      b.reason === null
        ? null
        : enumValue(b.reason, integrationFileRestorationReasons, '文件恢复原因');
  if (
    (b.sequence === 1 && stage !== 'restoring' && stage !== 'failed') ||
    (b.sequence === 2 && stage === 'restoring') ||
    (['restoring', 'completed'].includes(stage) ? reason !== null : reason === null) ||
    (b.sequence === 1 && restoredPaths.length > 0) ||
    (stage === 'completed' && restoredPaths.length === 0)
  )
    throw new DomainError('INVALID_INPUT', '文件恢复阶段、文件证据与失败原因不一致');
  const result: IntegrationFileRestorationReport = {
    version: 1,
    kind: 'integration_file_restoration',
    integrationId: nodeId(b.integrationId),
    applicationId: nodeId(b.applicationId),
    restorationId: nodeId(b.restorationId),
    inputHash: checkpointHash(b.inputHash),
    originalApplicationEvidenceHash: checkpointHash(b.originalApplicationEvidenceHash),
    sequence: b.sequence,
    stage,
    observedAt: retentionDate(b.observedAt),
    restoredPaths,
    reason,
    confirmPublication: true,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > INTEGRATION_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '文件恢复报告超出48 KiB');
  return result;
}

/** A preserve-only settlement of the distinct restoration claim, never a restore result. */
export interface IntegrationFileRestorationRecoveryReport {
  version: 1;
  kind: 'local_integration_restoration_settlement';
  integrationId: string;
  applicationId: string;
  restorationId: string;
  recoveryId: string;
  integrationInputHash: string;
  applicationInputHash: string;
  restorationInputHash: string;
  originalApplicationEvidenceHash: string;
  restorationEvidenceHash: string;
  /** The one already-frozen packet permitted to arrive after this settlement. */
  pendingReportHash: string | null;
  stoppedConfirmedAt: string;
  releasedAt: string;
  disposition: 'preserve_files';
  processEvidence: 'operator_confirmed_stopped';
  lease: 'released';
  filesVerified: false;
  recordedRestoredCount: number;
  unresolvedWriteIntent: boolean;
  confirmPublication: true;
}
export interface IntegrationFileRestorationRecoveryObservation {
  report: IntegrationFileRestorationRecoveryReport;
  hash: string;
  receivedAt: string;
}
export interface IntegrationFileRestorationRecoveryReceipt {
  integrationId: string;
  applicationId: string;
  restorationId: string;
  recoveryId: string;
  hash: string;
  receivedAt: string;
}
export function parseIntegrationFileRestorationRecoveryReport(
  input: unknown,
): IntegrationFileRestorationRecoveryReport {
  const b = exact(input, [
    'version',
    'kind',
    'integrationId',
    'applicationId',
    'restorationId',
    'recoveryId',
    'integrationInputHash',
    'applicationInputHash',
    'restorationInputHash',
    'originalApplicationEvidenceHash',
    'restorationEvidenceHash',
    'pendingReportHash',
    'stoppedConfirmedAt',
    'releasedAt',
    'disposition',
    'processEvidence',
    'lease',
    'filesVerified',
    'recordedRestoredCount',
    'unresolvedWriteIntent',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人明确确认共享本次文件恢复的保留结算观察');
  if (
    b.version !== 1 ||
    b.kind !== 'local_integration_restoration_settlement' ||
    b.disposition !== 'preserve_files' ||
    b.processEvidence !== 'operator_confirmed_stopped' ||
    b.lease !== 'released' ||
    b.filesVerified !== false ||
    typeof b.unresolvedWriteIntent !== 'boolean' ||
    !Number.isSafeInteger(b.recordedRestoredCount) ||
    (b.recordedRestoredCount as number) < 0 ||
    (b.recordedRestoredCount as number) > INTEGRATION_LIMITS.files
  )
    throw new DomainError(
      'INVALID_INPUT',
      '仅接受保留全部文件、本人确认停止且恢复占用已释放的有界观察',
    );
  return {
    version: 1,
    kind: 'local_integration_restoration_settlement',
    integrationId: nodeId(b.integrationId),
    applicationId: nodeId(b.applicationId),
    restorationId: nodeId(b.restorationId),
    recoveryId: nodeId(b.recoveryId),
    integrationInputHash: checkpointHash(b.integrationInputHash),
    applicationInputHash: checkpointHash(b.applicationInputHash),
    restorationInputHash: checkpointHash(b.restorationInputHash),
    originalApplicationEvidenceHash: checkpointHash(b.originalApplicationEvidenceHash),
    restorationEvidenceHash: checkpointHash(b.restorationEvidenceHash),
    pendingReportHash: b.pendingReportHash === null ? null : checkpointHash(b.pendingReportHash),
    stoppedConfirmedAt: retentionDate(b.stoppedConfirmedAt),
    releasedAt: retentionDate(b.releasedAt),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedRestoredCount: b.recordedRestoredCount as number,
    unresolvedWriteIntent: b.unresolvedWriteIntent,
    confirmPublication: true,
  };
}
