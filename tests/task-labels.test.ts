import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Task } from '../packages/contracts/src/index.js';
import { parseTaskLabel, parseTaskLabelsChange } from '../packages/contracts/src/task-labels.js';
import { parseTaskPeopleFilters } from '../packages/contracts/src/task-participants.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { demoProjects, demoTasks, SPACE_ID } from '../packages/db/src/seed.js';
import { migrations } from '../packages/db/src/schema.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === expected;
const create = (store: Store) =>
  store.createTask(
    { title: '标签测试', description: '原工作说明', projectId: store.projects()[0]!.id },
    randomUUID(),
  );
const change = (
  store: Store,
  task: Task,
  labels: string[],
  expectedRevision = 1,
  key: string = randomUUID(),
) => store.taskLabels.change(task.id, { expectedRevision, labels }, key);
function snapshot(store: Store) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}

test('标签严格限制文本/集合/修订，规范化后去重且精确区分大小写', () => {
  assert.equal(parseTaskLabel('  Cafe\u0301  '), 'Café');
  assert.equal(parseTaskLabel('中'.repeat(32)), '中'.repeat(32));
  assert.deepEqual(parseTaskLabelsChange({ labels: [' b ', 'A', 'a'], expectedRevision: 1 }), {
    labels: ['A', 'a', 'b'],
    expectedRevision: 1,
  });
  for (const value of [
    '',
    '   ',
    '\nabc',
    'abc\t',
    '\u0000',
    'x'.repeat(33),
    ' '.repeat(33),
    '\u0085',
    null,
    4,
    {},
    [],
  ])
    assert.throws(() => parseTaskLabel(value), code('INVALID_INPUT'));
  for (const value of [
    { labels: ['a', ' a '], expectedRevision: 1 },
    { labels: ['e\u0301', 'é'], expectedRevision: 1 },
    { labels: Array.from({ length: 17 }, (_, i) => String(i)), expectedRevision: 1 },
    { labels: [], expectedRevision: 0 },
    { labels: [], expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { labels: [], expectedRevision: 1, taskId: 'other' },
    { labels: 'abc', expectedRevision: 1 },
  ])
    assert.throws(() => parseTaskLabelsChange(value), code('INVALID_INPUT'));
  assert.deepEqual(parseTaskLabelsChange({ labels: [], expectedRevision: 1 }), {
    labels: [],
    expectedRevision: 1,
  });
  assert.deepEqual(parseTaskPeopleFilters({ label: ' e\u0301 ' }).label, 'é');
  for (const label of ['', ' ', ['a', 'b'], '\n', 'x'.repeat(33)])
    assert.throws(() => parseTaskPeopleFilters({ label }), code('INVALID_INPUT'));
});

test('标签独立修订、精确旧回执与不可变事件，不改Task正文/时间/历史', () => {
  const store = new Store();
  try {
    const task = create(store),
      before = snapshot(store),
      key = 'original-label-save';
    assert.deepEqual(store.taskLabels.view(task.id), {
      taskId: task.id,
      revision: 1,
      labels: [],
      canEdit: true,
    });
    assert.deepEqual(snapshot(store), before);
    const saved = change(store, task, ['接口', ' UI '], 1, key);
    assert.equal(saved.revision, 2);
    const later = change(store, task, ['后来标签'], 2);
    assert.deepEqual(change(store, task, ['接口', 'UI'], 1, key), saved);
    assert.deepEqual(store.taskLabels.view(task.id).labels, ['后来标签']);
    assert.throws(() => change(store, task, ['不同请求'], 1, key), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => change(store, task, ['并发旧写入'], 2), code('REVISION_CONFLICT'));
    const writes = snapshot(store);
    assert.deepEqual(change(store, task, later.labels, later.revision), later);
    const after = snapshot(store);
    for (const name of Object.keys(writes).filter((name) => name !== 'idempotency_records'))
      assert.deepEqual(after[name], writes[name], name);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.project_task_ranks, before.project_task_ranks);
    assert.deepEqual(after.project_task_order_sets, before.project_task_order_sets);
    assert.deepEqual(store.detail(task.id).task.labelNames, later.labels);
    assert.equal(store.detail(task.id).task.labelsRevision, 3);
    assert.deepEqual(
      store.workbench().tasks.find((item) => item.id === task.id)!.labelNames,
      later.labels,
    );
    const events = store.db
      .prepare('SELECT body FROM task_label_events WHERE task_id=? ORDER BY revision')
      .all(task.id) as { body: string }[];
    assert.equal(events.length, 2);
    const event = JSON.parse(events[0]!.body);
    assert.deepEqual(event.previousLabels, []);
    assert.equal(event.actorId, store.actorId);
    assert.ok(event.savedAt);
    assert.throws(
      () =>
        store.db.prepare('UPDATE task_label_events SET body=? WHERE task_id=?').run('{}', task.id),
      /immutable/,
    );
    assert.throws(
      () => store.db.prepare('DELETE FROM task_label_events WHERE task_id=?').run(task.id),
      /immutable/,
    );
    const edited = store.patchTask(
      task.id,
      { expectedRevision: task.revision, title: '独立说明编辑' },
      randomUUID(),
    );
    assert.equal(store.taskLabels.view(task.id).revision, 3);
    assert.equal(edited.labelNames, undefined);
  } finally {
    store.close();
  }
});

