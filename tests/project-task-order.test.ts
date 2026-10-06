import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/control/src/app.js';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseProjectTaskMove,
  parseProjectTaskOrderQuery,
  type ProjectTaskMove,
  type ProjectTaskOrder,
  type ProjectTaskMoveReceipt,
} from '../packages/contracts/src/project-task-order.js';
import { ProjectTaskOrderStore } from '../packages/db/src/project-task-order.js';
import { Store } from '../packages/db/src/store.js';

type App = Awaited<ReturnType<typeof createApp>>;
const headers = (key: string) => ({ 'x-hexu-client': 'web', 'idempotency-key': key });
const url = (projectId: string) => `/api/v1/projects/${projectId}/task-order`;
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-project-task-order-'));
  const path = join(dir, 'preview.sqlite');
  const store = new Store(path);
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject(
    { name: '普通项目排序', description: '保留原项目' },
    randomUUID(),
  );
  const created = Array.from({ length: 6 }, (_, index) =>
    store.createTask(
      {
        title: `任务 ${index + 1}`,
        description: index % 2 ? '匹配说明' : '筛选隐藏说明',
        projectId: project.id,
      },
      randomUUID(),
    ),
  );
  return {
    app,
    store,
    path,
    project,
    tasks: created.reverse(),
    orders: new ProjectTaskOrderStore(store),
  };
}

async function read(app: App, projectId: string): Promise<ProjectTaskOrder> {
  const response = await app.inject({ url: url(projectId) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<ProjectTaskOrder>();
}

function moveBody(
  view: ProjectTaskOrder,
  taskId: string,
  anchorTaskId: string,
  placement: 'before' | 'after' = 'before',
): ProjectTaskMove {
  return {
    taskId,
    anchorTaskId,
    placement,
    expectedRevision: view.revision,
    expectedBaseline: view.baseline,
  };
}

function post(app: App, projectId: string, payload: unknown, key: string = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `${url(projectId)}/move`,
    payload: JSON.stringify(payload),
    headers: { ...headers(key), 'content-type': 'application/json' },
  });
}

function rows(store: Store, table: string): string {
  return JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function parentBytes(store: Store) {
  return Object.fromEntries(
    [
      'projects',
      'project_revisions',
      'tasks',
      'messages',
      'runs',
      'results',
      'result_revisions',
      'metadata',
    ].map((table) => [table, rows(store, table)]),
  );
}

function mutationBytes(store: Store) {
  return Object.fromEntries(
    ['project_task_order_sets', 'project_task_ranks', 'outbox', 'idempotency_records'].map(
      (table) => [table, rows(store, table)],
    ),
  );
}

test('ordering contracts require one explicit distinct anchor and a bounded exact baseline', () => {
  const valid = {
    taskId: 'task-a',
    anchorTaskId: 'task-b',
    placement: 'before',
    expectedRevision: 1,
    expectedBaseline: 'a'.repeat(64),
  };
  assert.deepEqual(parseProjectTaskMove(valid), valid);
  for (const value of [
    null,
    [],
    {},
    { ...valid, taskId: '' },
    { ...valid, anchorTaskId: valid.taskId },
    { ...valid, taskId: 'a'.repeat(151) },
    { ...valid, anchorTaskId: [] },
    { ...valid, placement: 'first' },
    { ...valid, expectedRevision: 0 },
    { ...valid, expectedRevision: '1' },
    { ...valid, expectedRevision: 1.1 },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, expectedBaseline: 'A'.repeat(64) },
    { ...valid, expectedBaseline: 'a'.repeat(63) },
    { ...valid, expectedBaseline: ['a'.repeat(64)] },
    ...['rank', 'taskIds', 'projectId', 'status', 'revision'].map((field) => ({
      ...valid,
      [field]: 'forged',
    })),
  ])
    assert.throws(() => parseProjectTaskMove(value), code('INVALID_INPUT'));
  assert.equal(parseProjectTaskOrderQuery({}), undefined);
  for (const query of [{ q: '' }, { limit: '1' }, { projectId: 'other' }])
    assert.throws(() => parseProjectTaskOrderQuery(query), code('INVALID_INPUT'));
});

