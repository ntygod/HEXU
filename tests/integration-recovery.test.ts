import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  parseIntegrationRecoveryReport,
  type IntegrationRecoveryReport,
  type IntegrationView,
} from '../packages/contracts/src/integrations.js';
import { IntegrationStore } from '../packages/db/src/integrations.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';
import { codeHash } from '../packages/db/src/result-code.js';
import { migrations } from '../packages/db/src/schema.js';
import { integrationFixture } from './helpers/integrations.js';
import { recordResultCode } from './helpers/result-code.js';

type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const view = (f: Fixture, id: string) =>
  f.as(() => new IntegrationStore(f.api.store).get(f.task.id, id));
async function queued(f: Fixture, original?: IntegrationView, index = 0, owner = f.alice) {
  const v = original ?? (await f.create());
  const report = await f.protocol('publish', f.report(v), index);
  assert.equal(report.statusCode, 200, report.body);
  const ready = view(f, v.operation.id);
  const result = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, owner, {
    expectedRevision: ready.operation.revision,
    expectedTaskRevision: ready.taskRevision,
    reportHash: ready.reportHash,
    paths: ['new.txt'],
    confirmApplication: true,
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json() as IntegrationView;
}
function recovery(v: IntegrationView): IntegrationRecoveryReport {
  return {
    version: 1,
    kind: 'local_integration_settlement',
    integrationId: v.operation.id,
    applicationId: v.operation.application!.id,
    recoveryId: randomUUID(),
    integrationInputHash: v.operation.inputHash,
    applicationInputHash: v.operation.application!.inputHash,
    // A digest of the original local private application record, opaque to control.
    originalApplicationEvidenceHash: 'e'.repeat(64),
    stoppedConfirmedAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedAddedCount: 1,
    unresolvedWriteIntent: true,
    confirmPublication: true,
  };
}
const publish = (f: Fixture, report: unknown, index = 0) =>
  f.protocol('recovery-publish', report, index);
async function stage(
  f: Fixture,
  v: IntegrationView,
  stage: 'applying' | 'needs_attention' | 'completed',
) {
  const a = v.operation.application!;
  const result = await f.protocol('apply-publish', {
    integrationId: v.operation.id,
    applicationId: a.id,
    inputHash: a.inputHash,
    sequence: stage === 'applying' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    appliedPaths: stage === 'applying' ? [] : a.paths,
    reason: stage === 'needs_attention' ? 'interrupted' : null,
    confirmPublication: true,
  });
  assert.equal(result.statusCode, 200, result.body);
}
const snapshots = (f: Fixture) =>
  [
    'integration_operations',
    'integration_events',
    'tasks',
    'runs',
    'results',
    'result_revisions',
    'work_branches',
    'work_branch_choices',
    'node_dispatches',
    'idempotency_records',
  ].map((table) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${table}`).all()));

test('保留文件观察严格拒绝额外字段、路径、身份、正文、凭证与扩大语义', () => {
  const report: IntegrationRecoveryReport = {
    version: 1,
    kind: 'local_integration_settlement',
    integrationId: 'i',
    applicationId: 'a',
    recoveryId: 'r',
    integrationInputHash: 'a'.repeat(64),
    applicationInputHash: 'b'.repeat(64),
    originalApplicationEvidenceHash: 'c'.repeat(64),
    stoppedConfirmedAt: '2026-01-01T00:00:00.000Z',
    releasedAt: '2026-01-01T00:00:00.000Z',
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedAddedCount: 0,
    unresolvedWriteIntent: false,
    confirmPublication: true,
  };
  assert.deepEqual(parseIntegrationRecoveryReport(report), report);
  assert.equal(
    parseIntegrationRecoveryReport({ ...report, recordedAddedCount: 80 }).recordedAddedCount,
    80,
  );
  for (const change of [
    { version: 2 },
    { kind: 'application' },
    { disposition: 'delete_files' },
    { processEvidence: 'system_verified' },
    { lease: 'available' },
    { filesVerified: true },
    { confirmPublication: false },
    { confirmPublication: undefined },
    { recordedAddedCount: -1 },
    { recordedAddedCount: 81 },
    { recordedAddedCount: 0.5 },
    { recordedAddedCount: '1' },
    { unresolvedWriteIntent: 0 },
    { unresolvedWriteIntent: null },
    { integrationId: '../secret' },
    { applicationId: '' },
    { recoveryId: '/tmp/a' },
    { integrationInputHash: 'x' },
    { applicationInputHash: 'b'.repeat(40) },
    { originalApplicationEvidenceHash: 'z'.repeat(64) },
    { stoppedConfirmedAt: 'today' },
    { releasedAt: '2026-02-30T00:00:00.000Z' },
    { paths: ['new.txt'] },
    { ownerId: 'person' },
    { workspace: '/private' },
    { body: 'secret' },
    { token: 'secret' },
    { applied: true },
  ])
    assert.throws(() => parseIntegrationRecoveryReport({ ...report, ...change }));
  for (const key of Object.keys(report)) {
    const missing: Record<string, unknown> = { ...report };
    delete missing[key];
    assert.throws(() => parseIntegrationRecoveryReport(missing), key);
  }
});

test('观察独立保存且精确幂等，原应用各阶段、历史与Task/Run/Result原封不动', async () => {
  const f = await integrationFixture();
  try {
    for (const state of ['queued', 'applying', 'needs_attention', 'completed'] as const) {
      const v = await queued(f);
      if (state !== 'queued') await stage(f, v, 'applying');
      if (state === 'needs_attention' || state === 'completed') await stage(f, v, state);
      const before = snapshots(f),
        old = view(f, v.operation.id),
        report = recovery(v);
      assert.equal(old.recovery, null);
      const result = await publish(f, report);
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(Object.keys(result.json()).sort(), [
        'applicationId',
        'hash',
        'integrationId',
        'receivedAt',
        'recoveryId',
      ]);
      assert.equal(result.json().hash, codeHash(parseIntegrationRecoveryReport(report)));
      assert.equal(result.json().recoveryId, report.recoveryId);
      const firstOutbox = f.api.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n;
      const replay = Object.fromEntries(Object.entries(report).reverse());
      assert.deepEqual((await publish(f, replay)).json(), result.json());
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n,
        firstOutbox,
      );
      assert.deepEqual(snapshots(f), before);
      const after = view(f, v.operation.id);
      assert.deepEqual(after.operation, old.operation);
      assert.equal(after.operation.state, state);
      assert.equal(after.canApply, false);
      assert.deepEqual(after.recovery, {
        report,
        hash: result.json().hash,
        receivedAt: result.json().receivedAt,
      });
      assert.equal(
        f
          .as(() => new IntegrationStore(f.api.store).list(f.task.id))
          .items.find((x) => x.operation.id === v.operation.id)!.recovery!.hash,
        codeHash(report),
      );
      for (const change of [
        { recoveryId: randomUUID() },
        { recordedAddedCount: 0 },
        { unresolvedWriteIntent: false },
        { originalApplicationEvidenceHash: 'f'.repeat(64) },
      ]) {
        assert.equal((await publish(f, { ...report, ...change })).statusCode, 409);
      }
      assert.throws(
        () =>
          f.api.store.db
            .prepare('UPDATE integration_recovery_observations SET body=? WHERE integration_id=?')
            .run('{}', v.operation.id),
        /immutable/,
      );
      assert.throws(
        () =>
          f.api.store.db
            .prepare('DELETE FROM integration_recovery_observations WHERE integration_id=?')
            .run(v.operation.id),
        /immutable/,
      );
    }
  } finally {
    await f.close();
  }
});

test('观察核对原应用、冻结输入、选择数量与时间，不借缺失报告推断成功', async () => {
  const f = await integrationFixture();
  try {
    const missing = await f.create(),
      v = await queued(f),
      report = recovery(v),
      before = snapshots(f);
    for (const change of [
      { applicationId: randomUUID() },
      { integrationInputHash: 'd'.repeat(64) },
      { applicationInputHash: 'd'.repeat(64) },
      { recordedAddedCount: 2 },
      { stoppedConfirmedAt: '2000-01-01T00:00:00.000Z' },
      { releasedAt: new Date(Date.parse(report.stoppedConfirmedAt) - 1).toISOString() },
      { releasedAt: new Date(Date.now() + 120000).toISOString() },
    ])
      assert.equal((await publish(f, { ...report, ...change })).statusCode, 409);
    assert.equal((await publish(f, report, 1)).statusCode, 404);
    assert.equal(
      (
        await publish(f, {
          ...report,
          integrationId: missing.operation.id,
          integrationInputHash: missing.operation.inputHash,
        })
      ).statusCode,
      409,
    );
    // Corrupt a fixed input without updating its digest: the target-only recovery path
    // must still validate the stored operation itself, without fetching source metadata.
    const changed = structuredClone(v.operation);
    changed.material.manifest.expiresAt = '2000-01-01T00:00:00.000Z';
    f.api.store.db
      .prepare('UPDATE integration_operations SET body=? WHERE id=?')
      .run(JSON.stringify(changed), v.operation.id);
    assert.equal((await publish(f, report)).statusCode, 409);
    f.api.store.db
      .prepare('UPDATE integration_operations SET body=? WHERE id=?')
      .run(JSON.stringify(v.operation), v.operation.id);
    assert.deepEqual(snapshots(f), before);
    assert.equal(view(f, v.operation.id).recovery, null);
  } finally {
    await f.close();
  }
});

test('排队应用有结算观察后不再取消；更早取消的原幂等回执仍可对账且不改历史', async () => {
  const f = await integrationFixture();
  try {
    const waiting = await queued(f);
    assert.equal(waiting.canCancel, true);
    assert.equal((await publish(f, recovery(waiting))).statusCode, 200);
    const before = snapshots(f);
    assert.equal(view(f, waiting.operation.id).canCancel, false);
    const denied = await f.api.call(
      `${f.integrationPath}/${waiting.operation.id}/cancel`,
      f.alice,
      {
        expectedRevision: waiting.operation.revision,
      },
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.deepEqual(snapshots(f), before);
    assert.equal(view(f, waiting.operation.id).operation.state, 'queued');

    const original = await queued(f),
      path = `${f.integrationPath}/${original.operation.id}/cancel`,
      body = { expectedRevision: original.operation.revision },
      key = randomUUID();
    const cancelled = await f.api.call(path, f.alice, body, key);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().operation.state, 'cancelled');
    assert.equal((await publish(f, recovery(original))).statusCode, 200);
    const current = view(f, original.operation.id),
      afterRecovery = snapshots(f),
      outbox = JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all());
    assert.equal(current.canCancel, false);
    assert.deepEqual(current.operation, cancelled.json().operation);
    const replay = await f.api.call(path, f.alice, body, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), current);
    assert.deepEqual(snapshots(f), afterRecovery);
    assert.equal(JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all()), outbox);
    assert.equal(
      (await f.api.call(path, f.alice, { expectedRevision: current.operation.revision }))
        .statusCode,
      409,
    );
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.equal((await f.api.call(path, f.alice, body, key)).statusCode, 409);
    assert.deepEqual(snapshots(f), afterRecovery);
  } finally {
    await f.close();
  }
});

test('静态UI文案：取消加结算观察仅陈述原取消历史，不断言未开始本机写入', () => {
  const source = readFileSync('apps/web/src/integrations.tsx', 'utf8');
  assert.match(
    source,
    /o\.state === 'cancelled'[\s\S]*?view\.recovery\s*\? '此处保留原应用取消记录与历史；不能据此断言本机未开始写入。固定预检与所选范围保留，本机结算观察单独列出。'/,
  );
});

test('观察与hash、接收时间和outbox同事务，故障不留半条回执', async () => {
  const f = await integrationFixture();
  try {
    const v = await queued(f),
      report = recovery(v),
      before = snapshots(f);
    const oldOutbox = JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all());
    f.api.store.db.exec(
      "CREATE TRIGGER fail_recovery BEFORE INSERT ON outbox WHEN NEW.kind='integration.recovery_observed' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await publish(f, report)).statusCode, 500);
    assert.equal(view(f, v.operation.id).recovery, null);
    assert.deepEqual(snapshots(f), before);
    assert.equal(JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all()), oldOutbox);
    f.api.store.db.exec('DROP TRIGGER fail_recovery');
    assert.equal((await publish(f, report)).statusCode, 200);
    assert.equal(
      f.api.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='integration.recovery_observed'")
        .get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

async function crossOwner(f: Fixture) {
  await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: 'edit' });
  // Separate target owner in this protocol-metadata fixture; no real node/filesystem.
  f.api.store.db
    .prepare('UPDATE runner_nodes SET owner_id=? WHERE id=?')
    .run(f.bob.user.id, f.ns[1]!.nodeId);
  const as = <T>(fn: () => T) => f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, fn);
  const cp = await recordResultCode({ ...f, as }, f.target, 1);
  const target = as(() =>
    f.retained.create(
      f.task.id,
      cp.checkpointId,
      {
        days: 7,
        expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
        confirmLocalRetention: true,
      },
      randomUUID(),
    ),
  );
  const at = new Date().toISOString();
  f.retained.report(f.ns[1]!.token, {
    requestId: target.request.id,
    requestHash: target.request.requestHash,
    sequence: 1,
    confirmPublication: true,
    report: {
      state: 'retained',
      observedAt: at,
      manifest: {
        ...f.tr.manifest!,
        retainedAt: at,
        expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(),
      },
    },
  });
  const transfers = new CheckpointTransferStore(f.api.store);
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
  f.api.store.db
    .prepare("UPDATE checkpoint_transfers SET state='received',received_at=? WHERE id=?")
    .run(new Date().toISOString(), transfer.ticket.id);
  const created = await f.api.call(f.integrationPath, f.bob, {
    ...f.body(),
    targetCheckpointId: cp.checkpointId,
    targetRetentionId: target.request.id,
    sourceMaterial: { kind: 'transfer', id: transfer.ticket.id },
  });
  assert.equal(created.statusCode, 201, created.body);
  return queued(f, created.json(), 1, f.bob);
}

test('来源到期、来源节点或来源所有者撤权不阻止独立观察；目标撤权阻止新报告和旧回执', async (t) => {
  const f = await integrationFixture();
  try {
    const v = await crossOwner(f),
      report = recovery(v);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const store = new IntegrationStore(f.api.store);
    assert.throws(() => store.inspect(f.ns[1]!.token, v.operation.id));
    const first = store.publishRecovery(f.ns[1]!.token, report);
    assert.equal(first.hash, codeHash(report));
    assert.deepEqual(store.publishRecovery(f.ns[1]!.token, report), first);
    assert.equal(view(f, v.operation.id).available, false);
    f.api.store.db
      .prepare('UPDATE runner_nodes SET revoked_at=? WHERE id=?')
      .run(new Date().toISOString(), f.ns[1]!.nodeId);
    assert.throws(() => store.publishRecovery(f.ns[1]!.token, report), /撤销/);
    assert.throws(
      () => store.publishRecovery(f.ns[1]!.token, { ...report, recoveryId: randomUUID() }),
      /撤销/,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('目标节点修订、目录授权、项目降权与Task撤权始终先于旧回执检查', async () => {
  const f = await integrationFixture();
  try {
    const v = await queued(f),
      waiting = await queued(f),
      report = recovery(v),
      next = recovery(waiting);
    assert.equal((await publish(f, report)).statusCode, 200);
    const db = f.api.store.db,
      node = f.ns[0]!.nodeId;
    const grants = db.prepare('SELECT grants FROM runner_nodes WHERE id=?').get(node)!.grants;
    for (const mutation of ['revision', 'grants', 'task', 'role'] as const) {
      const taskBody = db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!
        .body as string;
      if (mutation === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision+1 WHERE id=?').run(node);
      if (mutation === 'grants')
        db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(node);
      if (mutation === 'role')
        db.prepare(
          "UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?",
        ).run(f.project.id, f.alice.user.id);
      if (mutation === 'task')
        db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
          JSON.stringify({
            ...JSON.parse(taskBody),
            visibility: 'private',
            ownerUserId: f.bob.user.id,
          }),
          f.task.id,
        );
      for (const r of [report, next])
        assert.notEqual((await publish(f, r)).statusCode, 200, mutation);
      if (mutation === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision-1 WHERE id=?').run(node);
      if (mutation === 'grants')
        db.prepare('UPDATE runner_nodes SET grants=? WHERE id=?').run(grants!, node);
      if (mutation === 'role')
        db.prepare(
          "UPDATE collab_project_members SET role='manage' WHERE project_id=? AND user_id=?",
        ).run(f.project.id, f.alice.user.id);
      if (mutation === 'task')
        db.prepare('UPDATE tasks SET body=? WHERE id=?').run(taskBody, f.task.id);
    }
    assert.equal(view(f, waiting.operation.id).recovery, null);
    // The HTTP boundary permanently revokes the old token on project downgrade.
    assert.equal((await publish(f, report)).statusCode, 401);
    assert.equal((await publish(f, next)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('migration33保留旧操作/事件字节，单应用观察有唯一性及不可变约束', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE integration_operations(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE integration_events(body TEXT);',
    );
    db.prepare('INSERT INTO integration_operations VALUES(?,?)').run('i', '{"old":"unaltered"}');
    db.prepare('INSERT INTO integration_operations VALUES(?,?)').run('j', '{"old":"other"}');
    db.prepare('INSERT INTO integration_events VALUES(?)').run('{"history":true}');
    db.exec(migrations.find((m) => m.version === 33)!.sql);
    assert.equal(
      db.prepare('SELECT body FROM integration_operations WHERE id=?').get('i')!.body,
      '{"old":"unaltered"}',
    );
    assert.equal(db.prepare('SELECT body FROM integration_events').get()!.body, '{"history":true}');
    const insert = db.prepare('INSERT INTO integration_recovery_observations VALUES(?,?,?,?,?,?)');
    insert.run('i', 'a', 'r', 'hash', 'at', '{}');
    assert.throws(() => insert.run('j', 'a', 'r2', 'hash', 'at', '{}'), /UNIQUE/);
    assert.throws(() => insert.run('j', 'a2', 'r', 'hash', 'at', '{}'), /UNIQUE/);
    assert.throws(() => insert.run('missing', 'a2', 'r2', 'hash', 'at', '{}'), /FOREIGN KEY/);
    assert.throws(
      () => db.exec("UPDATE integration_recovery_observations SET hash='changed'"),
      /immutable/,
    );
    assert.throws(() => db.exec('DELETE FROM integration_recovery_observations'), /immutable/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
