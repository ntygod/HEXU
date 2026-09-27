import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId, parseSnapshot, publicName, type GitSummary } from './nodes.js';

export interface CheckpointManifest {
  version: 1;
  kind: 'git_commit_reference';
  objectFormat: 'sha1' | 'sha256';
  commit: string;
  tree: string;
  repositoryIdentity: string;
  verifiedAt: string;
  verifiedObjects: 'commit_and_root_tree';
  availability: 'local_reference';
  workingCopy: GitSummary;
}
export interface CheckpointRequest {
  id: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  nodeRevision: number;
  nodeName: string;
  workspaceId: string;
  workspaceName: string;
  requestedBy: { id: string; name: string };
  label: string;
  commit: string;
  requestHash: string;
  state: 'pending' | 'recorded' | 'cancelled' | 'expired' | 'invalidated';
  createdAt: string;
  expiresAt: string;
  checkpointId: string | null;
}
export interface CommitCheckpoint {
  id: string;
  request: CheckpointRequest;
  manifest: CheckpointManifest;
  recordedAt: string;
}
export interface CheckpointOption {
  nodeId: string;
  nodeName: string;
  workspaces: { id: string; name: string }[];
}
export interface CheckpointPage {
  requests: CheckpointRequest[];
  checkpoints: CommitCheckpoint[];
  nextCursor: number | null;
}
export function commitOid(value: unknown, format?: 'sha1' | 'sha256'): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ||
    (format && value.length !== (format === 'sha1' ? 40 : 64))
  )
    throw new DomainError(
      'INVALID_COMMIT',
      '请填写完整的小写 Git 提交 ID，不接受分支、标签或短 ID',
    );
  return value;
}
export function checkpointHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new DomainError('INVALID_INPUT', '检查点指纹无效');
  return value;
}
export function parseCheckpointCreate(input: unknown) {
  const b = exact(input, [
    'nodeId',
    'workspaceId',
    'commit',
    'label',
    'expectedTaskRevision',
    'confirmReference',
  ]);
  if (b.confirmReference !== true)
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      '需要明确同意记录本次提交引用，不会备份未提交内容',
    );
  return {
    nodeId: nodeId(b.nodeId),
    workspaceId: nodeId(b.workspaceId),
    commit: commitOid(b.commit),
    label: publicName(b.label),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    confirmReference: true as const,
  };
}
export function parseCheckpointManifest(input: unknown): CheckpointManifest {
  const b = exact(input, [
    'version',
    'kind',
    'objectFormat',
    'commit',
    'tree',
    'repositoryIdentity',
    'verifiedAt',
    'verifiedObjects',
    'availability',
    'workingCopy',
  ]);
  if (
    b.version !== 1 ||
    b.kind !== 'git_commit_reference' ||
    b.verifiedObjects !== 'commit_and_root_tree' ||
    b.availability !== 'local_reference'
  )
    throw new DomainError(
      'INVALID_INPUT',
      '仅接受本机提交与根树核对，不接受文件包或伪造可恢复状态',
    );
  const objectFormat = enumValue(b.objectFormat, ['sha1', 'sha256'] as const, '对象格式');
  const observed = parseSnapshot({ capturedAt: b.verifiedAt, workspaces: [b.workingCopy] });
  return {
    version: 1,
    kind: 'git_commit_reference',
    objectFormat,
    commit: commitOid(b.commit, objectFormat),
    tree: commitOid(b.tree, objectFormat),
    repositoryIdentity: checkpointHash(b.repositoryIdentity),
    verifiedAt: observed.capturedAt,
    verifiedObjects: 'commit_and_root_tree',
    availability: 'local_reference',
    workingCopy: observed.workspaces[0]!,
  };
}
export function parseCheckpointPublish(input: unknown) {
  const b = exact(input, ['requestId', 'requestHash', 'manifest', 'confirmPublication']);
  if (b.confirmPublication !== true)
    throw new DomainError('CONFIRMATION_REQUIRED', '需要本机明确确认');
  return {
    requestId: nodeId(b.requestId),
    requestHash: checkpointHash(b.requestHash),
    manifest: parseCheckpointManifest(b.manifest),
    confirmPublication: true as const,
  };
}
export function parseCheckpointCursor(value: unknown) {
  const b = exact(value, ['cursor']);
  if (b.cursor === undefined) return null;
  if (typeof b.cursor !== 'string' || !/^[1-9]\d{0,14}$/.test(b.cursor))
    throw new DomainError('INVALID_INPUT', '检查点分页游标无效');
  return Number(b.cursor);
}
