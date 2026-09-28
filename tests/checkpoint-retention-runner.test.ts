import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  RetentionVault,
  localRetentionOperation,
} from '../apps/runner/src/agent/checkpoint-retention.js';
import { objectHash, verifySnapshot } from '../apps/runner/src/agent/checkpoint-objects.js';
import { AgentStorage, writeCredentials } from '../apps/runner/src/agent/storage.js';
import { CheckpointRetentionStore } from '../packages/db/src/checkpoint-retention.js';
import { Store } from '../packages/db/src/store.js';
import { retentionFixture, git } from './helpers/checkpoint-retention.js';
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
const silent = () => {};
const noAsk = async () => {
  throw new Error('Must not ask or recapture');
};
for (const format of ['sha1', 'sha256'] as const)
  test(`真实 ${format} 文件闭包持久保留，原仓库移走后独立核验，原代码/index与主Runner不变`, async () => {
    const f = await retentionFixture(format);
    let guard: AgentStorage | undefined;
    try {
      guard = new AgentStorage(f.home);
      const beforeIndex = await readFile(join(f.root, '.git', 'index')),
        beforeHead = await readFile(join(f.root, '.git', 'HEAD'));
      const r = f.first.request;
      const child = spawn(
        process.execPath,
        [
          resolve('dist/apps/runner/src/cli.js'),
          'retain-checkpoint',
          '--request',
          r.id,
          '--state',
          f.home,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      let output = '';
      child.stdout.on('data', (v) => {
        output += v;
      });
      child.stderr.on('data', (v) => {
        output += v;
      });
      child.stdin.end(`RETAIN ${f.oid} 7\n`);
      const [status] = await once(child, 'close');
      assert.equal(status, 0, output);
      const saved = (await f.read())[0]!;
      assert.equal(saved.state, 'retained');
      assert.equal(saved.manifest!.coverage.files, 2);
      assert.equal(saved.manifest!.coverage.trees, 2);
      assert.equal(saved.manifest!.coverage.objects, 5);
      assert.doesNotMatch(
        JSON.stringify(saved),
        /README|private\.txt|binary\.dat|fixture@example|Local dirty|Staged only/,
      );
      assert(!JSON.stringify(saved).includes(f.root));
      assert(!output.includes(f.token));
      assert.deepEqual(await readFile(join(f.root, '.git', 'index')), beforeIndex);
      assert.deepEqual(await readFile(join(f.root, '.git', 'HEAD')), beforeHead);
      assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'Local dirty only\n');
      await rename(f.root, f.root + '-moved');
      await localRetentionOperation(f.home, r.id, 'verify', noAsk, silent);
      const verified = (await f.read())[0]!;
      assert.equal(verified.state, 'retained');
      assert.equal(verified.sequence, 2);
      assert.deepEqual(verified.manifest, saved.manifest);
      const vault = new RetentionVault(f.home);
      try {
        assert.equal(
          vault.db.prepare("SELECT COUNT(*) AS n FROM objects WHERE type='commit'").get()!.n,
          1,
        );
        assert.equal(
          vault.db.prepare('SELECT COUNT(*) AS n FROM objects WHERE oid=?').get(f.parent)!.n,
          0,
        );
        assert.equal(await vault.verify(r.id), 'verified');
      } finally {
        vault.close();
      }
      const reopened = new Store(f.api.dbPath, undefined, { team: true });
      try {
        assert.equal(
          reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
            new CheckpointRetentionStore(reopened).list(f.task.id, r.checkpointId),
          ).items[0]!.sequence,
          2,
        );
      } finally {
        reopened.close();
      }
      assert.equal((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().runs.length, 0);
    } finally {
      guard?.close();
      await f.close();
    }
  });
test('LFS只留指针、子模块只留引用、符号链接不跟随，不把外部内容计作完整代码', async () => {
  const f = await retentionFixture('sha1', true);
  try {
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'retain',
      async () => `RETAIN ${f.oid} 7`,
      silent,
    );
    const m = (await f.read())[0]!.manifest!;
    assert.equal(m.coverage.lfsPointers, 1);
    assert.equal(m.coverage.gitlinks, 1);
    assert.equal(m.coverage.symlinks, 1);
    assert.equal(m.coverage.files, 3);
    assert.equal(m.scope, 'commit_snapshot_without_ancestors_or_external_content');
  } finally {
    await f.close();
  }
});
test('缺失深层文件对象不能发布，原引用不伪装完整；拒绝本机确认不读取保留对象', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'retain', async () => 'NO', silent),
      code('CONFIRMATION_REQUIRED'),
    );
    const oid = git(f.root, 'rev-parse', `${f.oid}:src/binary.dat`);
    await rm(join(f.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent),
      code('SNAPSHOT_INCOMPLETE'),
    );
    assert.equal((await f.read())[0]!.manifest, null);
    const v = new RetentionVault(f.home);
    try {
      assert.equal(v.row(id), undefined);
      assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    } finally {
      v.close();
    }
  } finally {
    await f.close();
  }
});
test('真实HTTP发布回执丢失持久确认同一副本，不重读源仓库或续期；删除回执同样去重', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    f.dropNext();
    await assert.rejects(() =>
      localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent),
    );
    const saved = (await f.read())[0]!;
    assert.equal(saved.sequence, 1);
    await rename(f.root, f.root + '-moved');
    await localRetentionOperation(f.home, id, 'retain', noAsk, silent);
    assert.deepEqual((await f.read())[0]!.manifest, saved.manifest);
    assert.equal((await f.read())[0]!.sequence, 1);
    f.dropNext();
    await assert.rejects(() =>
      localRetentionOperation(f.home, id, 'forget', async () => `DELETE ${id}`, silent),
    );
    const v = new RetentionVault(f.home);
    try {
      assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
      assert.equal(v.row(id)!.status, 'deleted');
      assert(v.row(id)!.pending);
    } finally {
      v.close();
    }
    await localRetentionOperation(f.home, id, 'forget', noAsk, silent);
    assert.equal((await f.read())[0]!.state, 'deleted');
    assert.equal((await f.read())[0]!.sequence, 2);
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'retain', noAsk, silent),
      code('RETENTION_DELETED'),
    );
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_retention_reports').get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});
test('持久副本损坏与缺失分别报告，核验不从原仓库修补或隐式重新保留', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    await localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent);
    let v = new RetentionVault(f.home);
    try {
      v.db.prepare("UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'").run();
    } finally {
      v.close();
    }
    await localRetentionOperation(f.home, id, 'verify', noAsk, silent);
    assert.equal((await f.read())[0]!.state, 'corrupt');
    v = new RetentionVault(f.home);
    try {
      v.db.prepare("DELETE FROM objects WHERE type='blob'").run();
    } finally {
      v.close();
    }
    await localRetentionOperation(f.home, id, 'verify', noAsk, silent);
    assert.equal((await f.read())[0]!.state, 'missing');
    assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'Local dirty only\n');
  } finally {
    await f.close();
  }
});
test('本机副本写入事务故障全回滚，成功后换凭证不能借旧副本发布', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    let v = new RetentionVault(f.home);
    v.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    v.close();
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent),
      /injected/,
    );
    v = new RetentionVault(f.home);
    assert.equal(v.row(id), undefined);
    assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    v.db.exec('DROP TRIGGER fail');
    v.close();
    await localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent);
    writeCredentials(f.home, { ...f.credentials, nodeToken: 'z'.repeat(43) });
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'verify', noAsk, silent),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('本机确认期间取消不会保存对象，节点撤销后可明确删除已确认副本但不伪造回执', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    await assert.rejects(
      () =>
        localRetentionOperation(
          f.home,
          id,
          'retain',
          async () => {
            await f.api.call(`${f.path}/${id}/cancel`, f.alice, {});
            return `RETAIN ${f.oid} 7`;
          },
          silent,
        ),
      code('CHECKPOINT_REQUEST_CLOSED'),
    );
    const second = await f.create();
    await localRetentionOperation(
      f.home,
      second.request.id,
      'retain',
      async () => `RETAIN ${f.oid} 7`,
      silent,
    );
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
      f.registry.revoke(f.node.nodeId, 1, 'revoke-for-test'),
    );
    await assert.rejects(
      () =>
        localRetentionOperation(
          f.home,
          second.request.id,
          'forget',
          async () => `DELETE ${second.request.id}`,
          silent,
        ),
      code('NODE_REVOKED'),
    );
    const v = new RetentionVault(f.home);
    try {
      assert.equal(v.row(second.request.id)!.status, 'deleted');
      assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    } finally {
      v.close();
    }
    assert.equal((await f.read())[0]!.nodeAuthorized, false);
  } finally {
    await f.close();
  }
});
test('实际认证API隔离节点与浏览器，非项目受邀人看不到保留元数据，只读不能创建或取消', async () => {
  const f = await retentionFixture();
  try {
    const invite = await f.api.invite(f.alice),
      bob = await f.api.joinAccount(invite.token);
    assert.equal((await f.api.call(f.path, bob)).statusCode, 404);
    const wrong = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/checkpoint-retention-inspect',
      headers: { cookie: f.alice.cookie, 'x-hexu-runner': '1' },
      payload: { requestId: f.first.request.id },
    });
    assert.equal(wrong.statusCode, 403);
    f.api.store.db
      .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
      .run(f.project.id, bob.user.id, 'view');
    assert.equal((await f.api.call(f.path, bob)).statusCode, 200);
    assert.equal(
      (
        await f.api.call(f.path, bob, {
          days: 7,
          expectedTaskRevision: 1,
          confirmLocalRetention: true,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.api.call(`${f.path}/${f.first.request.id}/cancel`, bob, {})).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});
test('树格式、重复名字、路径逃逸、对象内容哈希和深度限制在保存前拒绝', async () => {
  const blob = Buffer.from('hello'),
    blobId = objectHash('sha1', 'blob', blob);
  for (const name of ['..', '../escape', '.git', 'a/b']) {
    const tree = Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blobId, 'hex')]),
      tid = objectHash('sha1', 'tree', tree),
      commit = Buffer.from(`tree ${tid}\n\nfixture`),
      cid = objectHash('sha1', 'commit', commit);
    await assert.rejects(
      () =>
        verifySnapshot('sha1', cid, tid, async (id) =>
          id === cid ? commit : id === tid ? tree : blob,
        ),
      code('SNAPSHOT_INCOMPLETE'),
    );
  }
  const entry = Buffer.concat([Buffer.from('100644 same\0'), Buffer.from(blobId, 'hex')]);
  for (const duplicate of [true, false]) {
    const tree = duplicate ? Buffer.concat([entry, entry]) : entry;
    const tid = objectHash('sha1', 'tree', tree),
      commit = Buffer.from(`tree ${tid}\n\nfixture`),
      cid = objectHash('sha1', 'commit', commit);
    await assert.rejects(
      () =>
        verifySnapshot('sha1', cid, tid, async (id) =>
          id === cid ? commit : id === tid ? tree : Buffer.from('corrupted'),
        ),
      code('SNAPSHOT_INCOMPLETE'),
    );
  }
  const map = new Map<string, Buffer>();
  let tree = Buffer.alloc(0),
    tid = objectHash('sha1', 'tree', tree);
  map.set(tid, tree);
  for (let i = 0; i < 66; i++) {
    tree = Buffer.concat([Buffer.from('40000 dir\0'), Buffer.from(tid, 'hex')]);
    tid = objectHash('sha1', 'tree', tree);
    map.set(tid, tree);
  }
  const commit = Buffer.from(`tree ${tid}\n\nfixture`),
    cid = objectHash('sha1', 'commit', commit);
  map.set(cid, commit);
  await assert.rejects(
    () => verifySnapshot('sha1', cid, tid, async (id) => map.get(id)!),
    code('RETENTION_LIMIT'),
  );
});

test('核验上限保留最后一个删除序号，不因历史限额锁住本机副本', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    await localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent);
    // Exercise all bounded remote/local sequence transitions, then explicitly delete.
    for (let n = 2; n <= 99; n++)
      await localRetentionOperation(f.home, id, 'verify', noAsk, silent);
    await assert.rejects(
      () => localRetentionOperation(f.home, id, 'verify', noAsk, silent),
      code('RETENTION_LIMIT'),
    );
    assert.equal((await f.read())[0]!.sequence, 99);
    await localRetentionOperation(f.home, id, 'forget', async () => `DELETE ${id}`, silent);
    const record = (await f.read())[0]!;
    assert.equal(record.sequence, 100);
    assert.equal(record.state, 'deleted');
    const vault = new RetentionVault(f.home);
    try {
      assert.equal(vault.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    } finally {
      vault.close();
    }
  } finally {
    await f.close();
  }
});
