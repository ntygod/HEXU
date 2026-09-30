import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid, type CommitCheckpoint } from './checkpoints.js';
import { retentionDate, type RetentionManifest } from './checkpoint-retention.js';
import type { CodeFileVersion, ResultCodeReference } from './result-code.js';
import type { IntegrationFileRestoration } from './integration-restorations.js';
export type {
  IntegrationFileRestoration,
  IntegrationFileRestorationReport,
  IntegrationFileRestorationReceipt,
} from './integration-restorations.js';

export const INTEGRATION_LIMITS = { files: 80, reportBytes: 48 * 1024, history: 100 } as const;
export interface IntegrationSource {
  resultId: string;
  revisionId: string;
  revision: number;
  title: string;
  branchId: string;
  branchName: string;
  code: ResultCodeReference;
}
export interface IntegrationMaterial {
  kind: 'retention' | 'transfer';
  id: string;
  manifest: RetentionManifest;
}
export interface IntegrationTarget {
  checkpoint: CommitCheckpoint;
  retentionId: string;
  manifest: RetentionManifest;
}
export type IntegrationAction = 'add' | 'modify' | 'delete' | 'already_present' | 'conflict';
export interface IntegrationFile {
  path: string;
  base: CodeFileVersion | null;
  source: CodeFileVersion | null;
  target: CodeFileVersion | null;
  action: IntegrationAction;
  conflict: 'both_changed' | 'path_collision' | null;
}
export interface IntegrationPlan {
  baseSnapshotHash: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  changedFiles: number;
  conflicts: number;
  alreadyPresent: number;
  omittedFiles: number;
  files: IntegrationFile[];
  applied: false;
  writeAuthorized: false;
}
export const integrationReasons = [
  'target_changed',
  'workspace_busy',
  'objects_unavailable',
  'unsupported_snapshot',
  'budget_exceeded',
  'preflight_failed',
] as const;
export type IntegrationReason = (typeof integrationReasons)[number];
export interface IntegrationReport {
  integrationId: string;
  inputHash: string;
  observedAt: string;
  plan: IntegrationPlan | null;
  reason: IntegrationReason | null;
  confirmPublication: true;
}
export const integrationApplicationReasons = [
  'target_changed',
  'workspace_busy',
  'objects_unavailable',
  'unsupported_snapshot',
  'application_failed',
  'interrupted',
] as const;
export interface IntegrationApplicationReport {
  integrationId: string;
  applicationId: string;
  inputHash: string;
  sequence: 1 | 2;
  stage: 'applying' | 'completed' | 'failed' | 'needs_attention';
  observedAt: string;
  appliedPaths: string[];
  reason: (typeof integrationApplicationReasons)[number] | null;
  confirmPublication: true;
}
export interface IntegrationApplicationCandidate {
  trialId: string;
  reportHash: string;
  manifestHash: string;
  confirmExistingChanges: true;
}
export interface IntegrationApplication {
  id: string;
  reportHash: string;
  paths: string[];
  inputHash: string;
  requestedAt: string;
  requestedBy: { id: string; name: string };
  /** Only new, explicitly confirmed candidate applications may modify/remove files. */
  candidate?: IntegrationApplicationCandidate;
  reports: IntegrationApplicationReport[];
}
/** Metadata-only historical observation; it does not verify files or settle application state. */
export interface IntegrationRecoveryReport {
  version: 1;
  kind: 'local_integration_settlement';
  integrationId: string;
  applicationId: string;
  recoveryId: string;
  integrationInputHash: string;
  applicationInputHash: string;
  originalApplicationEvidenceHash: string;
  stoppedConfirmedAt: string;
  releasedAt: string;
  disposition: 'preserve_files';
  processEvidence: 'operator_confirmed_stopped';
  lease: 'released';
  filesVerified: false;
  recordedAddedCount: number;
  unresolvedWriteIntent: boolean;
  confirmPublication: true;
}
export interface IntegrationRecoveryObservation {
  report: IntegrationRecoveryReport;
  hash: string;
  receivedAt: string;
}
export type IntegrationState =
  | 'queued'
  | 'awaiting_choice'
  | 'applying'
  | 'completed'
  | 'needs_attention'
  | 'conflict'
  | 'failed'
  | 'cancelled';
