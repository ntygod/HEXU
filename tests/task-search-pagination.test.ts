import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DomainError,
  parseTaskSearchQuery,
  taskStatuses,
  type Task,
  type TaskSearchPage,
} from '../packages/contracts/src/index.js';
import { normalizeTaskSearch, matchesTaskSearch } from '../packages/domain/src/index.js';
import { TaskSearch } from '../packages/db/src/task-search.js';
import { Store } from '../packages/db/src/store.js';
import { demoMembers } from '../packages/db/src/seed.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
const ids = (tasks: Task[]) => tasks.map(({ id }) => id);
const page = (store: Store, q: string, cursor: string | null = null) =>
  new TaskSearch(store).list(parseTaskSearchQuery({ q, ...(cursor === null ? {} : { cursor }) }));
function makeTask(store: Store, title: string, projectId: string | null = null, description = '') {
  return store.createTask({ title, description, projectId }, randomUUID());
}
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
const envelope = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('全局搜索契约保留原q字符预算和未知字段兼容，新增游标只接受有界单值', () => {
  assert.deepEqual(parseTaskSearchQuery({ q: '  Alpha  ', unknown: ['ignored'] }), {
    q: 'Alpha',
    cursor: null,
  });
  assert.equal(parseTaskSearchQuery({ q: '😀'.repeat(80) }).q.length, 160);
  const expanding = 'İ'.repeat(160);
  assert.equal(parseTaskSearchQuery({ q: expanding }).q, expanding);
  assert.equal(normalizeTaskSearch(expanding).length, 320);
  assert.equal(
    matchesTaskSearch(
      { title: expanding, description: '', shortId: 'HX-123' },
      normalizeTaskSearch(expanding),
    ),
    true,
  );
  for (const q of [
    undefined,
    null,
    [],
    ['q'],
    ['q', 'q'],
    {},
    1,
    '',
    '  ',
    'x'.repeat(161),
    '😀'.repeat(81),
    ' '.repeat(161) + 'x',
  ])
    assert.throws(() => parseTaskSearchQuery({ q }), code('INVALID_INPUT'));
  for (const cursor of [
    null,
    [],
    ['x'],
    ['x', 'x'],
    {},
    1,
    '',
    ' x',
    'x ',
    'x=',
    'x+',
    'x/'.repeat(3),
    'a'.repeat(513),
  ])
    assert.throws(() => parseTaskSearchQuery({ q: 'q', cursor }), code('INVALID_CURSOR'));
  assert.deepEqual(parseTaskSearchQuery({ q: 'q', cursor: 'abc-_123' }), {
    q: 'q',
    cursor: 'abc-_123',
  });
});

test('纯匹配保留中文、大小写、编号、字面%/_及title-description-shortId跨字段语义', () => {
  const task = { title: 'Alpha 订单', description: '导出 Beta 100%_完成', shortId: 'HX-123' };
  for (const q of [' ALPHA ', '订单', 'beta', 'hx-123', '100%_', '订单 导出', '完成 HX-123'])
    assert.equal(matchesTaskSearch(task, normalizeTaskSearch(q)), true, q);
  for (const q of ['订单 hx-123', 'alpha 导出', '100X_', '100%X', '未出现'])
    assert.equal(matchesTaskSearch(task, normalizeTaskSearch(q)), false, q);
});

