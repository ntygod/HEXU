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
/** Verify an ordinary registered Linux repository against a fixed commit, without writes. */
export async function verifyCleanCommit(
  home: string,
  credentials: NodeCredentials,
  directory: LocalDirectory,
  expected: Pick<CheckpointManifest, 'commit' | 'tree' | 'objectFormat' | 'repositoryIdentity'>,
  additions: readonly (RestoreEntry & { identity: string })[] = [],
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
    const entries = new Map(plan.entries.map((e) => [e.path, e]));
    for (const entry of additions) {
      if (entry.kind !== 'file' || entries.has(entry.path)) throw changed();
      entries.set(entry.path, entry);
    }
    const additionIdentities = new Map(additions.map((e) => [e.path, e.identity]));
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
    return snapshot!;
  } catch (cause) {
    if (cause instanceof DomainError && cause.code === 'WORKSPACE_COMMIT_CHANGED') throw cause;
    throw changed();
  } finally {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
  }
}
