import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import { parseProjectPatch, parseProjectRevisionQuery } from '../packages/contracts/src/project.js';
import { migrations } from '../packages/db/src/schema.js';
import { Store } from '../packages/db/src/store.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (value: string) => (error: unknown) =>
  error instanceof DomainError && error.code === value;
const historyQuery = { limit: 50, before: null };

test('项目设置契约只接受名称/说明，严格检查修订、文本和分页参数', () => {
  assert.deepEqual(parseProjectPatch({ expectedRevision: 1, name: ' 项目 ' }), {
    expectedRevision: 1,
    name: '项目',
  });
  assert.deepEqual(parseProjectPatch({ expectedRevision: 1, description: '  ' }), {
    expectedRevision: 1,
    description: '',
  });
  for (const input of [
    null,
    [],
    {},
    { expectedRevision: 1 },
    { expectedRevision: 0, name: 'N' },
    { expectedRevision: '1', name: 'N' },
    { expectedRevision: 1.1, name: 'N' },
    { expectedRevision: 1, name: ' ' },
    { expectedRevision: 1, name: 'X'.repeat(101) },
    { expectedRevision: 1, description: null },
    { expectedRevision: 1, description: 'X'.repeat(2001) },
    ...['id', 'spaceId', 'access', 'memberIds', 'archived', 'repository', 'command'].map(
      (field) => ({ expectedRevision: 1, name: 'N', [field]: 'forged' }),
    ),
  ])
    assert.throws(() => parseProjectPatch(input), code('INVALID_INPUT'));
  assert.deepEqual(parseProjectRevisionQuery({}), { limit: 10, before: null });
  assert.deepEqual(parseProjectRevisionQuery({ limit: '50', before: '12' }), {
    limit: 50,
    before: 12,
  });
  for (const input of [
    { limit: '51' },
    { before: '0' },
    { before: 'Infinity' },
    { before: '1.5' },
    { before: ['1'] },
    { q: 'x' },
  ])
    assert.throws(() => parseProjectRevisionQuery(input), code('INVALID_INPUT'));
});

test('项目编辑保留 ID/任务/成果/活动执行，修订和明确作者一同保存，说明可以清空', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const project = store.projects()[0]!;
    const task = store.createTask(
      { title: '保持原工作现场', description: '任务原说明', projectId: project.id },
      'task',
    );
    store.addMessage(task.id, '原讨论', null, 'message');
    store.createResult(task.id, '原成果', '不被项目编辑替换', 'result');
    const run = store.createRun(
      task.id,
      {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'success',
        prompt: '',
        expectedRevision: 1,
        reopenTask: false,
      },
      'run',
    );
    store.stepRun(run.id, 'preparing');
    store.stepRun(run.id, 'running');
    const previous = {
      task: store.getTask(task.id),
      messages: store.messages(task.id),
      results: store.results(),
      run: store.run(run.id),
    };
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { 'x-hexu-client': 'web', 'idempotency-key': 'edit' },
      payload: {
        expectedRevision: project.revision,
        name: ' 新项目名称 ',
        description: '新的目标\n第二行',
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const next = response.json();
    assert.equal(next.id, project.id);
    assert.equal(next.spaceId, project.spaceId);
    assert.equal(next.color, project.color);
    assert.equal(next.revision, project.revision + 1);
    assert.equal(next.name, '新项目名称');
    assert.deepEqual(
      {
        task: store.getTask(task.id),
        messages: store.messages(task.id),
        results: store.results(),
        run: store.run(run.id),
      },
      previous,
    );
    const records = store.projectSettings.history(project.id, historyQuery).items;
    assert.equal(records.length, 2);
    assert.equal(records[0]!.actorId, store.actorId);
    assert.equal(records[0]!.actorName, store.actorName());
    assert.ok(records[0]!.savedAt);
    assert.equal(records[1]!.name, project.name);
    assert.equal(records[1]!.savedAt, null);
    const clear = store.projectSettings.patch(
      project.id,
      { expectedRevision: next.revision, description: '' },
      'clear',
    );
    assert.equal(clear.name, next.name);
    assert.equal(clear.description, '');
  } finally {
    await app.close();
  }
});

test('同修订并发只接受一次，重放不重复，旧幂等回执不回写新版本，无改动不制造历史', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const project = store.createProject({ name: '基线', description: '' }, 'create');
    const patch = (name: string, expectedRevision: number, key: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        payload: { name, expectedRevision },
        headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
      });
    const responses = await Promise.all([patch('第一份', 1, 'a'), patch('第二份', 1, 'b')]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    const accepted = responses[0]!.statusCode === 200 ? ['第一份', 'a'] : ['第二份', 'b'];
    const replay = await patch(accepted[0]!, 1, accepted[1]!);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().revision, 2);
    assert.equal((await patch('第三份', 2, 'c')).statusCode, 200);
    assert.equal((await patch(accepted[0]!, 1, accepted[1]!)).json().revision, 2);
    assert.equal(store.project(project.id).name, '第三份');
    assert.equal(
      (await patch('不同载荷', 1, accepted[1]!)).json().error.code,
      'IDEMPOTENCY_CONFLICT',
    );
    const before = store.projectSettings.history(project.id, historyQuery);
    const count = store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n;
    assert.equal((await patch(' 第三份 ', 3, 'no-change')).json().revision, 3);
    assert.deepEqual(store.projectSettings.history(project.id, historyQuery), before);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, count);
    const page = (
      await app.inject({ url: `/api/v1/projects/${project.id}/revisions?limit=2` })
    ).json();
    assert.deepEqual(
      page.items.map((r: { revision: number }) => r.revision),
      [3, 2],
    );
    assert.equal(page.nextCursor, 2);
    const older = (
      await app.inject({ url: `/api/v1/projects/${project.id}/revisions?before=2` })
    ).json();
    assert.deepEqual(
      older.items.map((r: { revision: number }) => r.revision),
      [1],
    );
    assert.equal(older.nextCursor, null);
  } finally {
    await app.close();
  }
});

