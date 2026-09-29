import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseRestoreResultPacket } from '../packages/contracts/src/checkpoint-restore-results.js';
import { CheckpointRestoreResultStore } from '../packages/db/src/checkpoint-restore-results.js';
import { Store } from '../packages/db/src/store.js';
import { restoreResultFixture } from './helpers/checkpoint-restore-results.js';

test('恢复报告严格拒绝路径、字节、权限注入及不一致状态；第100序号仅留给清理结果', async () => {
  const f = await restoreResultFixture();
  try {
    const p = f.packet();
    for (const field of ['target', 'files', 'content', 'nodeToken', 'operatorUserId', 'runId'])
      assert.throws(() => parseRestoreResultPacket({ ...p, [field]: 'private' }));
    for (const change of [
      { target: '/private' },
      { completedFiles: 3 },
      { writtenBytes: -1 },
      { totalBytes: 67108865 },
      { state: 'restored' },
      { cleanup: 'cleaned' },
      { verifiedAt: '2099-01-01T00:00:00.000Z' },
    ])
      assert.throws(() => parseRestoreResultPacket({ ...p, report: { ...p.report, ...change } }));
    assert.throws(() => parseRestoreResultPacket({ ...p, confirmPublication: false }));
    assert.throws(() => parseRestoreResultPacket({ ...p, sequence: 100 }));
    assert.equal(
      parseRestoreResultPacket({
        ...p,
        sequence: 100,
        report: { ...p.report, cleanup: 'cleaned', materialState: 'none' },
      }).sequence,
      100,
    );
  } finally {
    await f.close();
  }
});
test('恢复/回执/outbox原子保存，旧回执返回最新清理状态且不修改Task/Run/保留记录', async () => {
  const f = await restoreResultFixture();
  try {
    const taskBefore = f.as(() => f.api.store.getTask(f.task.id));
    const retentionBefore = await f.read(),
      p = f.packet();
    const a = f.results.report(f.token, p);
    assert.equal(a.acceptedSequence, 1);
    const clean = {
      ...p,
      sequence: 2,
      report: { ...p.report, cleanup: 'cleaned', materialState: 'none' },
    };
    f.results.report(f.token, clean);
    const replay = f.results.report(f.token, p);
    assert.equal(replay.acceptedSequence, 1);
    assert.equal(replay.latest.sequence, 2);
    assert.equal(replay.latest.report.cleanup, 'cleaned');
    assert.equal(replay.acceptedHash, a.acceptedHash);
    assert.equal(
      f.api.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='checkpoint.restore.reported'")
        .get()!.n,
      2,
    );
    assert.deepEqual(
      f.as(() => f.api.store.getTask(f.task.id)),
      taskBefore,
    );
    assert.deepEqual(await f.read(), retentionBefore);
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 0);
    assert.equal(f.list().items.length, 1);
  } finally {
    await f.close();
  }
});
test('拒绝跳号、同号替换、换来源/计划/数量与未知状态伪升级成功', async () => {
  const f = await restoreResultFixture();
  try {
    const p = f.packet();
    p.report.state = 'interrupted';
    p.report.materialState = 'unknown';
    p.report.cleanup = 'needs_attention';
    f.results.report(f.token, p);
    for (const change of [
      { planHash: 'f'.repeat(64) },
      { snapshotHash: 'b'.repeat(64) },
      { totalFiles: 1 },
      { completedFiles: 1 },
      { state: 'restored', materialState: 'published', cleanup: 'not_needed' },
    ])
      assert.throws(() =>
        f.results.report(f.token, { ...p, sequence: 2, report: { ...p.report, ...change } }),
      );
    assert.throws(() => f.results.report(f.token, { ...p, sequence: 3 }));
    assert.throws(() =>
      f.results.report(f.token, {
        ...p,
        report: { ...p.report, cleanup: 'cleaned', materialState: 'none' },
      }),
    );
    assert.throws(() => f.results.report(f.token, { ...p, requestId: randomUUID() }));
    assert.equal(f.list().items[0]!.sequence, 1);
  } finally {
    await f.close();
  }
});
for (const table of ['checkpoint_restore_results', 'checkpoint_restore_reports', 'outbox'])
  test(`恢复记录事务在${table}故障全回滚，原报告安全重试`, async () => {
    const f = await restoreResultFixture();
    try {
      const p = f.packet();
      f.api.store.db.exec(
        `CREATE TRIGGER failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.throws(() => f.results.report(f.token, p));
      assert.equal(f.list().items.length, 0);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_restore_reports').get()!.n,
        0,
      );
      f.api.store.db.exec('DROP TRIGGER failure');
      assert.equal(f.results.report(f.token, p).latest.sequence, 1);
    } finally {
      await f.close();
    }
  });
test('当前任务编辑权限在旧回执前检查，永久撤销节点后恢复成员不能重放', async () => {
  const f = await restoreResultFixture();
  try {
    const p = f.packet();
    f.results.report(f.token, p);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    assert.throws(() => f.results.report(f.token, p));
    assert.equal(f.list().items.length, 1);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='manage' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    f.as(() =>
      f.registry.revoke(
        f.node.nodeId,
        Number(
          f.api.store.db.prepare('SELECT revision FROM runner_nodes WHERE id=?').get(f.node.nodeId)!
            .revision,
        ),
        randomUUID(),
      ),
    );
    assert.throws(() => f.results.report(f.token, p));
    assert.equal(f.list().items[0]!.nodeAuthorized, false);
  } finally {
    await f.close();
  }
});
test('列表/历史按当前父任务权限过滤，跨保留ID拒绝；服务端重开保留同一结果', async () => {
  const f = await restoreResultFixture();
  try {
    const p = f.packet();
    f.results.report(f.token, p);
    const other = await f.api.joinAccount((await f.api.invite(f.alice)).token);
    const path = `${f.path}/${p.requestId}/restores`;
    assert.equal((await f.api.call(path, other)).statusCode, 404);
    assert.throws(() =>
      f.as(() =>
        f.results.history(f.task.id, f.first.request.checkpointId, randomUUID(), p.restoreId, null),
      ),
    );
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const list = reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        new CheckpointRestoreResultStore(reopened).list(
          f.task.id,
          f.first.request.checkpointId,
          p.requestId,
          null,
        ),
      );
      assert.deepEqual(list, f.list());
    } finally {
      reopened.close();
    }
    f.api.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.alice.user.id);
    assert.throws(() => f.list());
    assert.throws(() =>
      f.as(() =>
        f.results.history(f.task.id, f.first.request.checkpointId, p.requestId, p.restoreId, null),
      ),
    );
  } finally {
    await f.close();
  }
});
test('恢复列表与顺序历史稳定分页，迟到回执不改变列表顺序', async () => {
  const f = await restoreResultFixture();
  try {
    const packets = Array.from({ length: 23 }, () => f.packet());
    for (const p of packets) f.results.report(f.token, p);
    const first = f.list();
    assert.equal(first.items.length, 20);
    assert(first.nextCursor);
    const second = f.as(() =>
      f.results.list(f.task.id, f.first.request.checkpointId, f.first.request.id, first.nextCursor),
    );
    assert.equal(second.items.length, 3);
    assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 23);
    const p = packets[0]!;
    p.restoreId = randomUUID();
    p.report = {
      ...p.report,
      state: 'writing',
      verifiedAt: null,
      completedFiles: 1,
      writtenBytes: 1,
    };
    for (let i = 1; i <= 23; i++)
      f.results.report(f.token, { ...p, sequence: i, report: { ...p.report, writtenBytes: i } });
    const page = f.as(() =>
      f.results.history(f.task.id, f.first.request.checkpointId, p.requestId, p.restoreId, null),
    );
    assert.equal(page.items.length, 20);
    assert.equal(page.nextCursor, 4);
    const tail = f.as(() =>
      f.results.history(
        f.task.id,
        f.first.request.checkpointId,
        p.requestId,
        p.restoreId,
        page.nextCursor,
      ),
    );
    assert.deepEqual(
      tail.items.map((r) => r.sequence),
      [3, 2, 1],
    );
  } finally {
    await f.close();
  }
});
test('Cookie/Bearer通道隔离，历史报告可在保留到期后送达但不授予新恢复权限', async () => {
  const f = await restoreResultFixture();
  try {
    const p = f.packet();
    const result = new CheckpointRestoreResultStore(
      f.api.store,
      () => Date.now() + 8 * 86400000,
    ).report(f.token, p);
    assert.equal(result.latest.report.state, 'cancelled');
    const r = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/checkpoint-restore-report',
      headers: { cookie: f.alice.cookie, 'x-hexu-runner': '1' },
      payload: p,
    });
    assert.equal(r.statusCode, 403);
    const read = await f.api.app.inject({
      url: `/api/v1/${f.path}/${p.requestId}/restores`,
      headers: { authorization: `Bearer ${f.token}`, 'x-hexu-runner': '1' },
    });
    assert.notEqual(read.statusCode, 200);
  } finally {
    await f.close();
  }
});
test('每份保留材料的恢复记录有界，满额拒绝不写半条记录；第100条清理报告仍能保存', async () => {
  const f = await restoreResultFixture();
  try {
    for (let i = 0; i < 128; i++) f.results.report(f.token, f.packet());
    assert.throws(() => f.results.report(f.token, f.packet()));
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_restore_results').get()!.n,
      128,
    );
    const first = f.list().items[0]!;
    const p = f.packet();
    p.restoreId = first.id;
    p.report = first.report;
    for (let sequence = 2; sequence < 100; sequence++)
      f.results.report(f.token, { ...p, sequence });
    const cleared = f.results.report(f.token, {
      ...p,
      sequence: 100,
      report: { ...p.report, cleanup: 'cleaned', materialState: 'none' },
    });
    assert.equal(cleared.latest.sequence, 100);
    assert.equal(cleared.latest.report.cleanup, 'cleaned');
    assert.throws(() => f.results.report(f.token, { ...p, sequence: 101 }));
  } finally {
    await f.close();
  }
});
