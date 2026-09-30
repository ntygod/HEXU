import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  parseIntegrationCreate,
  parseIntegrationReport,
} from '../packages/contracts/src/integrations.js';
import { integrationFixture } from './helpers/integrations.js';
import { IntegrationStore } from '../packages/db/src/integrations.js';
import { Store } from '../packages/db/src/store.js';
import { recordResultCode } from './helpers/result-code.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';

test('固定来源、目标和恢复副本创建一次，原Task/Run不变；重开记录、取消与回执保留', async () => {
  const f = await integrationFixture();
  try {
    const untouched = [
      'tasks',
      'runs',
      'node_dispatches',
      'work_branches',
      'work_branch_choices',
      'result_revisions',
    ];
    const snapshot = () =>
      untouched.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot(),
      b = f.body(),
      key = randomUUID();
    const r = await f.api.call(f.integrationPath, f.alice, b, key);
    assert.equal(r.statusCode, 201, r.body);
    const o = r.json().operation;
    assert.equal(o.source.revisionId, f.saved.revisionId);
    assert.equal(o.target.manifest.commit, f.target.commit);
    assert.equal(o.applied, false);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual((await f.api.call(f.integrationPath, f.alice, b, key)).json(), r.json());
    assert.equal(
      (await f.api.call(f.integrationPath, f.alice, { ...b, confirmPreflight: false }, key))
        .statusCode,
      400,
    );
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      assert.equal(
        reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
          new IntegrationStore(reopened).get(f.task.id, o.id),
        ).operation.state,
        'queued',
      );
    } finally {
      reopened.close();
    }
    const cancelPath = `${f.integrationPath}/${o.id}/cancel`,
      cancelKey = randomUUID();
    assert.equal((await f.api.call(cancelPath, f.alice, { expectedRevision: 99 })).statusCode, 409);
    const closed = await f.api.call(cancelPath, f.alice, { expectedRevision: 1 }, cancelKey);
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().operation.state, 'cancelled');
    assert.equal(closed.json().operation.history.length, 2);
    assert.deepEqual(
      (await f.api.call(cancelPath, f.alice, { expectedRevision: 1 }, cancelKey)).json(),
      closed.json(),
    );
    assert.equal(
      (await f.protocol('publish', f.report({ operation: o } as never))).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(f.integrationPath, f.alice, b, key)).json().operation.state,
      'cancelled',
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    await f.close();
  }
});

