import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  PinnedRestoreParent,
  publishRestore,
  identity,
} from '../apps/runner/src/agent/checkpoint-restore-files.js';
import { inspectRestoreTarget } from '../apps/runner/src/agent/checkpoint-restore-plan.js';
for (const occupied of ['directory', 'file', 'symlink'] as const)
  test(`真实Linux原语在最后检查之后出现${occupied}仍排他拒绝（包括空目录/悬空链接）`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexu-publish-race-'));
    const target = join(dir, 'new');
    const name = `.hexu-restore-${randomUUID()}`;
    const parent = new PinnedRestoreParent(inspectRestoreTarget(target, []));
    const stage = parent.createStage(name);
    try {
      parent.assertAbsent();
      if (occupied === 'directory') mkdirSync(target);
      else if (occupied === 'file') writeFileSync(target, 'keep');
      else symlinkSync('/missing', target);
      const before = lstatSync(target);
      assert.equal(publishRestore(parent, name, stage), 'not_published');
      assert.equal(lstatSync(target).ino, before.ino);
      assert.equal(lstatSync(join(dir, name)).ino, fstatSync(stage).ino);
    } finally {
      closeSync(stage);
      parent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('原语只能发布被固定的同一暂存目录，替换名称不能变成其他用户材料', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-publish-identity-'));
  const target = join(dir, 'new'),
    name = `.hexu-restore-${randomUUID()}`;
  const parent = new PinnedRestoreParent(inspectRestoreTarget(target, []));
  const stage = parent.createStage(name);
  try {
    renameSync(join(dir, name), join(dir, 'original'));
    mkdirSync(join(dir, name), { mode: 0o700 });
    assert.equal(publishRestore(parent, name, stage), 'not_published');
    assert.throws(() => lstatSync(target), { code: 'ENOENT' });
  } finally {
    closeSync(stage);
    parent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('空暂存目录也可原子发布，inode和已打开目录描述符保持同一身份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-publish-empty-'));
  const target = join(dir, 'new'),
    name = `.hexu-restore-${randomUUID()}`;
  const parent = new PinnedRestoreParent(inspectRestoreTarget(target, []));
  const stage = parent.createStage(name);
  try {
    const before = identity(fstatSync(stage, { bigint: true }));
    assert.equal(publishRestore(parent, name, stage), 'published');
    assert.equal(identity(lstatSync(target, { bigint: true })), before);
    assert.throws(() => lstatSync(join(dir, name)), { code: 'ENOENT' });
  } finally {
    closeSync(stage);
    parent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('不接受可被其他用户写入的目标父目录，不把摘要配对当作目录安全保证', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-restore-permissions-'));
  const target = join(dir, 'unsafe', 'new');
  mkdirSync(join(dir, 'unsafe'), { mode: 0o777 });
  // chmod avoids the caller umask changing this fixture.
  chmodSync(join(dir, 'unsafe'), 0o777);
  try {
    assert.throws(() => new PinnedRestoreParent(inspectRestoreTarget(target, [])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('持久观察的目标与父目录链不一致时拒绝，不把另一目录固定为清理父目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-observation-'));
  try {
    const observed = inspectRestoreTarget(join(dir, 'new'), []);
    observed.path = '/elsewhere/new';
    assert.throws(() => new PinnedRestoreParent(observed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