test('initial HTTP order is exactly the current project collection in rowid DESC and reads write nothing', async (t) => {
  const { app, store, project, tasks } = await fixture(t);
  store.createTask({ title: '个人任务', description: '', projectId: null }, randomUUID());
  const other = store.createProject({ name: '另一个项目', description: '' }, randomUUID());
  store.createTask({ title: '其他项目任务', description: '', projectId: other.id }, randomUUID());
  const before = { parent: parentBytes(store), mutation: mutationBytes(store) };
  const view = await read(app, project.id);
  assert.deepEqual(
    view.taskIds,
    tasks.map((task) => task.id),
  );
  assert.deepEqual(
    view.taskIds,
    store
      .tasks()
      .filter((task) => task.projectId === project.id)
      .map((task) => task.id),
  );
  assert.equal(view.revision, 1);
  assert.match(view.baseline, /^[a-f0-9]{64}$/);
  assert.deepEqual(await read(app, project.id), view);
  assert.deepEqual({ parent: parentBytes(store), mutation: mutationBytes(store) }, before);
  assert.equal(rows(store, 'project_task_ranks'), '[]');
  assert.equal(rows(store, 'project_task_order_sets'), '[]');
  const empty = store.createProject({ name: '空项目', description: '' }, randomUUID());
  assert.deepEqual((await read(app, empty.id)).taskIds, []);
  assert.equal((await app.inject({ url: `${url(project.id)}?q=任务` })).statusCode, 400);
});

test('single before/after moves persist across HTTP reload, preserve filter-hidden relative order and all parent bytes', async (t) => {
  const { app, store, path, project, tasks, orders } = await fixture(t);
  const [a, b, c, d, e, f] = tasks.map((task) => task.id) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  store.addMessage(a, '原讨论', null, randomUUID());
  store.createResult(a, '原成果', '固定成果内容', randomUUID());
  const run = store.createRun(
    a,
    {
      provider: 'mock',
      requestedTool: 'codex',
      scenario: 'success',
      prompt: '仅测试模拟记录',
      expectedRevision: 1,
      reopenTask: false,
    },
    randomUUID(),
  );
  store.stepRun(run.id, 'preparing');
  store.stepRun(run.id, 'running');
  store.stepRun(run.id, 'succeeded');
  const before = parentBytes(store);
  const globalBefore = store.tasks();
  const view = await read(app, project.id);
  // The chosen visible filter is [a,c,e]; b,d,f remain in the project sequence.
  const response = await post(app, project.id, moveBody(view, e, c));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual((await read(app, project.id)).taskIds, [a, b, e, c, d, f]);
  assert.deepEqual(
    (await read(app, project.id)).taskIds.filter((id) => [b, d, f].includes(id)),
    [b, d, f],
  );
  const moved = orders.move(
    project.id,
    moveBody(orders.view(project.id), a, d, 'after'),
    randomUUID(),
  );
  assert.equal(moved.revision, 3);
  assert.deepEqual(orders.view(project.id).taskIds, [b, e, c, d, a, f]);
  assert.deepEqual(parentBytes(store), before);
  assert.deepEqual(store.tasks(), globalBefore);
  const ordinaryList = await app.inject({
    url: `/api/v1/spaces/${store.spaceId}/tasks?projectId=${project.id}`,
  });
  assert.deepEqual(
    ordinaryList.json().items.map((task: { id: string }) => task.id),
    tasks.map((task) => task.id),
  );
  const expected = orders.view(project.id);
  await app.close();
  const reopened = new Store(path);
  const reopenedApp = await createApp({ store: reopened, native: { enabled: false, roots: [] } });
  try {
    assert.deepEqual(await read(reopenedApp, project.id), expected);
    assert.deepEqual(parentBytes(reopened), before);
  } finally {
    await reopenedApp.close();
  }
});

test('original keys return their exact ACK after later moves, content and status changes; no new cancelled move', async (t) => {
  const { app, store, project, tasks, orders } = await fixture(t);
  const [a, b, c] = tasks;
  const original = moveBody(await read(app, project.id), c!.id, a!.id);
  const key = randomUUID();
  const first = await post(app, project.id, original, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json<ProjectTaskMoveReceipt>().changed, true);
  assert.equal('taskIds' in first.json(), false);
  assert.equal((await post(app, project.id, original, key)).body, first.body);
  orders.move(project.id, moveBody(orders.view(project.id), b!.id, a!.id), randomUUID());
  store.patchTask(c!.id, { title: '后来修改标题', expectedRevision: c!.revision }, randomUUID());
  store.changeTask(c!.id, 'cancelled', c!.revision + 1, 'keep', randomUUID());
  const beforeReplay = mutationBytes(store);
  const replay = await post(app, project.id, original, key);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.body, first.body);
  assert.deepEqual(mutationBytes(store), beforeReplay);
  assert.notEqual(replay.json().baseline, orders.view(project.id).baseline);
  assert.equal(
    (await post(app, project.id, { ...original, placement: 'after' }, key)).json().error.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await post(app, project.id, { ...original, taskId: ` ${original.taskId}` }, key)).json().error
      .code,
    'IDEMPOTENCY_CONFLICT',
  );
  const cancelled = await post(app, project.id, moveBody(orders.view(project.id), c!.id, a!.id));
  assert.equal(cancelled.statusCode, 422, cancelled.body);
  assert.equal(cancelled.json().error.code, 'TASK_ORDER_UNAVAILABLE');
});

