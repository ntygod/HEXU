import {
  constants as F,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { CheckpointManifest } from '../../../../packages/contracts/src/checkpoints.js';
import { fdPath, inode, identity, stamp } from './checkpoint-restore-files.js';
import { snapshotEntries, type RestoreEntry } from './checkpoint-restore-plan.js';
import { captureCommitReference } from './checkpoints.js';
import { verifySnapshot, objectHash } from './checkpoint-objects.js';

import type { LocalDirectory } from './workspaces.js';
import type { NodeCredentials } from './storage.js';

const changed = () =>
  new DomainError(
    'WORKSPACE_COMMIT_CHANGED',
    '当前目录、HEAD或文件与所选提交不一致；保留现场，请先明确处理本机修改再继续',
    409,
  );
/** A short-lived synchronous observation check for a caller's final publish
 * boundary. It checks the exact tree plus HEAD/ref/index identity and stamps;
 * it never replaces full commit verification or establishes a writer lock. */
function recheckObservedCommit(
  directory: LocalDirectory,
  rootIdentity: string,
  gitIdentity: string,
  files: ReadonlyMap<string, string>,
  metadata: ReadonlyMap<string, string>,
) {
  let root: number | undefined, git: number | undefined;
  const flags = F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW;
  try {
    if (realpathSync(directory.root) !== directory.root) throw changed();
    root = openSync(directory.root, flags);
    git = openSync(fdPath(root, '.git'), flags);
    if (
      identity(fstatSync(root, { bigint: true })) !== rootIdentity ||
      identity(fstatSync(git, { bigint: true })) !== gitIdentity
    )
      throw changed();
    const remaining = new Map(files);
    const walk = (fd: number, prefix = '') => {
      for (const name of readdirSync(fdPath(fd))) {
        if (!prefix && name === '.git') {
          if (identity(lstatSync(fdPath(fd, name), { bigint: true })) !== gitIdentity)
            throw changed();
          continue;
        }
        const path = prefix ? `${prefix}/${name}` : name;
        const s = lstatSync(fdPath(fd, name), { bigint: true });
        if (remaining.get(path) !== identity(s) + ':' + stamp(s) || s.isSymbolicLink())
          throw changed();
        remaining.delete(path);
        if (s.isDirectory()) {
          const child = openSync(fdPath(fd, name), flags);
          try {
            if (identity(fstatSync(child, { bigint: true })) !== identity(s)) throw changed();
            walk(child, path);
          } finally {
            closeSync(child);
          }
        }
      }
    };
    walk(root);
    if (remaining.size) throw changed();
    for (const [path, expected] of metadata) {
      const opened: number[] = [];
      let fd = git;
      try {
        const parts = path.split('/');
        for (const part of parts.slice(0, -1)) {
          fd = openSync(fdPath(fd, part), flags);
          opened.push(fd);
        }
        const file = openSync(fdPath(fd, parts.at(-1)!), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
        opened.push(file);
        const s = fstatSync(file, { bigint: true });
        if (!s.isFile() || identity(s) + ':' + stamp(s) !== expected) throw changed();
      } finally {
        for (const fd of opened.reverse()) closeSync(fd);
      }
    }
    if (
      identity(lstatSync(directory.root, { bigint: true })) !== rootIdentity ||
      identity(lstatSync(directory.gitDir, { bigint: true })) !== gitIdentity
    )
      throw changed();
  } catch {
    throw changed();
  } finally {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
  }
}

/** Verify an ordinary registered Linux repository against a fixed commit, without writes. */
export async function verifyCleanCommit(
  home: string,
  credentials: NodeCredentials,
  directory: LocalDirectory,
  expected: Pick<CheckpointManifest, 'commit' | 'tree' | 'objectFormat' | 'repositoryIdentity'>,
  additions: readonly (RestoreEntry & { identity: string })[] = [],
  observe?: (assertUnchanged: () => void) => void,
  directories: readonly { path: string; identity: string }[] = [],
) {
  let root: number | undefined, git: number | undefined;
  try {
    if (
      realpathSync(directory.root) !== directory.root ||
      directory.gitDir !== join(directory.root, '.git')
    )
      throw changed();
    root = openSync(directory.root, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    if (inode(fstatSync(root)) !== directory.rootIdentity) throw changed();
    git = openSync(fdPath(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    if (inode(fstatSync(git)) !== directory.gitIdentity) throw changed();
    const rootIdentity = identity(fstatSync(root, { bigint: true })),
      gitIdentity = identity(fstatSync(git, { bigint: true }));
    const indexBefore = lstatSync(fdPath(git, 'index'), { bigint: true });
    if (!indexBefore.isFile() || indexBefore.nlink !== 1n) throw changed();
    const observedMetadata = new Map<string, string>([
      ['index', identity(indexBefore) + ':' + stamp(indexBefore)],
    ]);
    const metadata = (path: string, max: number) => {
      const parts = path.split('/'),
        opened: number[] = [];
      let dir = git!;
      try {
        for (const part of parts.slice(0, -1)) {
          dir = openSync(fdPath(dir, part), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
          opened.push(dir);
        }
        const fd = openSync(fdPath(dir, parts.at(-1)!), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
        opened.push(fd);
        const s = fstatSync(fd, { bigint: true });
        if (!s.isFile() || s.nlink !== 1n || s.size > BigInt(max)) throw changed();
        const bytes = Buffer.alloc(Number(s.size) + 1);
        let count = 0;
        while (count < bytes.length) {
          const n = readSync(fd, bytes, count, bytes.length - count, null);
          if (!n) break;
          count += n;
        }
        if (stamp(fstatSync(fd, { bigint: true })) !== stamp(s) || count !== Number(s.size))
          throw changed();
        const raw = bytes.subarray(0, count),
          value = raw.toString('utf8');
        if (!Buffer.from(value).equals(raw)) throw changed();
        observedMetadata.set(path, identity(s) + ':' + stamp(s));
        return value;
      } finally {
        for (const fd of opened.reverse()) closeSync(fd);
      }
    };
    const checkHead = () => {
      const head = metadata('HEAD', 4096);
      if (head === expected.commit + '\n') return;
      if (!head.startsWith('ref: refs/heads/') || !head.endsWith('\n')) throw changed();
      const ref = head.slice(5, -1);
      if (
        /[\\\p{Cc}\p{Cf}]/u.test(ref) ||
        ref.split('/').some((p) => !p || p === '.' || p === '..')
      )
        throw changed();
      let actual: string;
      try {
        actual = metadata(ref, 100).trim();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        const matches = metadata('packed-refs', 1024 * 1024)
          .split('\n')
          .filter((line) => line.endsWith(' ' + ref));
        if (matches.length !== 1) throw changed();
        actual = matches[0]!.split(' ')[0]!;
      }
      if (actual !== expected.commit) throw changed();
    };
    checkHead();
    let snapshot: Awaited<ReturnType<typeof verifySnapshot>> | undefined;
    const reference = await captureCommitReference(
      directory,
      expected.commit,
      credentials.clientId,
      home,
      async (read, _commit, tree) => {
        if (tree !== expected.tree) throw changed();
        snapshot = await verifySnapshot(
          expected.objectFormat,
          expected.commit,
          expected.tree,
          read,
        );
      },
    );
    if (
      reference.repositoryIdentity !== expected.repositoryIdentity ||
      reference.objectFormat !== expected.objectFormat ||
      reference.workingCopy.state !== 'available' ||
      reference.workingCopy.staged !== 0 ||
      reference.workingCopy.conflicts !== 0
    )
      throw changed();
    const plan = snapshotEntries(expected.objectFormat, expected.tree, snapshot!, directory.root);
    const entries = new Map<
      string,
      RestoreEntry | { path: string; kind: 'directory'; gitMode: '40000'; bytes: 0 }
    >(plan.entries.map((e) => [e.path, e]));
    for (const directory of directories) {
      if (entries.has(directory.path)) throw changed();
      entries.set(directory.path, {
        path: directory.path,
        kind: 'directory',
        gitMode: '40000',
        bytes: 0,
      });
    }
    for (const entry of additions) {
      if (entry.kind !== 'file' || entries.has(entry.path)) throw changed();
      entries.set(entry.path, entry);
    }
    const additionIdentities = new Map(additions.map((e) => [e.path, e.identity]));
    const directoryIdentities = new Map(directories.map((e) => [e.path, e.identity]));
    const observed = new Map<string, string>();
    const walk = (fd: number, prefix = '') => {
      for (const name of readdirSync(fdPath(fd))) {
        if (!prefix && name === '.git') {
          if (identity(lstatSync(fdPath(fd, name), { bigint: true })) !== gitIdentity)
            throw changed();
          continue;
        }
        const path = prefix ? `${prefix}/${name}` : name,
          entry = entries.get(path);
        if (!entry) throw changed(); // Includes untracked/ignored content: do not read or delete it.
        const handle = openSync(
          fdPath(fd, name),
          F.O_RDONLY |
            F.O_NOFOLLOW |
            F.O_NONBLOCK |
            (entry.kind === 'directory' ? F.O_DIRECTORY : 0),
        );
        try {
          const s = fstatSync(handle, { bigint: true });
          if (additionIdentities.has(path) && additionIdentities.get(path) !== inode(s))
            throw changed();
          if (
            directoryIdentities.has(path) &&
            (directoryIdentities.get(path) !== identity(s) || (s.mode & 0o777n) !== 0o700n)
          )
            throw changed();
          observed.set(path, identity(s) + ':' + stamp(s));
          if (entry.kind === 'directory') walk(handle, path);
          else {
            if (
              !s.isFile() ||
              s.nlink !== 1n ||
              s.size !== BigInt(entry.bytes) ||
              !!(s.mode & 0o111n) !== (entry.gitMode === '100755')
            )
              throw changed();
            const bytes = Buffer.alloc(entry.bytes + 1);
            let count = 0;
            while (count < bytes.length) {
              const n = readSync(handle, bytes, count, bytes.length - count, null);
              if (!n) break;
              count += n;
            }
            if (
              count !== entry.bytes ||
              stamp(fstatSync(handle, { bigint: true })) !== stamp(s) ||
              objectHash(expected.objectFormat, 'blob', bytes.subarray(0, count)) !== entry.objectId
            )
              throw changed();
          }
        } finally {
          closeSync(handle);
        }
      }
    };
    walk(root);
    if (observed.size !== entries.size) throw changed();
    const exactFiles = observe ? new Map(observed) : undefined;
    // Re-open only observed paths without following links and recheck after traversal.
    const revisit = (fd: number, prefix = '') => {
      for (const name of readdirSync(fdPath(fd))) {
        if (!prefix && name === '.git') {
          if (identity(lstatSync(fdPath(fd, name), { bigint: true })) !== gitIdentity)
            throw changed();
          continue;
        }
        const path = prefix ? `${prefix}/${name}` : name,
          entry = entries.get(path);
        if (!entry) throw changed();
        const h = openSync(
          fdPath(fd, name),
          F.O_RDONLY |
            F.O_NOFOLLOW |
            F.O_NONBLOCK |
            (entry.kind === 'directory' ? F.O_DIRECTORY : 0),
        );
        try {
          const s = fstatSync(h, { bigint: true });
          if (observed.get(path) !== identity(s) + ':' + stamp(s)) throw changed();
          if (entry.kind === 'directory') revisit(h, path);
          observed.delete(path);
        } finally {
          closeSync(h);
        }
      }
    };
    revisit(root);
    if (observed.size) throw changed();
    checkHead();
    if (
      realpathSync(directory.root) !== directory.root ||
      identity(lstatSync(directory.root, { bigint: true })) !== rootIdentity ||
      identity(lstatSync(directory.gitDir, { bigint: true })) !== gitIdentity ||
      stamp(lstatSync(fdPath(git, 'index'), { bigint: true })) !== stamp(indexBefore)
    )
      throw changed();
    observe?.(() =>
      recheckObservedCommit(directory, rootIdentity, gitIdentity, exactFiles!, observedMetadata),
    );
    return snapshot!;
  } catch (cause) {
    if (cause instanceof DomainError && cause.code === 'WORKSPACE_COMMIT_CHANGED') throw cause;
    throw changed();
  } finally {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
  }
}
