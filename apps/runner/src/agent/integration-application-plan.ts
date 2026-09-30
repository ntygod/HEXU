import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { IntegrationPlan } from '../../../../packages/contracts/src/integrations.js';
import { snapshotEntries, type RestoreEntry } from './checkpoint-restore-plan.js';
import type { verifySnapshot } from './checkpoint-objects.js';

export const INTEGRATION_DIRECTORY_LIMITS = { count: 256, pathBytes: 64 * 1024 } as const;
export interface IntegrationAdditionPlan {
  files: RestoreEntry[];
  /** Parent-first paths absent from the fixed target, never adopted from disk. */
  directories: string[];
  /** New entries whose parent existed in the fixed target. Freeze that ancestry. */
  anchors: string[];
}
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The selected union, not the preflight's union of every change, must be safe.
 * An add cannot rely on an unselected delete or normalize an existing parent. */
export function integrationAdditionPlan(
  format: 'sha1' | 'sha256',
  targetTree: string,
  target: Awaited<ReturnType<typeof verifySnapshot>>,
  plan: IntegrationPlan,
  paths: readonly string[],
  root: string,
): IntegrationAdditionPlan {
  const unsupported = () =>
    new DomainError(
      'INTEGRATION_UNSUPPORTED',
      '只应用新增普通文件及有界的新父目录；冲突、覆盖、删除或路径碰撞需另行处理',
    );
  if (
    plan.omittedFiles ||
    !paths.length ||
    paths.length > 80 ||
    new Set(paths).size !== paths.length
  )
    throw unsupported();
  const entries = snapshotEntries(format, targetTree, target, root).entries;
  const original = new Map(entries.map((e) => [e.path, e.kind]));
  const kinds = new Map(original);
  const aliases = new Map(entries.map((e) => [e.path.normalize('NFC').toLowerCase(), e.path]));
  const files: RestoreEntry[] = [],
    directories: string[] = [],
    anchors = new Set<string>();
  let directoryBytes = 0;
  for (const path of paths) {
    const file = plan.files.find((f) => f.path === path);
    if (!file || file.action !== 'add' || file.base || file.target || !file.source || file.conflict)
      throw unsupported();
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/'),
        key = parent.normalize('NFC').toLowerCase();
      if (aliases.has(key) && aliases.get(key) !== parent) throw unsupported();
      if (kinds.has(parent)) {
        if (kinds.get(parent) !== 'directory') throw unsupported();
        continue;
      }
      kinds.set(parent, 'directory');
      aliases.set(key, parent);
      directories.push(parent);
      directoryBytes += Buffer.byteLength(parent);
      if (
        directories.length > INTEGRATION_DIRECTORY_LIMITS.count ||
        directoryBytes > INTEGRATION_DIRECTORY_LIMITS.pathBytes ||
        Buffer.byteLength(
          `${root}/${parts.slice(0, i - 1).join('/')}/.hexu-restore-${'0'.repeat(36)}`,
        ) > 4095
      )
        throw unsupported();
      if (i === 1 || original.get(parts.slice(0, i - 1).join('/')) === 'directory')
        anchors.add(parent);
    }
    const key = path.normalize('NFC').toLowerCase();
    if (aliases.has(key)) throw unsupported();
    aliases.set(key, path);
    kinds.set(path, 'file');
    if (parts.length === 1 || original.get(parts.slice(0, -1).join('/')) === 'directory')
      anchors.add(path);
    files.push({
      path,
      kind: 'file',
      objectId: file.source.objectId,
      gitMode: file.source.mode,
      bytes: file.source.bytes,
    });
  }
  directories.sort((a, b) => a.split('/').length - b.split('/').length || compare(a, b));
  return { files, directories, anchors: [...anchors].sort(compare) };
}

/** Compatibility for callers that only need the selected file metadata. */
export function integrationAdditions(
  ...args: Parameters<typeof integrationAdditionPlan>
): RestoreEntry[] {
  return integrationAdditionPlan(...args).files;
}
