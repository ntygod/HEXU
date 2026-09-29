import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { transferFixture, silent, noAsk } from './helpers/checkpoint-transfer.js';
import { localRestorePreflight } from '../apps/runner/src/agent/checkpoint-restore-preflight.js';
import {
  localRestoreCheckpoint,
  cleanupRestoreCheckpoint,
} from '../apps/runner/src/agent/checkpoint-restore.js';
import {
  RestoreJournal,
  readRestoreProgress,
} from '../apps/runner/src/agent/checkpoint-restore-journal.js';
import { reportRestoreCheckpoint } from '../apps/runner/src/agent/checkpoint-restore-report.js';
import { TransferVault, localTransfer } from '../apps/runner/src/agent/checkpoint-transfer.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import { CheckpointRestoreResultStore } from '../packages/db/src/checkpoint-restore-results.js';
import { DomainError } from '../packages/contracts/src/index.js';
import { nodeRequest } from '../apps/runner/src/agent/connection.js';

const yes = async (q: string) => /(?:PLAN|RESTORE|PUBLISH|CLEAN|REPORT) [0-9a-f-]{36}/.exec(q)![0];
const code = (value: string) => (e: unknown) => e instanceof DomainError && e.code === value;
type Fixture = Awaited<ReturnType<typeof transferFixture>>;
const output = (f: Fixture) => join(f.dir, 'receiver-output');
const restore = (
  f: Fixture,
  ask = yes,
  onProgress?: NonNullable<Parameters<typeof localRestoreCheckpoint>[4]>['onProgress'],
) =>
  localRestoreCheckpoint(f.receiverHome, f.id, output(f), ask, {
    sourceKind: 'transfer',
    log: silent,
    onProgress,
  });
const plan = (f: Fixture, ask = yes) =>
  localRestorePreflight(f.receiverHome, f.id, output(f), ask, silent, undefined, 'transfer');
const report = (f: Fixture, ask = yes) =>
  reportRestoreCheckpoint(f.receiverHome, output(f), ask, silent);
