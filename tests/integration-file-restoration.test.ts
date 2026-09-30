import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  parseIntegrationFileRestorationCreate,
  parseIntegrationFileRestorationCancel,
  parseIntegrationFileRestorationInspect,
  parseIntegrationFileRestorationReport,
  parseIntegrationFileRestorationRecoveryReport,
  type IntegrationFileRestorationRecoveryReport,
  type IntegrationFileRestorationReport,
} from '../packages/contracts/src/integration-restorations.js';
import type {
  IntegrationApplicationReport,
  IntegrationView,
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
const endpoint = (f: Fixture, v: IntegrationView) =>
  `${f.integrationPath}/${v.operation.id}/restore`;
const body = (v: IntegrationView) => ({
  applicationId: v.operation.application!.id,
  applicationInputHash: v.operation.application!.inputHash,
  completedReportHash: v.completedReportHash!,
  paths: v.operation.application!.paths,
  expectedRevision: v.operation.revision,
  expectedTaskRevision: v.taskRevision,
  confirmFileRestoration: true,
});
const snapshot = (
  f: Fixture,
  tables = [
    'integration_operations',
    'integration_events',
    'tasks',
    'runs',
    'node_dispatches',
    'result_revisions',
    'work_branches',
    'work_branch_choices',
  ],
) => tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
async function completed(f: Fixture, initial?: IntegrationView, index = 0, owner = f.alice) {
  const first = initial ?? (await f.create()),
    report = f.report(first);
  // A deterministic protocol-metadata fixture with two confirmed additions.
  const added = report.plan.files.find((p) => p.path === 'new.txt')!;
  report.plan.files.push({ ...added, path: 'second.txt' });
  report.plan.changedFiles++;
  const published = await f.protocol('publish', report, index);
  assert.equal(published.statusCode, 200, published.body);
  const ready = view(f, first.operation.id);
  const applied = await f.api.call(`${f.integrationPath}/${first.operation.id}/apply`, owner, {
    expectedRevision: ready.operation.revision,
    expectedTaskRevision: ready.taskRevision,
    reportHash: ready.reportHash,
    paths: ['new.txt', 'second.txt'],
    confirmApplication: true,
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const queued = applied.json() as IntegrationView,
    a = queued.operation.application!;
  for (const stage of ['applying', 'completed'] as const) {
    const application: IntegrationApplicationReport = {
      integrationId: first.operation.id,
      applicationId: a.id,
      inputHash: a.inputHash,
      sequence: stage === 'applying' ? 1 : 2,
      stage,
      observedAt: new Date().toISOString(),
      appliedPaths: stage === 'applying' ? [] : a.paths,
      reason: null,
      confirmPublication: true,
    };
    const r = await f.protocol('apply-publish', application, index);
    assert.equal(r.statusCode, 200, r.body);
  }
  return view(f, first.operation.id);
}
async function requested(f: Fixture, initial?: IntegrationView, owner = f.alice) {
  const v = initial ?? (await completed(f)),
    result = await f.api.call(endpoint(f, v), owner, body(v));
  assert.equal(result.statusCode, 200, result.body);
  return result.json() as IntegrationView;
}
function evidence(
  v: IntegrationView,
  stage: IntegrationFileRestorationReport['stage'] = 'restoring',
  paths?: string[],
): IntegrationFileRestorationReport {
  const r = v.restoration!;
  return {
    version: 1,
    kind: 'integration_file_restoration',
    integrationId: v.operation.id,
    applicationId: r.applicationId,
    restorationId: r.id,
    inputHash: r.inputHash,
    originalApplicationEvidenceHash: 'e'.repeat(64),
    sequence: stage === 'restoring' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    restoredPaths: paths ?? (stage === 'completed' ? r.paths : []),
    reason: stage === 'restoring' || stage === 'completed' ? null : 'restoration_failed',
    confirmPublication: true,
  };
}
const publish = (f: Fixture, report: unknown, index = 0) =>
  f.protocol('restoration-publish', report, index);
const inspect = (f: Fixture, v: IntegrationView, index = 0) =>
  f.protocol(
    'restoration-inspect',
    { integrationId: v.operation.id, restorationId: v.restoration!.id },
    index,
  );
const cancelBody = (v: IntegrationView) => ({
  restorationId: v.restoration!.id,
  expectedRevision: v.restoration!.revision,
  expectedTaskRevision: v.taskRevision,
});

test('文件恢复严格契约：全量明确许可、有界路径及诚实阶段，不接受泛化恢复能力', () => {
  const request = {
    applicationId: 'application',
    applicationInputHash: 'a'.repeat(64),
    completedReportHash: 'b'.repeat(64),
    paths: ['b', 'a'],
    expectedRevision: 5,
    expectedTaskRevision: 3,
    confirmFileRestoration: true,
  };
  assert.deepEqual(parseIntegrationFileRestorationCreate(request).paths, ['a', 'b']);
  for (const invalid of [
    { confirmFileRestoration: false },
    { confirmFileRestoration: undefined },
    { force: true },
    { expectedRevision: 0 },
    { expectedTaskRevision: 1.5 },
    { applicationId: '../a' },
    { applicationInputHash: 'bad' },
    { completedReportHash: 'bad' },
    { paths: [] },
    { paths: ['a', 'a'] },
    { paths: ['../a'] },
    { paths: ['/a'] },
    { paths: ['.git/config'] },
    { paths: ['a\\b'] },
    { paths: ['a\u200db'] },
    { paths: Array.from({ length: 81 }, (_, i) => `${i}`) },
    { paths: ['a'.repeat(4097)] },
    { paths: Array.from({ length: 80 }, (_, i) => `${i}${'a'.repeat(1000)}`) },
  ])
    assert.throws(() => parseIntegrationFileRestorationCreate({ ...request, ...invalid }));
  assert.throws(() =>
    parseIntegrationFileRestorationCancel({
      restorationId: 'r',
      expectedRevision: 1,
      expectedTaskRevision: 1,
      cancelApplication: true,
    }),
  );
  assert.throws(() => parseIntegrationFileRestorationInspect({ integrationId: 'i' }));
  const report = {
    version: 1,
    kind: 'integration_file_restoration',
    integrationId: 'i',
    applicationId: 'a',
    restorationId: 'r',
    inputHash: 'c'.repeat(64),
    originalApplicationEvidenceHash: 'e'.repeat(64),
    sequence: 1,
    stage: 'restoring',
    observedAt: '2026-01-01T00:00:00.000Z',
    restoredPaths: [],
    reason: null,
    confirmPublication: true,
  };
  assert.equal(parseIntegrationFileRestorationReport(report).stage, 'restoring');
  assert.equal(
    parseIntegrationFileRestorationReport({
      ...report,
      stage: 'failed',
      reason: 'restoration_failed',
    }).sequence,
    1,
  );
  assert.deepEqual(
    parseIntegrationFileRestorationReport({
      ...report,
      sequence: 2,
      stage: 'failed',
      reason: 'restoration_failed',
      restoredPaths: ['a'],
    }).restoredPaths,
    ['a'],
  );
  for (const invalid of [
    { version: 2 },
    { kind: 'local_integration_settlement' },
    { force: true },
    { confirmPublication: false },
    { sequence: 0 },
    { sequence: 3 },
    { sequence: 2 },
    { stage: 'completed' },
    { stage: 'needs_attention', reason: 'interrupted' },
    { restoredPaths: ['a'] },
    { reason: 'restoration_failed' },
    { originalApplicationEvidenceHash: 'bad' },
    { sequence: 2, stage: 'completed' },
    { sequence: 2, stage: 'failed' },
    { stage: 'failed', reason: 'restoration_failed', restoredPaths: ['a'] },
  ])
    assert.throws(() => parseIntegrationFileRestorationReport({ ...report, ...invalid }));
});

test('恢复冻结全量选择和完成报告，单次许可、重复回执、所有阶段不改原应用历史', async () => {
  const f = await integrationFixture();
  try {
    const v = await completed(f),
      data = body(v),
      key = randomUUID(),
      before = snapshot(f);
    assert.equal(v.canRestoreFiles, true);
    assert.equal(v.completedReportHash, codeHash(v.operation.application!.reports[1]));
    for (const invalid of [
      { paths: ['new.txt'] },
      { paths: ['new.txt', 'second.txt', 'third.txt'] },
      { applicationId: 'other' },
      { applicationInputHash: 'f'.repeat(64) },
      { completedReportHash: 'f'.repeat(64) },
      { expectedRevision: v.operation.revision - 1 },
      { expectedTaskRevision: v.taskRevision + 1 },
    ]) {
      const r = await f.api.call(endpoint(f, v), f.alice, { ...data, ...invalid });
      assert.equal(r.statusCode, 409, r.body);
    }
    const created = await f.api.call(endpoint(f, v), f.alice, data, key);
    assert.equal(created.statusCode, 200, created.body);
    const q = created.json() as IntegrationView,
      r = q.restoration!;
    assert.equal(q.canRestoreFiles, false);
    assert.equal(q.canCancelFileRestoration, true);
    assert.equal(r.state, 'queued');
    assert.equal(r.revision, 1);
    const { inputHash, state, revision, reports, recovery, ...frozen } = r;
    assert.equal(inputHash, codeHash(frozen));
    assert.equal(r.completedReportHash, v.completedReportHash);
    assert.deepEqual(r.paths, v.operation.application!.paths);
    assert.deepEqual((await f.api.call(endpoint(f, v), f.alice, data, key)).json(), q);
    assert.equal((await f.api.call(endpoint(f, v), f.alice, data)).statusCode, 409);
    assert.equal(
      (await f.api.call(endpoint(f, v), f.alice, { ...data, paths: ['new.txt'] }, key)).statusCode,
      409,
    );
    const beforeStart = snapshot(f, [
      'integration_file_restorations',
      'integration_file_restoration_reports',
    ]);
    assert.equal((await publish(f, evidence(q, 'completed'))).statusCode, 409);
    assert.deepEqual(
      snapshot(f, ['integration_file_restorations', 'integration_file_restoration_reports']),
      beforeStart,
    );
    const start = evidence(q),
      started = await publish(f, start);
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.json().revision, 2);
    assert.equal(
      (await publish(f, { ...start, originalApplicationEvidenceHash: 'f'.repeat(64) })).statusCode,
      409,
    );
    assert.equal((await publish(f, evidence(q, 'completed', ['new.txt']))).statusCode, 409);
    const done = evidence(q, 'completed');
    assert.equal(
      (await publish(f, { ...done, originalApplicationEvidenceHash: 'f'.repeat(64) })).statusCode,
      409,
    );
    const finished = await publish(f, done);
    assert.equal(finished.statusCode, 200, finished.body);
    assert.equal(finished.json().revision, 3);
    const after = snapshot(f, [
      'integration_file_restorations',
      'integration_file_restoration_reports',
      'outbox',
    ]);
    assert.deepEqual((await publish(f, done)).json(), finished.json());
    const late = (await publish(f, start)).json();
    assert.equal(late.sequence, 1);
    assert.equal(late.hash, codeHash(start));
    assert.equal(late.state, 'completed');
    assert.equal(late.revision, 3);
    assert.deepEqual(
      snapshot(f, [
        'integration_file_restorations',
        'integration_file_restoration_reports',
        'outbox',
      ]),
      after,
    );
    const replay = (await f.api.call(endpoint(f, v), f.alice, data, key)).json() as IntegrationView;
    assert.equal(replay.restoration!.state, 'completed');
    assert.equal(replay.operation.state, 'completed');
    assert.deepEqual(snapshot(f), before);
    assert.deepEqual((await inspect(f, q)).json().restoration, replay.restoration);
    assert.equal(
      (
        await f.protocol('restoration-inspect', {
          integrationId: v.operation.id,
          restorationId: 'other',
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('独立恢复取消修订与开始竞争：先取消拒绝开始，先开始拒绝取消；关表单不是取消', async () => {
  const f = await integrationFixture();
  try {
    const q = await requested(f),
      before = snapshot(f),
      data = cancelBody(q),
      key = randomUUID();
    assert.equal(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, { ...data, expectedRevision: 2 }))
        .statusCode,
      409,
    );
    const cancelled = await f.api.call(endpoint(f, q) + '/cancel', f.alice, data, key);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().restoration.state, 'cancelled');
    assert.equal(cancelled.json().restoration.revision, 2);
    assert.equal(cancelled.json().canCancelFileRestoration, false);
    assert.equal((await publish(f, evidence(q))).statusCode, 409);
    assert.deepEqual(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, data, key)).json(),
      cancelled.json(),
    );
    assert.equal((await f.api.call(endpoint(f, q), f.alice, body(q))).statusCode, 409);
    assert.deepEqual(snapshot(f), before);
    const q2 = await requested(f),
      cancel2 = cancelBody(q2);
    const started = await publish(f, evidence(q2));
    assert.equal(started.statusCode, 200, started.body);
    assert.equal((await f.api.call(endpoint(f, q2) + '/cancel', f.alice, cancel2)).statusCode, 409);
    const latest = view(f, q2.operation.id);
    assert.equal(latest.canCancelFileRestoration, false);
    assert.equal(
      (await f.api.call(endpoint(f, q2) + '/cancel', f.alice, cancelBody(latest))).statusCode,
      409,
    );
    assert.equal(latest.restoration!.state, 'restoring');
    assert.equal((await inspect(f, q2)).json().restoration.state, 'restoring');
  } finally {
    await f.close();
  }
});

test('预写失败和部分失败诚实保留；失败/未知恢复不允许第二次许可', async () => {
  const f = await integrationFixture();
  try {
    for (const stage of ['failed', 'needs_attention'] as const) {
      const q = await requested(f),
        before = snapshot(f);
      if (stage === 'failed') {
        const failed = { ...evidence(q, 'failed'), sequence: 1 };
        assert.equal((await publish(f, failed)).statusCode, 200);
        assert.equal((await publish(f, evidence(q))).statusCode, 409);
      } else {
        assert.equal((await publish(f, evidence(q))).statusCode, 200);
        assert.equal((await publish(f, evidence(q, stage, ['new.txt']))).statusCode, 200);
      }
      const latest = view(f, q.operation.id);
      assert.equal(latest.restoration!.state, stage);
      assert.equal(latest.canRestoreFiles, false);
      assert.equal((await f.api.call(endpoint(f, q), f.alice, body(q))).statusCode, 409);
      assert.deepEqual(snapshot(f), before);
    }
  } finally {
    await f.close();
  }
});

test('恢复请求、阶段、取消和幂等回执与outbox原子提交；故障不留半条状态', async () => {
  const f = await integrationFixture();
  try {
    const v = await completed(f),
      data = body(v),
      key = randomUUID(),
      tables = [
        'integration_file_restorations',
        'integration_file_restoration_reports',
        'idempotency_records',
        'outbox',
      ],
      before = snapshot(f, tables);
    const fail = (stage: string) =>
      f.api.store.db.exec(
        `CREATE TRIGGER fail_restoration BEFORE INSERT ON outbox WHEN NEW.kind='integration.restoration_${stage}' BEGIN SELECT RAISE(ABORT,'fixture'); END`,
      );
    const drop = () => f.api.store.db.exec('DROP TRIGGER fail_restoration');
    fail('queued');
    assert.equal((await f.api.call(endpoint(f, v), f.alice, data, key)).statusCode, 500);
    assert.deepEqual(snapshot(f, tables), before);
    drop();
    const created = await f.api.call(endpoint(f, v), f.alice, data, key),
      q = created.json() as IntegrationView;
    assert.equal(created.statusCode, 200, created.body);
    const afterRequest = snapshot(f, tables),
      cancelKey = randomUUID();
    fail('cancelled');
    assert.equal(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, cancelBody(q), cancelKey)).statusCode,
      500,
    );
    assert.deepEqual(snapshot(f, tables), afterRequest);
    drop();
    fail('restoring');
    const start = evidence(q);
    assert.equal((await publish(f, start)).statusCode, 500);
    assert.deepEqual(snapshot(f, tables), afterRequest);
    drop();
    assert.equal((await publish(f, start)).statusCode, 200);
    const afterStart = snapshot(f, tables),
      done = evidence(q, 'completed');
    fail('completed');
    assert.equal((await publish(f, done)).statusCode, 500);
    assert.deepEqual(snapshot(f, tables), afterStart);
    drop();
    assert.equal((await publish(f, done)).statusCode, 200);
  } finally {
    await f.close();
  }
});

async function crossOwner(f: Fixture) {
  await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: 'edit' });
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
  const transfers = new CheckpointTransferStore(f.api.store),
    transfer = f.as(() =>
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
  return completed(f, created.json(), 1, f.bob);
}

test('来源撤权和所有副本到期不影响本人原备份恢复；目标撤权始终阻止新操作与旧回执', async (t) => {
  const f = await integrationFixture();
  try {
    const v = await crossOwner(f),
      before = snapshot(f),
      data = body(v),
      key = randomUUID();
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const store = new IntegrationStore(f.api.store),
      as = <T>(fn: () => T) => f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, fn);
    assert.throws(() => store.inspect(f.ns[1]!.token, v.operation.id));
    const expiredView = as(() => store.get(f.task.id, v.operation.id));
    assert.equal(expiredView.available, false);
    assert.equal(expiredView.canRestoreFiles, true);
    assert.equal(expiredView.completedReportHash, v.completedReportHash);
    const q = as(() => store.restoreFiles(f.task.id, v.operation.id, data, key));
    assert.equal(q.restoration!.state, 'queued');
    assert.deepEqual(
      as(() => store.restoreFiles(f.task.id, v.operation.id, data, key)),
      q,
    );
    const inspected = store.inspectRestoration(f.ns[1]!.token, {
      integrationId: v.operation.id,
      restorationId: q.restoration!.id,
    });
    assert.equal(inspected.restoration!.state, 'queued');
    const start = evidence(q),
      done = evidence(q, 'completed');
    assert.equal(store.publishRestoration(f.ns[1]!.token, start).state, 'restoring');
    assert.equal(store.publishRestoration(f.ns[1]!.token, done).state, 'completed');
    assert.equal(store.publishRestoration(f.ns[1]!.token, start).state, 'completed');
    const restorationSettlement = recovery(q);
    const settlementReceipt = store.publishRestorationRecovery(
      f.ns[1]!.token,
      restorationSettlement,
    );
    assert.equal(settlementReceipt.hash, codeHash(restorationSettlement));
    assert.deepEqual(
      store.publishRestorationRecovery(f.ns[1]!.token, restorationSettlement),
      settlementReceipt,
    );
    assert.deepEqual(snapshot(f), before);
    f.api.store.db
      .prepare('UPDATE runner_nodes SET revoked_at=? WHERE id=?')
      .run(new Date().toISOString(), f.ns[1]!.nodeId);
    assert.throws(
      () => as(() => store.restoreFiles(f.task.id, v.operation.id, data, key)),
      /撤销|不可用|授权/,
    );
    assert.throws(
      () =>
        store.inspectRestoration(f.ns[1]!.token, {
          integrationId: v.operation.id,
          restorationId: q.restoration!.id,
        }),
      /撤销/,
    );
    for (const report of [start, done, { ...done, restorationId: 'other' }])
      assert.throws(() => store.publishRestoration(f.ns[1]!.token, report), /撤销/);
    assert.throws(
      () => store.publishRestorationRecovery(f.ns[1]!.token, restorationSettlement),
      /撤销/,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('目标原节点修订、目录授权、Task范围和项目权限先于恢复旧回执', async () => {
  const f = await integrationFixture();
  try {
    const v = await completed(f),
      store = new IntegrationStore(f.api.store),
      data = body(v),
      key = randomUUID(),
      q = f.as(() => store.restoreFiles(f.task.id, v.operation.id, data, key)),
      start = evidence(q);
    store.publishRestoration(f.ns[0]!.token, start);
    const db = f.api.store.db,
      node = f.ns[0]!.nodeId,
      grants = db.prepare('SELECT grants FROM runner_nodes WHERE id=?').get(node)!.grants!,
      task = db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body as string;
    for (const change of ['revision', 'grants', 'task', 'role'] as const) {
      if (change === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision+1 WHERE id=?').run(node);
      if (change === 'grants')
        db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(node);
      if (change === 'task')
        db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
          JSON.stringify({
            ...JSON.parse(task),
            visibility: 'private',
            ownerUserId: f.bob.user.id,
          }),
          f.task.id,
        );
      if (change === 'role')
        db.prepare(
          "UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?",
        ).run(f.project.id, f.alice.user.id);
      assert.throws(
        () => f.as(() => store.restoreFiles(f.task.id, v.operation.id, data, key)),
        change,
      );
      assert.throws(
        () =>
          store.inspectRestoration(f.ns[0]!.token, {
            integrationId: v.operation.id,
            restorationId: q.restoration!.id,
          }),
        change,
      );
      assert.throws(() => store.publishRestoration(f.ns[0]!.token, start), change);
      assert.throws(
        () => store.publishRestoration(f.ns[0]!.token, evidence(q, 'completed')),
        change,
      );
      if (change === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision-1 WHERE id=?').run(node);
      if (change === 'grants')
        db.prepare('UPDATE runner_nodes SET grants=? WHERE id=?').run(grants, node);
      if (change === 'task') db.prepare('UPDATE tasks SET body=? WHERE id=?').run(task, f.task.id);
      if (change === 'role')
        db.prepare(
          "UPDATE collab_project_members SET role='manage' WHERE project_id=? AND user_id=?",
        ).run(f.project.id, f.alice.user.id);
    }
    assert.equal(view(f, v.operation.id).restoration!.reports.length, 1);
  } finally {
    await f.close();
  }
});

test('migration35不改原操作字节，恢复请求和每份报告不可替换、删除、复用原应用', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE integration_operations(id TEXT PRIMARY KEY,task_id TEXT,node_id TEXT,state TEXT,revision INTEGER,body TEXT); CREATE TABLE runner_nodes(id TEXT PRIMARY KEY);',
    );
    db.exec(
      "INSERT INTO integration_operations VALUES('i','t','n','completed',5,'{\"original\":true}'); INSERT INTO integration_operations VALUES('j','t','n','completed',5,'{}'); INSERT INTO runner_nodes VALUES('n');",
    );
    db.exec(migrations.find((m) => m.version === 35)!.sql);
    assert.equal(
      db.prepare("SELECT body FROM integration_operations WHERE id='i'").get()!.body,
      '{"original":true}',
    );
    const insert = db.prepare('INSERT INTO integration_file_restorations VALUES(?,?,?,?,?,?,?)');
    insert.run('r', 'i', 'a', 'n', 'queued', 1, '{"request":true}');
    assert.throws(() => insert.run('r2', 'i', 'a2', 'n', 'queued', 1, '{}'), /UNIQUE/);
    assert.throws(() => insert.run('r2', 'j', 'a', 'n', 'queued', 1, '{}'), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE integration_file_restorations SET body='{}'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM integration_file_restorations'), /immutable/);
    assert.throws(
      () => db.exec("UPDATE integration_operations SET body='{}' WHERE id='i'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("UPDATE integration_operations SET revision=6 WHERE id='i'"),
      /immutable/,
    );
    db.exec("INSERT INTO integration_file_restoration_reports VALUES('r',1,'hash','at','{}')");
    assert.throws(
      () => db.exec("UPDATE integration_file_restoration_reports SET body='changed'"),
      /immutable/,
    );
    assert.throws(() => db.exec('DELETE FROM integration_file_restoration_reports'), /immutable/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('固定候选的新增与修改共用完整应用指纹；恢复路径不再读取来源授权、候选或对象', async () => {
  const f = await integrationFixture();
  try {
    const initial = await f.create();
    assert.equal((await f.protocol('publish', f.report(initial))).statusCode, 200);
    const ready = view(f, initial.operation.id),
      at = new Date().toISOString();
    const trial = {
      version: 1,
      kind: 'integration_trial_difference',
      integrationId: ready.operation.id,
      trialId: randomUUID(),
      integrationInputHash: ready.operation.inputHash,
      preflightReportHash: ready.reportHash!,
      manifestHash: 'c'.repeat(64),
      selection: 'apply_source',
      selectedPaths: ['README.md', 'new.txt'],
      materializedAt: at,
      comparedAt: at,
      difference: { changedFiles: 2, omittedFiles: 2, files: [] },
      trialOnly: true,
      applied: false,
      writeAuthorized: false,
      confirmPublication: true,
    };
    const shared = await f.protocol('trial-diff-publish', trial);
    assert.equal(shared.statusCode, 200, shared.body);
    const candidate = {
      trialId: trial.trialId,
      reportHash: shared.json().hash,
      manifestHash: trial.manifestHash,
      confirmExistingChanges: true,
    };
    const selected = await f.api.call(`${f.integrationPath}/${ready.operation.id}/apply`, f.alice, {
      expectedRevision: ready.operation.revision,
      expectedTaskRevision: ready.taskRevision,
      reportHash: ready.reportHash,
      paths: trial.selectedPaths,
      confirmApplication: true,
      candidate,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    const queued = selected.json() as IntegrationView,
      a = queued.operation.application!;
    for (const stage of ['applying', 'completed'] as const) {
      const r = await f.protocol('apply-publish', {
        integrationId: queued.operation.id,
        applicationId: a.id,
        inputHash: a.inputHash,
        sequence: stage === 'applying' ? 1 : 2,
        stage,
        observedAt: new Date().toISOString(),
        appliedPaths: stage === 'applying' ? [] : a.paths,
        reason: null,
        confirmPublication: true,
      });
      assert.equal(r.statusCode, 200, r.body);
    }
    const v = view(f, ready.operation.id),
      before = snapshot(f),
      store = new IntegrationStore(f.api.store);
    Object.assign(store, {
      authority: () => assert.fail('恢复不得重新调用来源授权路径'),
      source: () => assert.fail('恢复不得读取来源'),
      material: () => assert.fail('恢复不得读取对象副本'),
      getTrial: () => assert.fail('恢复不得重新读取候选'),
    });
    const originalSettlement = {
      version: 1,
      kind: 'local_integration_settlement',
      integrationId: v.operation.id,
      applicationId: a.id,
      recoveryId: randomUUID(),
      integrationInputHash: v.operation.inputHash,
      applicationInputHash: a.inputHash,
      originalApplicationEvidenceHash: 'e'.repeat(64),
      stoppedConfirmedAt: new Date().toISOString(),
      releasedAt: new Date().toISOString(),
      disposition: 'preserve_files',
      processEvidence: 'operator_confirmed_stopped',
      lease: 'released',
      filesVerified: false,
      recordedAddedCount: 1,
      unresolvedWriteIntent: false,
      confirmPublication: true,
    };
    const originalReceipt = store.publishRecovery(f.ns[0]!.token, originalSettlement);
    assert.equal(originalReceipt.hash, codeHash(originalSettlement));
    assert.deepEqual(store.publishRecovery(f.ns[0]!.token, originalSettlement), originalReceipt);
    const q = f.as(() => store.restoreFiles(f.task.id, v.operation.id, body(v), randomUUID()));
    assert.deepEqual(q.restoration!.paths, ['README.md', 'new.txt']);
    assert.deepEqual(q.operation.application!.candidate, candidate);
    assert.equal(
      store.inspectRestoration(f.ns[0]!.token, {
        integrationId: v.operation.id,
        restorationId: q.restoration!.id,
      }).restoration!.state,
      'queued',
    );
    assert.equal(store.publishRestoration(f.ns[0]!.token, evidence(q)).state, 'restoring');
    assert.equal(
      store.publishRestoration(f.ns[0]!.token, evidence(q, 'completed')).state,
      'completed',
    );
    const settlement = recovery(q);
    assert.equal(
      store.publishRestorationRecovery(f.ns[0]!.token, settlement).hash,
      codeHash(settlement),
    );
    const final = store.inspectRestoration(f.ns[0]!.token, {
      integrationId: v.operation.id,
      restorationId: q.restoration!.id,
    });
    assert.deepEqual(final.recovery!.report, originalSettlement);
    assert.deepEqual(final.restoration!.recovery!.report, settlement);
    assert.deepEqual(snapshot(f), before);
  } finally {
    await f.close();
  }
});

function recovery(
  v: IntegrationView,
  pending: IntegrationFileRestorationReport | null = null,
): IntegrationFileRestorationRecoveryReport {
  return {
    version: 1,
    kind: 'local_integration_restoration_settlement',
    integrationId: v.operation.id,
    applicationId: v.restoration!.applicationId,
    restorationId: v.restoration!.id,
    recoveryId: randomUUID(),
    integrationInputHash: v.operation.inputHash,
    applicationInputHash: v.restoration!.applicationInputHash,
    restorationInputHash: v.restoration!.inputHash,
    originalApplicationEvidenceHash: 'e'.repeat(64),
    restorationEvidenceHash: 'f'.repeat(64),
    pendingReportHash: pending ? codeHash(pending) : null,
    stoppedConfirmedAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedRestoredCount: 0,
    unresolvedWriteIntent: true,
    confirmPublication: true,
  };
}
const settle = (f: Fixture, r: unknown, index = 0) =>
  f.protocol('restoration-recovery-publish', r, index);

test('恢复保留结算严格区分主体，不借原应用结算字段或未绑定待发包扩大许可', () => {
  const report = {
    version: 1,
    kind: 'local_integration_restoration_settlement',
    integrationId: 'i',
    applicationId: 'a',
    restorationId: 'r',
    recoveryId: 'settle',
    integrationInputHash: 'a'.repeat(64),
    applicationInputHash: 'b'.repeat(64),
    restorationInputHash: 'c'.repeat(64),
    originalApplicationEvidenceHash: 'd'.repeat(64),
    restorationEvidenceHash: 'e'.repeat(64),
    pendingReportHash: null,
    stoppedConfirmedAt: '2026-01-01T00:00:00.000Z',
    releasedAt: '2026-01-01T00:00:00.000Z',
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedRestoredCount: 2,
    unresolvedWriteIntent: true,
    confirmPublication: true,
  };
  assert.equal(parseIntegrationFileRestorationRecoveryReport(report).recordedRestoredCount, 2);
  assert.equal(
    parseIntegrationFileRestorationRecoveryReport({ ...report, pendingReportHash: 'f'.repeat(64) })
      .pendingReportHash,
    'f'.repeat(64),
  );
  for (const invalid of [
    { kind: 'local_integration_settlement' },
    { restorationId: undefined },
    { restorationInputHash: 'bad' },
    { restorationEvidenceHash: 'bad' },
    { pendingReportHash: undefined },
    { pendingReportHash: 'bad' },
    { recordedAddedCount: 2 },
    { recordedRestoredCount: -1 },
    { recordedRestoredCount: 81 },
    { recordedRestoredCount: 1.5 },
    { filesVerified: true },
    { disposition: 'restore_files' },
    { processEvidence: 'auto_confirmed' },
    { lease: 'expired' },
    { paths: ['new.txt'] },
    { privateBackup: '/tmp/private' },
    { confirmPublication: false },
  ])
    assert.throws(() => parseIntegrationFileRestorationRecoveryReport({ ...report, ...invalid }));
});

test('恢复结算是独立不可变观察，不改变原历史或恢复结果；无待发包关闭新的报告及取消', async () => {
  const f = await integrationFixture();
  try {
    const q = await requested(f),
      report = recovery(q),
      before = snapshot(f),
      restorationBefore = snapshot(f, [
        'integration_file_restorations',
        'integration_file_restoration_reports',
      ]);
    for (const invalid of [
      { applicationId: 'other' },
      { integrationInputHash: 'a'.repeat(64) },
      { applicationInputHash: 'a'.repeat(64) },
      { restorationInputHash: 'a'.repeat(64) },
      { recordedRestoredCount: 3 },
      { stoppedConfirmedAt: '2000-01-01T00:00:00.000Z' },
      { releasedAt: '2000-01-01T00:00:00.000Z' },
      { releasedAt: new Date(Date.now() + 120000).toISOString() },
    ])
      assert.equal((await settle(f, { ...report, ...invalid })).statusCode, 409);
    const first = await settle(f, report);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().hash, codeHash(report));
    const history = view(f, q.operation.id);
    assert.equal(history.restoration!.state, 'queued');
    assert.equal(history.restoration!.revision, 1);
    assert.equal(history.restoration!.recovery!.hash, codeHash(report));
    assert.equal(history.recovery, null, '不冒充原应用的结算');
    assert.equal(history.canCancelFileRestoration, false);
    assert.equal((await publish(f, evidence(q))).statusCode, 409);
    assert.equal((await publish(f, { ...evidence(q, 'failed'), sequence: 1 })).statusCode, 409);
    assert.equal(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, cancelBody(q))).statusCode,
      409,
    );
    assert.deepEqual(snapshot(f), before);
    assert.deepEqual(
      snapshot(f, ['integration_file_restorations', 'integration_file_restoration_reports']),
      restorationBefore,
    );
    const outbox = snapshot(f, ['outbox']);
    assert.deepEqual((await settle(f, report)).json(), first.json());
    assert.deepEqual(snapshot(f, ['outbox']), outbox);
    assert.equal((await settle(f, { ...report, recoveryId: randomUUID() })).statusCode, 409);
    assert.equal(
      (await settle(f, { ...report, pendingReportHash: codeHash(evidence(q)) })).statusCode,
      409,
    );
    assert.throws(
      () =>
        f.api.store.db.exec("UPDATE integration_file_restoration_recoveries SET hash='changed'"),
      /immutable/,
    );
    assert.throws(
      () => f.api.store.db.exec('DELETE FROM integration_file_restoration_recoveries'),
      /immutable/,
    );
  } finally {
    await f.close();
  }
});

test('结算只接收当时固定的未知start/terminal包，旧已接受回执仍可对账且不授权新写入', async () => {
  const f = await integrationFixture();
  try {
    for (const pendingStage of ['restoring', 'completed'] as const) {
      const q = await requested(f),
        start = evidence(q);
      if (pendingStage === 'completed') assert.equal((await publish(f, start)).statusCode, 200);
      const pending = pendingStage === 'restoring' ? start : evidence(q, 'completed'),
        report = recovery(q, pending);
      const before = snapshot(f),
        first = await settle(f, report);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(
        (
          await publish(f, {
            ...pending,
            observedAt: new Date(Date.parse(pending.observedAt) + 1).toISOString(),
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await publish(f, { ...pending, originalApplicationEvidenceHash: 'a'.repeat(64) }))
          .statusCode,
        409,
      );
      const accepted = await publish(f, pending);
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().state, pendingStage);
      assert.deepEqual((await publish(f, pending)).json(), accepted.json());
      assert.deepEqual((await settle(f, report)).json(), first.json());
      const later = {
        ...evidence(q, 'needs_attention'),
        observedAt: new Date(Date.parse(report.stoppedConfirmedAt) + 1).toISOString(),
      };
      assert.equal((await publish(f, later)).statusCode, 409);
      if (pendingStage === 'completed') {
        const old = await publish(f, start);
        assert.equal(old.statusCode, 200, old.body);
        assert.equal(old.json().state, 'completed');
      }
      const history = (await inspect(f, q)).json() as IntegrationView;
      assert.equal(history.restoration!.recovery!.hash, codeHash(report));
      assert.equal(history.canRestoreFiles, false);
      assert.equal(history.canCancelFileRestoration, false);
      assert.deepEqual(snapshot(f), before);
    }
  } finally {
    await f.close();
  }
});

test('恢复结算outbox故障原子回滚，目标撤权仍阻止结算和已接受报告旧回执', async () => {
  const f = await integrationFixture();
  try {
    const q = await requested(f),
      start = evidence(q);
    assert.equal((await publish(f, start)).statusCode, 200);
    const report = recovery(q),
      before = snapshot(f, ['integration_file_restoration_recoveries', 'outbox']);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_restoration_recovery BEFORE INSERT ON outbox WHEN NEW.kind='integration.restoration_recovery_observed' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await settle(f, report)).statusCode, 500);
    assert.deepEqual(snapshot(f, ['integration_file_restoration_recoveries', 'outbox']), before);
    f.api.store.db.exec('DROP TRIGGER fail_restoration_recovery');
    assert.equal((await settle(f, report)).statusCode, 200);
    assert.equal((await publish(f, start)).statusCode, 200);
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.equal((await settle(f, report)).statusCode, 409);
    assert.equal((await settle(f, { ...report, recoveryId: randomUUID() })).statusCode, 409);
    assert.equal((await publish(f, start)).statusCode, 409);
    assert.equal((await inspect(f, q)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('未完成原应用不可请求恢复；当前活动写入者阻止新请求及未结算的开始回执', async () => {
  const f = await integrationFixture();
  try {
    const initial = await f.create();
    assert.equal((await f.protocol('publish', f.report(initial))).statusCode, 200);
    const ready = view(f, initial.operation.id);
    const queued = await f.api.call(`${f.integrationPath}/${ready.operation.id}/apply`, f.alice, {
      expectedRevision: ready.operation.revision,
      expectedTaskRevision: ready.taskRevision,
      reportHash: ready.reportHash,
      paths: ['new.txt'],
      confirmApplication: true,
    });
    assert.equal(queued.statusCode, 200, queued.body);
    const notDone = queued.json() as IntegrationView;
    assert.equal(notDone.completedReportHash, null);
    assert.equal(notDone.canRestoreFiles, false);
    assert.equal(
      (
        await f.api.call(endpoint(f, notDone), f.alice, {
          ...body(notDone),
          completedReportHash: 'e'.repeat(64),
        })
      ).statusCode,
      409,
    );
    const v = await completed(f),
      db = f.api.store.db,
      dispatch = db
        .prepare('SELECT id,stage FROM node_dispatches WHERE node_id=? LIMIT 1')
        .get(f.ns[0]!.nodeId) as { id: string; stage: string };
    assert(dispatch);
    db.prepare("UPDATE node_dispatches SET stage='running' WHERE id=?").run(dispatch.id);
    assert.equal(view(f, v.operation.id).canRestoreFiles, false);
    assert.equal((await f.api.call(endpoint(f, v), f.alice, body(v))).statusCode, 409);
    db.prepare('UPDATE node_dispatches SET stage=? WHERE id=?').run(dispatch.stage, dispatch.id);
    const q = await requested(f, v),
      start = evidence(q);
    assert.equal((await publish(f, start)).statusCode, 200);
    db.prepare("UPDATE node_dispatches SET stage='running' WHERE id=?").run(dispatch.id);
    assert.equal((await publish(f, start)).statusCode, 409);
    // A preserve-only observation converts only the existing packet to a historical receipt.
    assert.equal((await settle(f, recovery(q))).statusCode, 200);
    assert.equal((await publish(f, start)).statusCode, 200);
    assert.equal((await publish(f, evidence(q, 'completed'))).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('已取消恢复的原回执也要核对当前目标权限；取消观察保留一次性原请求', async () => {
  const f = await integrationFixture();
  try {
    const q = await requested(f),
      data = cancelBody(q),
      key = randomUUID();
    const first = await f.api.call(endpoint(f, q) + '/cancel', f.alice, data, key);
    assert.equal(first.statusCode, 200, first.body);
    const report = recovery(q),
      observed = await settle(f, report);
    assert.equal(observed.statusCode, 200, observed.body);
    assert.equal(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, data, key)).json().restoration.state,
      'cancelled',
    );
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.equal(
      (await f.api.call(endpoint(f, q) + '/cancel', f.alice, data, key)).statusCode,
      409,
    );
    assert.equal((await settle(f, report)).statusCode, 409);
  } finally {
    await f.close();
  }
});