test('项目写入、历史、通知及幂等回执任一步失败全部回滚，同标识可重试', () => {
  for (const table of ['project_revisions', 'outbox', 'idempotency_records']) {
    const store = new Store();
    try {
      const project = store.createProject({ name: '回滚基线', description: '' }, 'create');
      const count = store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n;
      store.db.exec(
        `CREATE TRIGGER break_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`,
      );
      const body = { expectedRevision: 1, name: '未成功保存' };
      assert.throws(
        () => store.projectSettings.patch(project.id, body, 'failed'),
        /fixture rollback/,
      );
      assert.equal(store.project(project.id).name, project.name);
      assert.equal(store.projectSettings.history(project.id, historyQuery).items.length, 1);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, count);
      assert.equal(
        store.db.prepare("SELECT 1 FROM idempotency_records WHERE key='failed'").get(),
        undefined,
      );
      store.db.exec('DROP TRIGGER break_write');
      assert.equal(store.projectSettings.patch(project.id, body, 'failed').revision, 2);
    } finally {
      store.close();
    }
  }
});

test('旧 SQLite 项目迁移只记录已知快照，不伪造旧作者/时间，重启保留原 ID 与历史', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-project-migration-'));
  const path = join(dir, 'old.sqlite');
  let store: Store | undefined;
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);');
    for (const migration of migrations.filter((m) => m.version < 9)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    const project = {
      id: 'old-project',
      spaceId: 'space-demo',
      name: '旧项目',
      description: '旧目标',
      revision: 7,
      color: 'violet',
    };
    old.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    old
      .prepare('INSERT INTO projects VALUES(?,?,?)')
      .run(project.id, project.spaceId, JSON.stringify(project));
    old.close();
    store = new Store(path);
    const baseline = store.projectSettings.history(project.id, historyQuery).items;
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0]!.revision, 7);
    assert.equal(baseline[0]!.actorId, null);
    assert.equal(baseline[0]!.savedAt, null);
    store.projectSettings.patch(
      project.id,
      { expectedRevision: 7, name: '迁移后继续' },
      'post-migration',
    );
    store.close();
    store = new Store(path);
    assert.equal(store.project(project.id).name, '迁移后继续');
    assert.deepEqual(
      store.projectSettings.history(project.id, historyQuery).items.map((r) => r.revision),
      [8, 7],
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有项目管理者可编辑：空间所有者、只读/编辑成员、跨空间及撤权重放不能越权', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(bob); // The space owner has no implicit project membership.
    const path = `projects/${project.id}`;
    const body = { expectedRevision: 1, name: '有权限的新名称' };
    const patch = (account: typeof alice, payload = body, key: string = randomUUID()) =>
      f.call(path, account, payload, key, 'PATCH');
    assert.equal((await patch(alice)).statusCode, 404);
    assert.equal((await f.call(`${path}/revisions`, alice)).statusCode, 404);
    for (const role of ['view', 'edit']) {
      await f.call(`${path}/members/${alice.user.id}`, bob, { role });
      assert.equal((await patch(alice)).statusCode, 403);
      assert.equal((await f.call(`${path}/revisions`, alice)).statusCode, 200);
    }
    await f.call(`${path}/members/${alice.user.id}`, bob, { role: 'manage' });
    assert.equal((await patch(alice, body, 'managed-edit')).statusCode, 200);
    const stored = JSON.parse(
      (
        f.store.db.prepare('SELECT body FROM projects WHERE id=?').get(project.id) as {
          body: string;
        }
      ).body,
    );
    assert.equal(stored.access, undefined);
    assert.equal(stored.memberIds, undefined);
    assert.equal((await patch({ ...alice, spaceId: `personal-${alice.user.id}` })).statusCode, 404);
    await f.call(`${path}/members/${alice.user.id}`, bob, { role: 'edit' });
    assert.equal((await patch(alice, body, 'managed-edit')).statusCode, 403);
    await f.call(`${path}/members/${alice.user.id}`, bob, { role: null });
    assert.equal((await patch(alice, body, 'managed-edit')).statusCode, 404);
    assert.equal((await f.call(`${path}/revisions`, alice)).statusCode, 404);
    assert.equal((await f.call(path, null, body, 'anonymous', 'PATCH')).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('项目更新通知按项目权限过滤；撤权后游标仍推进但不暴露项目 ID 或历史', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(bob);
    const as = <T>(account: typeof alice, fn: () => T) =>
      f.store.as({ user: account.user, spaceId: account.spaceId }, fn);
    const cursor = as(bob, () => f.store.events(0).cursor);
    const body = { expectedRevision: 1, name: '仅项目内可见' };
    await f.call(`projects/${project.id}`, bob, body, 'update', 'PATCH');
    const hidden = as(alice, () => f.store.events(cursor));
    assert.equal(hidden.events.length, 0);
    assert.ok(hidden.cursor > cursor);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    const visible = as(alice, () => f.store.events(cursor)).events.filter(
      (e) => e.kind === 'project.updated',
    );
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.projectId, project.id);
    assert.ok(!JSON.stringify(visible).includes(body.name));
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null });
    assert.equal(
      as(alice, () => f.store.events(cursor)).events.some((e) => e.projectId === project.id),
      false,
    );
  } finally {
    await f.close();
  }
});
