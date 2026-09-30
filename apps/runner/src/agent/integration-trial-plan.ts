import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  INTEGRATION_LIMITS,
  type IntegrationPlan,
} from '../../../../packages/contracts/src/integrations.js';
import { RETENTION_LIMITS } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { verifySnapshot, type SnapshotObject } from './checkpoint-objects.js';
import { snapshotEntries } from './checkpoint-restore-plan.js';
import { buildIntegrationPlan } from './integration-plan.js';

type Format = 'sha1' | 'sha256';
type Snapshot = Awaited<ReturnType<typeof verifySnapshot>>;
type Sides<T> = { base: T; source: T; target: T };
export interface IntegrationTrialDirectory {
  path: string;
  kind: 'directory';
  gitMode: '40000';
  bytes: 0;
}
export interface IntegrationTrialFile {
  path: string;
  kind: 'file';
  gitMode: '100644' | '100755';
  objectId: string;
  bytes: number;
  origin: 'source' | 'target';
  snapshotHash: string;
}
export type IntegrationTrialEntry = IntegrationTrialDirectory | IntegrationTrialFile;
export interface IntegrationTrialManifest {
  version: 1;
  kind: 'integration_trial_plan';
  objectFormat: Format;
  trees: Sides<string>;
  snapshotHashes: Sides<string>;
  selection: 'apply_source';
  selectedPaths: string[];
  entries: IntegrationTrialEntry[];
  materializedBytes: number;
  trialOnly: true;
  applied: false;
  writeAuthorized: false;
}
export interface IntegrationTrialPlan extends IntegrationTrialManifest {
  /** Complete private metadata only; never a clipped display report or a Git tree. */
  manifest: IntegrationTrialManifest;
  manifestHash: string;
  /** Each file's own bytes, copied from its verified blob, never metadata/diff text. */
  entries: (IntegrationTrialDirectory | (IntegrationTrialFile & { data: Buffer }))[];
}
// A private manifest may describe far more target-only paths than the shared report.
// Keep its serialized form bounded too, independently of expanded file bytes.
export const INTEGRATION_TRIAL_LIMITS = { manifestBytes: RETENTION_LIMITS.bytes } as const;
const mismatch = () =>
  new DomainError('INTEGRATION_PLAN_CHANGED', '完整对象或原整合预检不一致，未生成试应用材料');
const unsupported = () =>
  new DomainError(
    'INTEGRATION_TRIAL_UNSUPPORTED',
    '只能明确选择完整预检中的无冲突新增、修改或删除',
  );
const expansion = () =>
  new DomainError(
    'RESTORE_EXPANSION_LIMIT',
    '试应用完整目录展开后超过文件数量、大小、深度或清单边界',
  );
const comparePath = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Reverify a detached, complete in-memory graph. No reader can fall back to a
 * worktree, diff, remote source or expired original bundle. Copy before the first
 * await so caller mutations cannot swap bytes during verification. */
async function reverify(format: Format, tree: string, input: Snapshot): Promise<Snapshot> {
  if (!Array.isArray(input.objects) || input.objects.length > RETENTION_LIMITS.objects)
    throw mismatch();
  const objects = new Map<string, SnapshotObject>();
  let bytes = 0;
  for (const object of input.objects) {
    if (!Buffer.isBuffer(object.data) || objects.has(object.id)) throw mismatch();
    bytes += object.data.length;
    if (bytes > RETENTION_LIMITS.bytes) throw expansion();
    objects.set(object.id, { ...object, data: Buffer.from(object.data) });
  }
  const commits = [...objects.values()].filter((o) => o.type === 'commit');
  if (commits.length !== 1) throw mismatch();
  const snapshotHash = input.snapshotHash,
    coverage = canonicalJson(input.coverage);
  const fresh = await verifySnapshot(format, commits[0]!.id, tree, async (id, type) => {
    const object = objects.get(id);
    if (!object || object.type !== type) throw mismatch();
    return object.data;
  });
  if (
    fresh.objects.length !== objects.size ||
    fresh.snapshotHash !== snapshotHash ||
    canonicalJson(fresh.coverage) !== coverage
  )
    throw mismatch();
  return fresh;
}

/** Pure private trial-tree planner. It never observes or writes a filesystem,
 * acquires a lease, creates a commit/ref/index, or authorizes existing-target writes.
 * The root is used only for the original report's conservative path-length check.
 * New directory entries describe a future PRIVATE materialization, not in-place
 * directory creation support. No conflicts, merge drivers or implicit side choice. */
