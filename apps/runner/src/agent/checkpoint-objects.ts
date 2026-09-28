import { createHash } from 'node:crypto';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  RETENTION_LIMITS as limits,
  type SnapshotCoverage,
} from '../../../../packages/contracts/src/checkpoint-retention.js';
import { commitOid } from '../../../../packages/contracts/src/checkpoints.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
export type ObjectType = 'commit' | 'tree' | 'blob';
export type ObjectReader = (id: string, type: ObjectType, max: number) => Promise<Buffer>;
export interface SnapshotObject {
  id: string;
  type: ObjectType;
  data: Buffer;
}
const invalid = () =>
  new DomainError(
    'SNAPSHOT_INCOMPLETE',
    '提交文件对象缺失、损坏或树格式不受支持；未发布完整保留记录',
  );
const tooLarge = () =>
  new DomainError(
    'RETENTION_LIMIT',
    '超过单份对象/文件数量、大小、深度或核验时间边界；未发布保留记录',
  );
export function objectHash(format: 'sha1' | 'sha256', type: ObjectType, data: Buffer) {
  return createHash(format).update(`${type} ${data.length}\0`).update(data).digest('hex');
}
/** Walk the selected snapshot only, not parent history or submodule/LFS repositories.
 * Names are parsed as bytes and are never used as filesystem paths. */
export async function verifySnapshot(
  format: 'sha1' | 'sha256',
  commit: string,
  tree: string,
  read: ObjectReader,
) {
  commitOid(commit, format);
  commitOid(tree, format);
  const objects = new Map<string, SnapshotObject>();
  const coverage: SnapshotCoverage = {
    objects: 0,
    bytes: 0,
    files: 0,
    trees: 0,
    symlinks: 0,
    gitlinks: 0,
    lfsPointers: 0,
  };
  const deadline = Date.now() + 120000;
  async function object(id: string, type: ObjectType) {
    const old = objects.get(id);
    if (old) {
      if (old.type !== type) throw invalid();
      return old.data;
    }
    if (objects.size >= limits.objects || Date.now() > deadline) throw tooLarge();
    const max = type === 'commit' ? 65536 : type === 'tree' ? limits.tree : limits.blob;
    let data: Buffer;
    try {
      data = await read(id, type, max);
    } catch {
      throw invalid();
    }
    if (!Buffer.isBuffer(data) || data.length > max || objectHash(format, type, data) !== id)
      throw invalid();
    coverage.bytes += data.length;
    if (coverage.bytes > limits.bytes) throw tooLarge();
    objects.set(id, { id, type, data });
    return data;
  }
  const rawCommit = await object(commit, 'commit');
  if (!rawCommit.subarray(0, tree.length + 6).equals(Buffer.from(`tree ${tree}\n`)))
    throw invalid();
  const width = format === 'sha1' ? 20 : 32;
  const stack = [{ id: tree, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > limits.depth || Date.now() > deadline) throw tooLarge();
    coverage.trees++;
    const raw = await object(current.id, 'tree'),
      names = new Set<string>();
    let offset = 0;
    while (offset < raw.length) {
      const space = raw.indexOf(32, offset),
        nul = raw.indexOf(0, space + 1);
      if (
        space < offset ||
        space - offset > 6 ||
        nul <= space + 1 ||
        nul - space > 4097 ||
        nul + 1 + width > raw.length
      )
        throw invalid();
      const mode = raw.subarray(offset, space).toString('ascii'),
        name = raw.subarray(space + 1, nul),
        key = name.toString('hex');
      if (
        !['40000', '100644', '100755', '120000', '160000'].includes(mode) ||
        name.includes(47) ||
        name.includes(92) ||
        name.equals(Buffer.from('.')) ||
        name.equals(Buffer.from('..')) ||
        name.toString('ascii').toLowerCase() === '.git' ||
        names.has(key)
      )
        throw invalid();
      names.add(key);
      const oid = raw.subarray(nul + 1, nul + 1 + width).toString('hex');
      offset = nul + 1 + width;
      if (mode === '40000') stack.push({ id: oid, depth: current.depth + 1 });
      else if (mode === '160000')
        coverage.gitlinks++; // External commit identity, not local code.
      else {
        const data = await object(oid, 'blob');
        if (mode === '120000')
          coverage.symlinks++; // Preserve raw link text, never follow it.
        else {
          coverage.files++;
          if (
            /^version (?:https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v1|http:\/\/git-media\.io\/v\/2)\r?\n/.test(
              data.subarray(0, 256).toString('utf8'),
            )
          )
            coverage.lfsPointers++;
        }
      }
      if (
        coverage.files + coverage.trees + coverage.symlinks + coverage.gitlinks + stack.length >
        limits.entries
      )
        throw tooLarge();
    }
  }
  coverage.objects = objects.size;
  const entries = [...objects.values()].sort((a, b) => a.id.localeCompare(b.id));
  const snapshotHash = createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        objectFormat: format,
        commit,
        tree,
        objects: entries.map((o) => [o.id, o.type, o.data.length]),
        coverage,
      }),
    )
    .digest('hex');
  return { objects: entries, coverage, snapshotHash };
}
