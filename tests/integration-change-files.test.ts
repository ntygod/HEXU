import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  constants as F,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  linkSync,
  chmodSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inode } from '../apps/runner/src/agent/checkpoint-restore-files.js';

const helper = fileURLToPath(
  new URL('../apps/runner/src/native/integration-change', import.meta.url),
);
const linux = { skip: process.platform !== 'linux' };
function fixture(before = Buffer.from('before\n'), mode = 0o644) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-change-primitive-'));
  const root = join(dir, 'target'),
    backup = join(dir, 'private-backup');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(backup, { mode: 0o700 });
  const path = join(root, 'chosen.txt'),
    slot = 'hexu-change-fixture';
  writeFileSync(path, before, { mode });
  const original = lstatSync(path);
  const pfd = openSync(root, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  const bfd = openSync(backup, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  function args(after: Buffer | null, overrides: Partial<Record<number, string>> = {}) {
    return [
      'chosen.txt',
      slot,
      mode & 0o111 ? '100755' : '100644',
      after === null ? 'delete' : '100644',
      String(before.length),
      String(after?.length ?? 0),
      String(original.dev),
      String(original.ino),
    ].map((v, i) => overrides[i] ?? v);
  }
  function call(
    after: Buffer | null,
    overrides: Partial<Record<number, string>> = {},
    input?: Buffer,
  ) {
    return spawnSync(helper, args(after, overrides), {
      stdio: ['pipe', 'pipe', 'pipe', pfd, bfd],
      input: input ?? Buffer.concat([before, after ?? Buffer.alloc(0)]),
      encoding: 'utf8',
      timeout: 5000,
      env: { LC_ALL: 'C' },
    });
  }
  return {
    dir,
    root,
    backup,
    path,
    slot,
    before,
    original,
    pfd,
    bfd,
    args,
    call,
    close() {
      closeSync(pfd);
      closeSync(bfd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const [name, before, after, mode, expected] of [
  ['text', Buffer.from('old\n'), Buffer.from('new\n'), 0o644, 0o644],
  ['binary', Buffer.from([0, 255, 10]), Buffer.from([255, 0, 128]), 0o600, 0o600],
  ['empty', Buffer.from('old'), Buffer.alloc(0), 0o644, 0o644],
  ['executable-bit', Buffer.from('old'), Buffer.from('new'), 0o600, 0o700],
] as const)
  test(`替换${name}保留原inode于私有备份，字节/权限确认且不改其他文件`, linux, () => {
    const f = fixture(before, mode);
    try {
      writeFileSync(join(f.root, 'unselected'), 'KEEP');
      const r = f.call(after, expected & 0o111 ? { 3: '100755' } : {});
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.stdout, `changed ${inode(f.original)} ${inode(lstatSync(f.path))}\n`);
      assert.deepEqual(readFileSync(f.path), after);
      assert.deepEqual(readFileSync(join(f.backup, f.slot)), before);
      assert.equal(inode(lstatSync(join(f.backup, f.slot))), inode(f.original));
      assert.equal(lstatSync(f.path).mode & 0o777, expected);
      assert.equal(lstatSync(join(f.backup, f.slot)).mode & 0o777, mode);
      assert.equal(readFileSync(join(f.root, 'unselected'), 'utf8'), 'KEEP');
      assert.deepEqual(readdirSync(f.backup), [f.slot]);
      assert.equal(
        f.call(after).status,
        20,
        'repeating a primitive is refused, never re-exchanged',
      );
      assert.deepEqual(readFileSync(f.path), after);
      assert.deepEqual(readFileSync(join(f.backup, f.slot)), before);
    } finally {
      f.close();
    }
  });
test('删除通过不覆盖移入私有备份，原inode/内容保留且重复不改名', linux, () => {
  const f = fixture();
  try {
    const r = f.call(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, `changed ${inode(f.original)} deleted\n`);
    assert.deepEqual(readdirSync(f.root), []);
    assert.deepEqual(readFileSync(join(f.backup, f.slot)), f.before);
    assert.equal(inode(lstatSync(join(f.backup, f.slot))), inode(f.original));
    assert.equal(f.call(null).status, 20);
  } finally {
    f.close();
  }
});
for (const change of [
  'bytes',
  'inode',
  'symlink',
  'hardlink',
  'directory',
  'setuid',
  'backup-permissions',
  'backup-occupied',
] as const)
  test(`写前${change}变化拒绝，不生成材料或丢失用户改动`, linux, () => {
    const f = fixture();
    try {
      if (change === 'bytes') writeFileSync(f.path, 'USER');
      if (change === 'inode' || change === 'symlink' || change === 'directory') {
        // Disposable fixture only; product paths never use unlink/rm.
        rmSync(f.path);
        if (change === 'inode') writeFileSync(f.path, f.before);
        if (change === 'symlink') symlinkSync('/missing-fixture', f.path);
        if (change === 'directory') mkdirSync(f.path);
      }
      if (change === 'hardlink') linkSync(f.path, join(f.root, 'other-name'));
      if (change === 'setuid') chmodSync(f.path, 0o4644);
      if (change === 'backup-permissions') chmodSync(f.backup, 0o755);
      if (change === 'backup-occupied') writeFileSync(join(f.backup, f.slot), 'USER BACKUP');
      const beforeStat = lstatSync(f.path),
        names = readdirSync(f.backup);
      for (const after of [Buffer.from('after'), null]) {
        const r = f.call(after);
        assert.equal(r.status, 20, r.stdout + r.stderr);
        assert.equal(inode(lstatSync(f.path)), inode(beforeStat));
        assert.deepEqual(readdirSync(f.backup), names);
      }
      if (change === 'bytes') assert.equal(readFileSync(f.path, 'utf8'), 'USER');
      if (change === 'backup-occupied')
        assert.equal(readFileSync(join(f.backup, f.slot), 'utf8'), 'USER BACKUP');
    } finally {
      f.close();
    }
  });
test('短/长输入、错身份、模式、路径和长度声明全在命名写入前拒绝', linux, () => {
  const f = fixture();
  try {
    const after = Buffer.from('after');
    for (const [overrides, input] of [
      [{ 0: '../outside' }, undefined],
      [{ 0: '.git' }, undefined],
      [{ 1: '../outside' }, undefined],
      [{ 1: 'unscoped-slot' }, undefined],
      [{ 2: '104755' }, undefined],
      [{ 3: '104755' }, undefined],
      [{ 5: '8388609' }, undefined],
      [{ 6: '0' }, undefined],
      [{}, Buffer.alloc(0)],
      [{}, Buffer.concat([f.before, after, Buffer.from('extra')])],
    ] as const) {
      const r = f.call(after, overrides, input);
      assert.equal(r.status, 20, r.stdout + r.stderr);
      assert.deepEqual(readFileSync(f.path), f.before);
      assert.deepEqual(readdirSync(f.backup), []);
    }
  } finally {
    f.close();
  }
});
test('读取前固定fd后用户改动仍在首个命名写入前拒绝', linux, async () => {
  const f = fixture();
  const after = Buffer.from('after');
  const child = spawn(helper, f.args(after), {
    stdio: ['pipe', 'pipe', 'pipe', f.pfd, f.bfd],
    env: { LC_ALL: 'C' },
  });
  const outcome = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const deadline = Date.now() + 3000;
    let pinned = false;
    while (Date.now() < deadline) {
      try {
        pinned = readlinkSync(`/proc/${child.pid}/fd/5`) === f.path;
      } catch {
        /* not yet opened */
      }
      if (pinned) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(pinned, 'helper has opened original target and is blocked only on fixture stdin');
    writeFileSync(f.path, 'USER AFTER OPEN');
    child.stdin!.end(Buffer.concat([f.before, after]));
    assert.equal(await outcome, 20);
    assert.equal(readFileSync(f.path, 'utf8'), 'USER AFTER OPEN');
    assert.deepEqual(readdirSync(f.backup), []);
  } finally {
    child.stdin!.end();
    await outcome;
    f.close();
  }
});

// A named fixture interposes precisely at the native namespace syscall, rather
// than relying on a scheduling sleep to happen to win a user-edit race.
const raceSource = fileURLToPath(
  new URL('../../tests/fixtures/integration-change-race.c', import.meta.url),
);
for (const deletion of [false, true])
  for (const race of [
    'edit',
    'replace',
    'sync-failed',
    'exit-after-rename',
    'unsupported',
    ...(deletion ? ['occupied-backup'] : ['replace-stage']),
  ])
    test(`${deletion ? '移出' : '替换'}最终原子边界${race}保留全部材料且不报成功`, linux, () => {
      const f = fixture();
      try {
        const library = join(f.dir, 'fixture-race.so');
        const built = spawnSync(
          'cc',
          ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', raceSource, '-o', library, '-ldl'],
          { encoding: 'utf8' },
        );
        assert.equal(built.status, 0, built.stderr);
        const after = deletion ? null : Buffer.from('after');
        const r = spawnSync(helper, f.args(after), {
          stdio: ['pipe', 'pipe', 'pipe', f.pfd, f.bfd],
          input: Buffer.concat([f.before, after ?? Buffer.alloc(0)]),
          encoding: 'utf8',
          timeout: 5000,
          env: { LC_ALL: 'C', LD_PRELOAD: library, HEXU_DISPOSABLE_RACE: race },
        });
        const expected =
          race === 'exit-after-rename'
            ? 86
            : deletion && (race === 'unsupported' || race === 'occupied-backup')
              ? 20
              : 21;
        assert.equal(r.status, expected, r.stdout + r.stderr);
        assert(!r.stdout.startsWith('changed '));
        if (race === 'unsupported' || race === 'occupied-backup') {
          assert.deepEqual(readFileSync(f.path), f.before);
          if (!deletion) assert.deepEqual(readFileSync(join(f.backup, f.slot)), after);
          if (race === 'occupied-backup')
            assert.equal(readFileSync(join(f.backup, f.slot), 'utf8'), 'USER RACE');
        } else {
          assert.deepEqual(
            readFileSync(join(f.backup, f.slot)),
            race === 'edit' || race === 'replace' ? Buffer.from('USER RACE') : f.before,
          );
          if (deletion) assert(!readdirSync(f.root).includes('chosen.txt'));
          else
            assert.deepEqual(
              readFileSync(f.path),
              race === 'replace-stage' ? Buffer.from('USER RACE') : after,
            );
          if (race === 'replace')
            assert.deepEqual(readFileSync(join(f.root, 'fixture-original-moved')), f.before);
          if (race === 'replace-stage')
            assert.deepEqual(readFileSync(join(f.backup, 'fixture-stage-moved')), after);
        }
      } finally {
        f.close();
      }
    });

for (const deletion of [false, true])
  test(`节点包装器重验${deletion ? '移出' : '替换'}后原文件备份与目标Git对象`, linux, async () => {
    const { randomUUID } = await import('node:crypto');
    const { objectHash } = await import('../apps/runner/src/agent/checkpoint-objects.js');
    const { PinnedRestoreParent } = await import(
      '../apps/runner/src/agent/checkpoint-restore-files.js'
    );
    const { inspectRestoreTarget } = await import(
      '../apps/runner/src/agent/checkpoint-restore-plan.js'
    );
    const {
      observeIntegrationChangeTarget,
      checkIntegrationChangeHelper,
      publishIntegrationFileChange,
    } = await import('../apps/runner/src/agent/integration-change-files.js');
    const f = fixture(),
      name = `hexu-change-${randomUUID()}`;
    const target = new PinnedRestoreParent(observeIntegrationChangeTarget(f.path));
    const backup = new PinnedRestoreParent(inspectRestoreTarget(join(f.backup, name), [f.root]));
    try {
      checkIntegrationChangeHelper();
      const after = deletion ? null : Buffer.from('confirmed after');
      const beforeEntry = {
        path: 'chosen.txt',
        kind: 'file' as const,
        gitMode: '100644' as const,
        bytes: f.before.length,
        objectId: objectHash('sha1', 'blob', f.before),
      };
      const afterEntry = after
        ? { ...beforeEntry, bytes: after.length, objectId: objectHash('sha1', 'blob', after) }
        : null;
      const result = publishIntegrationFileChange(
        target,
        backup,
        {
          before: beforeEntry,
          after: afterEntry,
          originalIdentity: inode(f.original),
          backupName: name,
        },
        f.before,
        after,
      );
      assert(result);
      assert.equal(result.backupIdentity, inode(f.original));
      assert.equal(result.targetIdentity, deletion ? null : inode(lstatSync(f.path)));
      assert.deepEqual(readFileSync(join(f.backup, name)), f.before);
      if (after) assert.deepEqual(readFileSync(f.path), after);
      else assert.deepEqual(readdirSync(f.root), []);
    } finally {
      target.close();
      backup.close();
      f.close();
    }
  });

test('节点包装器不从错误对象字节发布，固定父链被替换后拒绝', linux, async () => {
  const { randomUUID } = await import('node:crypto');
  const { renameSync } = await import('node:fs');
  const { objectHash } = await import('../apps/runner/src/agent/checkpoint-objects.js');
  const { PinnedRestoreParent } = await import(
    '../apps/runner/src/agent/checkpoint-restore-files.js'
  );
  const { inspectRestoreTarget } = await import(
    '../apps/runner/src/agent/checkpoint-restore-plan.js'
  );
  const { observeIntegrationChangeTarget, publishIntegrationFileChange } = await import(
    '../apps/runner/src/agent/integration-change-files.js'
  );
  const f = fixture(),
    name = `hexu-change-${randomUUID()}`;
  const target = new PinnedRestoreParent(observeIntegrationChangeTarget(f.path));
  const backup = new PinnedRestoreParent(inspectRestoreTarget(join(f.backup, name), [f.root]));
  try {
    const before = {
      path: 'chosen.txt',
      kind: 'file' as const,
      gitMode: '100644' as const,
      bytes: f.before.length,
      objectId: objectHash('sha1', 'blob', f.before),
    };
    const change = { before, after: null, originalIdentity: inode(f.original), backupName: name };
    assert.throws(
      () => publishIntegrationFileChange(target, backup, change, Buffer.from('invalid'), null),
      /未写入/,
    );
    renameSync(f.root, join(f.dir, 'moved'));
    mkdirSync(f.root, { mode: 0o700 });
    writeFileSync(f.path, 'USER');
    assert.throws(
      () => publishIntegrationFileChange(target, backup, change, f.before, null),
      /变化/,
    );
    assert.equal(readFileSync(f.path, 'utf8'), 'USER');
    assert.deepEqual(readFileSync(join(f.dir, 'moved', 'chosen.txt')), f.before);
    assert.deepEqual(readdirSync(f.backup), []);
  } finally {
    target.close();
    backup.close();
    f.close();
  }
});
