import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Task } from '../packages/contracts/src/index.js';
import { parseTaskContentHistoryQuery } from '../packages/contracts/src/task-content-history.js';
import { Store } from '../packages/db/src/store.js';
import { migrations } from '../packages/db/src/schema.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const query = { limit: 50, before: null };
const code = (name: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === name;
const create = (store: Store) =>
  store.createTask({ title: '原标题', description: '原说明', projectId: null }, randomUUID());
const headers = (key: string = randomUUID()) => ({
  'x-hexu-client': 'web',
  'idempotency-key': key,
});

test('工作说明历史严格校验有界查询，重复、未知、非安全整数被拒绝', async () => {
  assert.deepEqual(parseTaskContentHistoryQuery({}), { limit: 10, before: null });
  assert.deepEqual(parseTaskContentHistoryQuery({ limit: '50', before: '12' }), {
    limit: 50,
    before: 12,
  });
  for (const bad of [
    { limit: '51' },
    { limit: '0' },
    { before: '01' },
    { before: '1.1' },
    { before: '-1' },
    { before: '9007199254740992' },
    { before: ['1', '2'] },
    { taskId: 'other' },
  ])
    assert.throws(() => parseTaskContentHistoryQuery(bad), code('INVALID_INPUT'));
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const task = create(store);
    for (const suffix of ['?before=1&before=2', '?limit=1&limit=2', '?limit=51', '?other=x']) {
      const response = await app.inject(`/api/v1/tasks/${task.id}/content-history${suffix}`);
      assert.equal(response.statusCode, 400, response.body);
    }
  } finally {
    await app.close();
  }
});

test('创建及内容保存原子留存已知作者时间和完整快照；无内容变化、Run和状态修订不冒充内容历史', () => {
  const store = new Store();
  try {
    const task = create(store);
    const initial = store.taskContentHistory.history(task.id, query).items;
    assert.equal(initial.length, 1);
    assert.deepEqual(initial[0], {
      taskId: task.id,
      revision: 1,
      title: task.title,
      description: task.description,
      attention: null,
      source: 'created',
      changedFields: [],
      actorId: store.actorId,
      actorName: store.actorName(),
      savedAt: task.createdAt,
    });
    const edited = store.patchTask(
      task.id,
      { expectedRevision: 1, title: '新标题', description: '', attention: '等待反馈' },
      'edit',
    );
    const noChange = store.patchTask(
      task.id,
      { expectedRevision: edited.revision, title: edited.title },
      'same',
    );
    assert.equal(noChange.revision, edited.revision + 1); // Preserve the existing PATCH contract.
    const started = store.changeTask(task.id, 'in_progress', noChange.revision, 'keep', 'start');
    assert.equal(store.taskContentHistory.history(task.id, query).items.length, 2);
    const done = store.changeTask(task.id, 'done', started.revision, 'keep', 'done');
    const items = store.taskContentHistory.history(task.id, query).items;
    assert.deepEqual(
      items.map((item) => item.revision),
      [done.revision, edited.revision, 1],
    );
    assert.deepEqual(items[0]!.changedFields, ['attention']);
    assert.equal(items[0]!.source, 'status');
    assert.equal(items[0]!.attention, null);
    assert.deepEqual(items[1]!.changedFields, ['title', 'description', 'attention']);
    assert.equal(items[1]!.attention, '等待反馈');
    assert.deepEqual(items[2], initial[0]);
    assert.equal(store.runs(task.id).length, 0);
    assert.throws(
      () =>
        store.db
          .prepare('UPDATE task_content_revisions SET body=? WHERE task_id=?')
          .run('{}', task.id),
      /immutable/,
    );
    assert.throws(
      () => store.db.prepare('DELETE FROM task_content_revisions WHERE task_id=?').run(task.id),
      /immutable/,
    );
  } finally {
    store.close();
  }
});

