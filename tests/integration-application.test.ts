import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  parseIntegrationApply,
  parseIntegrationApplicationReport,
  type IntegrationApplicationReport,
  type IntegrationReport,
  type IntegrationView,
} from '../packages/contracts/src/integrations.js';
import { recordResultCode } from './helpers/result-code.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';
import { IntegrationStore } from '../packages/db/src/integrations.js';
import { codeHash } from '../packages/db/src/result-code.js';
import { migrations } from '../packages/db/src/schema.js';
import { integrationFixture } from './helpers/integrations.js';

type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const view = (f: Fixture, id: string) =>
  f.as(() => new IntegrationStore(f.api.store).get(f.task.id, id));
const applyBody = (v: IntegrationView, paths = ['new.txt']) => ({
  expectedRevision: v.operation.revision,
  expectedTaskRevision: v.taskRevision,
  reportHash: v.reportHash!,
  paths,
  confirmApplication: true,
});
const endpoint = (f: Fixture, v: IntegrationView) => `${f.integrationPath}/${v.operation.id}/apply`;
async function ready(f: Fixture, adapt?: (r: IntegrationReport) => IntegrationReport) {
  const created = await f.create(),
    original = f.report(created) as IntegrationReport,
    report = adapt ? adapt(original) : original,
    result = await f.protocol('publish', report);
  assert.equal(result.statusCode, 200, result.body);
  return view(f, created.operation.id);
}
async function queue(f: Fixture, v: IntegrationView, paths = ['new.txt']) {
  const result = await f.api.call(endpoint(f, v), f.alice, applyBody(v, paths));
  assert.equal(result.statusCode, 200, result.body);
  return result.json() as IntegrationView;
}
function evidence(
  v: IntegrationView,
  stage: IntegrationApplicationReport['stage'] = 'applying',
  appliedPaths: string[] = [],
): IntegrationApplicationReport {
  const a = v.operation.application!;
  return {
    integrationId: v.operation.id,
    applicationId: a.id,
    inputHash: a.inputHash,
    sequence: stage === 'applying' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    appliedPaths,
    reason: stage === 'applying' || stage === 'completed' ? null : 'application_failed',
    confirmPublication: true,
  };
}
const publish = (f: Fixture, r: unknown, index = 0) => f.protocol('apply-publish', r, index);

test('选择性应用严格契约拒绝伪造字段、路径、数量、阶段和不一致证据', () => {
  const b = {
    expectedRevision: 2,
    expectedTaskRevision: 3,
    reportHash: 'a'.repeat(64),
    paths: ['b.txt', 'a.txt'],
    confirmApplication: true,
  };
  assert.deepEqual(parseIntegrationApply(b).paths, ['a.txt', 'b.txt']);
  for (const change of [
    { confirmApplication: false },
    { confirmApplication: undefined },
    { writeAuthorized: true },
    { expectedRevision: 0 },
    { expectedTaskRevision: 1.2 },
    { reportHash: 'abc' },
    { paths: [] },
    { paths: ['x', 'x'] },
    { paths: ['../x'] },
    { paths: ['/x'] },
    { paths: ['x\\y'] },
    { paths: ['.GiT/config'] },
    { paths: ['x/./y'] },
    { paths: ['x\ny'] },
    { paths: ['x\u200dy'] },
    { paths: ['x'.repeat(4097)] },
    { paths: Array.from({ length: 81 }, (_, i) => `${i}.txt`) },
    { paths: Array.from({ length: 80 }, (_, i) => `${i}${'x'.repeat(1000)}`) },
  ])
    assert.throws(() => parseIntegrationApply({ ...b, ...change }));
  const r = {
    integrationId: 'integration',
    applicationId: 'application',
    inputHash: 'b'.repeat(64),
    sequence: 1,
    stage: 'applying',
    observedAt: new Date().toISOString(),
    appliedPaths: [],
    reason: null,
    confirmPublication: true,
  };
  assert.equal(parseIntegrationApplicationReport(r).stage, 'applying');
  for (const change of [
    { applied: true },
    { confirmPublication: false },
    { sequence: 0 },
    { sequence: 3 },
    { sequence: 2 },
    { stage: 'completed' },
    { appliedPaths: ['new.txt'] },
    { reason: 'application_failed' },
    { inputHash: 'invalid' },
    { observedAt: 'today' },
    { sequence: 2, stage: 'completed', appliedPaths: [] },
    { sequence: 2, stage: 'failed', reason: null },
    { sequence: 2, stage: 'failed', reason: 'application_failed', appliedPaths: ['x'] },
    { sequence: 2, stage: 'needs_attention', reason: 'preflight_failed' },
  ])
    assert.throws(() => parseIntegrationApplicationReport({ ...r, ...change }));
});