const resultPath = (f: Fixture) => `${f.transferPath}/${f.id}/restores`;
const receive = async (f: Fixture) => {
  await f.accept();
  await f.send();
  await f.receive();
};
const saved = async (f: Fixture) => (await f.api.call(resultPath(f), f.alice)).json();
function mutateCopy(f: Fixture, sql: string) {
  const vault = new TransferVault(f.receiverHome);
  try {
    vault.db.exec(sql);
  } finally {
    vault.close();
  }
}
function revoke(f: Fixture, receiver: boolean) {
  const id = receiver ? f.receiver.nodeId : f.node.nodeId;
  const account = receiver ? f.bob : f.alice;
  const revision = Number(
    f.api.store.db.prepare('SELECT revision FROM runner_nodes WHERE id=?').get(id)!.revision,
  );
  f.api.store.as({ user: account.user, spaceId: account.spaceId }, () =>
    f.registry.revoke(id, revision, randomUUID()),
  );
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 双账号实际传输后按接收来源预检、恢复、报告；不改来源凭证或两端现场`, async () => {
    const f = await transferFixture(format);
    try {
      await receive(f);
      const head = await readFile(join(f.root, '.git/HEAD')),
        index = await readFile(join(f.root, '.git/index'));
      const ticketBefore = (await f.read())[0],
        transferred = await f.readTransfers();
      const p = await plan(f);
      assert.equal(p.source.kind, 'transfer');
      assert.equal(p.source.nodeId, f.receiver.nodeId);
      assert.equal(p.source.workspaceId, null);
      assert.equal(p.source.transfer!.source.nodeId, f.node.nodeId);
      assert.equal(p.restored, false);
      assert.equal(p.writeAuthorized, false);
      assert(!existsSync(output(f)));
      await rename(f.root, f.root + '-moved'); // Independent objects, no source probing.
      const r = await restore(f);
      assert.equal(r.state, 'restored');
      assert.equal(r.sourceKind, 'transfer');
      assert.equal(r.transferId, f.id);
      assert.deepEqual(
        await readFile(join(output(f), 'src/binary.dat')),
        Buffer.from([0, 1, 255, 13, 10, 128]),
      );
      assert(!existsSync(join(output(f), '.git')));
      assert.equal(
        await readFile(join(f.receiverRoot, 'untouched.txt'), 'utf8'),
        'Recipient private working data',
      );
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git/HEAD')), head);
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git/index')), index);
      const receipt = await report(f);
      assert.equal(receipt.receipt.latest.sourceKind, 'transfer');
      assert.equal(receipt.receipt.latest.nodeId, f.receiver.nodeId);
      assert.equal(receipt.receipt.latest.ownerId, f.bob.user.id);
      assert.equal(receipt.receipt.latest.sourceNodeId, f.node.nodeId);
      assert.equal(receipt.receipt.latest.sourceRequestId, f.first.request.id);
      assert.equal((await saved(f)).items.length, 1);
      const legacy = await f.api.call(`${f.path}/${f.first.request.id}/restores`, f.alice);
      assert.equal(legacy.json().items.length, 0);
      const wrongHistory = await f.api.call(
        `${f.path}/${f.first.request.id}/restores/${r.id}/reports`,
        f.alice,
      );
      assert.equal(wrongHistory.statusCode, 404);
      await writeFile(join(output(f), 'README.md'), 'User edits must survive');
      assert.equal((await restore(f, noAsk)).id, r.id);
      assert.equal(await readFile(join(output(f), 'README.md'), 'utf8'), 'User edits must survive');
      await rename(output(f), output(f) + '-moved');
      assert.equal((await report(f, noAsk)).receipt.acceptedSequence, 1);
      const payload = JSON.stringify(await saved(f));
      for (const secret of [
        f.receiverHome,
        f.receiverRoot,
        f.root,
        f.token,
        f.receiverToken,
        'binary.dat',
      ])
        assert(!payload.includes(secret));
      assert.deepEqual((await f.read())[0], ticketBefore);
      assert.deepEqual(await f.readTransfers(), transferred);
      for (const table of ['runs', 'continuation_operations', 'node_continuation_operations'])
        assert.equal(f.api.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    } finally {
      await f.close();
    }
  });
test('未接受、未完成接收、待确认接收回执都不能恢复，也不隐式初始化或确认', async () => {
  const f = await transferFixture();
  try {
    await assert.rejects(plan(f));
    assert(!existsSync(join(f.receiverHome, 'checkpoint-transfers')));
    await f.accept();
    await assert.rejects(plan(f), code('RESTORE_NOT_AVAILABLE'));
    await f.send();
    f.dropNext('/runner/v1/checkpoint-transfer', 'received');
    await assert.rejects(f.receive());
    await assert.rejects(plan(f), code('RESTORE_NOT_AVAILABLE'));
    assert(!existsSync(output(f)));
    assert(!existsSync(join(f.receiverHome, 'checkpoint-restores')));
    await f.receive();
    assert.equal((await plan(f)).restored, false);
  } finally {
    await f.close();
  }
});
test('发送者不能把自己密文当接收副本，接收者不能把传输ID当原保留ID', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    await assert.rejects(
      localRestorePreflight(f.home, f.id, output(f), yes, silent, undefined, 'transfer'),
      code('RESTORE_NOT_AVAILABLE'),
    );
    await assert.rejects(localRestorePreflight(f.receiverHome, f.id, output(f), yes, silent));
    assert(!existsSync(output(f)));
    assert(!existsSync(join(f.receiverHome, 'retained-checkpoints')));
  } finally {
    await f.close();
  }
});
test('接收副本PLAN拒绝无写入；RESTORE/PUBLISH同意分离，取消可明确清理并报告', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    await assert.rejects(
      plan(f, async () => 'NO'),
      code('CONFIRMATION_REQUIRED'),
    );
    assert(!existsSync(join(f.receiverHome, 'checkpoint-restores')));
    await assert.rejects(
      restore(f, async () => 'NO'),
      code('CONFIRMATION_REQUIRED'),
    );
    const p = await restore(f, async (q) => (q.includes('PUBLISH') ? 'NO' : yes(q)));
    assert.equal(p.state, 'cancelled');
    assert.equal(p.materialState, 'staging');
    assert(!existsSync(output(f)));
    await report(f);
    await cleanupRestoreCheckpoint(f.receiverHome, output(f), yes);
    const r = await report(f);
    assert.equal(r.receipt.latest.report.cleanup, 'cleaned');
    assert.equal(r.receipt.latest.sequence, 2);
    const h = await f.api.call(`${resultPath(f)}/${p.id}/reports`, f.alice);
    assert.deepEqual(
      h.json().items.map((v: { sequence: number }) => v.sequence),
      [2, 1],
    );
  } finally {
    await f.close();
  }
});
for (const receiver of [true, false])
  test(`发布最后阶段撤销${receiver ? '接收' : '发送'}节点，拒绝发布但不取消本机明确清理权`, async () => {
    const f = await transferFixture();
    try {
      await receive(f);
      const p = await restore(f, yes, (r) => {
        if (r.state === 'publishing') revoke(f, receiver);
      });
      assert.equal(p.state, 'failed');
      assert.notEqual(p.materialState, 'published');
      assert(!existsSync(output(f)));
      await assert.rejects(report(f));
      assert.equal((await saved(f)).items.length, 0);
      assert.equal(
        (await cleanupRestoreCheckpoint(f.receiverHome, output(f), yes)).cleanup,
        'cleaned',
      );
    } finally {
      await f.close();
    }
  });
test('发布确认期间接收凭证轮换不能沿用旧授权或管理旧暂存', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const r = await restore(f, async (q) => {
      if (q.includes('PUBLISH'))
        writeCredentials(f.receiverHome, { ...f.receiverCredentials, nodeToken: 'x'.repeat(43) });
      return yes(q);
    });
    assert.equal(r.state, 'failed');
    assert(!existsSync(output(f)));
    await assert.rejects(cleanupRestoreCheckpoint(f.receiverHome, output(f), yes));
    writeCredentials(f.receiverHome, f.receiverCredentials);
    assert.equal(
      (await cleanupRestoreCheckpoint(f.receiverHome, output(f), yes)).cleanup,
      'cleaned',
    );
  } finally {
    await f.close();
  }
});
for (const timing of ['before', 'publish'])
  test(`接收持久对象${timing}损坏拒绝，不回源修补或重新下载`, async () => {
    const f = await transferFixture();
    try {
      await receive(f);
      const corrupt = () =>
        mutateCopy(f, "UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'");
      if (timing === 'before') {
        corrupt();
        await assert.rejects(plan(f));
      } else {
        const p = await restore(f, async (q) => {
          if (q.includes('PUBLISH')) corrupt();
          return yes(q);
        });
        assert.equal(p.state, 'failed');
      }
      assert(!existsSync(output(f)));
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_transfer_chunks').get()!.n,
        0,
      );
    } finally {
      await f.close();
    }
  });
test('接收副本明确删除后禁止新恢复；原恢复和报告仍能保留历史，不重读对象', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    assert.equal((await restore(f)).state, 'restored');
    await localTransfer(f.receiverHome, f.id, 'forget', async () => `FORGET ${f.id}`, silent);
    await assert.rejects(
      localRestorePreflight(
        f.receiverHome,
        f.id,
        output(f) + '-new',
        yes,
        silent,
        undefined,
        'transfer',
      ),
      code('RESTORE_NOT_AVAILABLE'),
    );
    assert.equal((await report(f)).receipt.latest.report.state, 'restored');
    assert.equal(
      await readFile(join(output(f), 'README.md'), 'utf8'),
      'Retain only this committed snapshot\n',
    );
  } finally {
    await f.close();
  }
});
test('接收材料固定期限在PUBLISH前再次检查，拒绝过期发布且不续期', async () => {
  const f = await transferFixture();
  const now = Date.now;
  try {
    await receive(f);
    const p = await restore(f, async (q) => {
      if (q.includes('PUBLISH'))
        Date.now = () => Date.parse(f.transferView.ticket.manifest.expiresAt) + 1;
      return yes(q);
    });
    assert.equal(p.state, 'failed');
    assert.equal(p.errorCode, 'RESTORE_RETENTION_EXPIRED');
    assert(!existsSync(output(f)));
  } finally {
    Date.now = now;
    await f.close();
  }
});
test('发布前出现同名空目录也不覆盖，清理只删除本次暂存', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const p = await restore(f, async (q) => {
      if (q.includes('PUBLISH')) await mkdir(output(f));
      return yes(q);
    });
    assert.equal(p.state, 'failed');
    await cleanupRestoreCheckpoint(f.receiverHome, output(f), yes);
    assert(existsSync(output(f)));
  } finally {
    await f.close();
  }
});
test('接收恢复报告丢失回执后先确认旧取消观察，再明确发送清理，不能重复执行', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const p = await restore(f, async (q) => (q.includes('PUBLISH') ? 'NO' : yes(q)));
    f.dropNext('/runner/v1/checkpoint-transfer-restore-report');
    await assert.rejects(report(f));
    await cleanupRestoreCheckpoint(f.receiverHome, output(f), yes);
    const ack = await report(f, noAsk);
    assert.equal(ack.localChangesPending, true);
    assert.equal(ack.receipt.acceptedSequence, 1);
    assert.equal((await report(f)).receipt.latest.report.cleanup, 'cleaned');
    assert.equal(readRestoreProgress(f.receiverHome, output(f))!.id, p.id);
    assert(!existsSync(output(f)));
  } finally {
    await f.close();
  }
});
for (const table of ['checkpoint_restore_results', 'checkpoint_restore_reports', 'outbox'])
  test(`接收恢复报告${table}故障原子回滚，固定待发报告重试不重复写文件`, async () => {
    const f = await transferFixture();
    try {
      await receive(f);
      await restore(f);
      f.api.store.db.exec(
        `CREATE TRIGGER fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      await assert.rejects(report(f));
      assert.equal((await saved(f)).items.length, 0);
      f.api.store.db.exec('DROP TRIGGER fail');
      const r = await report(f, noAsk);
      assert.equal(r.receipt.latest.sequence, 1);
    } finally {
      await f.close();
    }
  });
