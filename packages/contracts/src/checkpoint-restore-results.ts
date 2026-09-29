import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import { retentionDate, RETENTION_LIMITS } from './checkpoint-retention.js';

export const RESTORE_REPORT_LIMIT = 100;
export interface RestoreResultReport {
  version: 1;
  kind: 'local_restore_observation';
  planHash: string;
  snapshotHash: string;
  state:
    | 'preparing'
    | 'writing'
    | 'verified'
    | 'publishing'
    | 'restored'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  materialState: 'none' | 'staging' | 'published' | 'unknown';
  cleanup: 'not_needed' | 'retained' | 'cleaning' | 'cleaned' | 'needs_attention';
  completedFiles: number;
  writtenBytes: number;
  totalFiles: number;
  totalBytes: number;
  verifiedAt: string | null;
  recordedAt: string;
}
export interface RestoreResultView {
  id: string;
  requestId: string;
  checkpointId: string;
  taskId: string;
  nodeId: string;
  workspaceId: string | null;
  sourceKind?: 'transfer';
  transferId?: string;
  sourceRequestId?: string;
  sourceNodeId?: string;
  ownerId: string;
  commit: string;
  retentionExpiresAt: string;
  nodeAuthorized: boolean;
  sequence: number;
  resultHash: string;
  report: RestoreResultReport;
  receivedAt: string;
}
export interface RestoreResultReceipt {
  restoreId: string;
  requestId: string;
  acceptedSequence: number;
  acceptedHash: string;
  latest: RestoreResultView;
}
export function parseRestoreResult(input: unknown): RestoreResultReport {
  const b = exact(input, [
    'version',
    'kind',
    'planHash',
    'snapshotHash',
    'state',
    'materialState',
    'cleanup',
    'completedFiles',
    'writtenBytes',
    'totalFiles',
    'totalBytes',
    'verifiedAt',
    'recordedAt',
  ]);
  if (b.version !== 1 || b.kind !== 'local_restore_observation')
    throw new DomainError('INVALID_INPUT', '只接受本机恢复观察，不接受接手或执行授权');
  const count = (key: string, max: number) => {
    const n = b[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max)
      throw new DomainError('INVALID_INPUT', '恢复报告数量越界');
    return n;
  };
  const r: RestoreResultReport = {
    version: 1,
    kind: 'local_restore_observation',
    planHash: checkpointHash(b.planHash),
    snapshotHash: checkpointHash(b.snapshotHash),
    state: enumValue(
      b.state,
      [
        'preparing',
        'writing',
        'verified',
        'publishing',
        'restored',
        'cancelled',
        'failed',
        'interrupted',
      ] as const,
      '恢复状态',
    ),
    materialState: enumValue(
      b.materialState,
      ['none', 'staging', 'published', 'unknown'] as const,
      '材料状态',
    ),
    cleanup: enumValue(
      b.cleanup,
      ['not_needed', 'retained', 'cleaning', 'cleaned', 'needs_attention'] as const,
      '清理状态',
    ),
    completedFiles: count('completedFiles', RETENTION_LIMITS.entries),
    writtenBytes: count('writtenBytes', RETENTION_LIMITS.bytes),
    totalFiles: count('totalFiles', RETENTION_LIMITS.entries),
    totalBytes: count('totalBytes', RETENTION_LIMITS.bytes),
    verifiedAt: b.verifiedAt === null ? null : retentionDate(b.verifiedAt),
    recordedAt: retentionDate(b.recordedAt),
  };
  const full = r.completedFiles === r.totalFiles && r.writtenBytes === r.totalBytes;
  if (
    r.completedFiles > r.totalFiles ||
    r.writtenBytes > r.totalBytes ||
    (r.verifiedAt !== null && (!full || r.verifiedAt > r.recordedAt)) ||
    (['verified', 'publishing', 'restored'].includes(r.state) && !full) ||
    (r.state === 'restored' && (r.materialState !== 'published' || r.cleanup !== 'not_needed')) ||
    (r.materialState === 'published' && r.state !== 'restored') ||
    (['verified', 'publishing'].includes(r.state) && r.materialState !== 'staging') ||
    (r.cleanup === 'cleaned' &&
      (r.materialState !== 'none' || !['cancelled', 'failed', 'interrupted'].includes(r.state)))
  )
    throw new DomainError('INVALID_INPUT', '恢复状态、数量或核验时间不一致');
  return r;
}
export function parseRestoreResultPacket(input: unknown) {
  const hasSource =
    input !== null && typeof input === 'object' && Object.hasOwn(input, 'sourceKind');
  const b = exact(input, [
    ...(hasSource ? ['sourceKind'] : []),
    'requestId',
    'requestHash',
    'restoreId',
    'sequence',
    'report',
    'confirmPublication',
  ]);
  if (hasSource && b.sourceKind !== 'transfer')
    throw new DomainError('INVALID_INPUT', '恢复报告来源种类不受支持');
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需明确同意发布本机恢复元数据');
  const sequence = revision(b.sequence),
    report = parseRestoreResult(b.report);
  if (
    sequence > RESTORE_REPORT_LIMIT ||
    (sequence === RESTORE_REPORT_LIMIT && report.cleanup !== 'cleaned')
  )
    throw new DomainError(
      'RESTORE_REPORT_LIMIT',
      '报告次数已满；最后一个序号仅保留清理结果，本机清理不受此限额影响',
    );
  return {
    ...(hasSource ? { sourceKind: 'transfer' as const } : {}),
    requestId: nodeId(b.requestId),
    requestHash: checkpointHash(b.requestHash),
    restoreId: nodeId(b.restoreId),
    sequence,
    report,
    confirmPublication: true as const,
  };
}
export type RestoreResultPacket = ReturnType<typeof parseRestoreResultPacket>;
