import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, parseTaskCreate, type Task } from '../packages/contracts/src/index.js';
import {
  parseTaskAssignment,
  parseAssignmentHistoryQuery,
} from '../packages/contracts/src/task-assignment.js';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { Store } from '../packages/db/src/store.js';
import { migrations } from '../packages/db/src/schema.js';
import { demoMembers } from '../packages/db/src/seed.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (value: string) => (e: unknown) => e instanceof DomainError && e.code === value;
const historyQuery = { limit: 50, before: null };
const second = demoMembers[1]!.id,
  third = demoMembers[2]!.id;
function task(store: Store) {
  return store.createTask(
    { title: '负责人不是执行器账户', description: '固定说明', projectId: store.projects()[0]!.id },
    randomUUID(),
  );
}
function assign(store: Store, t: Task, ownerUserId = second, key: string = randomUUID()) {
  return store.taskAssignment.assign(t.id, { expectedRevision: t.revision, ownerUserId }, key);
}
function nativePlan(store: Store, t: Task) {
  const copy = store.registerWorkingCopy({
    id: randomUUID(),
    name: '非进程协议测试目录',
    root: '/fictional/assignment-fixture',
    createdAt: new Date().toISOString(),
  });
  const body = {
    provider: 'native',
    requestedTool: 'claude-code',
    workingCopyId: copy.id,
    prompt: '固定本轮材料',
    confirmExecution: true,
    expectedRevision: t.revision,
  };
  const source = store.createNativeRun(
    t.id,
    parseNativeRunCreate(body),
    {
      workingCopyId: copy.id,
      mode: 'read-only',
      model: null,
      maxTurns: 8,
      maxBudgetUsd: 1,
      timeoutSeconds: 30,
      toolVersion: 'protocol fixture only',
      contextText: '原执行材料',
      contextHash: 'fixture',
    },
    randomUUID(),
  );
  const operations = new ContinuationStore(store);
  const op = operations.create(
    t.id,
    parseContinuation({
      ...body,
      expectedRevision: store.getTask(t.id).revision,
      sourceRunId: source.id,
      onActiveRun: 'wait',
      prompt: '改派前明确确认的材料',
    }),
    randomUUID(),
  );
  return { source, operations, op };
}

test('改派契约拒绝身份/权限/执行参数注入，分页有界，创建不能伪造创建者或负责人', () => {
  assert.deepEqual(parseTaskAssignment({ expectedRevision: 1, ownerUserId: ' user-a ' }), {
    expectedRevision: 1,
    ownerUserId: 'user-a',
  });
  for (const body of [
    null,
    [],
    {},
    { expectedRevision: 1 },
    { expectedRevision: '1', ownerUserId: second },
    { expectedRevision: 0, ownerUserId: second },
    { expectedRevision: 1.5, ownerUserId: second },
    { expectedRevision: 1, ownerUserId: '' },
    { expectedRevision: 1, ownerUserId: 'x'.repeat(101) },
    ...[
      'createdByUserId',
      'projectId',
      'visibility',
      'nodeId',
      'stop',
      'access',
      'role',
      'command',
    ].map((field) => ({ expectedRevision: 1, ownerUserId: second, [field]: 'forged' })),
  ])
    assert.throws(() => parseTaskAssignment(body), code('INVALID_INPUT'));
  for (const field of ['createdByUserId', 'ownerUserId', 'visibility', 'operatorUserId'])
    assert.throws(
      () => parseTaskCreate({ title: '任务', [field]: 'forged' }),
      code('INVALID_INPUT'),
    );
  assert.deepEqual(parseAssignmentHistoryQuery({}), { before: null, limit: 10 });
  assert.deepEqual(parseAssignmentHistoryQuery({ before: '12', limit: '50' }), {
    before: 12,
    limit: 50,
  });
  for (const query of [
    { limit: '51' },
    { limit: '0' },
    { before: '-1' },
    { before: '1.2' },
    { before: '9007199254740992' },
    { before: ['2'] },
    { limit: 2 },
    { taskId: 'other' },
  ])
    assert.throws(() => parseAssignmentHistoryQuery(query), code('INVALID_INPUT'));
});

