import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseTransferAction,
  parseTransferCreate,
  parseTransferTicket,
  type TransferReply,
  type TransferEnvelope,
} from '../packages/contracts/src/checkpoint-transfer.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';
import {
  transferKeys,
  bytesHash,
  decryptSnapshot,
  unpackSnapshot,
  transferDigest,
} from '../apps/runner/src/agent/checkpoint-transfer-crypto.js';
import { TransferVault, localTransfer } from '../apps/runner/src/agent/checkpoint-transfer.js';
import { transferFixture, silent, noAsk } from './helpers/checkpoint-transfer.js';
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
test('传输严格契约拒绝路径/正文/费用权限和非规范公钥，大小/期限有界', async () => {
  assert.throws(() =>
    parseTransferCreate({
      targetNodeId: 'node',
      expectedTaskRevision: 1,
      confirmTransfer: true,
      path: '/private',
    }),
  );
  assert.throws(() =>
    parseTransferAction({
      action: 'accept',
      transferId: 'id',
      requestHash: 'a'.repeat(64),
      publicKey: 'invalid',
      confirmReceive: true,
    }),
  );
  assert.throws(() => parseTransferAction({ action: 'inspect', transferId: 'id', command: 'cat' }));
  const f = await transferFixture();
  try {
    assert.throws(
      () =>
        parseTransferTicket({
          ...f.transferView.ticket,
          manifest: {
            ...f.transferView.ticket.manifest,
            coverage: { ...f.transferView.ticket.manifest.coverage, bytes: 17 * 1024 * 1024 },
          },
        }),
      code('TRANSFER_SCOPE'),
    );
    assert.throws(
      () =>
        parseTransferTicket({
          ...f.transferView.ticket,
          expiresAt: new Date(
            Date.parse(f.transferView.ticket.createdAt) + 31 * 60000,
          ).toISOString(),
        }),
      code('TRANSFER_SCOPE'),
    );
  } finally {
    await f.close();
  }
});
test('创建请求沿用修订与幂等，取消后旧创建回执不复活传输，非原所有者不能发送', async () => {
  const f = await transferFixture();
  try {
    const stale = await f.api.call(f.transferPath, f.alice, {
      ...f.transferBody,
      expectedTaskRevision: 2,
    });
    assert.equal(stale.statusCode, 409);
    const wrong = await f.api.call(f.transferPath, f.bob, f.transferBody);
    assert.equal(wrong.statusCode, 403);
    const same = await f.api.call(f.transferPath, f.alice, {
      ...f.transferBody,
      targetNodeId: f.node.nodeId,
    });
    assert.equal(same.statusCode, 409);
    const key = randomUUID(),
      created = await f.createTransfer(key);
    const path = `${f.transferPath}/${created.ticket.id}/cancel`;
    assert.equal((await f.api.call(path, f.bob, {})).statusCode, 200);
    assert.equal((await f.createTransfer(key)).state, 'cancelled');
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers').get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});
test('接收者只读或跨项目节点不能成为目标，节点配对不是材料读取授权', async () => {
  const f = await transferFixture();
  try {
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.bob.user.id);
    const options = await f.api.call(f.transferPath + '/options', f.alice);
    assert.equal(options.json().items.length, 0);
    assert(
      [403, 409].includes((await f.api.call(f.transferPath, f.alice, f.transferBody)).statusCode),
    ); // Existing coordinator may already revoke a downgraded node.
    await assert.rejects(f.accept);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='edit' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.bob.user.id);
    const otherProject = await f.api.project(f.alice);
    f.api.store.db
      .prepare('UPDATE runner_nodes SET project_id=? WHERE id=?')
      .run(otherProject.id, f.receiver.nodeId);
    assert.equal((await f.api.call(f.transferPath, f.alice, f.transferBody)).statusCode, 409);
  } finally {
    await f.close();
  }
});
for (const table of ['checkpoint_transfers', 'outbox'])
  test(`新传输${table}事务故障不留下请求或回执，原幂等键可重试`, async () => {
    const f = await transferFixture();
    try {
      const before = f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers').get()!
          .n,
        key = randomUUID();
      f.api.store.db.exec(
        `CREATE TRIGGER fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.equal(
        (await f.api.call(f.transferPath, f.alice, f.transferBody, key)).statusCode,
        500,
      );
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers').get()!.n,
        before,
      );
      f.api.store.db.exec('DROP TRIGGER fail');
      await f.createTransfer(key);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers').get()!.n,
        Number(before) + 1,
      );
    } finally {
      await f.close();
    }
  });
test('密文分块任一步事务失败不提前ACK，重放固定块并拒绝同号替换/换密钥/越权下载', async () => {
  const f = await transferFixture('sha1', false, randomBytes(140000));
  try {
    await f.accept();
    f.api.store.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON checkpoint_transfer_chunks BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    await assert.rejects(f.send);
    assert.equal((await f.readTransfers())[0]!.uploadedChunks, 0);
    f.api.store.db.exec('DROP TRIGGER fail');
    await f.send();
    const v = new TransferVault(f.home),
      r = v.row(f.id)!,
      e = JSON.parse(r.envelope!) as TransferEnvelope,
      chunks = v.chunks(f.id);
    v.close();
    const base = { transferId: f.id, requestHash: f.transferView.ticket.requestHash };
    await assert.rejects(
      () => f.call({ action: 'begin', ...base, envelope: e, confirmSend: true }),
      code('TRANSFER_ROLE'),
    );
    await assert.rejects(
      () => f.call({ action: 'chunk', ...base, sequence: 1 }, true),
      code('TRANSFER_ROLE'),
    );
    await assert.rejects(
      () =>
        f.call({
          action: 'accept',
          ...base,
          publicKey: transferKeys().publicKey,
          confirmReceive: true,
        }),
      code('TRANSFER_CONFLICT'),
    );
    await assert.rejects(
      () =>
        f.call(
          {
            action: 'begin',
            ...base,
            envelope: { ...e, noncePrefix: 'a'.repeat(16) },
            confirmSend: true,
          },
          true,
        ),
      code('TRANSFER_CONFLICT'),
    );
    const changed = Buffer.from(chunks[0]!);
    changed[0] = changed[0]! ^ 1;
    await assert.rejects(
      () =>
        f.call(
          {
            action: 'upload',
            ...base,
            sequence: 1,
            ciphertext: changed.toString('base64'),
            hash: bytesHash(changed),
          },
          true,
        ),
      code('TRANSFER_CONFLICT'),
    );
    await assert.rejects(
      () =>
        f.call({
          action: 'received',
          ...base,
          snapshotHash: '0'.repeat(64),
          confirmVerified: true,
        }),
      code('TRANSFER_CORRUPT'),
    );
    assert.equal((await f.readTransfers())[0]!.receivedAt, null);
  } finally {
    await f.close();
  }
});
test('接收回执/outbox失败一起回滚，不删除未确认密文；接收重试不再采集对象', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    f.api.store.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON outbox WHEN NEW.kind='checkpoint.transfer.received' BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    await assert.rejects(f.receive);
    assert.equal((await f.readTransfers())[0]!.state, 'available');
    assert(
      Number(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
      ) > 0,
    );
    f.api.store.db.exec('DROP TRIGGER fail');
    await f.receive();
    assert.equal((await f.readTransfers())[0]!.state, 'received');
  } finally {
    await f.close();
  }
});
test('取消和到期清除服务密文，旧收发回执不能复活；满额限制不靠忽略记录绕过', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    const before = (await f.readTransfers())[0]!;
    const store = new CheckpointTransferStore(
      f.api.store,
      () => Date.parse(before.ticket.expiresAt) + 1,
    );
    store.sweep();
    assert.equal((await f.readTransfers())[0]!.state, 'expired');
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
      0,
    );
    await assert.rejects(f.receive, code('TRANSFER_CLOSED'));
    await assert.rejects(f.send, code('TRANSFER_CLOSED'));
    for (let i = 0; i < 4; i++) await f.createTransfer();
    assert.equal((await f.api.call(f.transferPath, f.alice, f.transferBody)).statusCode, 409);
    const active = (await f.readTransfers()).find((v) => v.state === 'offered')!;
    await f.api.call(`${f.transferPath}/${active.ticket.id}/cancel`, f.bob, {});
    await f.createTransfer();
  } finally {
    await f.close();
  }
});
test('原节点永久撤销后重新加入不恢复下载或回执，当前任务只读仍能看历史但不能访问字节', async () => {
  const f = await transferFixture();
  try {
    await f.accept();
    await f.send();
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
      f.api.store.collaboration.setProjectMember(f.project.id, f.bob.user.id, null, randomUUID()),
    );
    await assert.rejects(f.receive, code('NODE_REVOKED'));
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
      f.api.store.collaboration.setProjectMember(f.project.id, f.bob.user.id, 'edit', randomUUID()),
    );
    await assert.rejects(f.receive, code('NODE_REVOKED'));
    f.transfers.sweep();
    assert.equal((await f.readTransfers())[0]!.state, 'invalidated');
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
      0,
    );
    await localTransfer(f.receiverHome, f.id, 'forget', async () => `FORGET ${f.id}`, silent);
  } finally {
    await f.close();
  }
});
test('Cookie和Bearer渠道隔离，外节点或另一任务不能读固定传输，浏览器没有下载字节接口', async () => {
  const f = await transferFixture();
  try {
    const input = { action: 'inspect', transferId: f.id };
    const cookie = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/checkpoint-transfer',
      headers: { 'x-hexu-runner': '1', cookie: f.alice.cookie, authorization: `Bearer ${f.token}` },
      payload: input,
    });
    assert.equal(cookie.statusCode, 403);
    const bearer = await f.api.app.inject({
      method: 'GET',
      url: '/api/v1/' + f.transferPath,
      headers: { authorization: `Bearer ${f.token}` },
    });
    assert.equal(bearer.statusCode, 401);
    const task = await f.api.task(f.alice, f.project.id);
    const cross = f.transferPath.replace(f.task.id, task.id);
    assert.equal((await f.api.call(cross, f.alice)).statusCode, 404);
    await assert.rejects(
      () => f.call({ action: 'inspect', transferId: randomUUID() }),
      code('NOT_FOUND'),
    );
  } finally {
    await f.close();
  }
});
test('X25519/AES-GCM认证绑定传输身份、接收密钥、分块序号与完整包，重新计算外层哈希也不能伪造', async () => {
  const f = await transferFixture('sha1', false, randomBytes(140000));
  try {
    await f.accept();
    await f.send();
    const source = new TransferVault(f.home),
      target = new TransferVault(f.receiverHome);
    const r = source.row(f.id)!,
      d = target.row(f.id)!,
      chunks = source.chunks(f.id),
      e = JSON.parse(r.envelope!) as TransferEnvelope,
      t = f.transferView.ticket;
    source.close();
    target.close();
    const bytes = decryptSnapshot(chunks, t, d.public_key, d.private_key!, e);
    assert.equal((await unpackSnapshot(bytes, t)).length, t.manifest.coverage.objects);
    const changed = chunks.map((c) => Buffer.from(c));
    changed[0]![0] = changed[0]![0]! ^ 1;
    assert.throws(
      () =>
        decryptSnapshot(changed, t, d.public_key, d.private_key!, {
          ...e,
          digest: bytesHash(Buffer.concat(changed)),
        }),
      code('TRANSFER_CORRUPT'),
    );
    const reordered = [chunks[1]!, chunks[0]!, ...chunks.slice(2)];
    assert.throws(
      () =>
        decryptSnapshot(reordered, t, d.public_key, d.private_key!, {
          ...e,
          digest: bytesHash(Buffer.concat(reordered)),
        }),
      code('TRANSFER_CORRUPT'),
    );
    const other = transferKeys();
    assert.throws(
      () => decryptSnapshot(chunks, t, other.publicKey, other.privateKey, e),
      code('TRANSFER_CORRUPT'),
    );
    const otherTicket = { ...t, id: randomUUID(), requestHash: '' };
    otherTicket.requestHash = transferDigest(otherTicket);
    assert.throws(
      () => decryptSnapshot(chunks, otherTicket, d.public_key, d.private_key!, e),
      code('TRANSFER_CORRUPT'),
    );
    await assert.rejects(
      () => unpackSnapshot(Buffer.concat([bytes, Buffer.from([0])]), t),
      code('TRANSFER_CORRUPT'),
    );
    await assert.rejects(() => unpackSnapshot(bytes.subarray(0, -1), t), code('TRANSFER_CORRUPT'));
  } finally {
    await f.close();
  }
});
