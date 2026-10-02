import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Task } from '../packages/contracts/src/index.js';
import {
  parseTaskCompletionHistoryQuery,
  type TaskCompletionHistory,
} from '../packages/contracts/src/task-completion-history.js';
import { Store } from '../packages/db/src/store.js';
import { migrations } from '../packages/db/src/schema.js';
import { demoUser } from '../packages/db/src/seed.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === expected;
const create = (store: Store) =>
  store.createTask({ title: '完成记录', description: '保留原说明', projectId: null }, randomUUID());
const headers = (key: string = randomUUID()) => ({
  'x-hexu-client': 'web',
  'idempotency-key': key,
});
const snapshot = (store: Store) => {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
};
const insert = (
  store: Store,
  taskId: string,
  id: string,
  revision: number,
  actorId = store.actorId,
  action = 'complete',
  at = '2020-01-01T00:00:00.000Z',
) =>
  store.db
    .prepare('INSERT INTO completion_events VALUES(?,?,?,?,?,?)')
    .run(id, taskId, actorId, action, revision, at);

test('完成记录查询严格限制参数、重复值与条数，游标不自动修剪或改写', async () => {
  assert.deepEqual(parseTaskCompletionHistoryQuery({}), { limit: 10, before: null });
  assert.deepEqual(parseTaskCompletionHistoryQuery({ limit: '50', before: 'record-1' }), {
    limit: 50,
    before: 'record-1',
  });
  for (const input of [
    null,
    [],
    { limit: 1 },
    { limit: '0' },
    { limit: '-1' },
    { limit: '01' },
    { limit: '1.5' },
    { limit: '51' },
    { limit: '9007199254740992' },
    { limit: ['1', '2'] },
    { before: ['one', 'two'] },
    { before: null },
    { before: '' },
    { before: ' record-1' },
    { before: 'record-1\n' },
    { before: 'x'.repeat(129) },
    { cursor: 'record-1' },
    { taskId: 'other' },
  ])
    assert.throws(() => parseTaskCompletionHistoryQuery(input), code('INVALID_INPUT'));
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const task = create(store);
    for (const suffix of [
      '?before=one&before=two',
      '?limit=1&limit=2',
      '?limit=51',
      '?limit=0',
      '?limit=01',
      '?before=',
      '?before=%20record-1',
      '?other=x',
    ]) {
      const response = await app.inject(`/api/v1/tasks/${task.id}/completion-history${suffix}`);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, 'INVALID_INPUT');
    }
    assert.equal(
      (await app.inject(`/api/v1/tasks/${task.id}/completion-history`)).headers['cache-control'],
      'no-store',
    );
  } finally {
    await app.close();
  }
});

test('已有完成/重开/取消命令与精确回执原样可读，内容编辑和Run结束不补造记录', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    let task = create(store);
    const path = `/api/v1/tasks/${task.id}`;
    const change = (action: string, revision: number, key: string = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `${path}/${action}`,
        headers: headers(key),
        payload: { expectedRevision: revision, activeRunAction: 'keep' },
      });
    assert.deepEqual((await app.inject(path + '/completion-history')).json(), {
      items: [],
      nextCursor: null,
    });
    const complete = await change('complete', task.revision, 'complete-original');
    assert.equal(complete.statusCode, 200, complete.body);
    task = complete.json();
    const first = (await app.inject(path + '/completion-history')).json<TaskCompletionHistory>();
    assert.equal(first.items[0]!.action, 'complete');
    assert.equal(first.items[0]!.taskRevision, task.revision);
    assert.equal(first.items[0]!.actorId, store.actorId);
    assert.equal(first.items[0]!.actorName, demoUser.name);
    assert.equal(
      first.items[0]!.createdAt,
      store.db
        .prepare('SELECT created_at FROM completion_events WHERE id=?')
        .get(first.items[0]!.id)!.created_at,
    );
    const reopened = await change('reopen', task.revision);
    assert.equal(reopened.statusCode, 200, reopened.body);
    const cancelled = await change('cancel', reopened.json().revision);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const reopenedAgain = await change('reopen', cancelled.json().revision);
    assert.equal(reopenedAgain.statusCode, 200, reopenedAgain.body);
    const beforeReplay = snapshot(store);
    assert.deepEqual((await change('complete', 1, 'complete-original')).json(), complete.json());
    assert.deepEqual(snapshot(store), beforeReplay);
    task = store.patchTask(
      task.id,
      { expectedRevision: reopenedAgain.json().revision, title: '只有内容变化' },
      'edit',
    );
    const run = store.createRun(
      task.id,
      {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'success',
        prompt: '',
        expectedRevision: task.revision,
        reopenTask: false,
      },
      'mock',
    );
    for (const state of ['preparing', 'running', 'succeeded'] as const)
      store.stepRun(run.id, state);
    assert.equal(store.getTask(task.id).status, 'in_progress');
    const history = (await app.inject(path + '/completion-history')).json<TaskCompletionHistory>();
    assert.deepEqual(
      history.items.map((event) => event.action),
      ['reopen', 'cancel', 'reopen', 'complete'],
    );
    assert.deepEqual(
      history.items.map((event) => event.taskRevision),
      [5, 4, 3, 2],
    );
  } finally {
    await app.close();
  }
});