test('接收报告禁止发送者、Cookie、错来源入口、跨传输ID；旧回执也重查当前权限', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const p = await restore(f);
    await report(f);
    const j = new RestoreJournal(f.receiverHome);
    const packet = JSON.parse(
      String(
        j.storage.db
          .prepare('SELECT last_packet FROM restore_result_delivery WHERE id=?')
          .get(p.id)!.last_packet,
      ),
    );
    j.close();
    const store = new CheckpointRestoreResultStore(f.api.store);
    assert.throws(() => store.report(f.receiverToken, packet));
    assert.throws(() => store.reportTransfer(f.token, packet));
    assert.throws(() =>
      store.reportTransfer(f.receiverToken, { ...packet, requestId: randomUUID() }),
    );
    assert.throws(() =>
      store.reportTransfer(f.receiverToken, { ...packet, sourceKind: undefined }),
    );
    const r = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/checkpoint-transfer-restore-report',
      headers: { cookie: f.bob.cookie, 'x-hexu-runner': '1' },
      payload: packet,
    });
    assert.equal(r.statusCode, 403);
    const outsider = await f.api.joinAccount(
      (await f.api.invite(f.alice, 'charlie@example.invalid')).token,
    );
    assert.equal((await f.api.call(resultPath(f), outsider)).statusCode, 404);
    const wrong = await f.api.call(
      `${f.transferPath}/${randomUUID()}/restores/${p.id}/reports`,
      f.alice,
    );
    assert.equal(wrong.statusCode, 404);
    revoke(f, true);
    await assert.rejects(report(f, noAsk));
    assert.equal((await saved(f)).items[0].nodeAuthorized, false);
  } finally {
    await f.close();
  }
});
test('真实接收恢复CLI用--transfer预检和两次确认；双来源参数明确拒绝', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const run = async (script: string, args: string[]) => {
      const c = spawn(process.execPath, [resolve(`dist/apps/runner/src/${script}.js`), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH },
      });
      let out = '';
      const supplied = new Set<string>();
      c.stdout.on('data', (b) => {
        out += b;
        for (const q of out.matchAll(/(?:PLAN|RESTORE|PUBLISH|REPORT) [0-9a-f-]{36}/g))
          if (!supplied.has(q[0])) {
            supplied.add(q[0]);
            c.stdin.write(q[0] + '\n');
          }
      });
      c.stderr.on('data', (b) => (out += b));
      const [status] = await once(c, 'close');
      return { status, out };
    };
    const args = ['--state', f.receiverHome, '--target', output(f), '--transfer', f.id];
    const bad = await run('restore-plan', [...args, '--request', f.first.request.id]);
    assert.equal(bad.status, 1);
    assert(!existsSync(output(f)));
    const planned = await run('restore-plan', args);
    assert.equal(planned.status, 0, planned.out);
    assert(planned.out.includes('"kind":"transfer"'));
    assert(!existsSync(output(f)));
    const restored = await run('restore-checkpoint', ['restore', ...args]);
    assert.equal(restored.status, 0, restored.out);
    const reported = await run('restore-checkpoint', [
      'report',
      '--state',
      f.receiverHome,
      '--target',
      output(f),
    ]);
    assert.equal(reported.status, 0, reported.out);
    assert(!reported.out.includes(f.receiverToken));
    assert(!reported.out.includes(output(f)));
  } finally {
    await f.close();
  }
});

