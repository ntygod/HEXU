import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DomainError } from '../packages/contracts/src/index.js';
import { transferFixture, silent, noAsk } from './helpers/checkpoint-transfer.js';
import { localTransfer, TransferVault } from '../apps/runner/src/agent/checkpoint-transfer.js';
import { RetentionVault } from '../apps/runner/src/agent/checkpoint-retention.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
for (const format of ['sha1', 'sha256'] as const)
  test(`真实${format}双用户节点加密收发、独立持久副本核验，源移动与双方工作目录不变`, async () => {
    const blob = randomBytes(150000),
      f = await transferFixture(format, false, blob);
    try {
      const before = await readFile(join(f.root, '.git', 'index')),
        reports = (await f.read())[0];
      await assert.rejects(f.send, code('TRANSFER_CONSENT_REQUIRED'));
      await f.accept();
      await rename(f.root, f.root + '-moved');
      await f.send();
      let view = (await f.readTransfers())[0]!;
      assert.equal(view.state, 'available');
      assert(view.uploadedChunks > 1);
      assert.equal(view.receivedAt, null);
      const chunks = f.api.store.db
        .prepare('SELECT data FROM checkpoint_transfer_chunks WHERE transfer_id=?')
        .all(f.id) as { data: Uint8Array }[];
      const raw = Buffer.concat(chunks.map((c) => Buffer.from(c.data)));
      for (const value of ['README.md', 'Retain only this', 'fixture@example.invalid', f.token])
        assert(!raw.includes(value));
      assert(!raw.includes(blob.subarray(0, 100)));
      await f.receive();
      view = (await f.readTransfers())[0]!;
      assert.equal(view.state, 'received');
      assert(view.receivedAt);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
        0,
      );
      const vault = new TransferVault(f.receiverHome);
      try {
        const verified = await vault.verify(f.id);
        assert(verified.objects.some((o) => o.data.equals(blob)));
        assert(!verified.objects.some((o) => o.id === f.parent));
        assert.equal(vault.row(f.id)!.private_key, null);
      } finally {
        vault.close();
      }
      const summary = await localTransfer(f.receiverHome, f.id, 'status', noAsk, silent);
      assert.equal(summary.restored, false);
      assert.equal(
        await readFile(join(f.receiverRoot, 'untouched.txt'), 'utf8'),
        'Recipient private working data',
      );
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git', 'index')), before);
      assert.deepEqual((await f.read())[0], reports);
      assert.equal((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().runs.length, 0);
      assert.deepEqual((await readdir(f.receiverHome)).sort(), [
        'checkpoint-transfers',
        'credentials.json',
      ]);
    } finally {
      await f.close();
    }
  });
for (const action of ['accept', 'begin', 'upload', 'seal', 'received'] as const)
  test(`真实HTTP ${action}回执丢失仅对账固定包，不重新生成密钥/采集/创建副本`, async () => {
    const f = await transferFixture();
    try {
      if (action !== 'accept') await f.accept();
      if (action === 'received') await f.send();
      f.dropNext('/runner/v1/checkpoint-transfer', action);
      const run = () =>
        action === 'accept' ? f.accept() : action === 'received' ? f.receive() : f.send();
      await assert.rejects(run);
      const home = action === 'accept' || action === 'received' ? f.receiverHome : f.home;
      let v = new TransferVault(home),
        row = v.row(f.id)!;
      const key = row.public_key,
        envelope = row.envelope;
      v.close();
      await localTransfer(
        home,
        f.id,
        action === 'accept' ? 'accept' : action === 'received' ? 'receive' : 'send',
        noAsk,
        silent,
      );
      v = new TransferVault(home);
      assert.equal(v.row(f.id)!.public_key, key);
      assert.equal(v.row(f.id)!.envelope, envelope);
      v.close();
      if (action !== 'received') {
        if (action === 'accept') await f.send();
        await f.receive();
      }
      assert.equal((await f.readTransfers())[0]!.state, 'received');
      assert.equal(
        f.api.store.db
          .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='checkpoint.transfer.received'")
          .get()!.n,
        1,
      );
    } finally {
      await f.close();
    }
  });
