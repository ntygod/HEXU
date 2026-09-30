import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readdirSync,
  renameSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  WorkspaceLease,
  releaseWorkspaceClaim,
  workspaceReleaseReceipt,
  type WorkspaceReleaseRequest,
} from '../apps/runner/src/workspace-lease.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-release-')),
    home = join(dir, 'home'),
    root = join(dir, 'repo'),
    oldHome = process.env.HOME;
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'changed.txt'), 'USER_EDITED_KEEP');
  writeFileSync(join(root, 'extra.txt'), 'USER_EXTRA_KEEP');
  writeFileSync(join(root, '.git', 'HEAD'), 'FIXED_HEAD');
  writeFileSync(join(root, '.git', 'index'), 'FIXED_INDEX');
  process.env.HOME = home;
  const claimId = `integration:${randomUUID()}`,
    lease = new WorkspaceLease(root, claimId);
  lease.close();
  const identity = (path: string) => {
    const s = lstatSync(path);
    return `${s.dev}:${s.ino}`;
  };
  const request: WorkspaceReleaseRequest = {
    version: 1,
    recoveryId: randomUUID(),
    claimId,
    root,
    identity: identity(root),
    gitIdentity: identity(join(root, '.git')),
    evidenceHash: 'a'.repeat(64),
    stoppedConfirmedAt: new Date().toISOString(),
  };
  const registry = join(home, '.hexu', 'workspace-leases', 'registry.sqlite');
  const query = <T>(fn: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(registry);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const claim = () =>
    query((db) => db.prepare('SELECT * FROM claims WHERE dispatch_id=?').get(claimId));
  const close = () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, home, root, request, registry, query, claim, close };
}
test(
  '精确停止确认收据与原锁删除原子保存，用户文件/HEAD/index完全不动',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      const files = ['changed.txt', 'extra.txt', '.git/HEAD', '.git/index'].map((path) => ({
        path,
        bytes: readFileSync(join(f.root, path)),
        stat: lstatSync(join(f.root, path)),
      }));
      const names = readdirSync(f.root);
      assert(f.claim());
      assert.equal(workspaceReleaseReceipt(f.request), null);
      const receipt = releaseWorkspaceClaim(f.request);
      assert.equal(f.claim(), undefined);
      assert.deepEqual(workspaceReleaseReceipt(f.request), receipt);
      assert.equal(receipt.evidenceHash, f.request.evidenceHash);
      assert(receipt.releasedAt >= receipt.stoppedConfirmedAt);
      assert.deepEqual(readdirSync(f.root), names);
      for (const old of files) {
        assert.deepEqual(readFileSync(join(f.root, old.path)), old.bytes);
        assert.equal(lstatSync(join(f.root, old.path)).ino, old.stat.ino);
      }
      f.query((db) => {
        assert.throws(
          () =>
            db
              .prepare('UPDATE workspace_release_receipts SET body=? WHERE recovery_id=?')
              .run('{}', f.request.recoveryId),
          /immutable/,
        );
        assert.throws(
          () =>
            db
              .prepare('DELETE FROM workspace_release_receipts WHERE recovery_id=?')
              .run(f.request.recoveryId),
          /immutable/,
        );
      });
    } finally {
      f.close();
    }
  },
);
test('收据查找不初始化旧registry或改写任何字节', { skip: process.platform !== 'linux' }, () => {
  const f = fixture();
  try {
    const before = readFileSync(f.registry),
      names = readdirSync(join(f.home, '.hexu', 'workspace-leases'));
    assert.equal(workspaceReleaseReceipt(f.request), null);
    assert.deepEqual(readFileSync(f.registry), before);
    assert.deepEqual(readdirSync(join(f.home, '.hexu', 'workspace-leases')), names);
  } finally {
    f.close();
  }
});
test(
  '原收据重放不检查已移动目录，也不释放后来写入者的锁',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    let newer: WorkspaceLease | undefined;
    try {
      const receipt = releaseWorkspaceClaim(f.request);
      newer = new WorkspaceLease(f.root, 'newer-writer');
      renameSync(f.root, join(f.dir, 'moved'));
      mkdirSync(f.root);
      mkdirSync(join(f.root, '.git'));
      assert.deepEqual(releaseWorkspaceClaim(f.request), receipt);
      assert.deepEqual(workspaceReleaseReceipt(f.request), receipt);
      assert.equal(
        f.query((db) => db.prepare('SELECT dispatch_id FROM claims WHERE root=?').get(f.root))!
          .dispatch_id,
        'newer-writer',
      );
      assert.throws(() => new WorkspaceLease(f.root, 'another-writer'), /受管执行/);
    } finally {
      newer?.release();
      f.close();
    }
  },
);
test(
  '已有收据不能换证据或重新生成ID把另一请求当作原释放',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      releaseWorkspaceClaim(f.request);
      assert.throws(
        () => workspaceReleaseReceipt({ ...f.request, evidenceHash: 'b'.repeat(64) }),
        /不一致/,
      );
      assert.throws(
        () => releaseWorkspaceClaim({ ...f.request, recoveryId: randomUUID() }),
        /不一致/,
      );
      assert.equal(
        f.query((db) => db.prepare('SELECT COUNT(*) AS n FROM workspace_release_receipts').get())!
          .n,
        1,
      );
    } finally {
      f.close();
    }
  },
);
test(
  '原锁已经缺失且无收据时拒绝，不从缺失猜测已安全释放',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      new WorkspaceLease(f.root, f.request.claimId, true).release();
      assert.equal(workspaceReleaseReceipt(f.request), null);
      assert.throws(() => releaseWorkspaceClaim(f.request), /不一致/);
      assert.equal(workspaceReleaseReceipt(f.request), null);
    } finally {
      f.close();
    }
  },
);
for (const changed of [
  'root-replacement',
  'root-symlink',
  'git-replacement',
  'git-symlink',
  'identity',
  'foreign-claim',
  'overlap',
] as const)
  test(`结算拒绝${changed}并保留原锁`, { skip: process.platform !== 'linux' }, () => {
    const f = fixture();
    try {
      let request = f.request;
      if (changed.startsWith('root-')) {
        renameSync(f.root, join(f.dir, 'old-root'));
        if (changed === 'root-symlink') symlinkSync(join(f.dir, 'old-root'), f.root);
        else {
          mkdirSync(f.root);
          mkdirSync(join(f.root, '.git'));
        }
      }
      if (changed.startsWith('git-')) {
        renameSync(join(f.root, '.git'), join(f.root, 'old-git'));
        if (changed === 'git-symlink') symlinkSync(join(f.root, 'old-git'), join(f.root, '.git'));
        else mkdirSync(join(f.root, '.git'));
      }
      if (changed === 'identity') request = { ...request, identity: '123:456' };
      if (changed === 'foreign-claim')
        request = { ...request, claimId: `integration:${randomUUID()}` };
      if (changed === 'overlap')
        f.query((db) =>
          db
            .prepare('INSERT INTO claims VALUES(?,?,?)')
            .run(join(f.root, 'nested'), 'different-writer', '456:789'),
        );
      assert.throws(() => releaseWorkspaceClaim(request));
      assert(f.claim());
      assert.equal(workspaceReleaseReceipt(f.request), null);
    } finally {
      f.close();
    }
  });