for (const count of [0, 30, 31, 61])
  test(`全局搜索${count}项按创建顺序固定30条分页，所有读取不写数据库`, async () => {
    const store = new Store();
    const tasks = Array.from({ length: count }, (_, i) => makeTask(store, `分页边界 ${i}`));
    const app = await createApp({ store });
    try {
      const before = snapshot(store);
      const changes = store.db.prepare('SELECT total_changes() AS count').get();
      const all: Task[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: URLSearchParams = new URLSearchParams({
          q: '分页边界',
          ...(cursor ? { cursor } : {}),
        });
        const response = await app.inject({ url: `/api/v1/search?${query}` });
        assert.equal(response.statusCode, 200, response.body);
        const result: TaskSearchPage = response.json();
        const remaining = count - all.length;
        assert.equal(result.items.length, Math.min(30, remaining));
        assert.equal(result.nextCursor !== null, remaining > 30);
        assert.deepEqual(Object.keys(result).sort(), ['items', 'nextCursor']);
        if (result.nextCursor) {
          assert(result.nextCursor.length <= 512);
          const decoded = JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString('utf8'));
          assert.deepEqual(Object.keys(decoded).sort(), ['afterTaskId', 'fingerprint', 'v']);
          assert.equal(decoded.afterTaskId, result.items.at(-1)!.id);
          assert.equal(decoded.v, 1);
          assert.match(decoded.fingerprint, /^[a-f0-9]{64}$/);
        }
        all.push(...result.items);
        cursor = result.nextCursor;
        pages++;
      } while (cursor);
      assert.equal(pages, Math.max(1, Math.ceil(count / 30)));
      assert.deepEqual(ids(all), ids([...tasks].reverse()));
      assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), changes);
      assert.deepEqual(snapshot(store), before);
    } finally {
      await app.close();
    }
  });

test('搜索逐项扫描到第31个可读匹配即停止，不加载完整Task列表或把权限后的稀疏结果截断', (t) => {
  const store = new Store();
  try {
    const tasks: Task[] = [];
    for (let i = 0; i < 70; i++) {
      tasks.push(makeTask(store, `稀疏匹配 ${i}`));
      const hidden = makeTask(store, `稀疏匹配 隐藏${i}`);
      store.db
        .prepare('UPDATE tasks SET body=? WHERE id=?')
        .run(JSON.stringify({ ...hidden, ownerUserId: demoMembers[1]!.id }), hidden.id);
      makeTask(store, `其他标题 ${i}`);
    }
    t.mock.method(store, 'tasks', () => {
      throw new Error('Must not materialize all tasks');
    });
    const prepare = store.db.prepare.bind(store.db);
    let scanned = 0;
    t.mock.method(store.db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes('ORDER BY rowid DESC')) {
        const iterate = statement.iterate.bind(statement);
        t.mock.method(statement, 'all', () => {
          throw new Error('Must stream candidates');
        });
        t.mock.method(
          statement,
          'iterate',
          function* (...args: Parameters<typeof statement.iterate>) {
            for (const row of iterate(...args)) {
              scanned++;
              yield row;
            }
          },
        );
      }
      return statement;
    });
    const result = page(store, '稀疏匹配');
    assert.deepEqual(ids(result.items), ids([...tasks].reverse().slice(0, 30)));
    assert.equal(scanned, 31 * 3);
    assert(result.nextCursor);
  } finally {
    store.close();
  }
});

