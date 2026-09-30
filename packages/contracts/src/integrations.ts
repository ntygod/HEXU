import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid, type CommitCheckpoint } from './checkpoints.js';
import { retentionDate, type RetentionManifest } from './checkpoint-retention.js';
import type { CodeFileVersion, ResultCodeReference } from './result-code.js';

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
export type IntegrationState = 'queued' | 'awaiting_choice' | 'conflict' | 'failed' | 'cancelled';
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
  applied: false;
}
export interface IntegrationView {
  operation: IntegrationOperation;
  available: boolean;
  unavailableReason: string | null;
  canCancel: boolean;
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