test('two real SQLite connections using one revision accept only one competing move', async (t) => {
  const { app, path, store, project, tasks } = await fixture(t);
  const secondStore = new Store(path);
  const secondApp = await createApp({ store: secondStore, native: { enabled: false, roots: [] } });
  try {
    const firstView = await read(app, project.id),
      secondView = await read(secondApp, project.id);
    assert.deepEqual(firstView, secondView);
    const responses = await Promise.all([
      post(app, project.id, moveBody(firstView, tasks[4]!.id, tasks[0]!.id)),
      post(secondApp, project.id, moveBody(secondView, tasks[5]!.id, tasks[1]!.id)),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(
      responses.find((response) => response.statusCode === 409)!.json().error.code,
      'PROJECT_TASK_ORDER_CONFLICT',
    );
    assert.equal((await read(app, project.id)).revision, 2);
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM outbox WHERE kind='project.task_order_changed'")
        .get()!.n,
      1,
    );
  } finally {
    await secondApp.close();
  }
});

test('a concurrent connection cannot mix an old sequence with a new revision in a GET snapshot', async (t) => {
  const { app, store, path, project, tasks, orders } = await fixture(t);
  const before = orders.view(project.id);
  const second = new Store(path);
  const secondOrders = new ProjectTaskOrderStore(second);
  const prepare = store.db.prepare.bind(store.db);
  let moved = false;
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql === 'SELECT task_id,rank FROM project_task_ranks WHERE project_id=?') {
      statement.all = new Proxy(statement.all, {
        apply(target, receiver, args) {
          const current = Reflect.apply(target, receiver, args);
          if (!moved) {
            moved = true;
            // Commit after the first connection has read old ranks but before it reads revision.
            secondOrders.move(
              project.id,
              moveBody(before, tasks[4]!.id, tasks[0]!.id),
              randomUUID(),
            );
          }
          return current;
        },
      });
    }
    return statement;
  };
  try {
    assert.deepEqual(await read(app, project.id), before);
    store.db.prepare = prepare;
    const after = await read(app, project.id);
    assert.equal(after.revision, before.revision + 1);
    assert.notDeepEqual(after.taskIds, before.taskIds);
    assert.deepEqual(
      store.atomic(() => orders.view(project.id)),
      after,
    );
  } finally {
    store.db.prepare = prepare;
    second.close();
  }
});

test('current collection/status changes invalidate the baseline; content-only edits do not and new tasks append deterministically', async (t) => {
  const { app, store, project, tasks, orders } = await fixture(t);
  const initial = orders.view(project.id);
  store.patchTask(
    tasks[3]!.id,
    { title: '内容修订不等于排序修订', expectedRevision: 1 },
    randomUUID(),
  );
  const first = orders.move(
    project.id,
    moveBody(initial, tasks[5]!.id, tasks[0]!.id),
    randomUUID(),
  );
  assert.equal(first.revision, 2);
  const statusBaseline = orders.view(project.id);
  store.changeTask(tasks[3]!.id, 'in_progress', 2, 'keep', randomUUID());
  const statusConflict = await post(
    app,
    project.id,
    moveBody(statusBaseline, tasks[4]!.id, tasks[0]!.id),
  );
  assert.equal(statusConflict.statusCode, 409, statusConflict.body);
  const memberBaseline = orders.view(project.id);
  const firstNew = store.createTask(
    { title: '新增一', description: '', projectId: project.id },
    randomUUID(),
  );
  const secondNew = store.createTask(
    { title: '新增二', description: '', projectId: project.id },
    randomUUID(),
  );
  const withNew = orders.view(project.id);
  assert.deepEqual(withNew.taskIds, [...memberBaseline.taskIds, secondNew.id, firstNew.id]);
  assert.equal(withNew.revision, memberBaseline.revision);
  assert.notEqual(withNew.baseline, memberBaseline.baseline);
  const membershipConflict = await post(
    app,
    project.id,
    moveBody(memberBaseline, tasks[4]!.id, tasks[0]!.id),
  );
  assert.equal(membershipConflict.statusCode, 409, membershipConflict.body);
  const beforeRead = mutationBytes(store);
  await read(app, project.id);
  assert.deepEqual(mutationBytes(store), beforeRead);
  assert.equal(
    store.db.prepare('SELECT 1 FROM project_task_ranks WHERE task_id=?').get(firstNew.id),
    undefined,
  );
  const movedNew = await post(app, project.id, moveBody(withNew, firstNew.id, tasks[0]!.id));
  assert.equal(movedNew.statusCode, 200, movedNew.body);
  assert.deepEqual(
    orders.view(project.id).taskIds.filter((id) => id !== firstNew.id),
    withNew.taskIds.filter((id) => id !== firstNew.id),
  );
});