test('分页以同Task已有事件为边界，修订优先且同修订稳定，新增记录不扰乱后续页', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const task = create(store),
      foreign = create(store);
    for (let revision = 1; revision <= 60; revision++)
      insert(store, task.id, `event-${String(revision).padStart(3, '0')}`, revision);
    // Two stored events at one revision still have a strict deterministic order.
    insert(store, task.id, 'event-060-z', 60, store.actorId, 'cancel', '2010-01-01T00:00:00.000Z');
    insert(store, foreign.id, 'foreign-event', 60);
    const path = `/api/v1/tasks/${task.id}/completion-history`;
    const first = (await app.inject(path + '?limit=2')).json<TaskCompletionHistory>();
    assert.deepEqual(
      first.items.map((event) => event.id),
      ['event-060-z', 'event-060'],
    );
    assert.equal(first.nextCursor, 'event-060');
    insert(store, task.id, 'later-event', 61);
    const second = (
      await app.inject(path + `?limit=50&before=${first.nextCursor}`)
    ).json<TaskCompletionHistory>();
    assert.equal(second.items.length, 50);
    assert.deepEqual(
      second.items.map((event) => event.taskRevision),
      Array.from({ length: 50 }, (_, i) => 59 - i),
    );
    const third = (
      await app.inject(path + `?limit=50&before=${second.nextCursor}`)
    ).json<TaskCompletionHistory>();
    assert.deepEqual(
      third.items.map((event) => event.taskRevision),
      [9, 8, 7, 6, 5, 4, 3, 2, 1],
    );
    assert.equal(third.nextCursor, null);
    const tiePage = (
      await app.inject(path + '?limit=1&before=event-060-z')
    ).json<TaskCompletionHistory>();
    assert.equal(tiePage.items[0]!.id, 'event-060');
    for (const cursor of ['foreign-event', 'missing-event']) {
      const response = await app.inject(path + `?before=${cursor}`);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'INVALID_CURSOR');
    }
    assert.equal((await app.inject(path)).json().items[0].id, 'later-event');
  } finally {
    await app.close();
  }
});

test('真实API先检查当前Task读取权，再处理历史和任何游标；只读、私有、跨空间、撤权边界保留', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(bob),
      task = await f.task(bob, project.id);
    const path = `tasks/${task.id}/completion-history`;
    const complete = await f.call(`tasks/${task.id}/complete`, bob, {
      expectedRevision: 1,
      activeRunAction: 'keep',
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const cursor = (await f.call(path, bob)).json().items[0].id;
    for (const suffix of [
      '',
      `?before=${cursor}`,
      '?before=missing',
      '?before=',
      '?limit=0',
      '?unexpected=yes',
    ]) {
      const response = await f.call(path + suffix, alice);
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.body.includes(cursor), false);
    }
    assert.equal(
      (await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(path, alice)).statusCode, 200);
    assert.equal(
      (await f.call(`tasks/${task.id}/reopen`, alice, { expectedRevision: 2 })).statusCode,
      403,
    );
    const privateTask = await f.task(bob);
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/completion-history?before=${cursor}`, alice))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.call(path, { ...alice, spaceId: `personal-${alice.user.id}` })).statusCode,
      404,
    );
    assert.equal((await f.call(path, null)).statusCode, 401);
    assert.equal(
      (await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(path + `?before=${cursor}`, alice)).statusCode, 404);
    assert.equal((await f.call(path + '?before=', alice)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('作者只解析当前同空间/项目成员名字，降为只读仍可显示，撤权与未知作者保持未知', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice),
      task = await f.task(alice, project.id);
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.call(`tasks/${task.id}/complete`, bob, { expectedRevision: 1 })).statusCode,
      200,
    );
    const path = `tasks/${task.id}/completion-history`;
    const original = (await f.call(path, alice)).json().items[0];
    assert.equal(original.actorName, bob.user.name);
    f.store.db.prepare('UPDATE collab_people SET name=? WHERE id=?').run('当前新名字', bob.user.id);
    assert.equal((await f.call(path, alice)).json().items[0].actorName, '当前新名字');
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(path, alice)).json().items[0].actorName, '当前新名字');
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
      200,
    );
    const unavailable = (await f.call(path, alice)).json().items[0];
    assert.deepEqual(unavailable, { ...original, actorName: null });
    // The person still exists in this space, but belongs to a different project.
    const other = await f.project(alice);
    await f.call(`projects/${other.id}/members/${bob.user.id}`, alice, { role: 'view' });
    assert.equal((await f.call(path, alice)).json().items[0].actorName, null);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    const remove = await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {});
    assert.equal(remove.statusCode, 200, remove.body);
    // Even an old project membership row cannot stand in for current space membership.
    f.store.db
      .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
      .run(project.id, bob.user.id, 'view');
    assert.equal((await f.call(path, alice)).json().items[0].actorName, null);
    const revoked = await f.call(path + `?before=${original.id}`, bob);
    assert.equal(revoked.statusCode, 403);
    assert.equal(revoked.json().error.code, 'SPACE_ACCESS_REVOKED');
    insert(f.store, task.id, 'unknown-author', 3, 'absent-person', 'legacy-action');
    const unknown = (await f.call(path, alice)).json().items[0];
    assert.equal(unknown.actorName, null);
    assert.equal(unknown.action, 'legacy-action');
    const privateTask = await f.task(alice);
    insert(f.store, privateTask.id, 'private-outsider', 2, bob.user.id);
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/completion-history`, alice)).json().items[0].actorName,
      null,
    );
  } finally {
    await f.close();
  }
});

