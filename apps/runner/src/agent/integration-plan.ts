import type { CodeFileVersion } from '../../../../packages/contracts/src/result-code.js';
import {
  INTEGRATION_LIMITS,
  type IntegrationPlan,
  type IntegrationFile,
} from '../../../../packages/contracts/src/integrations.js';
import { snapshotEntries } from './checkpoint-restore-plan.js';
import type { verifySnapshot } from './checkpoint-objects.js';
import { DomainError } from '../../../../packages/contracts/src/index.js';

type Snapshot = Awaited<ReturnType<typeof verifySnapshot>>;
const same = (a: CodeFileVersion | null, b: CodeFileVersion | null) =>
  a === b || (!!a && !!b && a.objectId === b.objectId && a.mode === b.mode);

/** Conservative three-way file comparison over complete verified object graphs.
 * No merge driver, textual auto-merge, working-tree fallback or clipped UI patch. */
export function buildIntegrationPlan(
  format: 'sha1' | 'sha256',
  trees: { base: string; source: string; target: string },
  snapshots: { base: Snapshot; source: Snapshot; target: Snapshot },
  targetRoot: string,
): IntegrationPlan {
  const files = (tree: string, s: Snapshot) => {
    const entries = snapshotEntries(format, tree, s, targetRoot).entries;
    const parents = new Set<string>();
    for (const e of entries)
      if (e.kind === 'file') {
        const parts = e.path.split('/');
        for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'));
      }
    if (entries.some((e) => e.kind === 'directory' && !parents.has(e.path)))
      throw new DomainError(
        'INTEGRATION_UNSUPPORTED',
        '本轮文件整合不支持空子树，不省略后声称完整',
      );
    return new Map(
      entries
        .filter((e) => e.kind === 'file')
        .map((e) => [
          e.path,
          { objectId: e.objectId, mode: e.gitMode as CodeFileVersion['mode'], bytes: e.bytes },
        ]),
    );
  };
  const base = files(trees.base, snapshots.base),
    source = files(trees.source, snapshots.source),
    target = files(trees.target, snapshots.target);
  const changes: IntegrationFile[] = [],
    combined = new Map(target);
  for (const path of [...new Set([...base.keys(), ...source.keys()])].sort()) {
    const b = base.get(path) ?? null,
      s = source.get(path) ?? null,
      t = target.get(path) ?? null;
    if (same(b, s)) continue;
    const action = same(s, t)
      ? 'already_present'
      : !same(b, t)
        ? 'conflict'
        : !s
          ? 'delete'
          : !t
            ? 'add'
            : 'modify';
    changes.push({
      path,
      base: b,
      source: s,
      target: t,
      action,
      conflict: action === 'conflict' ? 'both_changed' : null,
    });
    if (action === 'delete') combined.delete(path);
    else if (action === 'add' || action === 'modify') combined.set(path, s!);
  }
  // Check the proposed full tree, including target-only paths, for file/directory
  // and cross-snapshot case/NFC collisions. Never silently choose one spelling.
  const normalize = (p: string) => p.normalize('NFC').toLowerCase();
  const names = new Map<string, Set<string>>(),
    leaf = new Set([...combined.keys()].map(normalize)),
    collisions = new Set<string>();
  for (const path of combined.keys()) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const raw = parts.slice(0, i).join('/'),
        key = normalize(raw),
        set = names.get(key) ?? new Set<string>();
      set.add(raw);
      names.set(key, set);
      if (set.size > 1 || (i < parts.length && leaf.has(key))) collisions.add(key);
    }
  }
  for (const file of changes) {
    if (!file.source) continue;
    const parts = file.path.split('/');
    if (parts.some((_, i) => collisions.has(normalize(parts.slice(0, i + 1).join('/'))))) {
      file.action = 'conflict';
      file.conflict = 'path_collision';
    }
  }
  const plan: IntegrationPlan = {
    baseSnapshotHash: snapshots.base.snapshotHash,
    sourceSnapshotHash: snapshots.source.snapshotHash,
    targetSnapshotHash: snapshots.target.snapshotHash,
    changedFiles: changes.length,
    conflicts: changes.filter((f) => f.action === 'conflict').length,
    alreadyPresent: changes.filter((f) => f.action === 'already_present').length,
    omittedFiles: changes.length,
    files: [],
    applied: false,
    writeAuthorized: false,
  };
  // Leave space for the enclosing immutable report and fixed identifiers.
  for (const file of changes) {
    if (plan.files.length >= INTEGRATION_LIMITS.files) break;
    const next = { ...plan, files: [...plan.files, file], omittedFiles: plan.omittedFiles - 1 };
    if (Buffer.byteLength(JSON.stringify(next)) > INTEGRATION_LIMITS.reportBytes - 2048) break;
    plan.files = next.files;
    plan.omittedFiles = next.omittedFiles;
  }
  return plan;
}
