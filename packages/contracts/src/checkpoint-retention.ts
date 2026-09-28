import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid } from './checkpoints.js';

export const RETENTION_LIMITS = {
  objects: 10000,
  entries: 50000,
  bytes: 64 * 1024 * 1024,
  blob: 8 * 1024 * 1024,
  tree: 4 * 1024 * 1024,
  depth: 64,
  records: 16,
} as const;
export type RetentionDays = 1 | 7 | 30;
export interface SnapshotCoverage {
  objects: number;
  bytes: number;
  files: number;
  trees: number;
  symlinks: number;
  gitlinks: number;
  lfsPointers: number;
}
export interface RetentionManifest {
  version: 1;
  kind: 'git_snapshot_objects';
  objectFormat: 'sha1' | 'sha256';
  commit: string;
  tree: string;
  repositoryIdentity: string;
  snapshotHash: string;
  coverage: SnapshotCoverage;
  scope: 'commit_snapshot_without_ancestors_or_external_content';
  retainedAt: string;
  expiresAt: string;
}
export interface RetentionTicket {
  id: string;
  checkpointId: string;
  taskId: string;
  nodeId: string;
  nodeRevision: number;
  projectId: string;
  spaceId: string;
  workspaceId: string;
  ownerId: string;
  objectFormat: 'sha1' | 'sha256';
  commit: string;
  tree: string;
  repositoryIdentity: string;
  days: RetentionDays;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
}
export type RetentionReport =
  | { state: 'retained'; observedAt: string; manifest: RetentionManifest }
  | { state: 'verified' | 'missing' | 'corrupt' | 'deleted'; observedAt: string };
export interface RetentionView {
  request: RetentionTicket;
  state:
    | 'pending'
    | 'cancelled'
    | 'expired'
    | 'invalidated'
    | 'retained'
    | 'missing'
    | 'corrupt'
    | 'deleted';
  nodeAuthorized: boolean;
  manifest: RetentionManifest | null;
  sequence: number;
  observedAt: string | null;
}
export const retentionDate = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    throw new DomainError('INVALID_INPUT', '保留时间格式无效');
  return v;
};
export function parseRetentionCreate(input: unknown) {
  const b = exact(input, ['days', 'expectedTaskRevision', 'confirmLocalRetention']);
  if (b.confirmLocalRetention !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需明确同意本机对象保留及其范围');
  if (b.days !== 1 && b.days !== 7 && b.days !== 30)
    throw new DomainError('INVALID_INPUT', '保留期限只能为 1、7 或 30 天');
  return {
    days: b.days as RetentionDays,
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmLocalRetention: true as const,
  };
}
export function parseRetentionManifest(input: unknown): RetentionManifest {
  const b = exact(input, [
    'version',
    'kind',
    'objectFormat',
    'commit',
    'tree',
    'repositoryIdentity',
    'snapshotHash',
    'coverage',
    'scope',
    'retainedAt',
    'expiresAt',
  ]);
  if (
    b.version !== 1 ||
    b.kind !== 'git_snapshot_objects' ||
    b.scope !== 'commit_snapshot_without_ancestors_or_external_content'
  )
    throw new DomainError('INVALID_INPUT', '仅接受本机提交文件对象，不接受完整项目或远端备份声明');
  const objectFormat = enumValue(b.objectFormat, ['sha1', 'sha256'] as const, '对象格式');
  const c = exact(b.coverage, [
    'objects',
    'bytes',
    'files',
    'trees',
    'symlinks',
    'gitlinks',
    'lfsPointers',
  ]);
  const count = (key: keyof SnapshotCoverage, max: number, min = 0) => {
    const n = c[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max)
      throw new DomainError('INVALID_INPUT', '保留清单数量越界');
    return n;
  };
  const coverage: SnapshotCoverage = {
    objects: count('objects', RETENTION_LIMITS.objects, 2),
    bytes: count('bytes', RETENTION_LIMITS.bytes, 1),
    files: count('files', RETENTION_LIMITS.entries),
    trees: count('trees', RETENTION_LIMITS.entries, 1),
    symlinks: count('symlinks', RETENTION_LIMITS.entries),
    gitlinks: count('gitlinks', RETENTION_LIMITS.entries),
    lfsPointers: count('lfsPointers', RETENTION_LIMITS.entries),
  };
  if (
    coverage.lfsPointers > coverage.files ||
    coverage.files + coverage.trees + coverage.symlinks + coverage.gitlinks >
      RETENTION_LIMITS.entries
  )
    throw new DomainError('INVALID_INPUT', '保留清单数量不一致');
  const retainedAt = retentionDate(b.retainedAt),
    expiresAt = retentionDate(b.expiresAt);
  if (expiresAt <= retainedAt || Date.parse(expiresAt) - Date.parse(retainedAt) > 30 * 86400000)
    throw new DomainError('INVALID_INPUT', '保留期限无效');
  return {
    version: 1,
    kind: 'git_snapshot_objects',
    objectFormat,
    commit: commitOid(b.commit, objectFormat),
    tree: commitOid(b.tree, objectFormat),
    repositoryIdentity: checkpointHash(b.repositoryIdentity),
    snapshotHash: checkpointHash(b.snapshotHash),
    coverage,
    scope: 'commit_snapshot_without_ancestors_or_external_content',
    retainedAt,
    expiresAt,
  };
}
export function parseRetentionReport(input: unknown) {
  const b = exact(input, ['requestId', 'requestHash', 'sequence', 'report', 'confirmPublication']);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '缺少本机保留确认');
  const sequence = revision(b.sequence);
  if (sequence > 100) throw new DomainError('RETENTION_LIMIT', '此保留记录的核验次数达到上限');
  const value = b.report as { state?: unknown } | null;
  const r = exact(
    value,
    value?.state === 'retained' ? ['state', 'observedAt', 'manifest'] : ['state', 'observedAt'],
  );
  const state = enumValue(
    r.state,
    ['retained', 'verified', 'missing', 'corrupt', 'deleted'] as const,
    '保留状态',
  );
  // Reserve the last bounded report for deletion so verification cannot trap local data.
  if (sequence === 100 && state !== 'deleted')
    throw new DomainError('RETENTION_LIMIT', '核验次数已满，仍可明确删除此副本');
  if ((sequence === 1) !== (state === 'retained'))
    throw new DomainError('INVALID_INPUT', '首次必须发布保留清单，后续不得替换原清单');
  const observedAt = retentionDate(r.observedAt);
  const report: RetentionReport =
    state === 'retained'
      ? { state, observedAt, manifest: parseRetentionManifest(r.manifest) }
      : { state, observedAt };
  return {
    requestId: nodeId(b.requestId),
    requestHash: checkpointHash(b.requestHash),
    sequence,
    report,
    confirmPublication: true as const,
  };
}