export interface IntegrationOperation {
  id: string;
  taskId: string;
  projectId: string;
  spaceId: string;
  source: IntegrationSource;
  target: IntegrationTarget;
  material: IntegrationMaterial;
  inputHash: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  revision: number;
  state: IntegrationState;
  report: IntegrationReport | null;
  history: { revision: number; state: IntegrationState; at: string; actorId: string }[];
  applied: boolean;
  /** Absent in historical preflight-only records. */
  application?: IntegrationApplication | null;
}
export interface IntegrationView {
  operation: IntegrationOperation;
  available: boolean;
  unavailableReason: string | null;
  canCancel: boolean;
  canApply: boolean;
  canTrial?: boolean;
  taskRevision: number;
  reportHash: string | null;
  recovery?: IntegrationRecoveryObservation | null;
  restoration?: IntegrationFileRestoration | null;
  completedReportHash?: string | null;
  canRestoreFiles?: boolean;
  canCancelFileRestoration?: boolean;
}
export interface IntegrationOptions {
  source: IntegrationSource;
  taskRevision: number;
  targets: { target: IntegrationTarget; materials: IntegrationMaterial[] }[];
}
export function parseIntegrationCreate(input: unknown) {
  const b = exact(input, [
    'resultId',
    'resultRevisionId',
    'targetCheckpointId',
    'targetRetentionId',
    'sourceMaterial',
    'expectedTaskRevision',
    'confirmPreflight',
  ]);
  const m = exact(b.sourceMaterial, ['kind', 'id']);
  if (b.confirmPreflight !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需明确选择来源、目标与只读预检范围');
  return {
    resultId: nodeId(b.resultId),
    resultRevisionId: nodeId(b.resultRevisionId),
    targetCheckpointId: nodeId(b.targetCheckpointId),
    targetRetentionId: nodeId(b.targetRetentionId),
    sourceMaterial: {
      kind: enumValue(m.kind, ['retention', 'transfer'] as const, '来源副本'),
      id: nodeId(m.id),
    },
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmPreflight: true as const,
  };
}
export function parseIntegrationReport(input: unknown): IntegrationReport {
  const b = exact(input, [
    'integrationId',
    'inputHash',
    'observedAt',
    'plan',
    'reason',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人确认共享文件名与预检结论');
  const count = (v: unknown, max = 150000): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max)
      throw new DomainError('INVALID_INPUT', '预检数量超出边界');
    return v as number;
  };
  const version = (v: unknown): CodeFileVersion | null => {
    if (v === null) return null;
    const f = exact(v, ['objectId', 'mode', 'bytes']);
    return {
      objectId: commitOid(f.objectId),
      mode: enumValue(f.mode, ['100644', '100755'] as const, '文件模式'),
      bytes: count(f.bytes, 8 * 1024 * 1024),
    };
  };
  let plan: IntegrationPlan | null = null;
  if (b.plan !== null) {
    const p = exact(b.plan, [
      'baseSnapshotHash',
      'sourceSnapshotHash',
      'targetSnapshotHash',
      'changedFiles',
      'conflicts',
      'alreadyPresent',
      'omittedFiles',
      'files',
      'applied',
      'writeAuthorized',
    ]);
    if (
      p.applied !== false ||
      p.writeAuthorized !== false ||
      !Array.isArray(p.files) ||
      p.files.length > INTEGRATION_LIMITS.files
    )
      throw new DomainError('INVALID_INPUT', '仅接受有界只读预检，不接受已应用或写入授权声明');
    const seen = new Set<string>();
    const files = p.files.map((input): IntegrationFile => {
      const f = exact(input, ['path', 'base', 'source', 'target', 'action', 'conflict']);
      if (
        typeof f.path !== 'string' ||
        new TextEncoder().encode(f.path).length > 4096 ||
        /[\\\p{Cc}\p{Cf}]/u.test(f.path) ||
        f.path
          .split('/')
          .some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
        seen.has(f.path)
      )
        throw new DomainError('INVALID_INPUT', '预检文件名无效或重复');
      seen.add(f.path);
      const file = {
        path: f.path,
        base: version(f.base),
        source: version(f.source),
        target: version(f.target),
        action: enumValue(
          f.action,
          ['add', 'modify', 'delete', 'already_present', 'conflict'] as const,
          '文件动作',
        ),
        conflict:
          f.conflict === null
            ? null
            : enumValue(f.conflict, ['both_changed', 'path_collision'] as const, '冲突类型'),
      };
      const same = (a: CodeFileVersion | null, b: CodeFileVersion | null) =>
        a === b ||
        (!!a && !!b && a.objectId === b.objectId && a.mode === b.mode && a.bytes === b.bytes);
      if (
        same(file.base, file.source) ||
        (file.action === 'conflict') !== !!file.conflict ||
        (file.conflict === 'both_changed' &&
          (same(file.base, file.target) || same(file.source, file.target))) ||
        (file.conflict === 'path_collision' && !file.source) ||
        (file.action === 'already_present' && !same(file.source, file.target)) ||
        (['add', 'modify', 'delete'].includes(file.action) &&
          (!same(file.base, file.target) || same(file.source, file.target))) ||
        (file.action === 'add' && (!file.source || file.target)) ||
        (file.action === 'delete' && (file.source || !file.target)) ||
        (file.action === 'modify' && (!file.source || !file.target))
      )
        throw new DomainError('INVALID_INPUT', '预检文件动作与固定版本不一致');
      return file;
    });
    plan = {
      baseSnapshotHash: checkpointHash(p.baseSnapshotHash),
      sourceSnapshotHash: checkpointHash(p.sourceSnapshotHash),
      targetSnapshotHash: checkpointHash(p.targetSnapshotHash),
      changedFiles: count(p.changedFiles),
      conflicts: count(p.conflicts),
      alreadyPresent: count(p.alreadyPresent),
      omittedFiles: count(p.omittedFiles),
      files,
      applied: false,
      writeAuthorized: false,
    };
    if (
      plan.changedFiles !== files.length + plan.omittedFiles ||
      plan.conflicts + plan.alreadyPresent > plan.changedFiles ||
      plan.conflicts < files.filter((f) => f.action === 'conflict').length ||
      plan.alreadyPresent < files.filter((f) => f.action === 'already_present').length ||
      (!plan.omittedFiles &&
        (plan.conflicts !== files.filter((f) => f.action === 'conflict').length ||
          plan.alreadyPresent !== files.filter((f) => f.action === 'already_present').length))
    )
      throw new DomainError('INVALID_INPUT', '预检汇总与清单不一致');
  }
  const reason = b.reason === null ? null : enumValue(b.reason, integrationReasons, '阻止原因');
  if ((plan === null) !== (reason !== null))
    throw new DomainError('INVALID_INPUT', '预检应包含清单或明确失败原因');
  const result = {
    integrationId: nodeId(b.integrationId),
    inputHash: checkpointHash(b.inputHash),
    observedAt: retentionDate(b.observedAt),
    plan,
    reason,
    confirmPublication: true as const,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > INTEGRATION_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '预检清单超出48 KiB');
  return result;
}

/** Exact relative names only: never turn caller-supplied paths into a write capability. */
export function integrationPaths(input: unknown, allowEmpty: boolean): string[] {
  if (
    !Array.isArray(input) ||
    (!allowEmpty && !input.length) ||
    input.length > INTEGRATION_LIMITS.files
  )
    throw new DomainError('INVALID_INPUT', '需选择1–80个完整预检中的文件');
  const seen = new Set<string>();
  const paths = input.map((path: unknown) => {
    if (
      typeof path !== 'string' ||
      new TextEncoder().encode(path).length > 4096 ||
      /[\\\p{Cc}\p{Cf}]/u.test(path) ||
      path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
      seen.has(path)
    )
      throw new DomainError('INVALID_INPUT', '应用文件名无效或重复');
    seen.add(path);
    return path;
  });
  if (new TextEncoder().encode(JSON.stringify(paths)).length > INTEGRATION_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '应用文件清单超出48 KiB');
  return paths.sort();
}
export function parseIntegrationApplicationCandidate(
  input: unknown,
): IntegrationApplicationCandidate {
  const b = exact(input, ['trialId', 'reportHash', 'manifestHash', 'confirmExistingChanges']);
  if (b.confirmExistingChanges !== true)
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      '需另行明确确认候选包含的已有文件修改/移出；旧新增许可不适用',
    );
  return {
    trialId: nodeId(b.trialId),
    reportHash: checkpointHash(b.reportHash),
    manifestHash: checkpointHash(b.manifestHash),
    confirmExistingChanges: true,
  };
}
export function parseIntegrationApply(input: unknown) {
  const b = exact(input, [
    'expectedRevision',
    'expectedTaskRevision',
    'reportHash',
    'paths',
    'confirmApplication',
    'candidate',
  ]);
  const candidate =
    'candidate' in b ? parseIntegrationApplicationCandidate(b.candidate) : undefined;
  if (b.confirmApplication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需明确确认把选定新增文件写入原目标目录');
  return {
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    reportHash: checkpointHash(b.reportHash),
    paths: integrationPaths(b.paths, false),
    ...(candidate ? { candidate } : {}),
    confirmApplication: true as const,
  };
}
export function parseIntegrationApplicationReport(input: unknown): IntegrationApplicationReport {
  const b = exact(input, [
    'integrationId',
    'applicationId',
    'inputHash',
    'sequence',
    'stage',
    'observedAt',
    'appliedPaths',
    'reason',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人确认共享本次应用阶段与文件名');
  if (b.sequence !== 1 && b.sequence !== 2)
    throw new DomainError('INVALID_INPUT', '应用报告仅接受第1或第2阶段');
  const stage = enumValue(
      b.stage,
      ['applying', 'completed', 'failed', 'needs_attention'] as const,
      '应用阶段',
    ),
    appliedPaths = integrationPaths(b.appliedPaths, true),
    reason =
      b.reason === null ? null : enumValue(b.reason, integrationApplicationReasons, '应用原因');
  if (
    (b.sequence === 1 && stage !== 'applying' && stage !== 'failed') ||
    (b.sequence === 2 && stage === 'applying') ||
    (['applying', 'completed'].includes(stage) ? reason !== null : reason === null) ||
    (['applying', 'failed'].includes(stage) && appliedPaths.length > 0) ||
    (stage === 'completed' && appliedPaths.length === 0)
  )
    throw new DomainError('INVALID_INPUT', '应用阶段、文件证据与失败原因不一致');
  const result: IntegrationApplicationReport = {
    integrationId: nodeId(b.integrationId),
    applicationId: nodeId(b.applicationId),
    inputHash: checkpointHash(b.inputHash),
    sequence: b.sequence,
    stage,
    observedAt: retentionDate(b.observedAt),
    appliedPaths,
    reason,
    confirmPublication: true,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > INTEGRATION_LIMITS.reportBytes)
    throw new DomainError('INVALID_INPUT', '应用报告超出48 KiB');
  return result;
}

export function parseIntegrationRecoveryReport(input: unknown): IntegrationRecoveryReport {
  const b = exact(input, [
    'version',
    'kind',
    'integrationId',
    'applicationId',
    'recoveryId',
    'integrationInputHash',
    'applicationInputHash',
    'originalApplicationEvidenceHash',
    'stoppedConfirmedAt',
    'releasedAt',
    'disposition',
    'processEvidence',
    'lease',
    'filesVerified',
    'recordedAddedCount',
    'unresolvedWriteIntent',
    'confirmPublication',
  ]);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需本人明确确认共享本次保留文件结算观察');
  if (
    b.version !== 1 ||
    b.kind !== 'local_integration_settlement' ||
    b.disposition !== 'preserve_files' ||
    b.processEvidence !== 'operator_confirmed_stopped' ||
    b.lease !== 'released' ||
    b.filesVerified !== false ||
    typeof b.unresolvedWriteIntent !== 'boolean' ||
    !Number.isSafeInteger(b.recordedAddedCount) ||
    (b.recordedAddedCount as number) < 0 ||
    (b.recordedAddedCount as number) > INTEGRATION_LIMITS.files
  )
    throw new DomainError(
      'INVALID_INPUT',
      '仅接受保留文件、本人确认进程停止且本次占用已释放的有界观察',
    );
  return {
    version: 1,
    kind: 'local_integration_settlement',
    integrationId: nodeId(b.integrationId),
    applicationId: nodeId(b.applicationId),
    recoveryId: nodeId(b.recoveryId),
    integrationInputHash: checkpointHash(b.integrationInputHash),
    applicationInputHash: checkpointHash(b.applicationInputHash),
    originalApplicationEvidenceHash: checkpointHash(b.originalApplicationEvidenceHash),
    stoppedConfirmedAt: retentionDate(b.stoppedConfirmedAt),
    releasedAt: retentionDate(b.releasedAt),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedAddedCount: b.recordedAddedCount as number,
    unresolvedWriteIntent: b.unresolvedWriteIntent,
    confirmPublication: true,
  };
}