test('改派只更新负责人和修订，创建者/运行发起者/讨论/成果与活动执行不变', () => {
  const store = new Store();
  try {
    const t = task(store);
    assert.equal(t.createdByUserId, store.actorId);
    store.addMessage(t.id, '创建者的原讨论', null, 'm');
    store.createResult(t.id, '原成果', '保留来源', 'result');
    const run = store.createRun(
      t.id,
      {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'success',
        prompt: '',
        expectedRevision: t.revision,
        reopenTask: false,
      },
      'run',
    );
    store.stepRun(run.id, 'preparing');
    store.stepRun(run.id, 'running');
    const before = store.getTask(t.id),
      runs = store.runs(t.id),
      messages = store.messages(t.id),
      results = store.results();
    assert.equal(runs[0]!.createdByUserId, t.createdByUserId);
    const next = assign(store, before);
    assert.deepEqual(
      {
        ...next,
        ownerUserId: before.ownerUserId,
        revision: before.revision,
        updatedAt: before.updatedAt,
      },
      before,
    );
    assert.equal(next.ownerUserId, second);
    assert.equal(next.revision, before.revision + 1);
    assert.equal(next.status, 'in_progress');
    assert.deepEqual(store.runs(t.id), runs);
    assert.deepEqual(store.messages(t.id), messages);
    assert.deepEqual(store.results(), results);
    const history = store.taskAssignment.history(t.id, historyQuery).items;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.actorId, store.actorId);
    assert.equal(history[0]!.fromUserId, store.actorId);
    assert.equal(history[0]!.toUserId, second);
    assert.equal(history[0]!.toName, demoMembers[1]!.name);
    assert.ok(history[0]!.createdAt);
  } finally {
    store.close();
  }
});

