import {
  constants as F,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  fsyncSync,
  readdirSync,
  readSync,
  unlinkSync,
  rmdirSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { RestoreTargetObservation } from './checkpoint-restore-plan.js';

export const fdPath = (fd: number, leaf = '') => `/proc/self/fd/${fd}${leaf ? `/${leaf}` : ''}`;
export const inode = (s: { dev: bigint | number; ino: bigint | number }) => `${s.dev}:${s.ino}`;
export const identity = (s: BigIntStats) => `${inode(s)}:${s.birthtimeNs}`;
export const stamp = (s: BigIntStats) => `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}:${s.nlink}`;
const dirFlags = F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW;
const unsafe = () =>
  new DomainError('RESTORE_FILES_CHANGED', '目录或文件已变化/归属不明，保留现场，不覆盖或递归删除');
const helper = fileURLToPath(new URL('../native/restore-publish', import.meta.url));

function invoke(args: string[], parent?: number, stage?: number) {
  return spawnSync(helper, args, {
    stdio: ['ignore', 'pipe', 'pipe', parent ?? 'ignore', stage ?? 'ignore'],
    env: { LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
}
export function checkRestoreHelper() {
  const r = invoke(['--version']);
  if (r.error || r.status !== 0 || r.stdout.trim() !== 'hexu-restore-publish-v1')
    throw new DomainError(
      'RESTORE_HELPER_UNAVAILABLE',
      '缺少 Linux 排他发布组件，请先 npm run build:server；不会退回可覆盖的 rename/copy',
    );
}

/** Pin each ancestor from the already-open parent, never follow arbitrary path
 * symlinks. /proc/self/fd is used only for our own descriptors, not caller paths. */
export class PinnedRestoreParent {
  readonly fd: number;
  private handles: number[] = [];
  constructor(
    readonly observation: RestoreTargetObservation,
    protectedIdentities: readonly string[] = [],
  ) {
    if (process.platform !== 'linux')
      throw new DomainError('PLATFORM_UNSUPPORTED', '恢复写入仅支持 Linux');
    // Persisted observations must still describe this target's exact ancestry;
    // never let a damaged local journal redirect cleanup through an arbitrary fd.
    if (
      !isAbsolute(observation.path) ||
      resolve(observation.path) !== observation.path ||
      !observation.parents.length ||
      observation.parents.length > 2048
    )
      throw unsafe();
    let expected = dirname(observation.path);
    for (const [i, p] of observation.parents.entries()) {
      if (p.path !== expected || (expected === '/' && i !== observation.parents.length - 1))
        throw unsafe();
      expected = dirname(expected);
    }
    if (observation.parents.at(-1)!.path !== '/') throw unsafe();
    try {
      let fd = openSync('/', dirFlags);
      this.handles.push(fd);
      const parents = [...observation.parents].reverse();
      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i]!;
        if (i) {
          fd = openSync(fdPath(fd, basename(parent.path)), dirFlags);
          this.handles.push(fd);
        }
        const s = fstatSync(fd, { bigint: true });
        if (
          inode(s) !== parent.identity ||
          protectedIdentities.includes(inode(s)) ||
          protectedIdentities.includes(inode(fstatSync(fd)))
        )
          throw unsafe();
      }
      this.fd = fd;
      this.revalidate();
      const r = invoke(['--check'], fd);
      if (r.error || r.status !== 0 || r.stdout.trim() !== 'supported_parent')
        throw new DomainError(
          'RESTORE_FILESYSTEM_UNSUPPORTED',
          '目标父目录需属于本人、不可被组/其他用户写入，并位于受支持的 Linux 本地文件系统',
        );
    } catch (error) {
      this.close();
      throw error;
    }
  }
  revalidate() {
    for (const parent of this.observation.parents) {
      const s = lstatSync(parent.path, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || inode(s) !== parent.identity) throw unsafe();
    }
    const s = fstatSync(this.fd, { bigint: true });
    if (s.uid !== BigInt(process.getuid!()) || s.mode & 0o022n) throw unsafe();
  }
  assertAbsent() {
    try {
      lstatSync(fdPath(this.fd, basename(this.observation.path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    throw new DomainError('RESTORE_TARGET_EXISTS', '目标已被占用，没有覆盖');
  }
  createStage(name: string) {
    this.revalidate();
    this.assertAbsent();
    mkdirSync(fdPath(this.fd, name), { mode: 0o700 });
    fsyncSync(this.fd);
    return openSync(fdPath(this.fd, name), dirFlags);
  }
  openStage(name: string, expected: string) {
    const fd = openSync(fdPath(this.fd, name), dirFlags);
    if (identity(fstatSync(fd, { bigint: true })) !== expected) {
      closeSync(fd);
      throw unsafe();
    }
    return fd;
  }
  close() {
    for (const fd of this.handles.reverse()) closeSync(fd);
    this.handles = [];
  }
}
export interface OwnedRestoreEntry {
  path: string;
  kind: 'directory' | 'file';
  identity: string;
  stamp: string;
}
export function ownedEntry(
  path: string,
  kind: OwnedRestoreEntry['kind'],
  fd: number,
): OwnedRestoreEntry {
  const s = fstatSync(fd, { bigint: true });
  return { path, kind, identity: identity(s), stamp: stamp(s) };
}
/** Walk a relative directory through pinned fds, verifying each against this
 * attempt's ownership ledger. At most the tree depth's descriptors are held. */
export function withOwnedDirectory<T>(
  root: number,
  path: string,
  owned: ReadonlyMap<string, OwnedRestoreEntry>,
  fn: (fd: number) => T,
): T {
  let fd = root;
  const opened: number[] = [];
  let prefix = '';
  try {
    for (const name of path ? path.split('/') : []) {
      if (!name || name === '.' || name === '..') throw unsafe();
      prefix = prefix ? `${prefix}/${name}` : name;
      const expected = owned.get(prefix);
      if (!expected || expected.kind !== 'directory') throw unsafe();
      fd = openSync(fdPath(fd, name), dirFlags);
      opened.push(fd);
      const s = fstatSync(fd, { bigint: true });
      if (identity(s) !== expected.identity || s.mode & 0o077n) throw unsafe();
    }
    return fn(fd);
  } finally {
    for (const h of opened.reverse()) closeSync(h);
  }
}
export function checkOwnedTree(
  root: number,
  owned: ReadonlyMap<string, OwnedRestoreEntry>,
  gitMetadata?: { name: '.git'; identity: string },
) {
  let count = 0;
  let metadataSeen = false;
  const walk = (fd: number, prefix: string) => {
    for (const name of readdirSync(fdPath(fd))) {
      if (!prefix && gitMetadata && name === gitMetadata.name) {
        const s = lstatSync(fdPath(fd, name), { bigint: true });
        if (
          !s.isDirectory() ||
          s.isSymbolicLink() ||
          identity(s) !== gitMetadata.identity ||
          s.mode & 0o077n
        )
          throw unsafe();
        metadataSeen = true;
        continue;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      const expected = owned.get(path);
      if (!expected) throw unsafe();
      const s = lstatSync(fdPath(fd, name), { bigint: true });
      if (identity(s) !== expected.identity || s.isSymbolicLink()) throw unsafe();
      count++;
      if (expected.kind === 'directory') {
        if (!s.isDirectory() || s.mode & 0o077n) throw unsafe();
        const next = openSync(fdPath(fd, name), dirFlags);
        try {
          if (identity(fstatSync(next, { bigint: true })) !== expected.identity) throw unsafe();
          walk(next, path);
        } finally {
          closeSync(next);
        }
      } else if (!s.isFile() || s.nlink !== 1n || stamp(s) !== expected.stamp) throw unsafe();
    }
  };
  walk(root, '');
  if (count !== owned.size) throw unsafe();
  if (gitMetadata && !metadataSeen) throw unsafe();
}
export function readOwnedFile(
  root: number,
  entry: OwnedRestoreEntry,
  owned: ReadonlyMap<string, OwnedRestoreEntry>,
  max: number,
) {
  return withOwnedDirectory(
    root,
    dirname(entry.path) === '.' ? '' : dirname(entry.path),
    owned,
    (parent) => {
      const fd = openSync(
        fdPath(parent, basename(entry.path)),
        F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK,
      );
      try {
        const s = fstatSync(fd, { bigint: true });
        if (
          !s.isFile() ||
          identity(s) !== entry.identity ||
          stamp(s) !== entry.stamp ||
          s.size > BigInt(max) ||
          s.nlink !== 1n
        )
          throw unsafe();
        const buffer = Buffer.alloc(Number(s.size) + 1);
        let length = 0;
        while (length < buffer.length) {
          const n = readSync(fd, buffer, length, buffer.length - length, null);
          if (!n) break;
          length += n;
        }
        if (stamp(fstatSync(fd, { bigint: true })) !== entry.stamp || length !== Number(s.size))
          throw unsafe();
        return buffer.subarray(0, length);
      } finally {
        closeSync(fd);
      }
    },
  );
}
export function publishRestore(
  parent: PinnedRestoreParent,
  name: string,
  stage: number,
): 'published' | 'not_published' | 'unknown' {
  const r = invoke([name, basename(parent.observation.path)], parent.fd, stage);
  if (!r.error && r.status === 0 && r.stdout.trim() === 'published') return 'published';
  if (!r.error && r.status === 20 && r.stdout.trim() === 'not_published') return 'not_published';
  return 'unknown'; // Never guess from exit code, a lost reply, or target existence.
}

/** Explicit cleanup only. Validate the entire inventory before removing anything;
 * no recursive rm and never visit/delete the published target. */
export function removeOwnedStage(
  parent: PinnedRestoreParent,
  name: string,
  stage: number,
  rootIdentity: string,
  owned: ReadonlyMap<string, OwnedRestoreEntry>,
  removed: (path: string) => void,
) {
  parent.revalidate();
  if (identity(lstatSync(fdPath(parent.fd, name), { bigint: true })) !== rootIdentity)
    throw unsafe();
  checkOwnedTree(stage, owned);
  const entries = [...owned.values()].sort(
    (a, b) => b.path.split('/').length - a.path.split('/').length,
  );
  for (const entry of entries) {
    withOwnedDirectory(
      stage,
      dirname(entry.path) === '.' ? '' : dirname(entry.path),
      owned,
      (fd) => {
        const path = fdPath(fd, basename(entry.path));
        const s = lstatSync(path, { bigint: true });
        if (identity(s) !== entry.identity || (entry.kind === 'file' && stamp(s) !== entry.stamp))
          throw unsafe();
        if (entry.kind === 'directory') rmdirSync(path);
        else unlinkSync(path);
        fsyncSync(fd);
        removed(entry.path);
      },
    );
  }
  if (identity(lstatSync(fdPath(parent.fd, name), { bigint: true })) !== rootIdentity)
    throw unsafe();
  rmdirSync(fdPath(parent.fd, name));
  fsyncSync(parent.fd);
}
