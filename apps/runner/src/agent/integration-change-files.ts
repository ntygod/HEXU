import { spawnSync } from 'node:child_process';
import { constants as F, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { RestoreEntry, RestoreTargetObservation } from './checkpoint-restore-plan.js';
import { PinnedRestoreParent, fdPath, identity, inode, stamp } from './checkpoint-restore-files.js';
import { objectHash } from './checkpoint-objects.js';

const helper = fileURLToPath(new URL('../native/integration-change', import.meta.url));
const unsupported = () =>
  new DomainError(
    'INTEGRATION_CHANGE_UNSUPPORTED',
    '仅支持明确选定的普通文件替换/移出及私有备份；未写入',
  );
const unknown = () =>
  new DomainError(
    'INTEGRATION_CHANGE_UNKNOWN',
    '替换/移出结果未确认；保留原目标、私有备份和写锁，不重试或回滚',
  );
type FileEntry = RestoreEntry & { kind: 'file'; gitMode: '100644' | '100755' };
export interface IntegrationFileChange {
  before: RestoreEntry;
  after: RestoreEntry | null;
  originalIdentity: string;
  backupName: string;
}

/** Freeze existing-file ancestry without relaxing the restore-to-new-path API.
 * Observation alone is neither write permission nor a lock. */
export function observeIntegrationChangeTarget(path: string): RestoreTargetObservation {
  if (
    process.platform !== 'linux' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    Buffer.byteLength(path) > 4095 ||
    /[\\\p{Cc}\p{Cf}]/u.test(path) ||
    path
      .split('/')
      .some(
        (part, i) =>
          i > 0 && (!part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
      )
  )
    throw unsupported();
  const parents: RestoreTargetObservation['parents'] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    const s = lstatSync(current, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw unsupported();
    parents.push({ path: current, identity: inode(s) });
    if (current === '/') break;
  }
  return { path, parents };
}
export function checkIntegrationChangeHelper() {
  const r = spawnSync(helper, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { LC_ALL: 'C' },
  });
  if (r.error || r.status !== 0 || r.stdout.trim() !== 'hexu-integration-change-v2')
    throw new DomainError(
      'INTEGRATION_HELPER_UNAVAILABLE',
      'Linux保留原文件的替换组件缺失或版本不匹配，请重新构建；不降级为覆盖/删除',
    );
}
function verifiedEntry(entry: RestoreEntry, bytes: Buffer): asserts entry is FileEntry {
  if (
    entry.kind !== 'file' ||
    !['100644', '100755'].includes(entry.gitMode) ||
    entry.bytes !== bytes.length ||
    entry.bytes > 8 * 1024 * 1024 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.objectId) ||
    objectHash(entry.objectId.length === 40 ? 'sha1' : 'sha256', 'blob', bytes) !== entry.objectId
  )
    throw unsupported();
}
/** Check the actual named regular file and hold its fd across reading; both
 * helper and caller verify persisted bytes instead of trusting exit text. */
export function readIntegrationChangeFile(
  parent: number,
  leaf: string,
  expected: RestoreEntry,
  wantedIdentity: string,
) {
  if (
    expected.kind !== 'file' ||
    !['100644', '100755'].includes(expected.gitMode) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    expected.bytes > 8 * 1024 * 1024
  )
    throw unknown();
  const fd = openSync(fdPath(parent, leaf), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true });
    if (
      !s.isFile() ||
      s.uid !== BigInt(process.getuid!()) ||
      s.nlink !== 1n ||
      s.size !== BigInt(expected.bytes) ||
      inode(s) !== wantedIdentity ||
      ![0o600n, 0o644n, 0o700n, 0o755n].includes(s.mode & 0o7777n) ||
      !!(s.mode & 0o111n) !== (expected.gitMode === '100755')
    )
      throw unknown();
    const bytes = Buffer.alloc(expected.bytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const named = lstatSync(fdPath(parent, leaf), { bigint: true });
    if (
      count !== expected.bytes ||
      stamp(fstatSync(fd, { bigint: true })) !== stamp(s) ||
      identity(named) !== identity(s) ||
      stamp(named) !== stamp(s) ||
      objectHash(
        expected.objectId.length === 40 ? 'sha1' : 'sha256',
        'blob',
        bytes.subarray(0, count),
      ) !== expected.objectId
    )
      throw unknown();
    return {
      bytes: bytes.subarray(0, count),
      fingerprint: identity(s) + ':' + stamp(s),
      permissions: Number(s.mode & 0o7777n),
    };
  } finally {
    closeSync(fd);
  }
}

export function verifyIntegrationChangeFile(...args: Parameters<typeof readIntegrationChangeFile>) {
  return readIntegrationChangeFile(...args).fingerprint;
}

/** Call only after durable exact intent, explicit stopped-writers consent and a
 * held workspace claim. The backup parent is separately pinned and explicitly
 * selected outside all registered roots/private state. A null return proves no
 * namespace change by this helper; unknown must retain intent and both places.
 * Atomic rename is NOT conditional on content. Unmanaged writers can still
 * race; any detected mismatch is unknown, never a reason to reverse/delete. */
export function publishIntegrationFileChange(
  target: PinnedRestoreParent,
  backup: PinnedRestoreParent,
  change: IntegrationFileChange,
  beforeBytes: Buffer,
  afterBytes: Buffer | null,
): { backupIdentity: string; targetIdentity: string | null } | null {
  verifiedEntry(change.before, beforeBytes);
  if (change.after) {
    if (!afterBytes || change.after.path !== change.before.path) throw unsupported();
    verifiedEntry(change.after, afterBytes);
  } else if (afterBytes !== null) throw unsupported();
  if (
    basename(target.observation.path) !== basename(change.before.path) ||
    basename(backup.observation.path) !== change.backupName ||
    !/^hexu-change-[a-f0-9-]{36}$/.test(change.backupName) ||
    !/^\d+:\d+$/.test(change.originalIdentity)
  )
    throw unsupported();
  target.revalidate();
  backup.revalidate();
  backup.assertAbsent();
  verifyIntegrationChangeFile(
    target.fd,
    basename(change.before.path),
    change.before,
    change.originalIdentity,
  );
  const [dev, ino] = change.originalIdentity.split(':') as [string, string];
  const r = spawnSync(
    helper,
    [
      basename(change.before.path),
      change.backupName,
      change.before.gitMode,
      change.after?.gitMode ?? 'delete',
      String(beforeBytes.length),
      String(afterBytes?.length ?? 0),
      dev,
      ino,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe', target.fd, backup.fd],
      input: Buffer.concat([beforeBytes, afterBytes ?? Buffer.alloc(0)]),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
      env: { LC_ALL: 'C' },
    },
  );
  if (!r.error && r.status === 20 && r.stdout.trim() === 'not_changed') return null;
  const match =
    !r.error && r.status === 0 && /^changed (\d+:\d+) (\d+:\d+|deleted)\n$/.exec(r.stdout);
  if (
    !match ||
    match[1] !== change.originalIdentity ||
    (match[2] === 'deleted') !== (change.after === null)
  )
    throw unknown();
  try {
    target.revalidate();
    backup.revalidate();
    verifyIntegrationChangeFile(backup.fd, change.backupName, change.before, match[1]!);
    if (change.after)
      verifyIntegrationChangeFile(
        target.fd,
        basename(change.before.path),
        change.after as FileEntry,
        match[2]!,
      );
    else target.assertAbsent();
    return { backupIdentity: match[1]!, targetIdentity: change.after ? match[2]! : null };
  } catch {
    throw unknown();
  }
}