test('明确选择冻结一次；应用、旧预检回执和历史不改变Task/Run或原计划', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      body = applyBody(v),
      key = randomUUID();
    const tables = [
      'tasks',
      'runs',
      'node_dispatches',
      'work_branches',
      'work_branch_choices',
      'result_revisions',
    ];
    const snapshot = () =>
      tables.map((table) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    assert.equal(v.canApply, true);
    assert.equal(v.reportHash, codeHash(v.operation.report));
    const r = await f.api.call(endpoint(f, v), f.alice, body, key);
    assert.equal(r.statusCode, 200, r.body);
    const queued = r.json() as IntegrationView,
      a = queued.operation.application!;
    assert.equal(queued.operation.state, 'queued');
    assert.equal(queued.canCancel, true);
    assert.equal(queued.canApply, false);
    assert.deepEqual(a.paths, ['new.txt']);
    assert.equal(
      a.inputHash,
      codeHash({
        integrationId: v.operation.id,
        applicationId: a.id,
        reportHash: v.reportHash,
        paths: a.paths,
      }),
    );
    assert.deepEqual((await f.api.call(endpoint(f, v), f.alice, body, key)).json(), queued);
    assert.equal(
      (await f.api.call(endpoint(f, v), f.alice, { ...body, paths: ['README.md'] }, key))
        .statusCode,
      409,
    );
    assert.equal((await f.api.call(endpoint(f, v), f.alice, applyBody(queued))).statusCode, 409);
    const start = evidence(queued),
      started = await publish(f, start);
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.json().state, 'applying');
    assert.equal(started.json().sequence, 1);
    assert.equal(started.json().hash, codeHash(start));
    assert.deepEqual((await publish(f, start)).json(), started.json());
    const done = evidence(queued, 'completed', ['new.txt']),
      completed = await publish(f, done);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().state, 'completed');
    assert.deepEqual((await publish(f, done)).json(), completed.json());
    assert.equal((await publish(f, start)).json().state, 'completed');
    assert.equal((await f.protocol('publish', v.operation.report)).json().state, 'completed');
    const final = view(f, v.operation.id);
    assert.equal(final.operation.applied, true);
    assert.equal(final.operation.report!.plan!.applied, false);
    assert.equal(final.operation.report!.plan!.writeAuthorized, false);
    assert.deepEqual(final.operation.report, v.operation.report);
    assert.equal(final.operation.history.length, 5);
    assert.equal(final.canCancel, false);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      (await f.api.call(endpoint(f, v), f.alice, body, key)).json().operation.state,
      'completed',
    );
  } finally {
    await f.close();
  }
});

test('只允许完整报告中新增文件；修改、删除、冲突、已存在和省略记录保留但不能选', async () => {
  const f = await integrationFixture();
  try {
    const original = await ready(f);
    for (const paths of [['README.md'], ['missing.txt'], ['new.txt', 'README.md']])
      assert.equal(
        (await f.api.call(endpoint(f, original), f.alice, applyBody(original, paths))).statusCode,
        409,
      );
    const source = original.operation.report!.plan!.files.find(
      (entry) => entry.action === 'add',
    )!.source!;
    for (const action of ['delete', 'conflict', 'already_present'] as const) {
      const v = await ready(f, (r) => ({
        ...r,
        plan: {
          ...r.plan!,
          changedFiles: 2,
          conflicts: action === 'conflict' ? 1 : 0,
          alreadyPresent: action === 'already_present' ? 1 : 0,
          files: [
            r.plan!.files.find((entry) => entry.action === 'add')!,
            {
              path: 'unsupported.txt',
              source: action === 'delete' ? null : source,
              base: action === 'delete' ? source : null,
              target: action === 'conflict' ? { ...source, objectId: 'a'.repeat(40) } : source,
              action,
              conflict: action === 'conflict' ? 'both_changed' : null,
            },
          ],
        },
      }));
      assert.equal(
        (await f.api.call(endpoint(f, v), f.alice, applyBody(v, ['unsupported.txt']))).statusCode,
        409,
      );
      assert.equal(v.canApply, true);
      await queue(f, v); // An unrelated conflict does not force or silently resolve it.
    }
    const omitted = await ready(f, (r) => ({
      ...r,
      plan: { ...r.plan!, changedFiles: r.plan!.changedFiles + 1, omittedFiles: 1 },
    }));
    assert.equal(omitted.canApply, false);
    assert.equal(
      (await f.api.call(endpoint(f, omitted), f.alice, applyBody(omitted))).statusCode,
      409,
    );
    assert.equal(view(f, omitted.operation.id).operation.report!.plan!.omittedFiles, 1);
  } finally {
    await f.close();
  }
});