test('严格契约拒绝写入字段、伪造清单及跨任务/版本/节点，当前任务修订与占用分别核对', async () => {
  const f = await integrationFixture(undefined, 'sha256');
  try {
    for (const extra of [
      { apply: true },
      { run: true },
      { targetPath: '/tmp/other' },
      { sourceMaterial: { kind: 'text', id: f.sr.request.id } },
    ])
      assert.throws(() => parseIntegrationCreate({ ...f.body(), ...extra }));
    const v = await f.create(),
      report = f.report(v);
    assert.throws(() =>
      parseIntegrationReport({ ...report, plan: { ...report.plan, applied: true } }),
    );
    assert.throws(() =>
      parseIntegrationReport({
        ...report,
        plan: { ...report.plan, files: [{ ...report.plan.files[0], action: 'delete' }] },
      }),
    );
    assert.throws(() =>
      parseIntegrationReport({
        ...report,
        plan: { ...report.plan, files: [{ ...report.plan.files[0], path: '../secret' }] },
      }),
    );
    const other = await f.api.task(f.alice, f.project.id);
    assert.equal(
      (await f.api.call(`tasks/${other.id}/integrations`, f.alice, f.body())).statusCode,
      409,
    );
    assert.equal(
      (
        await f.api.call(f.integrationPath, f.alice, {
          ...f.body(),
          resultRevisionId: randomUUID(),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await f.api.call(f.integrationPath, f.alice, { ...f.body(), expectedTaskRevision: 99 }))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.protocol('inspect', { integrationId: v.operation.id }, 1)).statusCode,
      404,
    );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(f.integrationPath, f.bob, f.body())).statusCode, 403);
    assert.equal(
      (
        await f.api.call(`${f.integrationPath}/${v.operation.id}/cancel`, f.bob, {
          expectedRevision: 1,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.protocol('publish', { ...report, inputHash: 'd'.repeat(64) })).statusCode,
      409,
    );
    assert.equal(
      (
        await f.protocol('publish', {
          ...report,
          plan: { ...report.plan, sourceSnapshotHash: 'd'.repeat(64) },
        })
      ).statusCode,
      409,
    );
    // Same node busy in a different directory/branch is conservatively unavailable.
    f.api.store.db
      .prepare("UPDATE node_dispatches SET stage='started' WHERE run_id=?")
      .run(f.read().branches[0]!.runId);
    assert.equal((await f.api.call(f.integrationPath, f.alice, f.body())).statusCode, 409);
    assert.equal((await f.protocol('publish', report)).statusCode, 409);
    assert.equal(
      (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).json().available,
      false,
    );
  } finally {
    await f.close();
  }
});

test('报告不可覆盖；丢失回执可在材料失效后对账，取消不等于应用，撤权不能借旧回执', async () => {
  const f = await integrationFixture();
  try {
    const v = await f.create(),
      report = f.report(v),
      r = await f.protocol('publish', report);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().state, 'awaiting_choice');
    assert.equal(
      (
        await f.protocol('publish', {
          ...report,
          observedAt: new Date(Date.now() + 1).toISOString(),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.api.call(`${f.integrationPath}/${v.operation.id}/cancel`, f.alice, {
          expectedRevision: 2,
        })
      ).statusCode,
      200,
    );
    f.retained.report(f.ns[0]!.token, {
      requestId: f.tr.request.id,
      requestHash: f.tr.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    const replay = await f.protocol('publish', report);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().state, 'cancelled');
    const read = (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).json();
    assert.equal(read.available, false);
    assert.equal(read.operation.report.plan.applied, false);
    assert.equal(read.operation.history.length, 3);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal((await f.protocol('publish', report)).statusCode, 401);
    assert.equal(
      (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test('创建、历史、outbox与幂等回执共同回滚；报告中途失败保留原排队记录', async () => {
  const f = await integrationFixture();
  try {
    const key = randomUUID(),
      body = f.body();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_integration BEFORE INSERT ON integration_events BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await f.api.call(f.integrationPath, f.alice, body, key)).statusCode, 500);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM integration_operations').get()!.n,
      0,
    );
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_records WHERE key=?').get(key)!
        .n,
      0,
    );
    f.api.store.db.exec('DROP TRIGGER fail_integration');
    const created = await f.api.call(f.integrationPath, f.alice, body, key);
    assert.equal(created.statusCode, 201, created.body);
    const report = f.report(created.json());
    f.api.store.db.exec(
      "CREATE TRIGGER fail_integration BEFORE INSERT ON outbox WHEN NEW.kind LIKE 'integration.%' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await f.protocol('publish', report)).statusCode, 500);
    let v = (
      await f.api.call(`${f.integrationPath}/${created.json().operation.id}`, f.alice)
    ).json();
    assert.equal(v.operation.state, 'queued');
    assert.equal(v.operation.report, null);
    assert.equal(v.operation.history.length, 1);
    f.api.store.db.exec('DROP TRIGGER fail_integration');
    assert.equal((await f.protocol('publish', report)).statusCode, 200);
    v = (await f.api.call(`${f.integrationPath}/${created.json().operation.id}`, f.alice)).json();
    assert.equal(v.operation.history.length, 2);
  } finally {
    await f.close();
  }
});

test('跨节点仅接受已确认接收的独立副本，原副本删除不抹掉接收材料，来源节点撤权仍阻止对账', async () => {
  const f = await integrationFixture();
  try {
    const cp = await recordResultCode(f, f.target, 1),
      target = f.retain(cp.checkpointId, f.target, 1),
      transfers = new CheckpointTransferStore(f.api.store);
    const transfer = f.as(() =>
      transfers.create(
        f.task.id,
        f.sourceCp.checkpointId,
        f.sr.request.id,
        {
          targetNodeId: f.ns[1]!.nodeId,
          expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
          confirmTransfer: true,
        },
        randomUUID(),
      ),
    );
    const body = {
      ...f.body(),
      targetCheckpointId: cp.checkpointId,
      targetRetentionId: target.request.id,
      sourceMaterial: { kind: 'transfer', id: transfer.ticket.id },
    };
    assert.equal((await f.api.call(f.integrationPath, f.alice, body)).statusCode, 409);
    // Control-only received metadata fixture. Real encrypted byte transport is tested separately.
    f.api.store.db
      .prepare("UPDATE checkpoint_transfers SET state='received',received_at=? WHERE id=?")
      .run(new Date().toISOString(), transfer.ticket.id);
    const r = await f.api.call(f.integrationPath, f.alice, body);
    assert.equal(r.statusCode, 201, r.body);
    const report = f.report(r.json());
    assert.equal((await f.protocol('publish', report)).statusCode, 404);
    f.retained.report(f.ns[0]!.token, {
      requestId: f.sr.request.id,
      requestHash: f.sr.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    assert.equal((await f.protocol('publish', report, 1)).statusCode, 200);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal((await f.protocol('publish', report, 1)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('材料到期后历史报告仍可读取与对账，但不能借旧预检创建新的材料读取', async (t) => {
  const f = await integrationFixture();
  try {
    const v = await f.create(),
      report = f.report(v);
    assert.equal((await f.protocol('publish', report)).statusCode, 200);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const integrations = new IntegrationStore(f.api.store);
    const view = f.as(() => integrations.get(f.task.id, v.operation.id));
    assert.equal(view.available, false);
    assert.deepEqual(view.operation.report, report);
    assert.throws(
      () => f.as(() => integrations.create(f.task.id, f.body(), randomUUID())),
      /恢复副本|到期/,
    );
    assert.equal(integrations.publish(f.ns[0]!.token, report).state, 'awaiting_choice');
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