test('同修订并发只接受一份改派，旧回执不反转新负责人，无变化不增加历史且分页不重复', async () => {
  const store = new Store(),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const t = task(store),
      url = `/api/v1/tasks/${t.id}/assignment`;
    const post = (ownerUserId: string, expectedRevision: number, key: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
        payload: { ownerUserId, expectedRevision },
      });
    const responses = await Promise.all([post(second, 1, 'a'), post(third, 1, 'b')]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    const winner =
      responses[0]!.statusCode === 200 ? { id: second, key: 'a' } : { id: third, key: 'b' };
    assert.equal((await post(winner.id, 1, winner.key)).json().revision, 2);
    const current = assign(store, store.getTask(t.id), store.actorId);
    assert.equal((await post(winner.id, 1, winner.key)).json().ownerUserId, winner.id);
    assert.equal(store.getTask(t.id).ownerUserId, store.actorId);
    assert.equal(
      (await post(store.actorId, 1, winner.key)).json().error.code,
      'IDEMPOTENCY_CONFLICT',
    );
    const count = store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n;
    assert.equal(assign(store, current, store.actorId).revision, current.revision);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n, count);
    assert.equal(store.taskAssignment.history(t.id, historyQuery).items.length, 2);
    const first = (
      await app.inject({ url: `/api/v1/tasks/${t.id}/assignment-history?limit=1` })
    ).json();
    assert.equal(first.items[0].revision, 3);
    assert.equal(first.nextCursor, 3);
    const next = (
      await app.inject({ url: `/api/v1/tasks/${t.id}/assignment-history?before=3&limit=1` })
    ).json();
    assert.equal(next.items[0].revision, 2);
    assert.equal(next.nextCursor, null);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${t.id}`,
      headers: { 'x-hexu-client': 'web', 'idempotency-key': 'forgery' },
      payload: { expectedRevision: current.revision, ownerUserId: third },
    });
    assert.equal(patch.json().error.code, 'INVALID_INPUT');
  } finally {
    await app.close();
  }
});

test('改派立即持久暂停 preview 接续，往返改派/旧回执不复活或改写原材料，原生发起者不变', () => {
  const store = new Store();
  try {
    const t = task(store),
      f = nativePlan(store, t),
      before = store.getTask(t.id);
    const rows = () => store.db.prepare('SELECT * FROM native_workspace_locks').all();
    const locks = rows(),
      run = store.run(f.source.id);
    assert.equal(run.createdByUserId, store.actorId);
    const next = assign(store, before, second, 'first');
    const paused = f.operations.get(f.op.id);
    assert.equal(paused.state, 'needs_attention');
    assert.equal(paused.blockers[0]!.code, 'TASK_ASSIGNMENT_CHANGED');
    assert.deepEqual(paused.input, f.op.input);
    assert.equal(paused.humanContextHash, f.op.humanContextHash);
    assign(store, next, store.actorId);
    const newPlan = f.operations.create(
      t.id,
      { ...f.op.input, run: { ...f.op.input.run, expectedRevision: store.getTask(t.id).revision } },
      'new-plan',
    );
    assign(store, before, second, 'first');
    assert.equal(f.operations.get(newPlan.id).state, 'waiting_for_stop');
    assert.equal(f.operations.get(f.op.id).state, 'needs_attention');
    assert.deepEqual(store.run(f.source.id), run);
    assert.deepEqual(rows(), locks);
    assert.equal(store.runs(t.id).length, 1);
  } finally {
    store.close();
  }
});

test('负责人、历史、接续暂停、通知与回执在事务故障下全部回滚，原标识可重试', () => {
  for (const [table, action] of [
    ['tasks', 'UPDATE'],
    ['task_assignment_events', 'INSERT'],
    ['continuation_operations', 'UPDATE'],
    ['outbox', 'INSERT'],
    ['idempotency_records', 'INSERT'],
  ]) {
    const store = new Store();
    try {
      const t = task(store),
        f = nativePlan(store, t),
        before = store.getTask(t.id),
        events = store.db.prepare('SELECT * FROM outbox').all();
      store.db.exec(
        `CREATE TRIGGER failure BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'assignment fixture rollback'); END;`,
      );
      assert.throws(() => assign(store, before, second, 'retry'), /assignment fixture rollback/);
      assert.deepEqual(store.getTask(t.id), before);
      assert.deepEqual(f.operations.get(f.op.id), f.op);
      assert.deepEqual(store.taskAssignment.history(t.id, historyQuery).items, []);
      assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
      assert.equal(
        store.db.prepare("SELECT 1 FROM idempotency_records WHERE key='retry'").get(),
        undefined,
      );
      store.db.exec('DROP TRIGGER failure');
      assert.equal(assign(store, before, second, 'retry').ownerUserId, second);
    } finally {
      store.close();
    }
  }
});

test('真实项目编辑者可改派但不是额外授权：只读/跨空间/移除成员和私有任务严格受限', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(bob),
      t = await f.task(bob, p.id);
    const path = `tasks/${t.id}/assignment`,
      body = { expectedRevision: t.revision, ownerUserId: alice.user.id };
    assert.equal((await f.call(path, alice)).statusCode, 404); // Space owner != project member.
    assert.equal((await f.call(path, bob, body)).json().error.code, 'ASSIGNEE_UNAVAILABLE');
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(path, alice, body)).statusCode, 403);
    assert.equal((await f.call(path, bob, body)).json().error.code, 'ASSIGNEE_UNAVAILABLE');
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const beforeMembers = f.store.db.prepare('SELECT * FROM collab_project_members').all();
    const changed = await f.call(path, alice, body, 'assign-as-editor');
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().createdByUserId, bob.user.id);
    assert.equal(changed.json().ownerUserId, alice.user.id);
    assert.deepEqual(
      f.store.db.prepare('SELECT * FROM collab_project_members').all(),
      beforeMembers,
    );
    assert.equal(
      (await f.call(path, { ...alice, spaceId: `personal-${alice.user.id}` })).statusCode,
      404,
    );
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(path, alice, body, 'assign-as-editor')).statusCode, 403);
    const readonly = (await f.call(path, bob)).json();
    assert.equal(readonly.owner.availability, 'read_only');
    assert.ok(!readonly.candidates.some((u: { id: string }) => u.id === alice.user.id));
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: null });
    const removed = (await f.call(path, bob)).json();
    assert.equal(removed.owner.availability, 'removed');
    assert.equal(removed.owner.name, alice.user.name);
    assert.equal((await f.call(path, alice, body, 'assign-as-editor')).statusCode, 404);
    assert.equal((await f.call(`tasks/${t.id}/assignment-history`, alice)).statusCode, 404);
    assert.equal((await f.call(path, null)).statusCode, 401);
    const privateTask = await f.task(bob);
    assert.equal(
      (
        await f.call(`tasks/${privateTask.id}/assignment`, bob, {
          expectedRevision: 1,
          ownerUserId: alice.user.id,
        })
      ).statusCode,
      422,
    );
    assert.equal((await f.call(`tasks/${privateTask.id}/assignment`, alice)).statusCode, 404);
    assert.equal(
      f.store.as(bob, () => f.store.getTask(privateTask.id).visibility),
      'private',
    );
  } finally {
    await f.close();
  }
});

test('候选人只来自当前空间和项目成员，成员移除后的改派事件与历史仍按任务权限过滤', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(alice),
      other = await f.project(bob),
      t = await f.task(alice, p.id);
    let options = (await f.call(`tasks/${t.id}/assignment`, alice)).json();
    assert.equal(options.candidates.length, 1);
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const cursor = f.store.as(alice, () => f.store.events(0).cursor);
    assert.equal(
      (
        await f.call(`tasks/${t.id}/assignment`, alice, {
          expectedRevision: 1,
          ownerUserId: bob.user.id,
        })
      ).statusCode,
      200,
    );
    assert.ok(
      f.store
        .as(bob, () => f.store.events(cursor))
        .events.some((e) => e.taskId === t.id && e.kind === 'task.assignment_changed'),
    );
    // Corrupt leftover project membership is still not a valid space membership.
    f.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(bob.spaceId, bob.user.id);
    options = (await f.call(`tasks/${t.id}/assignment`, alice)).json();
    assert.equal(options.owner.availability, 'removed');
    assert.equal(options.candidates.length, 1);
    assert.equal((await f.call(`tasks/${t.id}/assignment-history`, bob)).statusCode, 403);
    const visible = f.store.as(alice, () => f.store.events(cursor)).events;
    assert.ok(visible.every((e) => !JSON.stringify(e).includes(bob.user.email)));
    assert.equal(
      (
        await f.call(`tasks/${t.id}/assignment`, alice, {
          expectedRevision: 2,
          ownerUserId: bob.user.id,
        })
      ).json().error.code,
      'ASSIGNEE_UNAVAILABLE',
    );
    assert.notEqual(other.id, p.id);
  } finally {
    await f.close();
  }
});

test('旧任务和运行迁移不倒填创建者，改派历史跨 SQLite 重启保留且归档仍可人工改派', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-assignment-migration-')),
    path = join(dir, 'old.sqlite');
  let store: Store | undefined;
  try {
    const seed = new Store();
    const t = task(seed),
      f = nativePlan(seed, t),
      project = seed.project(t.projectId!);
    const oldTask = { ...seed.getTask(t.id) },
      oldRun = { ...seed.run(f.source.id) };
    delete oldTask.createdByUserId;
    delete oldRun.createdByUserId;
    seed.close();
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const m of migrations.filter((m) => m.version < 11)) {
      old.exec(m.sql);
      old.prepare('INSERT INTO schema_migrations VALUES(?)').run(m.version);
    }
    old.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    old
      .prepare('INSERT INTO projects VALUES(?,?,?)')
      .run(project.id, project.spaceId, JSON.stringify(project));
    old
      .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
      .run(t.id, t.spaceId, t.projectId, JSON.stringify(oldTask));
    old.prepare('INSERT INTO runs VALUES(?,?,?)').run(oldRun.id, t.id, JSON.stringify(oldRun));
    old.close();
    store = new Store(path);
    assert.equal(store.getTask(t.id).createdByUserId, null);
    assert.equal(store.run(oldRun.id).createdByUserId, null);
    assert.equal(store.taskAssignment.history(t.id, historyQuery).items.length, 0);
    store.projectLifecycle.change(
      project.id,
      { action: 'archive', expectedRevision: project.revision, activeRunAction: 'keep' },
      'archive',
    );
    const next = assign(store, store.getTask(t.id));
    store.close();
    store = new Store(path);
    assert.equal(store.getTask(t.id).ownerUserId, second);
    assert.equal(store.getTask(t.id).createdByUserId, null);
    assert.equal(store.run(oldRun.id).createdByUserId, null);
    assert.equal(
      store.taskAssignment.history(t.id, historyQuery).items[0]!.revision,
      next.revision,
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