test('报告哈希、任务和操作修订、实际创建者与节点当前授权独立核对', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      body = applyBody(v);
    for (const change of [
      { reportHash: 'f'.repeat(64) },
      { expectedRevision: 99 },
      { expectedTaskRevision: 99 },
    ])
      assert.equal(
        (await f.api.call(endpoint(f, v), f.alice, { ...body, ...change })).statusCode,
        409,
      );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(endpoint(f, v), f.bob, body)).statusCode, 403);
    f.as(() =>
      f.api.store.patchTask(
        f.task.id,
        { expectedRevision: v.taskRevision, title: '新任务修订' },
        randomUUID(),
      ),
    );
    assert.equal((await f.api.call(endpoint(f, v), f.alice, body)).statusCode, 409);
    const current = view(f, v.operation.id),
      queued = await queue(f, current);
    assert.equal((await publish(f, evidence(queued), 1)).statusCode, 404);
    f.api.store.db
      .prepare('UPDATE runner_nodes SET revision=revision+1 WHERE id=?')
      .run(f.ns[0]!.nodeId);
    assert.equal((await publish(f, evidence(queued))).statusCode, 409);
    assert.equal(view(f, v.operation.id).canApply, false);
  } finally {
    await f.close();
  }
});

test('取消仅限排队且尚无写入声明，已应用或未知部分写入不可取消或重新选择', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      queued = await queue(f, v),
      body = { expectedRevision: queued.operation.revision },
      key = randomUUID();
    const cancelPath = `${f.integrationPath}/${v.operation.id}/cancel`;
    const cancelled = await f.api.call(cancelPath, f.alice, body, key);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().operation.application.id, queued.operation.application!.id);
    assert.equal((await publish(f, evidence(queued))).statusCode, 409);
    assert.equal(
      (await f.api.call(endpoint(f, v), f.alice, applyBody(cancelled.json()))).statusCode,
      409,
    );
    assert.deepEqual((await f.api.call(cancelPath, f.alice, body, key)).json(), cancelled.json());
    for (const stage of ['applying', 'completed', 'needs_attention'] as const) {
      const next = await queue(f, await ready(f));
      assert.equal((await publish(f, evidence(next))).statusCode, 200);
      if (stage !== 'applying')
        assert.equal((await publish(f, evidence(next, stage, ['new.txt']))).statusCode, 200);
      const current = view(f, next.operation.id);
      assert.equal(current.canCancel, false);
      assert.equal(
        (
          await f.api.call(`${f.integrationPath}/${next.operation.id}/cancel`, f.alice, {
            expectedRevision: current.operation.revision,
          })
        ).statusCode,
        409,
      );
    }
  } finally {
    await f.close();
  }
});