export async function buildIntegrationTrialPlan(
  format: Format,
  trees: Sides<string>,
  snapshots: Sides<Snapshot>,
  originalPlan: IntegrationPlan,
  paths: readonly string[],
  targetRoot: string,
): Promise<IntegrationTrialPlan> {
  if (
    !['sha1', 'sha256'].includes(format) ||
    typeof targetRoot !== 'string' ||
    !isAbsolute(targetRoot) ||
    resolve(targetRoot) !== targetRoot ||
    Buffer.byteLength(targetRoot) > 4095 ||
    /[\p{Cc}\p{Cf}\\]/u.test(targetRoot)
  )
    throw new DomainError('RESTORE_PATH_UNSUPPORTED', '试应用路径边界无效，未写入文件');
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > INTEGRATION_LIMITS.files ||
    paths.some((p) => typeof p !== 'string') ||
    new Set(paths).size !== paths.length ||
    Buffer.byteLength(JSON.stringify(paths)) > INTEGRATION_LIMITS.reportBytes
  )
    throw unsupported();
  if (
    !originalPlan ||
    originalPlan.omittedFiles !== 0 ||
    !Array.isArray(originalPlan.files) ||
    originalPlan.files.length > INTEGRATION_LIMITS.files ||
    originalPlan.changedFiles !== originalPlan.files.length ||
    Buffer.byteLength(JSON.stringify(originalPlan)) > INTEGRATION_LIMITS.reportBytes
  )
    throw mismatch();
  // Freeze caller metadata and every input graph before awaiting any verification.
  const fixedTrees = { ...trees },
    original = canonicalJson(originalPlan),
    selectedPaths = [...paths].sort(comparePath);
  const [base, source, target] = await Promise.all([
    reverify(format, fixedTrees.base, snapshots.base),
    reverify(format, fixedTrees.source, snapshots.source),
    reverify(format, fixedTrees.target, snapshots.target),
  ]);
  const fresh = { base, source, target };
  const report = buildIntegrationPlan(format, fixedTrees, fresh, targetRoot);
  if (report.omittedFiles || canonicalJson(report) !== original) throw mismatch();
  const changes = new Map(report.files.map((file) => [file.path, file]));
  const mapFiles = (origin: 'source' | 'target') =>
    new Map(
      snapshotEntries(format, fixedTrees[origin], fresh[origin], targetRoot)
        .entries.filter((e) => e.kind === 'file')
        .map((e): [string, IntegrationTrialFile] => [
          e.path,
          {
            path: e.path,
            kind: 'file',
            gitMode: e.gitMode as IntegrationTrialFile['gitMode'],
            objectId: e.objectId,
            bytes: e.bytes,
            origin,
            snapshotHash: fresh[origin].snapshotHash,
          },
        ]),
    );
  const sourceFiles = mapFiles('source'),
    combined = mapFiles('target');
  for (const path of selectedPaths) {
    const file = changes.get(path);
    if (!file || file.conflict || !['add', 'modify', 'delete'].includes(file.action))
      throw unsupported();
    if (file.action === 'delete') combined.delete(path);
    else {
      const entry = sourceFiles.get(path);
      if (!entry || entry.objectId !== file.source?.objectId || entry.gitMode !== file.source.mode)
        throw mismatch();
      combined.set(path, entry);
    }
  }

  // Build the actual selected union, not the preflight's union of all changes.
  // Case-only renames and file/directory replacements require the matching delete.
  const entries = new Map<string, IntegrationTrialEntry>(),
    aliases = new Map<string, string>();
  let materializedBytes = 0;
  const insert = (entry: IntegrationTrialEntry) => {
    const key = entry.path.normalize('NFC').toLowerCase(),
      priorName = aliases.get(key),
      prior = entries.get(entry.path);
    if (
      (priorName !== undefined && priorName !== entry.path) ||
      (prior && prior.kind !== entry.kind)
    )
      throw new DomainError(
        'INTEGRATION_PATH_COLLISION',
        '所选试应用与保留目标发生路径、大小写或 NFC 碰撞',
      );
    if (prior) return;
    aliases.set(key, entry.path);
    entries.set(entry.path, entry);
    // The complete expanded tree includes its root, just like verifySnapshot.
    if (entries.size + 1 > RETENTION_LIMITS.entries) throw expansion();
  };
  for (const file of combined.values()) {
    const parts = file.path.split('/');
    if (
      parts.length - 1 > RETENTION_LIMITS.depth ||
      Buffer.byteLength(`${targetRoot}/${file.path}`) > 4095 ||
      file.bytes > RETENTION_LIMITS.blob
    )
      throw expansion();
    materializedBytes += file.bytes;
    if (materializedBytes > RETENTION_LIMITS.bytes) throw expansion();
    for (let i = 1; i < parts.length; i++)
      insert({ path: parts.slice(0, i).join('/'), kind: 'directory', gitMode: '40000', bytes: 0 });
    insert(file);
  }
  const sorted = [...entries.values()].sort((a, b) => comparePath(a.path, b.path));
  const manifest: IntegrationTrialManifest = {
    version: 1,
    kind: 'integration_trial_plan',
    objectFormat: format,
    trees: fixedTrees,
    snapshotHashes: {
      base: base.snapshotHash,
      source: source.snapshotHash,
      target: target.snapshotHash,
    },
    selection: 'apply_source',
    selectedPaths,
    entries: sorted,
    materializedBytes,
    trialOnly: true,
    applied: false,
    writeAuthorized: false,
  };
  let manifestBytes = Buffer.byteLength(canonicalJson({ ...manifest, entries: [] }));
  for (let i = 0; i < sorted.length; i++) {
    manifestBytes += Buffer.byteLength(canonicalJson(sorted[i])) + (i ? 1 : 0);
    if (manifestBytes > INTEGRATION_TRIAL_LIMITS.manifestBytes) throw expansion();
  }
  const objectMaps = {
    source: new Map(source.objects.map((o) => [o.id, o])),
    target: new Map(target.objects.map((o) => [o.id, o])),
  };
  return {
    ...manifest,
    manifest,
    manifestHash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
    entries: sorted.map((entry) => {
      if (entry.kind === 'directory') return { ...entry };
      const object = objectMaps[entry.origin].get(entry.objectId);
      if (!object || object.type !== 'blob' || object.data.length !== entry.bytes) throw mismatch();
      return { ...entry, data: Buffer.from(object.data) };
    }),
  };
}