test('集合、标签、事件、outbox与回执任一失败均回滚，不丢掉原标签', () => {
  for (const table of [
    'task_label_sets',
    'task_labels',
    'task_label_events',
    'outbox',
    'idempotency_records',
  ]) {
    const store = new Store();
    try {
      const task = create(store);
      change(store, task, ['原标签']);
      const before = snapshot(store);
      store.db.exec(
        `CREATE TRIGGER label_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'label write fault'); END`,
      );
      assert.throws(() => change(store, task, ['新标签'], 2, 'fault-key'), /label write fault/);
      assert.deepEqual(snapshot(store), before, table);
      store.db.exec('DROP TRIGGER label_fault');
      assert.equal(change(store, task, ['新标签'], 2, 'fault-key').revision, 3);
    } finally {
      store.close();
    }
  }
});

test('API精确标签与原条件交集在权限之后、分页之前；查询只读且重复/空值拒绝', async () => {
  const store = new Store(),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const first = create(store),
      second = create(store),
      miss = create(store),
      cancelled = create(store);
    for (const task of [first, second, cancelled]) change(store, task, ['接口', 'API']);
    change(store, miss, ['api']);
    store.changeTask(cancelled.id, 'cancelled', cancelled.revision, 'keep', randomUUID());
    store.patchTask(
      second.id,
      { expectedRevision: 1, description: '原工作说明 请复查' },
      randomUUID(),
    );
    const path = `/api/v1/spaces/${store.spaceId}/tasks?projectId=${first.projectId}&label=${encodeURIComponent('接口')}`;
    const before = snapshot(store);
    const page1 = (await app.inject(path + '&limit=1')).json();
    assert.equal(page1.items[0].id, cancelled.id);
    const page2 = (await app.inject(path + '&limit=1&cursor=' + page1.nextCursor)).json();
    assert.equal(page2.items[0].id, second.id);
    const page3 = (await app.inject(path + '&limit=1&cursor=' + page2.nextCursor)).json();
    assert.equal(page3.items[0].id, first.id);
    assert.equal(page3.nextCursor, null);
    const intersection = (
      await app.inject(
        path + '&q=' + encodeURIComponent('请复查') + '&ownerUserId=' + store.actorId,
      )
    ).json();
    assert.deepEqual(
      intersection.items.map((t: Task) => t.id),
      [second.id],
    );
    assert.equal(
      (await app.inject(path + '&cursor=' + miss.id)).json().error.code,
      'INVALID_CURSOR',
    );
    for (const query of [
      'label=',
      'label=%20',
      'label=a&label=b',
      'label=%0A',
      'label=' + 'x'.repeat(33),
    ])
      assert.equal(
        (await app.inject(`/api/v1/spaces/${store.spaceId}/tasks?${query}`)).statusCode,
        400,
        query,
      );
    assert.deepEqual(
      (await app.inject(`/api/v1/spaces/${store.spaceId}/tasks?label=unknown`)).json().items,
      [],
    );
    assert.equal(matchesTaskPeopleFilters(store.detail(miss.id).task, { label: 'API' }), false);
    assert.equal(matchesTaskPeopleFilters(store.detail(miss.id).task, { label: 'api' }), true);
    assert.deepEqual(snapshot(store), before);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${first.id}/labels`,
      headers: { 'x-hexu-client': 'web', 'idempotency-key': 'extra' },
      payload: { expectedRevision: 2, labels: ['a'], status: 'done' },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('当前项目/空间与编辑权限先于旧回执，私有和跨项目标签不泄露', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      hiddenProject = await f.project(bob),
      task = await f.task(alice, project.id),
      hidden = await f.task(bob, hiddenProject.id),
      privateTask = await f.task(alice);
    const path = `tasks/${task.id}/labels`,
      body = { expectedRevision: 1, labels: ['公开标签'] };
    assert.equal((await f.call(path)).statusCode, 401);
    assert.equal((await f.call(path, bob)).statusCode, 404);
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' }))
        .statusCode,
      200,
    );
    const receipt = await f.call(path, bob, body, 'old-label-key');
    assert.equal(receipt.statusCode, 200);
    assert.equal(
      (
        await f.call(`tasks/${hidden.id}/labels`, bob, {
          expectedRevision: 1,
          labels: ['隐藏标签'],
        })
      ).statusCode,
      200,
    );
    assert.equal((await f.call(`tasks/${privateTask.id}/labels`, alice)).statusCode, 422);
    assert.equal((await f.call(`tasks/${privateTask.id}/labels`, bob)).statusCode, 404);
    assert.equal((await f.call(`tasks/${hidden.id}/labels`, alice)).statusCode, 404);
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(path, bob)).json().canEdit, false);
    assert.equal((await f.call(path, bob, body, 'old-label-key')).statusCode, 403);
    const otherSpace = { ...bob, spaceId: `personal-${bob.user.id}` };
    assert.equal((await f.call(path, otherSpace)).statusCode, 404);
    const listed = (
      await f.call(`spaces/${alice.spaceId}/tasks?label=${encodeURIComponent('隐藏标签')}`, alice)
    ).json();
    assert.deepEqual(listed.items, []);
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(path, bob)).statusCode, 404);
    assert.equal((await f.call(path, bob, body, 'old-label-key')).statusCode, 404);
    assert.deepEqual(
      (
        await f.call(`spaces/${bob.spaceId}/tasks?label=${encodeURIComponent('公开标签')}`, bob)
      ).json().items,
      [],
    );
    assert.equal((await f.call(path, alice)).json().revision, 2);
  } finally {
    await f.close();
  }
});

test('迁移仅创建空标签结构；已保存集合与回执在重启后保持', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-label-migration-')),
    path = join(dir, 'workspace.sqlite');
  let store: Store | undefined;
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((m) => m.version < 34)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    const project = demoProjects[0]!,
      task = demoTasks.find((task) => task.projectId === project.id)!;
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
      project.id,
      SPACE_ID,
      JSON.stringify(project),
    );
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(
      task.id,
      SPACE_ID,
      project.id,
      JSON.stringify(task),
    );
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', 'true');
    const originalTask = db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id);
    db.close();
    store = new Store(path);
    assert.deepEqual(
      store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id),
      originalTask,
    );
    assert.equal(
      (store.db.prepare('SELECT count(*) AS n FROM task_label_events').get() as { n: number }).n,
      0,
    );
    assert.deepEqual(store.taskLabels.view(task.id).labels, []);
    const original = change(store, task, ['重启保留'], 1, 'restart-label-key');
    store.close();
    store = new Store(path);
    assert.deepEqual(store.taskLabels.view(task.id).labels, ['重启保留']);
    assert.deepEqual(change(store, task, ['重启保留'], 1, 'restart-label-key'), original);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('事务开始后的权限降级仍拒绝旧回执，不回放已保存标签', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const body = { expectedRevision: 1, labels: ['原标签'] };
    f.store.as(bob, () => f.store.taskLabels.change(task.id, body, 'transaction-replay'));
    const before = f.store.db.prepare('SELECT * FROM task_label_events').all();
    const original = f.store.mutate.bind(f.store);
    f.store.mutate = <T>(
      scope: string,
      key: string,
      payload: unknown,
      action: () => T,
      beforeReplay?: () => void,
    ) => {
      f.store.db
        .prepare('UPDATE collab_project_members SET role=? WHERE project_id=? AND user_id=?')
        .run('view', project.id, bob.user.id);
      return original(scope, key, payload, action, beforeReplay);
    };
    assert.throws(
      () => f.store.as(bob, () => f.store.taskLabels.change(task.id, body, 'transaction-replay')),
      code('FORBIDDEN'),
    );
    assert.deepEqual(f.store.db.prepare('SELECT * FROM task_label_events').all(), before);
    f.store.mutate = original;
  } finally {
    await f.close();
  }
});