test('API保留原匹配、全部状态和项目/本人私有范围，非法查询与失效游标返回统一错误', async () => {
  const store = new Store();
  const app = await createApp({ store });
  try {
    const project = store.projects()[0]!;
    const tasks = taskStatuses.map((status, i) => {
      const task = makeTask(
        store,
        `Alpha 订单 ${i}`,
        i % 2 ? null : project.id,
        '导出 Beta 100%_完成',
      );
      return status === 'todo'
        ? task
        : store.changeTask(task.id, status, task.revision, 'keep', randomUUID());
    });
    for (const q of [
      'ALPHA',
      '订单',
      'beta',
      '%_',
      '0 导出',
      `完成 ${tasks[0]!.shortId}`,
      tasks[0]!.shortId.toLowerCase(),
    ]) {
      const response = await app.inject({ url: `/api/v1/search?${new URLSearchParams({ q })}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        ids(response.json<TaskSearchPage>().items),
        ids(
          store
            .tasks()
            .filter((task) =>
              (task.title + ' ' + task.description + ' ' + task.shortId)
                .toLocaleLowerCase()
                .includes(q.trim().toLocaleLowerCase()),
            ),
        ),
      );
    }
    const expected = (await app.inject({ url: '/api/v1/search?q=alpha' })).json();
    assert.deepEqual(
      (
        await app.inject({ url: '/api/v1/search?q=alpha&limit=1&status=done&unknown=x&unknown=y' })
      ).json(),
      expected,
    );
    for (const query of ['q=', 'q=%20', 'q=alpha&q=alpha', `q=${'x'.repeat(161)}`, 'q[]=alpha']) {
      const response = await app.inject({ url: `/api/v1/search?${query}` });
      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json().error.code, 'INVALID_INPUT');
    }
    for (const query of [
      'cursor=',
      'cursor=bad',
      'cursor=x&cursor=x',
      `cursor=${'a'.repeat(513)}`,
    ]) {
      const response = await app.inject({ url: `/api/v1/search?q=alpha&${query}` });
      assert.equal(response.statusCode, 409, query);
      assert.equal(response.json().error.code, 'INVALID_CURSOR');
      assert.equal(response.json().error.message, '搜索位置已无效，请重新搜索');
    }
  } finally {
    await app.close();
  }
});

test('API先校验原始160字符，大小写展开后的320字符仍可匹配并继续分页', async () => {
  const store = new Store();
  const app = await createApp({ store });
  try {
    const q = 'İ'.repeat(160);
    for (let i = 0; i < 31; i++) makeTask(store, q);
    const first = await app.inject({ url: `/api/v1/search?${new URLSearchParams({ q })}` });
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json<TaskSearchPage>();
    assert.equal(result.items.length, 30);
    const next = await app.inject({
      url: `/api/v1/search?${new URLSearchParams({ q, cursor: result.nextCursor! })}`,
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json<TaskSearchPage>().items.length, 1);
    assert.equal(next.json<TaskSearchPage>().nextCursor, null);
  } finally {
    await app.close();
  }
});

test('游标绑定规范搜索/模式/用户/空间，拒绝非规范编码与额外/重复/错误版本字段', () => {
  const store = new Store();
  try {
    const tasks = Array.from({ length: 31 }, (_, i) => makeTask(store, `Cursor Scope ${i}`));
    const cursor = page(store, 'cursor scope').nextCursor!;
    assert.equal(page(store, '  CURSOR SCOPE  ', cursor).items.length, 1);
    assert.throws(() => page(store, 'scope', cursor), code('INVALID_CURSOR'));
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const malformed = [
      'a',
      envelope(null),
      envelope([]),
      envelope({}),
      envelope({ ...decoded, v: 2 }),
      envelope({ ...decoded, afterTaskId: '' }),
      envelope({ ...decoded, afterTaskId: 'x'.repeat(101) }),
      envelope({ ...decoded, fingerprint: '0'.repeat(64) }),
      envelope({ ...decoded, extra: true }),
      envelope({ fingerprint: decoded.fingerprint, afterTaskId: decoded.afterTaskId, v: 1 }),
      Buffer.from(
        `{"v":1,"v":1,"afterTaskId":${JSON.stringify(decoded.afterTaskId)},"fingerprint":${JSON.stringify(decoded.fingerprint)}}`,
      ).toString('base64url'),
      Buffer.from(' ' + JSON.stringify(decoded)).toString('base64url'),
      cursor + '=',
    ];
    const before = snapshot(store);
    for (const invalid of malformed)
      assert.throws(() => page(store, 'cursor scope', invalid), code('INVALID_CURSOR'), invalid);
    assert.deepEqual(snapshot(store), before);
    // Same actor, space, IDs and searchable text in an independent team fixture:
    // the data mode alone must still invalidate a preview cursor in both directions.
    const team = new Store(':memory:', undefined, { team: true });
    try {
      const principal = {
        user: { id: store.actorId, name: '模式隔离测试', email: 'mode@example.invalid' },
        spaceId: store.spaceId,
      };
      team.collaboration.ensurePerson(principal.user);
      team.db
        .prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)')
        .run(store.spaceId, '模式测试', 'team', new Date().toISOString());
      team.db
        .prepare('INSERT INTO collab_memberships VALUES(?,?,?)')
        .run(store.spaceId, store.actorId, 'owner');
      for (const task of tasks)
        team.db
          .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
          .run(task.id, task.spaceId, null, JSON.stringify(task));
      const teamFirst = team.as(principal, () => page(team, 'cursor scope'));
      assert.deepEqual(ids(teamFirst.items), ids(page(store, 'cursor scope').items));
      assert.throws(
        () => team.as(principal, () => page(team, 'cursor scope', cursor)),
        code('INVALID_CURSOR'),
      );
      assert.throws(
        () => page(store, 'cursor scope', teamFirst.nextCursor),
        code('INVALID_CURSOR'),
      );
    } finally {
      team.close();
    }
  } finally {
    store.close();
  }
});

test('编辑和插入不移动已有页边界，仍匹配的anchor可续读，不匹配/删除/失权统一失效', () => {
  const store = new Store();
  try {
    const tasks = Array.from({ length: 61 }, (_, i) => makeTask(store, `稳定边界 ${i}`));
    const first = page(store, '稳定边界');
    const anchor = first.items.at(-1)!;
    const inserted = makeTask(store, '稳定边界 新插入');
    store.patchTask(
      anchor.id,
      { expectedRevision: anchor.revision, title: '稳定边界 已编辑' },
      randomUUID(),
    );
    const edited = store.patchTask(
      tasks[0]!.id,
      { expectedRevision: tasks[0]!.revision, title: '稳定边界 最旧任务已编辑' },
      randomUUID(),
    );
    const second = page(store, '稳定边界', first.nextCursor);
    const third = page(store, '稳定边界', second.nextCursor);
    assert.deepEqual(
      ids([...first.items, ...second.items, ...third.items]),
      ids([...tasks].reverse()),
    );
    assert.equal(third.items[0]!.title, edited.title);
    assert.equal(page(store, '稳定边界').items[0]!.id, inserted.id);

    const current = store.getTask(anchor.id);
    store.patchTask(
      anchor.id,
      { expectedRevision: current.revision, title: '已不匹配' },
      randomUUID(),
    );
    assert.throws(() => page(store, '稳定边界', first.nextCursor), code('INVALID_CURSOR'));
    const restore = store.getTask(anchor.id);
    store.patchTask(
      anchor.id,
      { expectedRevision: restore.revision, title: '稳定边界 恢复' },
      randomUUID(),
    );
    store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(
        JSON.stringify({ ...store.getTask(anchor.id), ownerUserId: demoMembers[1]!.id }),
        anchor.id,
      );
    assert.throws(() => page(store, '稳定边界', first.nextCursor), code('INVALID_CURSOR'));
    // Model a deletable legacy row without inventing a product delete route or
    // changing the immutable history constraints on the normally created tasks.
    const legacy = { ...anchor, id: randomUUID(), title: '稳定边界 待删除旧任务' };
    store.db
      .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
      .run(legacy.id, legacy.spaceId, legacy.projectId, JSON.stringify(legacy));
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    const legacyCursor = envelope({ ...decoded, afterTaskId: legacy.id });
    assert.equal(page(store, '稳定边界', legacyCursor).items.length, 30);
    store.db.prepare('DELETE FROM tasks WHERE id=?').run(legacy.id);
    assert.throws(() => page(store, '稳定边界', legacyCursor), code('INVALID_CURSOR'));
  } finally {
    store.close();
  }
});

test('团队每页当前权限覆盖只读、私有、项目、空间和用户，撤销非anchor范围不会泄漏后页', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const olderProject = await f.project(alice),
      newerProject = await f.project(alice);
    const hiddenProject = await f.project(bob);
    const personalBob = { ...bob, spaceId: `personal-${bob.user.id}` };
    const old = f.store.as(alice, () =>
      Array.from({ length: 31 }, (_, i) => makeTask(f.store, `权限分页 旧${i}`, olderProject.id)),
    );
    const recent = f.store.as(alice, () =>
      Array.from({ length: 30 }, (_, i) => makeTask(f.store, `权限分页 新${i}`, newerProject.id)),
    );
    const privateAlice = f.store.as(alice, () => makeTask(f.store, '权限分页 私有甲'));
    const privateBob = f.store.as(bob, () => makeTask(f.store, '权限分页 私有乙'));
    const hidden = f.store.as(bob, () => makeTask(f.store, '权限分页 隐藏项目', hiddenProject.id));
    const otherSpace = f.store.as(personalBob, () => makeTask(f.store, '权限分页 其他空间'));
    for (const project of [olderProject, newerProject])
      assert.equal(
        (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
          .statusCode,
        200,
      );
    const call = (account: typeof alice, cursor?: string | null) =>
      f.call(
        `search?${new URLSearchParams({ q: '权限分页', ...(cursor ? { cursor } : {}) })}`,
        account,
      );
    assert.equal((await f.call('search?q=权限分页')).statusCode, 401);
    let before = snapshot(f.store);
    const first = (await call(alice)).json<TaskSearchPage>();
    const allAlice = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const result = (await call(alice, cursor)).json<TaskSearchPage>();
      allAlice.push(...result.items);
      cursor = result.nextCursor;
    }
    assert.deepEqual(
      ids(allAlice),
      ids([privateAlice, ...recent.slice().reverse(), ...old.slice().reverse()]),
    );
    const bobFirst = (await call(bob)).json<TaskSearchPage>();
    assert.equal(bobFirst.items[0]!.id, hidden.id);
    assert.equal(bobFirst.items[1]!.id, privateBob.id);
    const bobAll = [...bobFirst.items];
    cursor = bobFirst.nextCursor;
    while (cursor) {
      const result = (await call(bob, cursor)).json<TaskSearchPage>();
      bobAll.push(...result.items);
      cursor = result.nextCursor;
    }
    assert.deepEqual(
      ids(bobAll),
      ids([hidden, privateBob, ...recent.slice().reverse(), ...old.slice().reverse()]),
    );
    assert(!bobAll.some(({ id }) => id === privateAlice.id || id === otherSpace.id));
    assert.equal((await call(bob, first.nextCursor)).json().error.code, 'INVALID_CURSOR');
    assert.equal(
      (await call(personalBob, bobFirst.nextCursor)).json().error.code,
      'INVALID_CURSOR',
    );
    const decoded = JSON.parse(Buffer.from(bobFirst.nextCursor!, 'base64url').toString('utf8'));
    for (const afterTaskId of [privateAlice.id, otherSpace.id, 'absent'])
      assert.equal(
        (await call(bob, envelope({ ...decoded, afterTaskId }))).json().error.code,
        'INVALID_CURSOR',
      );
    assert.deepEqual(snapshot(f.store), before);

    assert.equal(
      (await f.call(`projects/${olderProject.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
      200,
    );
    before = snapshot(f.store);
    const afterRevoke = (await call(bob, bobFirst.nextCursor)).json<TaskSearchPage>();
    assert.deepEqual(ids(afterRevoke.items), ids(recent.slice(0, 2).reverse()));
    assert.equal(afterRevoke.nextCursor, null);
    assert.deepEqual(snapshot(f.store), before);
    assert.equal(
      (await f.call(`projects/${newerProject.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
      200,
    );
    assert.equal((await call(bob, bobFirst.nextCursor)).json().error.code, 'INVALID_CURSOR');
    assert.equal(
      (
        await f.call(`projects/${hiddenProject.id}/members/${alice.user.id}`, bob, {
          role: 'manage',
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    assert.equal((await call(bob, bobFirst.nextCursor)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('权限、anchor和候选读取使用同一只读快照，下一页请求重新检查已提交撤权', async (t) => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    f.store.as(alice, () => {
      for (let i = 0; i < 61; i++) makeTask(f.store, `一致快照 ${i}`, project.id);
    });
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
      200,
    );
    const first = f.store.as(bob, () => page(f.store, '一致快照'));
    const other = new DatabaseSync(f.dbPath);
    try {
      const prepare = f.store.db.prepare.bind(f.store.db);
      let revoked = false;
      t.mock.method(f.store.db, 'prepare', (sql: string) => {
        if (sql.includes('ORDER BY rowid DESC') && !revoked) {
          other
            .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
            .run(project.id, bob.user.id);
          revoked = true;
        }
        return prepare(sql);
      });
      const next = f.store.as(bob, () => page(f.store, '一致快照', first.nextCursor));
      assert.equal(revoked, true);
      assert.equal(next.items.length, 30);
      assert.throws(
        () => f.store.as(bob, () => page(f.store, '一致快照', next.nextCursor)),
        code('INVALID_CURSOR'),
      );
      assert.equal(f.store.as(bob, () => page(f.store, '一致快照')).items.length, 0);
    } finally {
      other.close();
    }
  } finally {
    await f.close();
  }
});
