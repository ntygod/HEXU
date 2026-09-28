import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  parseRetentionManifest,
  RETENTION_LIMITS,
  type RetentionManifest,
} from '../../../../packages/contracts/src/checkpoint-retention.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { verifySnapshot, type ObjectReader } from './checkpoint-objects.js';

export interface RestorePlanSource {
  requestId: string;
  checkpointId: string;
  nodeId: string;
  workspaceId: string;
  manifest: RetentionManifest;
}
export interface RestoreEntry {
  path: string;
  kind: 'directory' | 'file';
  objectId: string;
  gitMode: '40000' | '100644' | '100755';
  bytes: number;
}
export interface RestoreTargetObservation {
  path: string;
  parents: { path: string; identity: string }[];
}
export const RESTORE_EXCLUSIONS = [
  'git_metadata_and_ancestor_history',
  'uncommitted_staged_untracked_and_ignored_content',
  'lfs_entities_submodule_repositories_and_symlinks',
  'node_private_state_external_accounts_and_model_execution_authorization',
] as const;
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};
const invalidPath = () =>
  new DomainError('RESTORE_PATH_UNSUPPORTED', '恢复路径存在歧义、冲突或不受支持的名字，未写入文件');

/** Conservative names for the first Linux ordinary-file slice. Never normalize a
 * name into a different output path: normalization is used only to detect aliases. */
