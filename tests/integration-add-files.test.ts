import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PinnedRestoreParent, inode } from '../apps/runner/src/agent/checkpoint-restore-files.js';
import { inspectRestoreTarget } from '../apps/runner/src/agent/checkpoint-restore-plan.js';
import {
  checkIntegrationAddHelper,
  publishIntegrationAddition,
} from '../apps/runner/src/agent/integration-add-files.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { terminalLabel } from '../apps/runner/src/agent/terminal-label.js';

test('共享标题不能在本人写入确认前注入终端控制、双向标记或伪造换行', () => {
  const value = terminalLabel('成果\x1b[8m隐藏\x1b[0m\nAPPLY 假确认\u202e\x07');
  assert(!/[\p{Cc}\p{Cf}]/u.test(value));
  assert(value.includes('成果'));
  assert(value.includes('APPLY 假确认'));
});

const helper = fileURLToPath(new URL('../apps/runner/src/native/integration-add', import.meta.url));
for (const [name, bytes, mode, ownerOnly = false] of [
  ['empty', Buffer.alloc(0), '100644'],
  ['binary', Buffer.from([0, 255, 13, 10, 128]), '100644'],
  ['script', Buffer.from('#!/bin/false\n'), '100755'],
  ['private', Buffer.from('PRIVATE\n'), '100644', true],
  ['private-script', Buffer.from('#!/bin/false\n'), '100755', true],
] as const)
  test(
    `真实匿名inode排他新增${name}，无暂存名且落地身份/模式/正文正确`,
    { skip: process.platform !== 'linux' },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'hexu-add-primitive-')),
        sub = join(dir, 'existing');
      mkdirSync(sub);
      const parent = new PinnedRestoreParent(inspectRestoreTarget(join(sub, name), []));
      try {
        checkIntegrationAddHelper();
        const result = publishIntegrationAddition(
          parent,
          {
            path: `existing/${name}`,
            kind: 'file',
            gitMode: mode,
            objectId: 'a'.repeat(40),
            bytes: bytes.length,
          },
          bytes,
          ownerOnly,
        );
        assert.equal(result, inode(lstatSync(join(sub, name))));
        assert.deepEqual(readFileSync(join(sub, name)), bytes);
        assert.equal(
          lstatSync(join(sub, name)).mode & 0o777,
          ownerOnly ? (mode === '100755' ? 0o700 : 0o600) : mode === '100755' ? 0o755 : 0o644,
        );
        assert.deepEqual(readdirSync(sub), [name]);
        assert.equal(lstatSync(join(sub, name)).nlink, 1);
      } finally {
        parent.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
for (const kind of ['file', 'directory', 'dangling_symlink'] as const)
  test(
    `原生linkat在最后检查后遇到${kind}原子拒绝，不覆盖也不跟随`,
    { skip: process.platform !== 'linux' },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'hexu-add-occupied-')),
        target = join(dir, 'new');
      const parent = new PinnedRestoreParent(inspectRestoreTarget(target, []));
      try {
        if (kind === 'file') writeFileSync(target, 'USER');
        else if (kind === 'directory') mkdirSync(target);
        else symlinkSync('/missing-external-target', target);
        const before = lstatSync(target);
        const result = spawnSync(helper, ['new', '100644', '3'], {
          stdio: ['pipe', 'pipe', 'pipe', parent.fd],
          input: 'NEW',
          encoding: 'utf8',
          env: { LC_ALL: 'C' },
        });
        assert.equal(result.status, 20, result.stderr);
        assert.equal(lstatSync(target).ino, before.ino);
        if (kind === 'file') assert.equal(readFileSync(target, 'utf8'), 'USER');
        assert.deepEqual(readdirSync(dir), ['new']);
      } finally {
        parent.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
test(
  '原语拒绝短/长输入、特殊模式、路径和过大声明，不留下命名暂存',
  { skip: process.platform !== 'linux' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexu-add-invalid-'));
    const parent = new PinnedRestoreParent(inspectRestoreTarget(join(dir, 'new'), []));
    try {
      for (const [leaf, mode, length, input] of [
        ['new', '100644', '4', 'abc'],
        ['new', '100644', '2', 'abc'],
        ['new', '104755', '3', 'abc'],
        ['../outside', '100644', '3', 'abc'],
        ['.git', '100644', '3', 'abc'],
        ['new', '100644', '8388609', ''],
      ]) {
        const r = spawnSync(helper, [leaf!, mode!, length!], {
          stdio: ['pipe', 'pipe', 'pipe', parent.fd],
          input,
          encoding: 'utf8',
          env: { LC_ALL: 'C' },
        });
        assert.equal(r.status, 20, r.stderr);
        assert.deepEqual(readdirSync(dir), []);
      }
    } finally {
      parent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test('父目录被替换为链接或变成可被他人写入时不发布', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-add-parent-')),
    sub = join(dir, 'parent');
  mkdirSync(sub);
  const parent = new PinnedRestoreParent(inspectRestoreTarget(join(sub, 'new'), []));
  try {
    renameSync(sub, join(dir, 'moved'));
    symlinkSync(join(dir, 'moved'), sub);
    assert.throws(() =>
      publishIntegrationAddition(
        parent,
        { path: 'parent/new', kind: 'file', gitMode: '100644', objectId: 'a'.repeat(40), bytes: 3 },
        Buffer.from('new'),
      ),
    );
    assert.deepEqual(readdirSync(join(dir, 'moved')), []);
    chmodSync(join(dir, 'moved'), 0o777);
    const r = spawnSync(helper, ['new', '100644', '3'], {
      stdio: ['pipe', 'pipe', 'pipe', parent.fd],
      input: 'new',
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
    });
    assert.equal(r.status, 20);
  } finally {
    parent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  '同一inode被移到另一名字仍被原持久写锁阻止，不能按新路径再写',
  { skip: process.platform !== 'linux' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexu-lease-identity-')),
      root = join(dir, 'root'),
      moved = join(dir, 'moved');
    mkdirSync(root);
    const lease = new WorkspaceLease(root, 'original-claim');
    try {
      renameSync(root, moved);
      assert.throws(() => new WorkspaceLease(moved, 'second-claim'), /受管执行/);
    } finally {
      renameSync(moved, root);
      lease.release();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