test('并发冲突与原幂等回执不会重复记录或覆盖较新的历史', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const task = create(store);
    const patch = (title: string, revision: number, key: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id}`,
        headers: headers(key),
        payload: { title, expectedRevision: revision },
      });
    const replies = await Promise.all([patch('先保存', 1, 'first'), patch('冲突', 1, 'second')]);
    assert.deepEqual(
      replies.map((reply) => reply.statusCode),
      [200, 409],
    );
    const next = await patch('后保存', 2, 'third');
    assert.equal(next.statusCode, 200);
    const previous = store.taskContentHistory.history(task.id, query);
    const replay = await patch('先保存', 1, 'first');
    assert.deepEqual(replay.json(), replies[0]!.json());
    assert.equal((await patch('换正文', 1, 'first')).statusCode, 409);
    assert.deepEqual(store.taskContentHistory.history(task.id, query), previous);
    assert.deepEqual(
      previous.items.map((item) => item.title),
      ['后保存', '先保存', '原标题'],
    );
  } finally {
    await app.close();
  }
});

test('历史写入失败回滚Task、outbox、回执与创建计数，重试原请求只保存一次', () => {
  const store = new Store();
  try {
    const task = create(store);
    const before = store.getTask(task.id);
    const outbox = store.db.prepare('SELECT * FROM outbox').all();
    const receipts = store.db.prepare('SELECT * FROM idempotency_records').all();
    const counter = store.db.prepare("SELECT value FROM metadata WHERE key='task_counter'").get();
    store.db.exec(
      "CREATE TRIGGER fail_content_history BEFORE INSERT ON task_content_revisions BEGIN SELECT RAISE(ABORT,'fixture history failed'); END;",
    );
    const input = { expectedRevision: before.revision, description: '一起提交' };
    assert.throws(() => store.patchTask(task.id, input, 'retry'), /fixture history failed/);
    assert.throws(() => create(store), /fixture history failed/);
    assert.deepEqual(store.getTask(task.id), before);
    assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), outbox);
    assert.deepEqual(store.db.prepare('SELECT * FROM idempotency_records').all(), receipts);
    assert.deepEqual(
      store.db.prepare("SELECT value FROM metadata WHERE key='task_counter'").get(),
      counter,
    );
    store.db.exec('DROP TRIGGER fail_content_history');
    store.patchTask(task.id, input, 'retry');
    store.patchTask(task.id, input, 'retry');
    assert.equal(store.taskContentHistory.history(task.id, query).items.length, 2);
  } finally {
    store.close();
  }
});

test('分页固定在原Task的已存在内容修订；后来保存不会重复或漏掉原页之后的历史', () => {
  const store = new Store();
  try {
    let task = create(store);
    const foreign = create(store);
    for (let i = 0; i < 14; i++)
      task = store.patchTask(
        task.id,
        { expectedRevision: task.revision, description: `说明 ${i}` },
        randomUUID(),
      );
    const first = store.taskContentHistory.history(task.id, { limit: 10, before: null });
    assert.equal(first.items.length, 10);
    assert.equal(first.nextCursor, 6);
    store.patchTask(task.id, { expectedRevision: task.revision, description: '后来保存' }, 'later');
    const second = store.taskContentHistory.history(task.id, {
      limit: 10,
      before: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.revision),
      [5, 4, 3, 2, 1],
    );
    assert.equal(second.nextCursor, null);
    assert.throws(
      () => store.taskContentHistory.history(foreign.id, { limit: 10, before: first.nextCursor }),
      code('INVALID_CURSOR'),
    );
    assert.throws(
      () => store.taskContentHistory.history(task.id, { limit: 10, before: 999 }),
      code('INVALID_CURSOR'),
    );
    assert.equal(
      store.taskContentHistory.history(task.id, query).items[0]!.description,
      '后来保存',
    );
  } finally {
    store.close();
  }
});

test('旧库只迁移当前已知内容，不根据创建者或更新时间补造历史，独立重开持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-content-history-migration-'));
  const path = join(dir, 'workspace.sqlite');
  let store: Store | undefined;
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((item) => item.version < 38)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    old.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    const task: Task = {
      id: 'old-task',
      shortId: 'HX-OLD',
      spaceId: 'space-demo',
      projectId: null,
      visibility: 'private',
      ownerUserId: 'user-lin',
      createdByUserId: 'not-the-editor',
      title: '旧标题',
      description: '仅最后已知说明',
      attention: '旧关注',
      status: 'todo',
      revision: 17,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-02-01T00:00:00.000Z',
    };
    old
      .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
      .run(task.id, task.spaceId, null, JSON.stringify(task));
    old.close();
    store = new Store(path, task.ownerUserId);
    const items = store.taskContentHistory.history(task.id, query).items;
    assert.equal(items.length, 1);
    assert.deepEqual(
      { ...items[0] },
      {
        taskId: task.id,
        revision: 17,
        title: task.title,
        description: task.description,
        attention: task.attention,
        source: 'legacy',
        actorId: null,
        actorName: null,
        savedAt: null,
        changedFields: [],
      },
    );
    store.patchTask(task.id, { expectedRevision: 17, description: '迁移后保存' }, 'new');
    store.close();
    store = new Store(path, task.ownerUserId);
    assert.deepEqual(
      store.taskContentHistory.history(task.id, query).items.map((item) => item.revision),
      [18, 17],
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('历史沿用当前Task读取权限，空间所有者、私有任务、撤权旧游标和旧回执不能泄漏内容', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(bob);
    const task = await f.task(bob, project.id, '只有项目成员可见');
    const path = `tasks/${task.id}`;
    const body = { expectedRevision: task.revision, description: '被撤权后不可见的旧说明' };
    assert.equal((await f.call(path, bob, body, 'edit', 'PATCH')).statusCode, 200);
    assert.equal((await f.call(path + '/content-history', alice)).statusCode, 404);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(path + '/content-history', alice)).statusCode, 200);
    assert.equal(
      (await f.call(path, alice, { expectedRevision: 2, title: '不可改' }, 'viewer', 'PATCH'))
        .statusCode,
      403,
    );
    const privateTask = await f.task(bob, null, '私有原说明');
    assert.equal((await f.call(`tasks/${privateTask.id}/content-history`, alice)).statusCode, 404);
    assert.equal(
      (await f.call(path + '/content-history', { ...alice, spaceId: `personal-${alice.user.id}` }))
        .statusCode,
      404,
    );
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const edit = { expectedRevision: 2, title: '记录中的编辑者' };
    assert.equal((await f.call(path, alice, edit, 'alice-edit', 'PATCH')).statusCode, 200);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null });
    for (const suffix of [
      '/content-history',
      '/content-history?before=3',
      '/content-history?before=999',
    ]) {
      const response = await f.call(path + suffix, alice);
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.body.includes(body.description), false);
    }
    assert.equal((await f.call(path, alice, edit, 'alice-edit', 'PATCH')).statusCode, 404);
    assert.equal((await f.call(path + '/content-history', null)).statusCode, 401);
    assert.equal(
      (await f.call(path + '/content-history', bob)).json().items[0].actorId,
      alice.user.id,
    );
  } finally {
    await f.close();
  }
});

test('明确采用已有AI草稿与采用回执同事务记录说明，不会把AI伪装成人工编辑', () => {
  const store = new Store();
  try {
    const task = create(store);
    const message = {
      id: randomUUID(),
      taskId: task.id,
      actorType: 'agent',
      actorName: '虚构AI协议夹具',
      body: '采用这一段',
      resultId: null,
      createdAt: new Date().toISOString(),
    };
    store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(message.id, task.id, JSON.stringify(message));
    const preview = store.aiDrafts.preview(task.id, message.id);
    const draft = store.aiDrafts.create(
      task.id,
      {
        sourceMessageId: message.id,
        expectedSourceHash: preview.origin.hash,
        title: '建议',
        content: message.body,
      },
      'draft',
    );
    const input = {
      expectedRevision: draft.revision,
      ranges: [{ start: 0, end: message.body.length }],
      mode: 'append',
      target: { kind: 'task', id: task.id, expectedRevision: task.revision },
    };
    store.db.exec(
      "CREATE TRIGGER reject_adoption_history BEFORE INSERT ON task_content_revisions BEGIN SELECT RAISE(ABORT,'fixture adoption rollback'); END;",
    );
    assert.throws(
      () => store.aiDrafts.adopt(task.id, draft.id, input, 'adopt'),
      /fixture adoption rollback/,
    );
    assert.equal(store.getTask(task.id).description, task.description);
    assert.equal(store.db.prepare('SELECT 1 FROM ai_draft_adoptions').get(), undefined);
    store.db.exec('DROP TRIGGER reject_adoption_history');
    const adopted = store.aiDrafts.adopt(task.id, draft.id, input, 'adopt');
    assert.deepEqual(store.aiDrafts.adopt(task.id, draft.id, input, 'adopt'), adopted);
    const items = store.taskContentHistory.history(task.id, query).items;
    assert.equal(items.length, 2);
    assert.equal(items[0]!.source, 'adopted');
    assert.equal(items[0]!.actorId, store.actorId);
    assert.equal(items[0]!.description, adopted.target.afterContent);
    assert.deepEqual(items[0]!.changedFields, ['description']);
  } finally {
    store.close();
  }
});
