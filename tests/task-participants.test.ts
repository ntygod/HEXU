import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseParticipantChange,
  parseParticipantHistoryQuery,
  parseTaskPeopleFilters,
} from '../packages/contracts/src/task-participants.js';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { migrations } from '../packages/db/src/schema.js';
import { demoMembers } from '../packages/db/src/seed.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const second = demoMembers[1]!.id,
  third = demoMembers[2]!.id;
const historyQuery = { limit: 50, before: null };
const code = (expected: string) => (e: unknown) => e instanceof DomainError && e.code === expected;
const task = (store: Store) =>
  store.createTask(
    {
      title: '订单协作',
      description: '参与记录不是模型上下文',
      projectId: store.projects()[0]!.id,
    },
    randomUUID(),
  );
const change = (
  store: Store,
  id: string,
  userId = second,
  action: 'add' | 'remove' = 'add',
  key: string = randomUUID(),
) =>
  store.taskParticipants.change(
    id,
    { expectedRevision: store.taskParticipants.view(id).revision, userId, action },
    key,
  );

test('参与契约拒绝身份/权限和执行注入，历史及人员筛选查询有界', () => {
  assert.deepEqual(parseTaskPeopleFilters({ q: '   ' }), {
    q: undefined,
    ownerUserId: undefined,
    participantUserId: undefined,
  });
  assert.deepEqual(
    parseParticipantChange({ expectedRevision: 1, action: 'add', userId: ' user-a ' }),
    { expectedRevision: 1, action: 'add', userId: 'user-a' },
  );
  for (const body of [
    null,
    [],
    {},
    { expectedRevision: '1', action: 'add', userId: second },
    { expectedRevision: 0, action: 'add', userId: second },
    { expectedRevision: 1, action: 'invite', userId: second },
    { expectedRevision: 1, action: 'add', userId: '' },
    { expectedRevision: 1, action: 'add', userId: 'x'.repeat(101) },
    ...['role', 'ownerUserId', 'projectId', 'visibility', 'command', 'actorId', 'threadId'].map(
      (field) => ({ expectedRevision: 1, action: 'add', userId: second, [field]: 'forged' }),
    ),
  ])
    assert.throws(() => parseParticipantChange(body), code('INVALID_INPUT'));
  assert.deepEqual(parseParticipantHistoryQuery({}), { before: null, limit: 10 });
  for (const query of [
    { limit: '51' },
    { before: '0' },
    { before: '1.5' },
    { before: '9007199254740992' },
    { before: ['2'] },
    { taskId: 'foreign' },
  ])
    assert.throws(() => parseParticipantHistoryQuery(query), code('INVALID_INPUT'));
  assert.deepEqual(
    parseTaskPeopleFilters({
      q: '  订单 ',
      ownerUserId: ' x ',
      participantUserId: 'y',
      limit: '1',
    }),
    { q: '订单', ownerUserId: 'x', participantUserId: 'y' },
  );
  for (const query of [
    { q: ['a'] },
    { q: 'x'.repeat(161) },
    { ownerUserId: 'x'.repeat(101) },
    { participantUserId: { id: 'a' } },
  ])
    assert.throws(() => parseTaskPeopleFilters(query), code('INVALID_INPUT'));
});

test('参与者独立修订，加入/退出不改变任务、运行、锁、已确认接续或原材料', () => {
  const store = new Store();
  try {
    const t = task(store),
      copy = store.registerWorkingCopy({
        id: randomUUID(),
        name: '无进程协议夹具',
        root: '/fictional/participants-fixture',
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
        contextText: '原材料',
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
      }),
      randomUUID(),
    );
    const before = store.getTask(t.id),
      run = store.run(source.id),
      locks = store.db.prepare('SELECT * FROM native_workspace_locks').all();
    change(store, t.id);
    change(store, t.id, store.actorId);
    change(store, t.id, store.actorId, 'remove');
    assert.equal(store.taskParticipants.view(t.id).revision, 4);
    assert.deepEqual(store.getTask(t.id), before);
    assert.equal('participantUserIds' in store.getTask(t.id), false);
    assert.deepEqual(store.run(source.id), run);
    assert.deepEqual(store.db.prepare('SELECT * FROM native_workspace_locks').all(), locks);
    assert.deepEqual(operations.get(op.id), op);
    assert.deepEqual(store.detail(t.id).task.participantUserIds, [second]);
    assert.deepEqual(store.workbench().tasks.find((item) => item.id === t.id)?.participantUserIds, [
      second,
    ]);
    assert.deepEqual(
      store.taskParticipants.history(t.id, historyQuery).items.map((item) => item.action),
      ['left', 'joined', 'added'],
    );
    assert.equal(
      store.taskParticipants.history(t.id, historyQuery).items[0]!.actorId,
      store.actorId,
    );
  } finally {
    store.close();
  }
});