test('no-op and repeated no-op keep virtual/current revisions and publish no duplicate event', async (t) => {
  const { app, store, project, tasks, orders } = await fixture(t);
  const key = randomUUID();
  const body = moveBody(orders.view(project.id), tasks[0]!.id, tasks[1]!.id);
  const outbox = rows(store, 'outbox');
  const original = await post(app, project.id, body, key);
  assert.equal(original.statusCode, 200, original.body);
  assert.equal(original.json().changed, false);
  assert.equal(original.json().revision, 1);
  assert.equal(rows(store, 'project_task_ranks'), '[]');
  assert.equal(rows(store, 'project_task_order_sets'), '[]');
  assert.equal(rows(store, 'outbox'), outbox);
  assert.equal((await post(app, project.id, body, key)).body, original.body);
  const moved = orders.move(
    project.id,
    moveBody(orders.view(project.id), tasks[4]!.id, tasks[0]!.id),
    randomUUID(),
  );
  const before = rows(store, 'outbox');
  const currentNoop = orders.move(
    project.id,
    moveBody(orders.view(project.id), tasks[4]!.id, tasks[0]!.id),
    randomUUID(),
  );
  assert.equal(currentNoop.changed, false);
  assert.equal(currentNoop.revision, moved.revision);
  assert.equal(rows(store, 'outbox'), before);
});

test('wrong-project targets, malformed bodies and request bounds cannot write ordering', async (t) => {
  const { app, store, project, tasks, orders } = await fixture(t);
  const other = store.createProject({ name: '别的项目', description: '' }, randomUUID());
  const elsewhere = store.createTask(
    { title: '别处任务', description: '', projectId: other.id },
    randomUUID(),
  );
  const valid = moveBody(orders.view(project.id), tasks[4]!.id, tasks[0]!.id);
  const before = mutationBytes(store);
  for (const body of [
    { ...valid, taskId: elsewhere.id },
    { ...valid, anchorTaskId: elsewhere.id },
    { ...valid, anchorTaskId: randomUUID() },
  ]) {
    const result = await post(app, project.id, body);
    assert.equal(result.statusCode, 404, result.body);
  }
  for (const body of [null, { ...valid, status: 'done' }, { ...valid, taskId: valid.anchorTaskId }])
    assert.equal((await post(app, project.id, body)).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `${url(project.id)}/move`,
        payload: valid,
        headers: { 'x-hexu-client': 'web' },
      })
    ).statusCode,
    400,
  );
  assert.equal((await post(app, project.id, valid, 'bad key')).statusCode, 400);
  const maximal = {
    ...valid,
    taskId: 'a'.repeat(150),
    anchorTaskId: 'b'.repeat(150),
    expectedRevision: Number.MAX_SAFE_INTEGER,
  };
  const escaped = JSON.stringify(maximal).replace(
    /"[^"]*"/g,
    (quoted) =>
      '"' +
      [...quoted.slice(1, -1)]
        .map((character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
        .join('') +
      '"',
  );
  assert.ok(Buffer.byteLength(escaped) > 2048 && Buffer.byteLength(escaped) < 4096);
  const escapedResponse = await app.inject({
    method: 'POST',
    url: `${url(project.id)}/move`,
    payload: escaped,
    headers: { ...headers(randomUUID()), 'content-type': 'application/json' },
  });
  assert.equal(escapedResponse.statusCode, 404, escapedResponse.body);
  assert.equal(
    (await post(app, project.id, { ...valid, extra: 'a'.repeat(4096) })).statusCode,
    413,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `${url(project.id)}/move?q=any`,
        payload: valid,
        headers: headers(randomUUID()),
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(mutationBytes(store), before);
});

