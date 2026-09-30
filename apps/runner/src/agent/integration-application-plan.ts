import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { IntegrationPlan } from '../../../../packages/contracts/src/integrations.js';
import { snapshotEntries, type RestoreEntry } from './checkpoint-restore-plan.js';
import type { verifySnapshot } from './checkpoint-objects.js';

/** The selected union, not the preflight's union of every change, must be safe.
 * In particular, a case-only rename's add cannot rely on an unselected delete. */
export function integrationAdditions(
  format: 'sha1' | 'sha256',
  targetTree: string,
  target: Awaited<ReturnType<typeof verifySnapshot>>,
  plan: IntegrationPlan,
  paths: readonly string[],
  root: string,
): RestoreEntry[] {
  const unsupported = () =>
    new DomainError(
      'INTEGRATION_UNSUPPORTED',
      '本轮仅应用已有父目录中的新增普通文件；冲突、覆盖、删除、新目录或路径碰撞需另行处理',
    );
  if (plan.omittedFiles || !paths.length || new Set(paths).size !== paths.length)
    throw unsupported();
  const entries = snapshotEntries(format, targetTree, target, root).entries;
  const existing = new Map(entries.map((e) => [e.path, e]));
  const names = new Set(entries.map((e) => e.path.normalize('NFC').toLowerCase()));
  const added: RestoreEntry[] = [];
  for (const path of paths) {
    const file = plan.files.find((f) => f.path === path);
    if (!file || file.action !== 'add' || file.base || file.target || !file.source || file.conflict)
      throw unsupported();
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++)
      if (existing.get(parts.slice(0, i).join('/'))?.kind !== 'directory') throw unsupported();
    const key = path.normalize('NFC').toLowerCase();
    if (names.has(key)) throw unsupported();
    names.add(key);
    added.push({
      path,
      kind: 'file',
      objectId: file.source.objectId,
      gitMode: file.source.mode,
      bytes: file.source.bytes,
    });
  }
  return added;
}