test('同参与修订并发只接受一份操作，丢失回执不重复事件/复活关系，历史游标稳定', async () => {
  const store = new Store(),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const t = task(store),
      url = `/api/v1/tasks/${t.id}/participants`;
    const post = (userId: string, expectedRevision: number, key: string, action = 'add') =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
        payload: { userId, expectedRevision, action },
      });
    const results = await Promise.all([post(second, 1, 'a'), post(third, 1, 'b')]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    const winner =
      results[0]!.statusCode === 200 ? { id: second, key: 'a' } : { id: third, key: 'b' };
    assert.equal((await post(winner.id, 1, winner.key)).json().revision, 2);
    assert.equal((await post(winner.id, 2, 'remove', 'remove')).json().revision, 3);
    assert.equal((await post(winner.id, 1, winner.key)).json().revision, 2);
    assert.deepEqual(store.detail(t.id).task.participantUserIds, []);
    const events = store.db.prepare('SELECT * FROM outbox').all();
    assert.equal((await post(winner.id, 3, 'noop', 'remove')).json().revision, 3);
    assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
    assert.equal(
      (await post(winner.id, 1, winner.key, 'remove')).json().error.code,
      'IDEMPOTENCY_CONFLICT',
    );
    const first = (await app.inject({ url: url + '/history?limit=1' })).json();
    assert.equal(first.items[0].revision, 3);
    assert.equal(first.nextCursor, 3);
    const next = (await app.inject({ url: url + '/history?limit=1&before=3' })).json();
    assert.equal(next.items[0].revision, 2);
    assert.equal(next.nextCursor, null);
  } finally {
    await app.close();
  }
});

test('参与关系、修订、历史、通知和回执在事务任一步故障后全部回滚', () => {
  for (const table of [
    'task_participant_sets',
    'task_participants',
    'task_participant_events',
    'outbox',
    'idempotency_records',
  ]) {
    const store = new Store();
    try {
      const t = task(store),
        before = store.getTask(t.id),
        events = store.db.prepare('SELECT * FROM outbox').all();
      store.db.exec(
        `CREATE TRIGGER failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'participation fixture rollback'); END;`,
      );
      assert.throws(
        () => change(store, t.id, second, 'add', 'retry'),
        /participation fixture rollback/,
      );
      assert.equal(store.taskParticipants.view(t.id).revision, 1);
      assert.deepEqual(store.taskParticipants.view(t.id).participants, []);
      assert.deepEqual(store.taskParticipants.history(t.id, historyQuery).items, []);
      assert.deepEqual(store.getTask(t.id), before);
      assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
      assert.equal(
        store.db.prepare("SELECT 1 FROM idempotency_records WHERE key='retry'").get(),
        undefined,
      );
      store.db.exec('DROP TRIGGER failure');
      assert.equal(change(store, t.id, second, 'add', 'retry').revision, 2);
    } finally {
      store.close();
    }
  }
});

