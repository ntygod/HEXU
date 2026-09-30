import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, chmod, rm } from 'node:fs/promises';
import { openSync, closeSync, fstatSync, constants as F, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectRestoreTarget } from '../apps/runner/src/agent/checkpoint-restore-plan.js';
import {
  PinnedRestoreParent,
  identity,
} from '../apps/runner/src/agent/checkpoint-restore-files.js';
import {
  checkBranchPreserveHelper,
  preserveBranchDirectory,
} from '../apps/runner/src/agent/branch-preserve-files.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-preserve-native-'));
  let source: PinnedRestoreParent | undefined,
    destination: PinnedRestoreParent | undefined,
    root: number | undefined,
    git: number | undefined;
  try {
    const from = join(dir, 'active'),
      to = join(dir, 'private-preserved');
    await mkdir(from, { mode: 0o700 });
    await mkdir(to, { mode: 0o700 });
    const path = join(from, 'branch'),
      target = join(to, '保留方案');
    const original = inspectRestoreTarget(path, []),
      preserved = inspectRestoreTarget(target, []);
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, '.git'), { mode: 0o700 });
    await mkdir(join(path, '.git/refs'), { mode: 0o700 });
    const names = ['README.md', 'user-unsaved.txt', '.git/HEAD', '.git/refs/extra'];
    for (const name of names)
      await writeFile(join(path, name), 'KEEP ' + name + '\n', { mode: 0o600 });
    source = new PinnedRestoreParent(original);
    destination = new PinnedRestoreParent(preserved);
    root = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    git = openSync(join(path, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    const rootIdentity = identity(fstatSync(root, { bigint: true })),
      gitIdentity = identity(fstatSync(git, { bigint: true }));
    const run = () =>
      preserveBranchDirectory(source!, destination!, root!, git!, rootIdentity, gitIdentity);
    const snapshot = async (base: string) =>
      Promise.all(
        names.map(async (name) => ({
          name,
          bytes: await readFile(join(base, name)),
          identity: identity(lstatSync(join(base, name), { bigint: true })),
          mode: lstatSync(join(base, name)).mode,
        })),
      );
    const close = async () => {
      if (git !== undefined) closeSync(git);
      if (root !== undefined) closeSync(root);
      destination?.close();
      source?.close();
      await rm(dir, { recursive: true, force: true });
    };
    return { dir, from, to, path, target, run, snapshot, rootIdentity, gitIdentity, root, close };
  } catch (error) {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
    destination?.close();
    source?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
test('独立整目录原语保留.git/额外未保存文件的原inode、模式与字节，不进行复制或永久删除', async () => {
  checkBranchPreserveHelper();
  const f = await fixture();
  try {
    const before = await f.snapshot(f.path);
    assert.equal(f.run(), 'preserved');
    assert.equal(existsSync(f.path), false);
    assert.equal(identity(lstatSync(f.target, { bigint: true })), f.rootIdentity);
    assert.equal(identity(fstatSync(f.root, { bigint: true })), f.rootIdentity);
    assert.deepEqual(await f.snapshot(f.target), before);
    // Primitive preservation is not policy approval for a dirty workspace.
    // The orchestration must retain the separate clean-snapshot gate.
  } finally {
    await f.close();
  }
});
test('已存在保留目标拒绝，不覆盖任何一边；移动成功后的重复不触碰后来原路径', async () => {
  const f = await fixture();
  try {
    assert.equal(f.run(), 'preserved');
    await mkdir(f.path, { mode: 0o700 });
    await writeFile(join(f.path, 'later'), 'KEEP LATER');
    assert.throws(f.run, { code: 'RESTORE_TARGET_EXISTS' });
    assert.equal(await readFile(join(f.path, 'later'), 'utf8'), 'KEEP LATER');
    assert.equal(identity(lstatSync(f.target, { bigint: true })), f.rootIdentity);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await mkdir(g.target, { mode: 0o700 });
    await writeFile(join(g.target, 'mine'), 'KEEP DESTINATION');
    const before = await g.snapshot(g.path);
    assert.throws(g.run, { code: 'RESTORE_TARGET_EXISTS' });
    assert.deepEqual(await g.snapshot(g.path), before);
    assert.equal(await readFile(join(g.target, 'mine'), 'utf8'), 'KEEP DESTINATION');
  } finally {
    await g.close();
  }
});
test('原名称换成其他目录时原语拒绝，不移动后来目录或仍打开的原目录', async () => {
  const f = await fixture();
  try {
    await rename(f.path, f.path + '-original');
    await mkdir(f.path, { mode: 0o700 });
    await mkdir(join(f.path, '.git'), { mode: 0o700 });
    await writeFile(join(f.path, 'later'), 'KEEP REPLACEMENT');
    assert.equal(f.run(), 'not_moved');
    assert.equal(existsSync(f.target), false);
    assert.equal(await readFile(join(f.path, 'later'), 'utf8'), 'KEEP REPLACEMENT');
    assert.equal(identity(lstatSync(f.path + '-original', { bigint: true })), f.rootIdentity);
  } finally {
    await f.close();
  }
});
test('Git身份替换或非私有目录模式拒绝，原语不改权限或跟随特殊布局', async () => {
  const f = await fixture();
  try {
    await rename(join(f.path, '.git'), join(f.path, '.git-original'));
    await mkdir(join(f.path, '.git'), { mode: 0o700 });
    assert.equal(f.run(), 'not_moved');
    assert.equal(existsSync(f.target), false);
    assert.equal(
      identity(lstatSync(join(f.path, '.git-original'), { bigint: true })),
      f.gitIdentity,
    );
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await chmod(g.path, 0o755);
    assert.equal(g.run(), 'not_moved');
    assert.equal(lstatSync(g.path).mode & 0o777, 0o755);
    assert.equal(existsSync(g.target), false);
  } finally {
    await g.close();
  }
});
test('父路径被重命名并替换时停止，不借旧描述符移动脱离授权路径的现场', async () => {
  const f = await fixture();
  try {
    await rename(f.from, f.from + '-moved');
    await mkdir(f.from, { mode: 0o700 });
    assert.throws(f.run, { code: 'RESTORE_FILES_CHANGED' });
    assert.equal(existsSync(f.target), false);
    assert.equal(
      identity(lstatSync(join(f.from + '-moved', 'branch'), { bigint: true })),
      f.rootIdentity,
    );
  } finally {
    await f.close();
  }
});
