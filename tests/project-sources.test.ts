import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseSourceCreate,
  parseSourceEdit,
  parseSourceLifecycle,
  parseSourceListQuery,
  parseSourceRevisionQuery,
  type ProjectSource,
} from '../packages/contracts/src/project-sources.js';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { migrations } from '../packages/db/src/schema.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === expected;
const content = { kind: 'text', title: '接口说明', content: '  保留首行缩进\n下一行\n', url: null };
const listQuery = parseSourceListQuery({}),
  historyQuery = { before: null, limit: 50 };
const create = (store: Store, projectId = store.projects()[0]!.id, key: string = randomUUID()) =>
  store.projectSources.create(projectId, content, key);
const edit = (store: Store, source: ProjectSource, text: string, key: string = randomUUID()) =>
  store.projectSources.edit(
    source.projectId,
    source.id,
    { expectedRevision: source.revision, title: source.title, content: text, url: source.url },
    key,
  );

test('资料契约保留原文，严格限制链接、类型、身份字段与有界查询', () => {
  assert.deepEqual(parseSourceCreate({ ...content, title: '  接口说明 ' }), content);
  assert.deepEqual(
    parseSourceCreate({ kind: 'link', title: '接口文档', url: ' HTTPS://Example.invalid/a ' }),
    { kind: 'link', title: '接口文档', url: 'https://example.invalid/a', content: '' },
  );
  for (const value of [
    null,
    [],
    {},
    { ...content, kind: 'file' },
    { ...content, title: '' },
    { ...content, title: 'x'.repeat(121) },
    { ...content, content: '' },
    { ...content, content: 'x'.repeat(8001) },
    { ...content, url: 'https://example.invalid' },
    ...[
      'id',
      'projectId',
      'spaceId',
      'createdByUserId',
      'revision',
      'deletedAt',
      'filePath',
      'command',
      'fetch',
      'contentHash',
    ].map((field) => ({ ...content, [field]: 'forged' })),
  ])
    assert.throws(() => parseSourceCreate(value), code('INVALID_INPUT'));
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///tmp/key',
    'ssh://example.invalid/a',
    '//example.invalid/a',
    'https:example.invalid',
    'https://user:password@example.invalid',
    'https://user@example.invalid',
    'https://exa\nmple.invalid',
    'https://example.invalid/' + 'a'.repeat(2048),
  ])
    assert.throws(
      () => parseSourceCreate({ kind: 'link', title: '链接', url }),
      code('INVALID_INPUT'),
    );
  for (const body of [
    { expectedRevision: '1', title: 'x', content: 'x' },
    { expectedRevision: 0, title: 'x', content: 'x' },
    { expectedRevision: 1, title: 'x', content: 'x', kind: 'link' },
    { expectedRevision: 1, title: 'x' },
    { expectedRevision: 1, title: 'x', content: 'x', projectId: 'foreign' },
  ])
    assert.throws(() => parseSourceEdit(body, 'text'), code('INVALID_INPUT'));
  assert.throws(
    () => parseSourceLifecycle({ action: 'delete', expectedRevision: 1, permanent: true }),
    code('INVALID_INPUT'),
  );
  assert.throws(
    () => parseSourceLifecycle({ action: 'purge', expectedRevision: 1 }),
    code('INVALID_INPUT'),
  );
  assert.deepEqual(parseSourceListQuery({}), { state: 'active', q: '', cursor: null, limit: 20 });
  for (const query of [
    { limit: '51' },
    { limit: '0' },
    { limit: ['1'] },
    { state: 'all' },
    { q: 'x'.repeat(161) },
    { spaceId: 'other' },
    { cursor: ['foreign'] },
  ])
    assert.throws(() => parseSourceListQuery(query), code('INVALID_INPUT'));
  for (const query of [
    { limit: '51' },
    { before: '-1' },
    { before: '1.2' },
    { before: '9007199254740992' },
    { before: 2 },
    { taskId: 'other' },
  ])
    assert.throws(() => parseSourceRevisionQuery(query), code('INVALID_INPUT'));
});