test('只读成员能自行加入退出，管理他人需编辑权；参与不授予访问，撤权和旧回执遵守当前权限', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(bob),
      t = await f.task(bob, p.id),
      path = `tasks/${t.id}/participants`;
    const self = { expectedRevision: 1, userId: alice.user.id, action: 'add' };
    assert.equal((await f.call(path, alice)).statusCode, 404);
    assert.equal((await f.call(path, bob, self)).json().error.code, 'PARTICIPANT_UNAVAILABLE');
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(path, alice)).json().canManage, false);
    const members = f.store.db.prepare('SELECT * FROM collab_project_members').all();
    assert.equal((await f.call(path, alice, self, 'join')).statusCode, 200);
    assert.equal(
      (await f.call(path, alice, { expectedRevision: 2, action: 'add', userId: bob.user.id }))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.call(`tasks/${t.id}/start`, alice, { expectedRevision: 1 })).statusCode,
      403,
    );
    assert.equal(
      (await f.call(path, alice, { expectedRevision: 2, action: 'remove', userId: alice.user.id }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(`tasks/${t.id}`, alice)).statusCode, 200); // Leaving participation is not leaving project access.
    assert.deepEqual(f.store.db.prepare('SELECT * FROM collab_project_members').all(), members);
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const other = { expectedRevision: 3, action: 'add', userId: bob.user.id };
    assert.equal((await f.call(path, alice, other, 'manage')).statusCode, 200);
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(path, alice, other, 'manage')).statusCode, 403);
    await f.call(`projects/${p.id}/members/${alice.user.id}`, bob, { role: null });
    for (const url of [path, path + '/history', `projects/${p.id}/task-people`])
      assert.equal((await f.call(url, alice)).statusCode, 404);
    assert.equal((await f.call(path, alice, self, 'join')).statusCode, 404);
    assert.equal((await f.call(path, null)).statusCode, 401);
    const privateTask = await f.task(bob);
    assert.equal((await f.call(`tasks/${privateTask.id}/participants`, bob, self)).statusCode, 422);
    assert.equal((await f.call(`tasks/${privateTask.id}/participants`, alice)).statusCode, 404);
    assert.equal(
      (await f.call(path, { ...bob, spaceId: `personal-${bob.user.id}` })).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('项目/空间撤权原子结束参与，重新入组和历史回执不复活关系，事件不向被移除者泄露', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(alice),
      t = await f.task(alice, p.id),
      path = `tasks/${t.id}/participants`;
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const body = { expectedRevision: 1, action: 'add', userId: bob.user.id };
    await f.call(path, bob, body, 'self');
    const cursor = f.store.as(bob, () => f.store.events(0).cursor);
    f.store.db.exec(
      "CREATE TRIGGER failure BEFORE INSERT ON task_participant_events BEGIN SELECT RAISE(ABORT,'revocation fixture rollback'); END;",
    );
    assert.equal(
      (await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: null })).statusCode,
      500,
    );
    assert.equal((await f.call(path, bob)).json().participants[0].state, 'active');
    f.store.db.exec('DROP TRIGGER failure');
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: null });
    assert.equal((await f.call(path, alice)).json().participants[0].state, 'access_revoked');
    assert.ok(
      f.store.as(bob, () => f.store.events(cursor)).events.every((event) => event.taskId !== t.id),
    );
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'view' });
    assert.equal((await f.call(path, bob, body, 'self')).statusCode, 200);
    assert.deepEqual((await f.call(`tasks/${t.id}`, bob)).json().task.participantUserIds, []);
    await f.call(path, bob, { ...body, expectedRevision: 3 });
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    assert.equal((await f.call(path, alice)).json().participants[0].state, 'access_revoked');
    assert.equal((await f.call(path, bob, body, 'self')).statusCode, 403);
    assert.deepEqual(
      (await f.call(path + '/history', alice))
        .json()
        .items.map((item: { action: string }) => item.action),
      ['access_revoked', 'joined', 'access_revoked', 'joined'],
    );
  } finally {
    await f.close();
  }
});