test('应用证据按阶段追加，范围不得扩张，失败不得声称部分成功，终态证据与选择不可覆盖', async () => {
  const f = await integrationFixture();
  try {
    const queued = await queue(f, await ready(f)),
      start = evidence(queued),
      done = evidence(queued, 'completed', ['new.txt']);
    assert.equal((await publish(f, done)).statusCode, 409);
    for (const change of [
      { applicationId: randomUUID() },
      { inputHash: 'e'.repeat(64) },
      { observedAt: '2020-01-01T00:00:00.000Z' },
      { observedAt: new Date(Date.now() + 120000).toISOString() },
    ])
      assert.equal((await publish(f, { ...start, ...change })).statusCode, 409);
    assert.equal((await publish(f, start)).statusCode, 200);
    assert.equal(
      (
        await publish(f, {
          ...start,
          observedAt: new Date(Date.parse(start.observedAt) + 1).toISOString(),
        })
      ).statusCode,
      409,
    );
    assert.equal((await publish(f, { ...done, appliedPaths: ['README.md'] })).statusCode, 409);
    assert.equal(
      (await publish(f, { ...done, stage: 'failed', reason: 'application_failed' })).statusCode,
      400,
    );
    assert.equal(
      (
        await publish(f, {
          ...done,
          observedAt: new Date(Date.parse(start.observedAt) - 1).toISOString(),
        })
      ).statusCode,
      409,
    );
    const partial = evidence(queued, 'needs_attention', ['new.txt']);
    assert.equal((await publish(f, partial)).statusCode, 200);
    assert.equal((await publish(f, done)).statusCode, 409);
    const current = view(f, queued.operation.id);
    assert.equal(current.operation.applied, false);
    assert.deepEqual(current.operation.application!.reports[1]!.appliedPaths, ['new.txt']);
    const update = (o: unknown) =>
      f.api.store.db
        .prepare('UPDATE integration_operations SET body=? WHERE id=?')
        .run(JSON.stringify(o), queued.operation.id);
    for (const application of [
      null,
      { ...current.operation.application!, paths: ['README.md'] },
      { ...current.operation.application!, reports: [] },
      { ...current.operation.application!, reports: [start, done] },
    ])
      assert.throws(() => update({ ...current.operation, application }), /immutable/);
    assert.throws(() => update({ ...current.operation, report: null }), /immutable/);
    const failed = await queue(f, await ready(f));
    assert.equal((await publish(f, evidence(failed))).statusCode, 200);
    assert.equal((await publish(f, evidence(failed, 'failed'))).statusCode, 200);
    assert.equal(view(f, failed.operation.id).operation.applied, false);
    assert.equal(
      (await f.api.call(endpoint(f, failed), f.alice, applyBody(view(f, failed.operation.id))))
        .statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('旧回执不能绕过项目降权、节点永久撤权和当前目录权限', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      body = applyBody(v),
      key = randomUUID();
    const result = await f.api.call(endpoint(f, v), f.alice, body, key);
    assert.equal(result.statusCode, 200, result.body);
    const queued = result.json() as IntegrationView,
      start = evidence(queued);
    assert.equal((await publish(f, start)).statusCode, 200);
    const grants = f.api.store.db
      .prepare('SELECT grants FROM runner_nodes WHERE id=?')
      .get(f.ns[0]!.nodeId)!.grants;
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.equal((await publish(f, start)).statusCode, 409);
    assert.equal((await f.api.call(endpoint(f, v), f.alice, body, key)).statusCode, 409);
    f.api.store.db
      .prepare('UPDATE runner_nodes SET grants=? WHERE id=?')
      .run(grants!, f.ns[0]!.nodeId);
    const done = evidence(queued, 'completed', ['new.txt']);
    assert.equal((await publish(f, done)).statusCode, 200);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    assert.equal((await f.api.call(endpoint(f, v), f.alice, body, key)).statusCode, 403);
    assert.equal((await publish(f, done)).statusCode, 401);
    assert.equal(view(f, v.operation.id).canApply, false);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='manage' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    assert.equal((await publish(f, done)).statusCode, 401); // Rejoining cannot revive old credentials.
    assert.notEqual((await f.api.call(endpoint(f, v), f.alice, body, key)).statusCode, 200);
    assert.equal(view(f, v.operation.id).operation.state, 'completed');
  } finally {
    await f.close();
  }
});

test('到期和删除阻止新的写入声明，原终态仍可对账且新终态仍可记录实际证据', async (t) => {
  const f = await integrationFixture();
  try {
    const waiting = await queue(f, await ready(f)),
      started = await queue(f, await ready(f)),
      completed = await queue(f, await ready(f));
    const start = evidence(started),
      doneStart = evidence(completed),
      done = evidence(completed, 'completed', ['new.txt']);
    assert.equal((await publish(f, start)).statusCode, 200);
    assert.equal((await publish(f, doneStart)).statusCode, 200);
    assert.equal((await publish(f, done)).statusCode, 200);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const integrations = new IntegrationStore(f.api.store);
    assert.throws(
      () => integrations.publishApplication(f.ns[0]!.token, evidence(waiting)),
      /恢复副本|到期/,
    );
    assert.throws(() => integrations.publishApplication(f.ns[0]!.token, start), /恢复副本|到期/);
    assert.equal(integrations.publishApplication(f.ns[0]!.token, done).state, 'completed');
    assert.equal(
      integrations.publishApplication(f.ns[0]!.token, evidence(started, 'needs_attention')).state,
      'needs_attention',
    );
    assert.equal(view(f, completed.operation.id).available, false);
    t.mock.timers.reset();
    f.retained.report(f.ns[0]!.token, {
      requestId: f.tr.request.id,
      requestHash: f.tr.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    assert.equal((await publish(f, done)).statusCode, 200);
    assert.equal((await publish(f, evidence(waiting))).statusCode, 409);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('排队选择与阶段报告的业务、历史、outbox和幂等回执在故障时共同回滚', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      body = applyBody(v),
      key = randomUUID();
    const fail = () =>
      f.api.store.db.exec(
        "CREATE TRIGGER fail_application BEFORE INSERT ON outbox WHEN NEW.kind LIKE 'integration.%' BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
    const reset = () => f.api.store.db.exec('DROP TRIGGER fail_application');
    fail();
    assert.equal((await f.api.call(endpoint(f, v), f.alice, body, key)).statusCode, 500);
    assert.deepEqual(view(f, v.operation.id), v);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_records WHERE key=?').get(key)!
        .n,
      0,
    );
    reset();
    const result = await f.api.call(endpoint(f, v), f.alice, body, key),
      queued = result.json() as IntegrationView;
    assert.equal(result.statusCode, 200, result.body);
    const start = evidence(queued);
    fail();
    assert.equal((await publish(f, start)).statusCode, 500);
    assert.deepEqual(view(f, v.operation.id), queued);
    reset();
    assert.equal((await publish(f, start)).statusCode, 200);
    const started = view(f, v.operation.id),
      done = evidence(queued, 'completed', ['new.txt']);
    fail();
    assert.equal((await publish(f, done)).statusCode, 500);
    assert.deepEqual(view(f, v.operation.id), started);
    reset();
    assert.equal((await publish(f, done)).statusCode, 200);
    assert.equal(view(f, v.operation.id).operation.history.length, 5);
  } finally {
    await f.close();
  }
});

test('迁移31既有报告与事件完整保留，外键和不可变守卫继续生效，旧JSON不要求application', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE runner_nodes(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('task'); INSERT INTO runner_nodes VALUES('node');",
    );
    db.exec(migrations.find((m) => m.version === 31)!.sql);
    const body = {
      id: 'operation',
      report: { retained: 'original' },
      state: 'awaiting_choice',
      applied: false,
    };
    db.prepare('INSERT INTO integration_operations VALUES(?,?,?,?,?,?)').run(
      'operation',
      'task',
      'node',
      'awaiting_choice',
      2,
      JSON.stringify(body),
    );
    db.prepare('INSERT INTO integration_events VALUES(?,?,?)').run(
      'operation',
      2,
      '{"original":true}',
    );
    db.exec('BEGIN IMMEDIATE');
    db.exec(migrations.find((m) => m.version === 32)!.sql);
    db.exec('COMMIT');
    assert.deepEqual(
      JSON.parse(db.prepare('SELECT body FROM integration_operations').get()!.body as string),
      body,
    );
    assert.equal(
      db.prepare('SELECT body FROM integration_events').get()!.body,
      '{"original":true}',
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.prepare('UPDATE integration_events SET body=?').run('{}'), /immutable/);
    assert.throws(() => db.exec('DELETE FROM integration_events'), /immutable/);
    assert.throws(
      () => db.prepare('INSERT INTO integration_events VALUES(?,?,?)').run('missing', 1, '{}'),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        db
          .prepare('UPDATE integration_operations SET body=?')
          .run(JSON.stringify({ ...body, report: null })),
      /immutable/,
    );
    for (const state of ['applying', 'completed', 'needs_attention'])
      db.prepare('UPDATE integration_operations SET state=?').run(state);
    assert.throws(
      () => db.prepare('UPDATE integration_operations SET state=?').run('unknown'),
      /CHECK/,
    );
  } finally {
    db.close();
  }
});

test('写入前失败可直接关闭第1阶段；到期后仍可结算但不能后续声明写入或替换', async (t) => {
  const f = await integrationFixture();
  try {
    const queued = await queue(f, await ready(f));
    const aborted = {
      ...evidence(queued, 'failed'),
      sequence: 1 as const,
      reason: 'interrupted' as const,
    };
    assert.equal(parseIntegrationApplicationReport(aborted).stage, 'failed');
    assert.throws(() =>
      parseIntegrationApplicationReport({ ...aborted, appliedPaths: ['new.txt'] }),
    );
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const integrations = new IntegrationStore(f.api.store);
    const result = integrations.publishApplication(f.ns[0]!.token, aborted);
    assert.equal(result.sequence, 1);
    assert.equal(result.state, 'failed');
    assert.deepEqual(integrations.publishApplication(f.ns[0]!.token, aborted), result);
    assert.throws(
      () => integrations.publishApplication(f.ns[0]!.token, evidence(queued)),
      /恢复副本|到期/,
    );
    assert.throws(
      () => integrations.publishApplication(f.ns[0]!.token, evidence(queued, 'failed')),
      /阶段/,
    );
    assert.throws(
      () =>
        integrations.publishApplication(f.ns[0]!.token, evidence(queued, 'completed', ['new.txt'])),
      /阶段/,
    );
    assert.equal(view(f, queued.operation.id).operation.applied, false);
    assert.equal(view(f, queued.operation.id).operation.application!.reports.length, 1);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('完成报告必须恰好覆盖固定多文件选择；部分证据只能保留待人工检查', async () => {
  const f = await integrationFixture();
  try {
    const prepared = await ready(f, (r) => {
      const file = r.plan!.files.find((entry) => entry.action === 'add')!;
      return {
        ...r,
        plan: {
          ...r.plan!,
          changedFiles: 3,
          files: [...r.plan!.files, { ...file, path: 'second.txt' }],
        },
      };
    });
    const queued = await queue(f, prepared, ['second.txt', 'new.txt']);
    assert.deepEqual(queued.operation.application!.paths, ['new.txt', 'second.txt']);
    assert.equal((await publish(f, evidence(queued))).statusCode, 200);
    assert.equal((await publish(f, evidence(queued, 'completed', ['new.txt']))).statusCode, 409);
    assert.equal(
      (await publish(f, evidence(queued, 'needs_attention', ['missing.txt']))).statusCode,
      409,
    );
    assert.equal(
      (await publish(f, evidence(queued, 'needs_attention', ['new.txt']))).statusCode,
      200,
    );
    const current = view(f, queued.operation.id);
    assert.deepEqual(current.operation.application!.reports[1]!.appliedPaths, ['new.txt']);
    assert.deepEqual(current.operation.application!.paths, ['new.txt', 'second.txt']);
    assert.equal(current.operation.state, 'needs_attention');
    assert.equal(current.operation.applied, false);
  } finally {
    await f.close();
  }
});

test('跨节点应用复核独立来源和目标权限，来源撤权阻止已完成报告的旧回执', async () => {
  const f = await integrationFixture();
  try {
    const cp = await recordResultCode(f, f.target, 1),
      target = f.retain(cp.checkpointId, f.target, 1);
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
    // Control metadata fixture; encrypted transport and actual writes have separate tests.
    f.api.store.db
      .prepare("UPDATE checkpoint_transfers SET state='received',received_at=? WHERE id=?")
      .run(new Date().toISOString(), transfer.ticket.id);
    const created = await f.api.call(f.integrationPath, f.alice, {
      ...f.body(),
      targetCheckpointId: cp.checkpointId,
      targetRetentionId: target.request.id,
      sourceMaterial: { kind: 'transfer', id: transfer.ticket.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    const report = f.report(created.json());
    assert.equal((await f.protocol('publish', report, 1)).statusCode, 200);
    const prepared = view(f, created.json().operation.id),
      body = applyBody(prepared),
      key = randomUUID();
    const result = await f.api.call(endpoint(f, prepared), f.alice, body, key);
    assert.equal(result.statusCode, 200, result.body);
    const queued = result.json() as IntegrationView;
    assert.equal((await publish(f, evidence(queued), 1)).statusCode, 200);
    const done = evidence(queued, 'completed', ['new.txt']);
    assert.equal((await publish(f, done, 1)).statusCode, 200);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal((await publish(f, done, 1)).statusCode, 409);
    assert.equal((await f.api.call(endpoint(f, prepared), f.alice, body, key)).statusCode, 409);
    assert.equal(view(f, prepared.operation.id).operation.state, 'completed');
  } finally {
    await f.close();
  }
});