test('资料独立保存作者、内容指纹及修订；增改删恢复不改变 Task、项目修订、Run、锁和接续材料', () => {
  const store = new Store();
  try {
    const project = store.projects()[0]!,
      task = store.createTask(
        { title: '已有执行', description: '已确认要求', projectId: project.id },
        'task',
      );
    const copy = store.registerWorkingCopy({
      id: randomUUID(),
      name: '无进程协议夹具',
      root: '/fictional/project-sources',
      createdAt: new Date().toISOString(),
    });
    const body = {
      provider: 'native',
      requestedTool: 'claude-code',
      workingCopyId: copy.id,
      prompt: '固定材料',
      confirmExecution: true,
      expectedRevision: task.revision,
    };
    const sourceRun = store.createNativeRun(
      task.id,
      parseNativeRunCreate(body),
      {
        workingCopyId: copy.id,
        mode: 'read-only',
        model: null,
        maxTurns: 8,
        maxBudgetUsd: 1,
        timeoutSeconds: 30,
        toolVersion: 'protocol fixture only',
        contextText: '原上下文',
        contextHash: 'fixture',
      },
      'run',
    );
    const operations = new ContinuationStore(store),
      operation = operations.create(
        task.id,
        parseContinuation({
          ...body,
          expectedRevision: store.getTask(task.id).revision,
          sourceRunId: sourceRun.id,
          onActiveRun: 'wait',
        }),
        'operation',
      );
    const before = {
      task: store.getTask(task.id),
      run: store.run(sourceRun.id),
      locks: store.db.prepare('SELECT * FROM native_workspace_locks').all(),
    };
    const first = create(store, project.id),
      second = edit(store, first, '\n    新正文\n');
    const deleted = store.projectSources.lifecycle(
      project.id,
      first.id,
      { expectedRevision: 2, action: 'delete' },
      'delete',
    );
    const restored = store.projectSources.lifecycle(
      project.id,
      first.id,
      { expectedRevision: 3, action: 'restore' },
      'restore',
    );
    assert.equal(first.content, content.content);
    assert.equal(first.revision, 1);
    assert.equal(first.createdByUserId, store.actorId);
    assert.equal(first.createdByName, store.actorName());
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.content, '\n    新正文\n');
    assert.notEqual(first.contentHash, second.contentHash);
    assert.equal(restored.id, first.id);
    assert.equal(restored.revision, 4);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.deletedByUserId, null);
    assert.equal(deleted.deletedByUserId, store.actorId);
    assert.equal(deleted.contentHash, second.contentHash);
    assert.equal(restored.contentHash, second.contentHash);
    assert.deepEqual(
      store.projectSources
        .history(project.id, first.id, historyQuery)
        .items.map((item) => item.action),
      ['restored', 'deleted', 'updated', 'created'],
    );
    assert.equal(
      store.projectSources.history(project.id, first.id, historyQuery).items.at(-1)!.source.content,
      content.content,
    );
    assert.deepEqual(store.project(project.id), project);
    assert.deepEqual(store.getTask(task.id), before.task);
    assert.deepEqual(store.run(sourceRun.id), before.run);
    assert.deepEqual(operations.get(operation.id), operation);
    assert.deepEqual(store.db.prepare('SELECT * FROM native_workspace_locks').all(), before.locks);
    const count = store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n;
    assert.equal(edit(store, restored, restored.content).revision, 4);
    assert.equal(
      store.projectSources.lifecycle(
        project.id,
        first.id,
        { expectedRevision: 4, action: 'restore' },
        'noop',
      ).revision,
      4,
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n, count);
  } finally {
    store.close();
  }
});