test('负责人/参与者/关键词交集先按权限筛选再分页，候选不枚举其他项目或跨空间人员', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(alice),
      hidden = await f.project(bob);
    const t1 = await f.task(alice, p.id, '共享订单 Alpha'),
      t2 = await f.task(alice, p.id, '共享订单 Beta'),
      t3 = await f.task(alice, p.id, '无参与记录');
    await f.task(bob, hidden.id, '共享订单 隐藏');
    await f.task(bob, null, '共享订单 私有');
    assert.equal((await f.call(`projects/${hidden.id}/task-people`, alice)).statusCode, 404);
    assert.equal(
      (await f.call(`projects/${p.id}/task-people`, alice)).json().participants.length,
      1,
    );
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    for (const t of [t1, t2])
      await f.call(`tasks/${t.id}/participants`, bob, {
        expectedRevision: 1,
        userId: bob.user.id,
        action: 'add',
      });
    const query = `projectId=${p.id}&ownerUserId=${alice.user.id}&participantUserId=${bob.user.id}&q=${encodeURIComponent(' 订单 ')}&limit=1`;
    const list = `spaces/${alice.spaceId}/tasks?${query}`,
      first = (await f.call(list, alice)).json();
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const next = (await f.call(list + '&cursor=' + first.nextCursor, alice)).json();
    assert.equal(next.nextCursor, null);
    assert.deepEqual([first.items[0].id, next.items[0].id].sort(), [t1.id, t2.id].sort());
    const data = f.store.as(alice, () => f.store.workbench());
    const filters = parseTaskPeopleFilters({
      ownerUserId: alice.user.id,
      participantUserId: bob.user.id,
      q: '订单',
    });
    assert.deepEqual(
      data.tasks
        .filter((t) => t.projectId === p.id && matchesTaskPeopleFilters(t, filters))
        .map((t) => t.id)
        .sort(),
      [t1.id, t2.id].sort(),
    );
    assert.equal(
      (await f.call(list + '&cursor=' + t3.id, alice)).json().error.code,
      'INVALID_CURSOR',
    );
    await f.call(`tasks/${t1.id}/assignment`, alice, {
      expectedRevision: 1,
      ownerUserId: bob.user.id,
    });
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'view' });
    assert.equal(
      (await f.call(`projects/${p.id}/task-people`, alice))
        .json()
        .owners.find((u: { id: string }) => u.id === bob.user.id).availability,
      'read_only',
    );
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: null });
    const people = (await f.call(`projects/${p.id}/task-people`, alice)).json();
    assert.deepEqual(
      people.owners.find((u: { id: string }) => u.id === bob.user.id),
      { id: bob.user.id, name: bob.user.name, availability: 'removed' },
    );
    assert.equal(people.participants.length, 1);
    assert.equal((await f.call(list, alice)).json().items.length, 0);
    // Even a leftover project row cannot stand in for current space membership.
    f.store.db
      .prepare('INSERT INTO collab_project_members(project_id,user_id,role) VALUES(?,?,?)')
      .run(p.id, bob.user.id, 'edit');
    f.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(bob.spaceId, bob.user.id);
    assert.equal(
      (await f.call(`projects/${p.id}/task-people`, alice)).json().participants.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('迁移不根据负责人伪造参与者；关系与历史跨重启保存，归档项目仍可人工协作', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-participation-migration-')),
    path = join(dir, 'old.sqlite');
  let store: Store | undefined;
  try {
    const seed = new Store(),
      t = task(seed),
      p = seed.project(t.projectId!);
    seed.close();
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((item) => item.version < 12)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    old.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    old.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id, p.spaceId, JSON.stringify(p));
    old
      .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
      .run(t.id, t.spaceId, t.projectId, JSON.stringify(t));
    old.close();
    store = new Store(path);
    assert.deepEqual(store.taskParticipants.view(t.id).participants, []);
    assert.deepEqual(store.taskParticipants.history(t.id, historyQuery).items, []);
    store.projectLifecycle.change(
      p.id,
      { action: 'archive', expectedRevision: p.revision, activeRunAction: 'keep' },
      'archive',
    );
    change(store, t.id);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.detail(t.id).task.participantUserIds, [second]);
    assert.equal(
      store.taskParticipants.history(t.id, historyQuery).items[0]!.name,
      demoMembers[1]!.name,
    );
    assert.deepEqual(store.getTask(t.id), t);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
