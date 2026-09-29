import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHandoffOffer, type HandoffView } from '../packages/contracts/src/handoffs.js';
import { HandoffStore } from '../packages/db/src/handoffs.js';
import { Store } from '../packages/db/src/store.js';
import { transferFixture } from './helpers/checkpoint-transfer.js';

async function fixture(received = true) {
  const f = await transferFixture();
  try {
    if (received) {
      await f.accept();
      await f.send();
      await f.receive();
    }
    const path = `tasks/${f.task.id}/handoffs`;
    const body = {
      transferId: f.id,
      transferHash: f.transferView.ticket.requestHash,
      expectedTaskRevision: 1,
      summary: '继续接口改造',
      remainingWork: '补齐异常分支',
      environment: '使用本人配置；缺少 PAYMENT_TEST_ENDPOINT',
      hours: 24,
    };
    const offer = async (key = randomUUID()) => {
      const r = await f.api.call(path, f.alice, body, key);
      assert.equal(r.statusCode, 201, r.body);
      return r.json() as HandoffView;
    };
    return { ...f, handoffPath: path, body, offer };
  } catch (e) {
    await f.close();
    throw e;
  }
}
test('接手邀请严格拒绝伪造接受、接收身份、路径及执行授权字段', () => {
  const valid = {
    transferId: randomUUID(),
    transferHash: 'a'.repeat(64),
    expectedTaskRevision: 1,
    summary: '工作摘要',
    remainingWork: '',
    environment: '',
    hours: 24,
  };
  for (const [key, value] of Object.entries({
    state: 'accepted',
    recipientId: 'other',
    operatorUserId: 'other',
    ownerUserId: 'other',
    targetPath: '/tmp/other',
    model: 'paid-model',
    material: {},
    transferOwnership: true,
  }))
    assert.throws(() => parseHandoffOffer({ ...valid, [key]: value }));
  for (const hours of [0, 2, 168, '24'])
    assert.throws(() => parseHandoffOffer({ ...valid, hours }));
  assert.throws(() => parseHandoffOffer({ ...valid, summary: 'x'.repeat(4001) }));
  assert.throws(() => parseHandoffOffer({ ...valid, transferHash: 'not-a-hash' }));
});

test('真实双账号副本发布固定邀请，关闭或后续任务编辑不改变代码、责任、运行或材料', async () => {
  const f = await fixture();
  try {
    const tracked = [
      'tasks',
      'runs',
      'continuation_operations',
      'node_continuation_operations',
      'native_workspace_locks',
      'node_dispatches',
    ];
    const before = tracked.map((t) =>
      JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    const h = (await f.offer()).handoff;
    assert.equal(h.state, 'offered');
    assert.equal(h.sender.id, f.alice.user.id);
    assert.equal(h.material.recipient.id, f.bob.user.id);
    assert.equal(h.material.targetNodeId, f.receiver.nodeId);
    assert.equal(h.material.commit, f.oid);
    const bobView = (await f.api.call(`${f.handoffPath}/${h.id}`, f.bob)).json() as HandoffView;
    assert.equal(bobView.canReject, true);
    assert.equal(bobView.canWithdraw, false);
    const rejected = await f.api.call(`${f.handoffPath}/${h.id}/reject`, f.bob, {
      expectedRevision: 1,
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(rejected.json().handoff.state, 'rejected');
    assert.deepEqual(
      tracked.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all())),
      before,
    );
    assert.equal(
      await readFile(join(f.receiverRoot, 'untouched.txt'), 'utf8'),
      'Recipient private working data',
    );
    const changed = await f.api.call(
      `tasks/${f.task.id}`,
      f.alice,
      { title: '后续任务标题', expectedRevision: 1 },
      randomUUID(),
      'PATCH',
    );
    assert.equal(changed.statusCode, 200, changed.body);
    const view = (await f.api.call(`${f.handoffPath}/${h.id}`, f.alice)).json() as HandoffView;
    assert.equal(view.taskChanged, true);
    assert.equal(view.handoff.taskTitle, f.task.title);
    assert.equal(view.handoff.summary, f.body.summary);
    const history = await f.api.call(`${f.handoffPath}/${h.id}/history`, f.bob);
    assert.deepEqual(
      history.json().items.map((e: { action: string }) => e.action),
      ['offer', 'reject'],
    );
    assert.equal((await f.api.call(`${f.handoffPath}/${h.id}/accept`, f.bob, {})).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('同包回执返回原邀请最新状态，重复发布和过期版本不能创建或反转邀请', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      first = await f.offer(key),
      h = first.handoff;
    assert.equal((await f.offer(key)).handoff.id, h.id);
    assert.equal((await f.api.call(f.handoffPath, f.alice, f.body)).statusCode, 409);
    assert.equal(
      (await f.api.call(f.handoffPath, f.alice, { ...f.body, summary: '另一份内容' }, key))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/reject`, f.alice, { expectedRevision: 1 }))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/withdraw`, f.bob, { expectedRevision: 1 }))
        .statusCode,
      403,
    );
    const closeKey = randomUUID(),
      closeBody = { expectedRevision: 1 };
    const closed = await f.api.call(
      `${f.handoffPath}/${h.id}/withdraw`,
      f.alice,
      closeBody,
      closeKey,
    );
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal((await f.offer(key)).handoff.state, 'withdrawn');
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/withdraw`, f.alice, closeBody, closeKey)).json()
        .handoff.revision,
      2,
    );
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/reject`, f.bob, closeBody)).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(f.handoffPath, f.alice, { ...f.body, expectedTaskRevision: 2 })).statusCode,
      409,
    );
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get()!.n, 1);
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM handoff_events').get()!.n, 2);
  } finally {
    await f.close();
  }
});