test('读取成功、空页、错误和分页都不改变Task、事件、回执、Run或任意数据库行', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    let task = create(store);
    const run = store.createRun(
      task.id,
      {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'success',
        prompt: '不执行',
        expectedRevision: task.revision,
        reopenTask: false,
      },
      'read-only-run',
    );
    task = store.changeTask(
      task.id,
      'done',
      store.getTask(task.id).revision,
      'keep',
      'complete-keep',
    );
    store.changeTask(task.id, 'todo', task.revision, 'keep', 'reopen-keep');
    const before = snapshot(store);
    const path = `/api/v1/tasks/${task.id}/completion-history`;
    const first = (await app.inject(path + '?limit=1')).json<TaskCompletionHistory>();
    assert.equal((await app.inject(path + `?before=${first.nextCursor}`)).statusCode, 200);
    const oldest = store.taskCompletionHistory.history(task.id).items.at(-1)!;
    assert.deepEqual((await app.inject(path + `?before=${oldest.id}`)).json(), {
      items: [],
      nextCursor: null,
    });
    for (const suffix of ['', '?before=missing', '?limit=51', '?unexpected=yes'])
      await app.inject(path + suffix);
    assert.deepEqual(snapshot(store), before);
    assert.equal(store.run(run.id).state, 'queued');
    assert.equal(store.getTask(task.id).status, 'todo');
  } finally {
    await app.close();
  }
});

test('旧库只增加查询索引，保留原事件动作/作者/时间；已完成但无记录的Task不回填，重启不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-completion-history-migration-'));
  const path = join(dir, 'workspace.sqlite');
  let store: Store | undefined;
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((migration) => migration.version < 40)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    const task: Task = {
      id: 'old-task',
      shortId: 'HX-OLD',
      spaceId: 'space-demo',
      projectId: null,
      visibility: 'private',
      ownerUserId: demoUser.id,
      createdByUserId: null,
      title: '旧完成任务',
      description: '',
      attention: null,
      status: 'done',
      revision: 17,
      createdAt: '2010-01-01T00:00:00.000Z',
      updatedAt: '2021-01-01T00:00:00.000Z',
    };
    for (const id of [task.id, 'old-empty-task'])
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(
        id,
        task.spaceId,
        null,
        JSON.stringify({ ...task, id }),
      );
    db.prepare('INSERT INTO completion_events VALUES(?,?,?,?,?,?)').run(
      'old-record',
      task.id,
      'unknown-person',
      'legacy-action',
      9,
      '2015-01-02T03:04:05.000Z',
    );
    const originalTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const originalEvents = db.prepare('SELECT * FROM completion_events').all();
    db.close();
    for (let opening = 0; opening < 2; opening++) {
      store = new Store(path);
      assert.deepEqual(store.db.prepare('SELECT * FROM tasks ORDER BY id').all(), originalTasks);
      assert.deepEqual(store.db.prepare('SELECT * FROM completion_events').all(), originalEvents);
      assert.deepEqual(store.taskCompletionHistory.history(task.id), {
        items: [
          {
            id: 'old-record',
            taskId: task.id,
            actorId: 'unknown-person',
            actorName: null,
            action: 'legacy-action',
            taskRevision: 9,
            createdAt: '2015-01-02T03:04:05.000Z',
          },
        ],
        nextCursor: null,
      });
      assert.deepEqual(store.taskCompletionHistory.history('old-empty-task'), {
        items: [],
        nextCursor: null,
      });
      assert.equal(
        store.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='completion_events_task_history'",
          )
          .get()!['1'],
        1,
      );
      store.close();
    }
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
