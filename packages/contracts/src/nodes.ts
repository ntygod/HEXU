import { DomainError, enumValue, record, text } from './index.js';

export const NODE_PROTOCOL = 1;
export const NODE_INTERVAL_MS = 5000;
export const NODE_LEASE_MS = 20000;
export const NODE_OFFLINE_MS = 60000;
export const NODE_MAX_WORKSPACES = 8;
export type NodePresence = 'paired' | 'online' | 'stale' | 'offline' | 'unknown' | 'revoked';
export interface DirectoryGrant {
  id: string;
  name: string;
}
export interface GitSummary {
  id: string;
  state: 'available' | 'unavailable' | 'authorization_changed';
  capturedAt: string;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
}
export interface NodeSnapshot {
  capturedAt: string;
  workspaces: GitSummary[];
}
export interface PairingView {
  id: string;
  projectId: string;
  projectName: string;
  spaceId: string;
  spaceName: string;
  ownerName: string;
  expiresAt: string;
  state: 'pending' | 'used' | 'cancelled' | 'expired';
}
export interface RunnerNode {
  id: string;
  name: string;
  ownerName: string;
  projectId: string;
  projectName: string;
  platform: string;
  arch: string;
  createdAt: string;
  revision: number;
  canRevoke: boolean;
  presence: NodePresence;
  lastSeenAt: string | null;
  revokedAt: string | null;
  acknowledgedSequence: number;
  workspaces: DirectoryGrant[];
  snapshot: NodeSnapshot | null;
  capabilities: ['git-summary'];
  executionEnabled: false;
}
export interface NodeHello {
  protocol: 1;
  nodeId: string;
  projectId: string;
  projectName: string;
  spaceId: string;
  ownerName: string;
  connectionId: string;
  acknowledgedSequence: number;
  intervalMs: number;
  leaseMs: number;
  executionEnabled: false;
}
export function exact(value: unknown, names: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some((key) => !names.includes(key)))
    throw new DomainError('INVALID_INPUT', '请求包含未支持的字段');
  return body;
}
export function nodeId(value: unknown, label = '标识'): string {
  const id = text(value, label, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new DomainError('INVALID_INPUT', `${label}格式不正确`);
  return id;
}
export function nodeSecret(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new DomainError('INVALID_CREDENTIAL', '配对码或节点凭证无效', 401);
  return value;
}
export function publicName(value: unknown): string {
  const name = text(value, '公开名称', 60);
  if (/[\/\\\p{Cc}\p{Cf}]/u.test(name))
    throw new DomainError('INVALID_INPUT', '请使用简短别名，不填写路径或控制字符');
  return name;
}
export function parseGrants(value: unknown): DirectoryGrant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NODE_MAX_WORKSPACES)
    throw new DomainError('INVALID_INPUT', `请选择 1–${NODE_MAX_WORKSPACES} 个目录`);
  const grants = value.map((v) => {
    const b = exact(v, ['id', 'name']);
    return { id: nodeId(b.id), name: publicName(b.name) };
  });
  if (
    new Set(grants.map((v) => v.id)).size !== grants.length ||
    new Set(grants.map((v) => v.name)).size !== grants.length
  )
    throw new DomainError('INVALID_INPUT', '目录标识和别名不能重复');
  return grants;
}
export function parsePair(value: unknown) {
  const b = exact(value, [
    'code',
    'nodeToken',
    'clientId',
    'projectId',
    'name',
    'platform',
    'arch',
    'protocol',
    'workspaces',
  ]);
  if (b.protocol !== NODE_PROTOCOL)
    throw new DomainError('PROTOCOL_UNSUPPORTED', '节点协议版本不兼容', 409);
  return {
    code: nodeSecret(b.code),
    nodeToken: nodeSecret(b.nodeToken),
    clientId: nodeId(b.clientId),
    projectId: nodeId(b.projectId, '项目'),
    name: publicName(b.name),
    platform: enumValue(b.platform, ['linux', 'darwin', 'win32'] as const, '平台'),
    arch: enumValue(b.arch, ['x64', 'arm64'] as const, '架构'),
    workspaces: parseGrants(b.workspaces),
  };
}
export function parseSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new DomainError('INVALID_SEQUENCE', '事件序号无效');
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new DomainError('INVALID_INPUT', '采集时间无效');
  return value;
}
export function parseSnapshot(value: unknown): NodeSnapshot {
  const b = exact(value, ['capturedAt', 'workspaces']);
  if (!Array.isArray(b.workspaces) || b.workspaces.length > NODE_MAX_WORKSPACES)
    throw new DomainError('INVALID_INPUT', '目录摘要数量无效');
  const count = (v: unknown) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1000000)
      throw new DomainError('INVALID_INPUT', '变更数量无效');
    return v;
  };
  const workspaces = b.workspaces.map((v) => {
    const w = exact(v, [
      'id',
      'state',
      'capturedAt',
      'staged',
      'modified',
      'untracked',
      'conflicts',
    ]);
    return {
      id: nodeId(w.id),
      state: enumValue(
        w.state,
        ['available', 'unavailable', 'authorization_changed'] as const,
        '目录状态',
      ),
      capturedAt: timestamp(w.capturedAt),
      staged: count(w.staged),
      modified: count(w.modified),
      untracked: count(w.untracked),
      conflicts: count(w.conflicts),
    };
  });
  if (new Set(workspaces.map((w) => w.id)).size !== workspaces.length)
    throw new DomainError('INVALID_INPUT', '摘要中目录不能重复');
  if (
    workspaces.some(
      (w) => w.state !== 'available' && (w.staged || w.modified || w.untracked || w.conflicts),
    )
  )
    throw new DomainError('INVALID_INPUT', '不可访问目录不得伪装为有效摘要');
  return { capturedAt: timestamp(b.capturedAt), workspaces };
}
export function controlOrigin(value: unknown): string {
  // No URL credentials, hostname aliases, redirects, external HTTP or arbitrary paths.
  const raw = text(value, '控制服务地址', 200);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('INVALID_CONTROL_URL', '控制地址格式不正确');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(raw)
  )
    throw new DomainError(
      'LOCAL_ONLY',
      '当前节点协议仅允许明确的回环 HTTP 地址；不跟随重定向或访问远程地址',
    );
  return url.origin;
}