test('未接收、错材料、跨任务与私有任务不能发布邀请，Cookie/Bearer不互用', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.api.call(f.handoffPath, f.alice, f.body)).statusCode, 409);
    await f.accept();
    await f.send();
    await f.receive();
    assert.equal(
      (await f.api.call(f.handoffPath, f.alice, { ...f.body, transferHash: '0'.repeat(64) }))
        .statusCode,
      409,
    );
    const other = await f.api.task(f.alice, f.project.id),
      privateTask = await f.api.task(f.alice);
    assert.equal((await f.api.call(`tasks/${other.id}/handoffs`, f.alice, f.body)).statusCode, 404);
    assert.equal(
      (await f.api.call(`tasks/${privateTask.id}/handoffs`, f.alice, f.body)).statusCode,
      422,
    );
    const h = (await f.offer()).handoff;
    assert.equal((await f.api.call(`tasks/${other.id}/handoffs/${h.id}`, f.alice)).statusCode, 404);
    const anonymous = await f.api.app.inject({ url: `/api/v1/${f.handoffPath}/${h.id}` });
    assert.equal(anonymous.statusCode, 401);
    const bearer = await f.api.app.inject({
      url: `/api/v1/${f.handoffPath}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    assert.equal(bearer.statusCode, 401);
  } finally {
    await f.close();
  }
});

test('当前项目权限控制列表、历史、动作和旧回执；移除成员后事件不泄露原任务', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      h = (await f.offer(key)).handoff;
    const asAlice = <T>(fn: () => T) =>
      f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, fn);
    asAlice(() =>
      f.api.store.collaboration.setProjectMember(f.project.id, f.bob.user.id, 'view', randomUUID()),
    );
    const readonly = await f.api.call(f.handoffPath, f.bob);
    assert.equal(readonly.statusCode, 200);
    assert.equal(readonly.json().items[0].canReject, false);
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/reject`, f.bob, { expectedRevision: 1 }))
        .statusCode,
      403,
    );
    assert.equal((await f.api.call(f.handoffPath, f.alice, f.body, key)).statusCode, 409);
    asAlice(() =>
      f.api.store.collaboration.setProjectMember(f.project.id, f.bob.user.id, null, randomUUID()),
    );
    for (const suffix of ['', `/${h.id}`, `/${h.id}/history`])
      assert.equal((await f.api.call(f.handoffPath + suffix, f.bob)).statusCode, 404);
    const events = f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () =>
      f.api.store.events(0),
    );
    assert(!JSON.stringify(events).includes(f.task.id));
    const kept = await f.api.call(`${f.handoffPath}/${h.id}/withdraw`, f.alice, {
      expectedRevision: 1,
    });
    assert.equal(kept.statusCode, 200, kept.body); // Human withdrawal remains possible after node revocation.
  } finally {
    await f.close();
  }
});