test('rank gap exhaustion deliberately rebalances in the same revision without changing other relative positions', async (t) => {
  const { store, project, tasks, orders } = await fixture(t);
  orders.move(
    project.id,
    moveBody(orders.view(project.id), tasks[5]!.id, tasks[0]!.id),
    randomUUID(),
  );
  const before = orders.view(project.id);
  before.taskIds.forEach((id, index) =>
    store.db
      .prepare('UPDATE project_task_ranks SET rank=? WHERE project_id=? AND task_id=?')
      .run(index + 1, project.id, id),
  );
  const parents = parentBytes(store);
  const [moved, , anchor] = before.taskIds;
  orders.move(
    project.id,
    moveBody(orders.view(project.id), moved!, anchor!, 'after'),
    randomUUID(),
  );
  const after = orders.view(project.id);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(
    after.taskIds.filter((id) => id !== moved),
    before.taskIds.filter((id) => id !== moved),
  );
  assert.equal(after.taskIds.indexOf(moved!), after.taskIds.indexOf(anchor!) + 1);
  assert.ok(
    (store.db.prepare('SELECT max(rank) AS rank FROM project_task_ranks').get()!.rank as number) >=
      1024,
  );
  assert.deepEqual(parentBytes(store), parents);
});

test('ordering ranks, set revision, outbox and receipt each roll back atomically and the identical key can retry', async (t) => {
  const { store, project, tasks, orders } = await fixture(t);
  for (const table of [
    'project_task_ranks',
    'project_task_order_sets',
    'outbox',
    'idempotency_records',
  ]) {
    const key = randomUUID();
    const view = orders.view(project.id);
    const body = moveBody(view, view.taskIds.at(-1)!, view.taskIds[0]!);
    const before = { parents: parentBytes(store), mutations: mutationBytes(store) };
    store.db.exec(
      `CREATE TRIGGER reject_order_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
    );
    assert.throws(() => orders.move(project.id, body, key), /fixture rollback/);
    assert.deepEqual({ parents: parentBytes(store), mutations: mutationBytes(store) }, before);
    assert.deepEqual(orders.view(project.id), view);
    store.db.exec('DROP TRIGGER reject_order_write');
    assert.equal(orders.move(project.id, body, key).revision, view.revision + 1);
  }
  assert.equal(store.getTask(tasks[0]!.id).revision, 1);
});

test('unchanged public parent/Task guards run outside and inside the mutation before original receipt replay', async (t) => {
  const { store, project, tasks, orders } = await fixture(t);
  const body = moveBody(orders.view(project.id), tasks[4]!.id, tasks[0]!.id);
  const key = randomUUID();
  const original = orders.move(project.id, body, key);
  const calls: string[] = [];
  const projectGuard = store.project.bind(store),
    taskGuard = store.getTask.bind(store),
    mutate = store.mutate.bind(store);
  let entered = false;
  store.project = (id) => {
    calls.push(`project:${entered ? 'inside' : 'outside'}`);
    return projectGuard(id);
  };
  store.getTask = (id, write) => {
    calls.push(`task:${write ? 'edit' : 'read'}:${entered ? 'inside' : 'outside'}`);
    return taskGuard(id, write);
  };
  store.mutate = (scope, requestKey, payload, action, beforeReplay) =>
    mutate(scope, requestKey, payload, action, () => {
      entered = true;
      assert.equal(store.db.isTransaction, true);
      beforeReplay?.();
    });
  assert.deepEqual(orders.move(project.id, body, key), original);
  assert.deepEqual(calls, [
    'project:outside',
    'task:edit:outside',
    'project:inside',
    'task:edit:inside',
  ]);
});

test('migration 33 adds empty metadata only and existing project/Task bytes survive rebuilding it', async (t) => {
  const { app, store, path } = await fixture(t);
  const before = parentBytes(store);
  await app.close();
  const previous = new DatabaseSync(path);
  previous.exec(
    'DROP TABLE project_task_ranks; DROP TABLE project_task_order_sets; DELETE FROM schema_migrations WHERE version=33',
  );
  previous.close();
  const migrated = new Store(path);
  try {
    assert.deepEqual(parentBytes(migrated), before);
    assert.equal(rows(migrated, 'project_task_ranks'), '[]');
    assert.equal(rows(migrated, 'project_task_order_sets'), '[]');
    assert.equal(
      migrated.db.prepare('SELECT version FROM schema_migrations WHERE version=33').get()!.version,
      33,
    );
  } finally {
    migrated.close();
  }
});