function fileName(raw: Buffer) {
  const name = raw.toString('utf8');
  if (
    !raw.length ||
    raw.length > 255 ||
    !Buffer.from(name, 'utf8').equals(raw) ||
    /[\p{Cc}\p{Cf}\\/:*?"<>|]/u.test(name) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..' ||
    name.toLowerCase() === '.git' ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw invalidPath();
  return name;
}
function absolutePath(path: string) {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path !== resolve(path) ||
    Buffer.byteLength(path) > 4095 ||
    /[\p{Cc}\p{Cf}\\]/u.test(path)
  )
    throw invalidPath();
  return path;
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DomainError('RESTORE_PLAN_CANCELLED', '已取消恢复预检，没有创建目标目录');
}

/** Read-only observation, NOT a reservation, write permit or race-free writer.
 * The eventual writer must pin/revalidate ancestors and exclusively claim a new
 * destination. An earlier successful plan can never authorize later writes. */
export function inspectRestoreTarget(
  target: string,
  protectedPaths: readonly string[],
): RestoreTargetObservation {
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '当前恢复预检仅支持 Linux 普通文件/目录');
  absolutePath(target);
  fileName(Buffer.from(target.slice(target.lastIndexOf('/') + 1)));
  for (const path of protectedPaths) {
    absolutePath(path);
    if (inside(path, target) || inside(target, path))
      throw new DomainError('RESTORE_TARGET_OVERLAP', '目标与来源目录或节点私有状态重叠，未写入');
  }
  const parents: RestoreTargetObservation['parents'] = [];
  let current = dirname(target);
  for (;;) {
    const s = lstatSync(current, { bigint: true });
    if (s.isSymbolicLink() || !s.isDirectory()) throw invalidPath();
    parents.push({ path: current, identity: `${s.dev}:${s.ino}` });
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  // lstat, not exists/stat: an existing dangling link is still an occupied target.
  try {
    lstatSync(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { path: target, parents };
    throw cause;
  }
  throw new DomainError('RESTORE_TARGET_EXISTS', '目标已存在；请选择全新目录，不覆盖已有内容');
}

export async function buildRestorePlan(
  source: RestorePlanSource,
  read: ObjectReader,
  target: string,
  protectedPaths: readonly string[],
  signal?: AbortSignal,
) {
  checkAbort(signal);
  const identity = {
    requestId: nodeId(source.requestId),
    checkpointId: nodeId(source.checkpointId),
    nodeId: nodeId(source.nodeId),
    workspaceId: nodeId(source.workspaceId),
  };
  const manifest = parseRetentionManifest(source.manifest);
  const fresh = () => {
    checkAbort(signal);
    if (Date.parse(manifest.expiresAt) <= Date.now())
      throw new DomainError(
        'RESTORE_RETENTION_EXPIRED',
        '对象副本已到期，不续期或生成可用恢复计划',
      );
  };
  fresh();
  const observed = inspectRestoreTarget(target, protectedPaths);
  const snapshot = await verifySnapshot(
    manifest.objectFormat,
    manifest.commit,
    manifest.tree,
    async (...args) => {
      fresh();
      const data = await read(...args);
      fresh();
      return data;
    },
  ).catch((cause: unknown) => {
    fresh();
    throw cause;
  });
  fresh();
  if (
    snapshot.snapshotHash !== manifest.snapshotHash ||
    canonicalJson(snapshot.coverage) !== canonicalJson(manifest.coverage)
  )
    throw new DomainError(
      'RESTORE_SNAPSHOT_MISMATCH',
      '持久对象与原保留清单不一致，未生成恢复计划',
    );
  if (snapshot.coverage.symlinks || snapshot.coverage.gitlinks || snapshot.coverage.lfsPointers)
    throw new DomainError(
      'RESTORE_EXTERNAL_CONTENT',
      '首个恢复切片只支持普通文件/目录；此副本含符号链接、子模块或 LFS 指针，整份拒绝而非跳过',
    );
  const objects = new Map(snapshot.objects.map((o) => [o.id, o]));
  const entries: RestoreEntry[] = [];
  const width = manifest.objectFormat === 'sha1' ? 20 : 32;
  const stack = [{ objectId: manifest.tree, path: '' }];
  let materializedBytes = 0;
  while (stack.length) {
    fresh();
    const current = stack.pop()!;
    const raw = objects.get(current.objectId)!.data;
    const names = new Set<string>();
    let offset = 0;
    while (offset < raw.length) {
      const space = raw.indexOf(32, offset);
      const nul = raw.indexOf(0, space + 1);
      // Structural/object validation above succeeded; this pass maps bytes to names.
      const mode = raw.subarray(offset, space).toString('ascii');
      const name = fileName(raw.subarray(space + 1, nul));
      const key = name.normalize('NFC').toLowerCase();
      if (names.has(key)) throw invalidPath();
      names.add(key);
      const path = current.path ? `${current.path}/${name}` : name;
      if (Buffer.byteLength(`${target}/${path}`) > 4095) throw invalidPath();
      const objectId = raw.subarray(nul + 1, nul + 1 + width).toString('hex');
      offset = nul + 1 + width;
      if (mode === '40000') {
        entries.push({ path, kind: 'directory', objectId, gitMode: mode, bytes: 0 });
        stack.push({ objectId, path });
      } else if (mode === '100644' || mode === '100755') {
        const bytes = objects.get(objectId)!.data.length;
        materializedBytes += bytes;
        // Unique object bytes can be small even when many tree paths reuse a blob.
        if (materializedBytes > RETENTION_LIMITS.bytes)
          throw new DomainError('RESTORE_EXPANSION_LIMIT', '展开后的文件总量超过 64 MiB，未写入');
        entries.push({ path, kind: 'file', objectId, gitMode: mode, bytes });
      } else throw invalidPath();
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  fresh();
  if (canonicalJson(inspectRestoreTarget(target, protectedPaths)) !== canonicalJson(observed))
    throw new DomainError('RESTORE_TARGET_CHANGED', '预检期间目标父目录已变化，请重新核对');
  const plan = {
    version: 1 as const,
    kind: 'local_restore_preflight' as const,
    source: { ...identity, manifest },
    target: observed,
    entries,
    materializedBytes,
    exclusions: RESTORE_EXCLUSIONS,
    committedSensitiveContentMayBeIncluded: true as const,
    restored: false as const,
    writeAuthorized: false as const,
  };
  return {
    ...plan,
    planHash: createHash('sha256').update(canonicalJson(plan)).digest('hex'),
    observedAt: new Date().toISOString(),
  };
}