test('邀请、不可变事件与回执发生事务故障时共同回滚，原请求可重试', async () => {
  const f = await fixture();
  try {
    f.api.store.db.exec(
      "CREATE TRIGGER fail_handoff BEFORE INSERT ON outbox WHEN NEW.kind='handoff.offer' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    const key = randomUUID();
    assert.equal((await f.api.call(f.handoffPath, f.alice, f.body, key)).statusCode, 500);
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get()!.n, 0);
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM handoff_events').get()!.n, 0);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_records WHERE key=?').get(key)!
        .n,
      0,
    );
    f.api.store.db.exec('DROP TRIGGER fail_handoff;');
    const h = (await f.offer(key)).handoff;
    f.api.store.db.exec(
      "CREATE TRIGGER fail_handoff BEFORE INSERT ON outbox WHEN NEW.kind='handoff.reject' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    const rejectKey = randomUUID();
    assert.equal(
      (
        await f.api.call(
          `${f.handoffPath}/${h.id}/reject`,
          f.bob,
          { expectedRevision: 1 },
          rejectKey,
        )
      ).statusCode,
      500,
    );
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}`, f.alice)).json().handoff.state,
      'offered',
    );
    f.api.store.db.exec('DROP TRIGGER fail_handoff;');
    assert.equal(
      (
        await f.api.call(
          `${f.handoffPath}/${h.id}/reject`,
          f.bob,
          { expectedRevision: 1 },
          rejectKey,
        )
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test('并发拒绝与撤回只提交一次；邀请到期与重启保持历史，不复活旧邀请', async () => {
  const f = await fixture();
  try {
    const first = (await f.offer()).handoff;
    const responses = await Promise.all([
      f.api.call(`${f.handoffPath}/${first.id}/reject`, f.bob, { expectedRevision: 1 }),
      f.api.call(`${f.handoffPath}/${first.id}/withdraw`, f.alice, { expectedRevision: 1 }),
    ]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    let now = Date.now();
    const store = new HandoffStore(f.api.store, () => now),
      key = randomUUID();
    const asAlice = <T>(fn: () => T) =>
      f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, fn);
    const body = { ...f.body, hours: 1 };
    const h = asAlice(() => store.offer(f.task.id, body, key)).handoff;
    now += 3600001;
    store.expire();
    store.expire();
    assert.equal(asAlice(() => store.offer(f.task.id, body, key)).handoff.state, 'expired');
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const read = reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        new HandoffStore(reopened, () => now).get(f.task.id, h.id),
      );
      assert.equal(read.handoff.revision, 2);
      assert.equal(read.handoff.state, 'expired');
      assert.equal(read.canWithdraw, false);
    } finally {
      reopened.close();
    }
    const history = asAlice(() => store.history(f.task.id, h.id)).items;
    assert.deepEqual(
      history.map((e) => e.action),
      ['offer', 'expire'],
    );
    assert.equal(history[1]!.actor, null);
  } finally {
    await f.close();
  }
});

test('邀请记录有界分页且归档项目可继续人类邀请流转，不接受第二套任务或执行', async () => {
  const f = await fixture();
  try {
    const store = new HandoffStore(f.api.store);
    const asAlice = <T>(fn: () => T) =>
      f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, fn);
    for (let i = 0; i < 22; i++)
      asAlice(() => {
        const h = store.offer(f.task.id, { ...f.body, summary: `邀请 ${i}` }, randomUUID()).handoff;
        store.close(f.task.id, h.id, 'withdraw', { expectedRevision: 1 }, randomUUID());
      });
    const page = asAlice(() => store.list(f.task.id));
    assert.equal(page.items.length, 20);
    const older = asAlice(() => store.list(f.task.id, page.nextCursor));
    assert.equal(older.items.length, 2);
    assert(!older.items.some((h) => page.items.some((p) => p.handoff.id === h.handoff.id)));
    const project = asAlice(() => f.api.store.project(f.project.id));
    const archived = await f.api.call(`projects/${f.project.id}/lifecycle`, f.alice, {
      expectedRevision: project.revision,
      action: 'archive',
      activeRunAction: 'keep',
    });
    assert.equal(archived.statusCode, 200, archived.body);
    const h = (await f.offer()).handoff;
    assert.equal(
      (await f.api.call(`${f.handoffPath}/${h.id}/reject`, f.bob, { expectedRevision: 1 }))
        .statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