test('拒绝双方本机确认不传字节，损坏源副本不能变成完整传输', async () => {
  const f = await transferFixture();
  try {
    await assert.rejects(
      () => localTransfer(f.receiverHome, f.id, 'accept', async () => 'NO', silent),
      code('CONFIRMATION_REQUIRED'),
    );
    assert.equal((await f.readTransfers())[0]!.state, 'offered');
    await f.accept();
    await assert.rejects(
      () => localTransfer(f.home, f.id, 'send', async () => 'NO', silent),
      code('CONFIRMATION_REQUIRED'),
    );
    const v = new RetentionVault(f.home);
    v.db.prepare("UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'").run();
    v.close();
    await assert.rejects(f.send);
    assert.equal((await f.readTransfers())[0]!.state, 'accepted');
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});
test('接收副本写入事务失败全回滚，重试核验真实持久对象后才提交收到回执', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    let v = new TransferVault(f.receiverHome);
    v.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    v.close();
    await assert.rejects(f.receive);
    v = new TransferVault(f.receiverHome);
    assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    v.db.exec('DROP TRIGGER fail');
    v.close();
    assert.equal((await f.readTransfers())[0]!.state, 'available');
    await f.receive();
    assert.equal((await f.readTransfers())[0]!.state, 'received');
  } finally {
    await f.close();
  }
});
test('服务器密文损坏被接收端拒绝，不写可用对象，不启动恢复', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    f.api.store.db
      .prepare(
        'UPDATE checkpoint_transfer_chunks SET data=zeroblob(length(data)) WHERE transfer_id=?',
      )
      .run(f.id);
    await assert.rejects(f.receive, code('TRANSFER_CORRUPT'));
    assert.equal((await f.readTransfers())[0]!.receivedAt, null);
    const v = new TransferVault(f.receiverHome);
    assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    v.close();
  } finally {
    await f.close();
  }
});
test('收到回执本机保存失败后只确认原观察；明确本机删除不复活副本或撤回源记录', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    let v = new TransferVault(f.receiverHome);
    v.db.exec(
      "CREATE TRIGGER fail BEFORE UPDATE ON transfers WHEN NEW.status='received' BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    v.close();
    await assert.rejects(f.receive);
    assert.equal((await f.readTransfers())[0]!.state, 'received');
    v = new TransferVault(f.receiverHome);
    assert.equal(v.row(f.id)!.status, 'verified');
    v.db.exec('DROP TRIGGER fail');
    v.close();
    await f.receive();
    await localTransfer(f.receiverHome, f.id, 'forget', async () => `FORGET ${f.id}`, silent);
    await assert.rejects(f.receive, code('TRANSFER_DELETED'));
    v = new TransferVault(f.receiverHome);
    assert.equal(v.db.prepare('SELECT COUNT(*) AS n FROM objects').get()!.n, 0);
    assert.equal(v.row(f.id)!.status, 'forgotten');
    v.close();
    assert.equal((await f.readTransfers())[0]!.state, 'received');
    assert.equal((await f.read())[0]!.state, 'retained');
  } finally {
    await f.close();
  }
});
test('确认期间撤销接收节点阻止接受；新凭证不能管理原密钥和副本', async () => {
  const f = await transferFixture();
  try {
    await assert.rejects(() =>
      localTransfer(
        f.receiverHome,
        f.id,
        'accept',
        async () => {
          f.api.store.db
            .prepare("UPDATE runner_nodes SET revoked_at='revoked',revision=revision+1 WHERE id=?")
            .run(f.receiver.nodeId);
          return `RECEIVE ${f.id}`;
        },
        silent,
      ),
    );
    assert.equal((await f.readTransfers())[0]!.state, 'invalidated');
  } finally {
    await f.close();
  }
  const g = await transferFixture();
  try {
    await g.accept();
    writeCredentials(g.receiverHome, {
      ...g.receiverCredentials,
      nodeToken: randomBytes(32).toString('base64url'),
    });
    await assert.rejects(
      () => localTransfer(g.receiverHome, g.id, 'forget', noAsk, silent),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
  } finally {
    await g.close();
  }
});
test('已有材料含符号链接/LFS/子模块时只传原始引用，不跟随外部文件', async () => {
  const f = await transferFixture('sha1', true);
  try {
    await f.accept();
    await f.send();
    await f.receive();
    const v = new TransferVault(f.receiverHome);
    try {
      const result = await v.verify(f.id);
      assert.equal(result.coverage.gitlinks, 1);
      assert.equal(result.coverage.symlinks, 1);
      assert.equal(result.coverage.lfsPointers, 1);
    } finally {
      v.close();
    }
    assert.deepEqual((await readdir(f.receiverRoot)).sort(), ['.git', 'untouched.txt']);
  } finally {
    await f.close();
  }
});
test('真实CLI分别接受、发送、接收与本机状态，不把接收当文件恢复', async () => {
  const f = await transferFixture();
  try {
    async function cli(mode: string, home: string, input: string) {
      const child = spawn(
        process.execPath,
        [
          resolve('dist/apps/runner/src/transfer-checkpoint.js'),
          mode,
          '--state',
          home,
          '--transfer',
          f.id,
        ],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let out = '';
      child.stdout.on('data', (v) => (out += v));
      child.stderr.on('data', (v) => (out += v));
      child.stdin.end(input);
      const [status] = await once(child, 'close');
      assert.equal(status, 0, out);
      assert(!out.includes(f.token));
      assert(!out.includes(f.receiverToken));
      return out;
    }
    await cli('accept', f.receiverHome, `RECEIVE ${f.id}\n`);
    await cli('send', f.home, `SEND ${f.id}\n`);
    const out = await cli('receive', f.receiverHome, '');
    assert.match(out, /"restored":false/);
    assert.match(out, /"localState":"received"/);
    assert.match(await cli('status', f.receiverHome, ''), /"currentObjectsVerified":false/);
  } finally {
    await f.close();
  }
});