test('传输窗口结束不撤销已确认独立副本；原材料期限内仍需当前双方权限才可恢复', async (t) => {
  const f = await transferFixture();
  try {
    await receive(f);
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.parse(f.transferView.ticket.expiresAt) + 60000,
    });
    const p = await plan(f);
    assert.equal(p.source.kind, 'transfer');
    const r = await restore(f);
    assert.equal(r.state, 'restored');
    // This test advances only the local clock. HTTP report-time validation is
    // covered with a shared real clock by the ordinary receipt tests above.
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
test('原发送副本明确删除不删接收材料；接收恢复不读取原源仓库或复活其保留回执', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const { localRetentionOperation } = await import(
      '../apps/runner/src/agent/checkpoint-retention.js'
    );
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'forget',
      async () => `DELETE ${f.first.request.id}`,
      silent,
    );
    const prior = await f.read();
    assert.equal(prior[0]!.state, 'deleted');
    assert.equal((await restore(f)).state, 'restored');
    assert.equal((await report(f)).receipt.latest.sourceKind, 'transfer');
    assert.deepEqual(await f.read(), prior);
  } finally {
    await f.close();
  }
});
test('接收恢复拒绝自身工作区和私有库重叠；不能把接收对象当作目录写授权', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    for (const target of [join(f.receiverRoot, 'new-output'), join(f.receiverHome, 'new-output')]) {
      await assert.rejects(
        localRestorePreflight(f.receiverHome, f.id, target, yes, silent, undefined, 'transfer'),
        code('RESTORE_TARGET_OVERLAP'),
      );
      assert(!existsSync(target));
    }
    assert.equal(
      await readFile(join(f.receiverRoot, 'untouched.txt'), 'utf8'),
      'Recipient private working data',
    );
  } finally {
    await f.close();
  }
});
test('确认期间接收对象库被替换，即使字节相同也拒绝使用原观察读取新位置', async () => {
  const f = await transferFixture();
  try {
    await receive(f);
    const database = join(f.receiverHome, 'checkpoint-transfers/journal.sqlite');
    const before = await readFile(database);
    await assert.rejects(
      plan(f, async (q) => {
        await rename(database, database + '-moved');
        await writeFile(database, before, { mode: 0o600 });
        return yes(q);
      }),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
    assert(!existsSync(output(f)));
  } finally {
    await f.close();
  }
});
test('收到外部实体引用仍不能恢复不完整工作目录，整份拒绝且不丢弃排除项', async () => {
  const f = await transferFixture('sha1', true);
  try {
    await receive(f);
    await assert.rejects(plan(f));
    await assert.rejects(restore(f));
    assert(!existsSync(output(f)));
    assert.equal((await saved(f)).items.length, 0);
  } finally {
    await f.close();
  }
});