test(
  '删除原锁失败时收据也回滚，重试原请求不会留下半条结算',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      f.query((db) =>
        db.exec(
          "CREATE TRIGGER fail_delete BEFORE DELETE ON claims BEGIN SELECT RAISE(ABORT,'fixture-delete-failed'); END;",
        ),
      );
      assert.throws(() => releaseWorkspaceClaim(f.request), /未获确认/);
      assert(f.claim());
      assert.equal(workspaceReleaseReceipt(f.request), null);
      f.query((db) => db.exec('DROP TRIGGER fail_delete'));
      assert.equal(releaseWorkspaceClaim(f.request).recoveryId, f.request.recoveryId);
      assert.equal(f.claim(), undefined);
    } finally {
      f.close();
    }
  },
);
test(
  '请求格式、非整合claim和未来停止时间均不能清锁',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      for (const change of [
        { claimId: 'unrelated-run' },
        { identity: 'bad' },
        { evidenceHash: 'bad' },
        { root: f.root + '/' },
        { version: 2 },
        { extra: 'no' },
        { stoppedConfirmedAt: new Date(Date.now() + 60000).toISOString() },
      ]) {
        assert.throws(() =>
          releaseWorkspaceClaim({ ...f.request, ...change } as WorkspaceReleaseRequest),
        );
        assert(f.claim());
      }
      assert.equal(workspaceReleaseReceipt(f.request), null);
    } finally {
      f.close();
    }
  },
);

test(
  '不能把被重定向到目标仓库内的registry当私有元数据改写',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      const home = join(f.home, '.hexu', 'workspace-leases'),
        moved = join(f.root, 'preserve-user-state');
      renameSync(home, moved);
      symlinkSync(moved, home);
      const path = join(moved, 'registry.sqlite'),
        before = readFileSync(path),
        names = readdirSync(moved);
      assert.throws(() => workspaceReleaseReceipt(f.request), /不一致/);
      assert.throws(() => releaseWorkspaceClaim(f.request), /不一致/);
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(readdirSync(moved), names);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert(db.prepare('SELECT 1 FROM claims WHERE dispatch_id=?').get(f.request.claimId));
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  },
);
test(
  '目标仓库包含租约registry时也拒绝结算，不能把相对路径检查绕过',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      const request = { ...f.request, root: f.home },
        before = readFileSync(f.registry);
      assert.throws(() => releaseWorkspaceClaim(request), /不一致/);
      assert.deepEqual(readFileSync(f.registry), before);
      assert(f.claim());
    } finally {
      f.close();
    }
  },
);