test('HTTP 创建回执复用原 ID，并发修改只接受一份；历史回执不反转更新或再次删除/恢复', async () => {
  const store = new Store(),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const project = store.projects()[0]!,
      base = `/api/v1/projects/${project.id}/sources`;
    const call = (url: string, body: unknown, key: string, method: 'POST' | 'PATCH' = 'POST') =>
      app.inject({
        method,
        url,
        headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
        payload: body as object,
      });
    const first = await call(base, content, 'create');
    assert.equal(first.statusCode, 201, first.body);
    const source = first.json() as ProjectSource,
      url = base + '/' + source.id;
    assert.deepEqual((await call(base, content, 'create')).json(), source);
    assert.equal(
      (await call(base, { ...content, title: 'different' }, 'create')).json().error.code,
      'IDEMPOTENCY_CONFLICT',
    );
    const bodies = ['first', 'second'].map((text) => ({
      expectedRevision: 1,
      title: source.title,
      content: text,
      url: null,
    }));
    const answers = await Promise.all([
      call(url, bodies[0], 'a', 'PATCH'),
      call(url, bodies[1], 'b', 'PATCH'),
    ]);
    assert.deepEqual(answers.map((answer) => answer.statusCode).sort(), [200, 409]);
    const win = answers[0]!.statusCode === 200 ? 0 : 1,
      winKey = win === 0 ? 'a' : 'b';
    const deleted = (
      await call(url + '/lifecycle', { expectedRevision: 2, action: 'delete' }, 'delete')
    ).json();
    assert.ok(deleted.deletedAt);
    assert.equal((await call(url, bodies[win], winKey, 'PATCH')).json().revision, 2);
    assert.ok(store.projectSources.get(project.id, source.id).deletedAt);
    const illegal = await call(
      url,
      { ...bodies[win], expectedRevision: 3 },
      'edit-deleted',
      'PATCH',
    );
    assert.equal(illegal.json().error.code, 'SOURCE_DELETED');
    assert.equal(
      (await call(url + '/lifecycle', { expectedRevision: 3, action: 'restore' }, 'restore')).json()
        .revision,
      4,
    );
    assert.equal(
      (await call(url + '/lifecycle', { expectedRevision: 2, action: 'delete' }, 'delete')).json()
        .revision,
      3,
    );
    assert.equal(store.projectSources.get(project.id, source.id).deletedAt, null);
    await call(url + '/lifecycle', { expectedRevision: 4, action: 'delete' }, 'delete-again');
    await call(url + '/lifecycle', { expectedRevision: 3, action: 'restore' }, 'restore');
    await call(base, content, 'create');
    assert.ok(store.projectSources.get(project.id, source.id).deletedAt);
    assert.equal(store.projectSources.history(project.id, source.id, historyQuery).items.length, 5);
    assert.equal(store.projectSources.list(project.id, listQuery).items.length, 0);
  } finally {
    await app.close();
  }
});

test('资料当前记录、不可变修订、通知和回执任一步失败全部回滚，原请求可重试', () => {
  for (const action of ['create', 'edit', 'delete'] as const)
    for (const table of [
      'project_sources',
      'project_source_revisions',
      'outbox',
      'idempotency_records',
    ]) {
      const store = new Store();
      try {
        const project = store.projects()[0]!,
          source = create(store, project.id),
          before = store.db.prepare('SELECT * FROM project_sources').all(),
          events = store.db.prepare('SELECT * FROM outbox').all(),
          history = store.projectSources.history(project.id, source.id, historyQuery);
        const mutation = () =>
          action === 'create'
            ? create(store, project.id, 'retry')
            : action === 'edit'
              ? edit(store, source, '失败要回滚', 'retry')
              : store.projectSources.lifecycle(
                  project.id,
                  source.id,
                  { expectedRevision: 1, action: 'delete' },
                  'retry',
                );
        store.db.exec(
          `CREATE TRIGGER failure BEFORE ${table === 'project_sources' && action !== 'create' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'sources fixture rollback'); END;`,
        );
        assert.throws(mutation, /sources fixture rollback/);
        assert.deepEqual(store.db.prepare('SELECT * FROM project_sources').all(), before);
        assert.deepEqual(
          store.projectSources.history(project.id, source.id, historyQuery),
          history,
        );
        assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
        assert.equal(
          store.db.prepare("SELECT 1 FROM idempotency_records WHERE key='retry'").get(),
          undefined,
        );
        store.db.exec('DROP TRIGGER failure');
        assert.ok(mutation().id);
      } finally {
        store.close();
      }
    }
});

test('资料按当前项目权限读写和回放，空间所有者不越权，降权/移除后不能借旧回执恢复访问', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(bob),
      own = await f.project(alice);
    const base = `projects/${project.id}/sources`;
    const created = await f.call(base, bob, content, 'create');
    assert.equal(created.statusCode, 201, created.body);
    const source = created.json(),
      url = base + '/' + source.id;
    for (const path of [base, url, url + '/revisions'])
      assert.equal((await f.call(path, alice)).statusCode, 404);
    assert.equal((await f.call(`projects/${own.id}/sources/${source.id}`, alice)).statusCode, 404);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(url, alice)).statusCode, 200);
    assert.equal((await f.call(base, alice, content)).statusCode, 403);
    assert.equal(
      (
        await f.call(
          url,
          alice,
          { expectedRevision: 1, title: '只读不能改', content: 'x', url: null },
          'view',
          'PATCH',
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.call(url + '/lifecycle', alice, { expectedRevision: 1, action: 'delete' }))
        .statusCode,
      403,
    );
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const body = {
      expectedRevision: 1,
      title: '协作更新',
      content: '修改并不会发送到模型',
      url: null,
    };
    const updated = await f.call(url, alice, body, 'edit', 'PATCH');
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().createdByUserId, bob.user.id);
    assert.equal(updated.json().updatedByUserId, alice.user.id);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(url, alice, body, 'edit', 'PATCH')).statusCode, 403);
    assert.equal((await f.call(url + '/revisions', alice)).statusCode, 200);
    assert.equal(
      (await f.call(url, { ...alice, spaceId: `personal-${alice.user.id}` })).statusCode,
      404,
    );
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null });
    for (const path of [base, url, url + '/revisions'])
      assert.equal((await f.call(path, alice)).statusCode, 404);
    assert.equal((await f.call(url, alice, body, 'edit', 'PATCH')).statusCode, 404);
    assert.equal((await f.call(url, null)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('资料事件限定父项目，移除空间成员后禁止内容与历史，归档仍允许人工资料操作', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      hidden = await f.project(bob),
      base = `projects/${project.id}/sources`;
    const cursor = f.store.as(bob, () => f.store.events(0).cursor);
    const source = (await f.call(base, alice, content, 'create')).json();
    await f.call(`projects/${hidden.id}/sources`, bob, { ...content, title: '别的项目资料' });
    assert.ok(
      f.store
        .as(bob, () => f.store.events(cursor))
        .events.every((event) => event.projectId !== project.id),
    );
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const visible = f.store
      .as(bob, () => f.store.events(cursor))
      .events.filter((event) => event.projectId === project.id);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.kind, 'project.source_changed');
    assert.equal(visible[0]!.taskId, null);
    assert.ok(!JSON.stringify(visible).includes(content.content));
    await f.call(`projects/${project.id}/lifecycle`, alice, {
      action: 'archive',
      expectedRevision: project.revision,
      activeRunAction: 'keep',
    });
    assert.equal(
      (
        await f.call(base, bob, {
          kind: 'link',
          title: '归档期仍可查阅的链接',
          url: 'https://example.invalid/docs',
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await f.call(base + '/' + source.id + '/lifecycle', bob, {
          action: 'delete',
          expectedRevision: 1,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.call(base + '/' + source.id + '/lifecycle', bob, {
          action: 'restore',
          expectedRevision: 2,
        })
      ).statusCode,
      200,
    );
    const newSource = (await f.call(base, bob, content, 'bob-source')).json();
    await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {}); // Bob manages hidden, so transfer first is required.
    await f.call(`projects/${hidden.id}/members/${alice.user.id}`, bob, { role: 'manage' });
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    assert.equal((await f.call(base, bob, content, 'bob-source')).statusCode, 403);
    assert.equal((await f.call(base + '/' + newSource.id + '/revisions', bob)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('资料列表正文摘要有界，关键词/删除范围先过滤后分页；历史按不可变修订分页', () => {
  const store = new Store();
  try {
    const p = store.projects()[0]!,
      first = create(store, p.id),
      second = store.projectSources.create(
        p.id,
        {
          kind: 'link',
          title: '链接资料',
          content: '包含关键词 Sigma 的参考',
          url: 'https://example.invalid/reference',
        },
        'second',
      );
    store.projectSources.create(
      p.id,
      { ...content, title: '长资料', content: 'x'.repeat(8000) },
      'long',
    );
    assert.equal(store.projectSources.list(p.id, listQuery).items[0]!.excerpt.length, 160);
    assert.equal('content' in store.projectSources.list(p.id, listQuery).items[0]!, false);
    assert.deepEqual(
      store.projectSources
        .list(p.id, parseSourceListQuery({ q: 'sigma' }))
        .items.map((item) => item.id),
      [second.id],
    );
    const page = store.projectSources.list(p.id, parseSourceListQuery({ limit: '2' }));
    const next = store.projectSources.list(
      p.id,
      parseSourceListQuery({ limit: '2', cursor: page.nextCursor }),
    );
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0]!.id, first.id);
    assert.equal(next.nextCursor, null);
    const updated = edit(store, first, '新的内容');
    const deleted = store.projectSources.lifecycle(
      p.id,
      first.id,
      { expectedRevision: updated.revision, action: 'delete' },
      'delete',
    );
    assert.deepEqual(
      store.projectSources
        .list(p.id, parseSourceListQuery({ state: 'deleted' }))
        .items.map((item) => item.id),
      [first.id],
    );
    assert.throws(
      () => store.projectSources.list(p.id, { ...listQuery, cursor: first.id }),
      code('INVALID_CURSOR'),
    );
    const history = store.projectSources.history(p.id, first.id, { before: null, limit: 2 });
    assert.deepEqual(
      history.items.map((item) => item.source.revision),
      [3, 2],
    );
    assert.equal(history.nextCursor, 2);
    assert.deepEqual(
      store.projectSources
        .history(p.id, first.id, { before: history.nextCursor, limit: 2 })
        .items.map((item) => item.source.revision),
      [1],
    );
    assert.equal(store.projectSources.get(p.id, deleted.id).content, '新的内容');
  } finally {
    store.close();
  }
});

test('迁移不把项目说明/旧讨论改成资料，独立资料及完整历史跨 SQLite 重启保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hexu-source-migration-')),
    path = join(directory, 'old.sqlite');
  let store: Store | undefined;
  try {
    const seed = new Store(),
      project = seed.projects()[0]!;
    seed.close();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((item) => item.version < 13)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
      project.id,
      project.spaceId,
      JSON.stringify(project),
    );
    db.close();
    store = new Store(path);
    assert.deepEqual(store.projectSources.list(project.id, listQuery).items, []);
    assert.deepEqual(store.project(project.id), project);
    const first = create(store, project.id),
      changed = edit(store, first, '重启后保留');
    store.projectSources.lifecycle(
      project.id,
      first.id,
      { expectedRevision: changed.revision, action: 'delete' },
      'delete',
    );
    const history = store.projectSources.history(project.id, first.id, historyQuery);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.projectSources.history(project.id, first.id, historyQuery), history);
    assert.equal(
      store.projectSources.lifecycle(
        project.id,
        first.id,
        { expectedRevision: 3, action: 'restore' },
        'restore',
      ).id,
      first.id,
    );
    assert.equal(store.projectSources.get(project.id, first.id).content, '重启后保留');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
