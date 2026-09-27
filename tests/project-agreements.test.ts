import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Message } from '../packages/contracts/src/index.js';
import {
  parseAgreementCreate,
  parseAgreementEdit,
  parseAgreementLifecycle,
  parseAgreementQuery,
  parseAgreementHistoryQuery,
  type ProjectAgreement,
} from '../packages/contracts/src/project-agreements.js';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { migrations } from '../packages/db/src/schema.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';
const code = (value: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === value;
const historyQuery = { before: null, limit: 50 },
  allQuery = parseAgreementQuery({ state: 'all' });
function discussion(store: Store, projectId = store.projects()[0]!.id) {
  const task = store.createTask(
    { title: '订单规则讨论', projectId, description: '已确认的任务说明' },
    randomUUID(),
  );
  const message = store.addMessage(task.id, '订单金额使用最小货币单位', null, randomUUID());
  return { task, message, projectId };
}
function input(
  store: Store,
  taskId: string,
  messageId: string,
  title = '金额约定',
  content = '  统一使用分，不用浮点元\n',
) {
  return {
    title,
    content,
    sourceTaskId: taskId,
    sourceMessageId: messageId,
    expectedSourceHash: store.projectAgreements.preview(taskId, messageId).origin.hash,
  };
}
function publish(store: Store, f: ReturnType<typeof discussion>) {
  return store.projectAgreements.create(
    f.projectId,
    input(store, f.task.id, f.message.id),
    randomUUID(),
  );
}
function edit(
  store: Store,
  agreement: ProjectAgreement,
  content: string,
  key: string = randomUUID(),
) {
  return store.projectAgreements.edit(
    agreement.projectId,
    agreement.id,
    { expectedRevision: agreement.revision, title: agreement.title, content },
    key,
  );
}

test('约定契约限定明确来源与替代修订，不接受作者、权限、执行或状态注入', () => {
  const body = {
    title: '  金额 ',
    content: '  按分计算\n',
    sourceTaskId: 'task',
    sourceMessageId: 'message',
    expectedSourceHash: 'a'.repeat(64),
  };
  assert.deepEqual(parseAgreementCreate(body), { ...body, title: '金额', replaces: null });
  for (const value of [
    null,
    [],
    { ...body, content: '' },
    { ...body, content: 'x'.repeat(8001) },
    { ...body, title: 'x'.repeat(121) },
    { ...body, expectedSourceHash: 'A'.repeat(64) },
    { ...body, replaces: { id: 'r', expectedRevision: '1' } },
    { ...body, replaces: { id: 'r', expectedRevision: 1, projectId: 'other' } },
    ...[
      'createdByUserId',
      'origin',
      'state',
      'spaceId',
      'projectId',
      'send',
      'approve',
      'command',
      'sourceBody',
    ].map((field) => ({ ...body, [field]: 'forged' })),
  ])
    assert.throws(() => parseAgreementCreate(value), code('INVALID_INPUT'));
  assert.throws(
    () => parseAgreementEdit({ title: 'x', content: 'y', expectedRevision: 1, origin: {} }),
    code('INVALID_INPUT'),
  );
  for (const value of [
    { action: 'delete', expectedRevision: 1 },
    { action: 'deactivate', expectedRevision: 0 },
    { action: 'reactivate', expectedRevision: 1, reason: 'x'.repeat(601) },
  ])
    assert.throws(() => parseAgreementLifecycle(value), code('INVALID_INPUT'));
  assert.deepEqual(parseAgreementQuery({}), { state: 'active', q: '', cursor: null, limit: 20 });
  for (const query of [
    { limit: '51' },
    { limit: 2 },
    { state: 'private' },
    { q: ['x'] },
    { projectId: 'other' },
  ])
    assert.throws(() => parseAgreementQuery(query), code('INVALID_INPUT'));
  for (const query of [
    { before: '0' },
    { before: '1.5' },
    { before: '9007199254740992' },
    { limit: '51' },
    { taskId: 'other' },
  ])
    assert.throws(() => parseAgreementHistoryQuery(query), code('INVALID_INPUT'));
});

test('人工发布保留来源与原文，AI 建议不自动成为约定；系统/私有/跨项目/陈旧来源被拒绝', () => {
  const store = new Store();
  try {
    const f = discussion(store),
      other = discussion(store, store.projects()[1]!.id);
    assert.equal(store.projectAgreements.list(f.projectId, allQuery).items.length, 0);
    const first = publish(store, f);
    assert.equal(first.origin.actorType, 'human');
    assert.equal(first.createdByUserId, store.actorId);
    assert.equal(first.origin.messageId, f.message.id);
    assert.equal(first.content, '  统一使用分，不用浮点元\n');
    assert.throws(
      () => store.projectAgreements.preview(f.task.id, other.message.id),
      code('NOT_FOUND'),
    );
    assert.throws(
      () =>
        store.projectAgreements.create(
          f.projectId,
          input(store, other.task.id, other.message.id),
          'cross',
        ),
      code('NOT_FOUND'),
    );
    const privateTask = store.createTask(
        { title: '私有资料', projectId: null, description: '' },
        'private',
      ),
      privateMessage = store.addMessage(privateTask.id, '不公开的讨论', null, 'private-message');
    assert.throws(
      () => store.projectAgreements.preview(privateTask.id, privateMessage.id),
      code('AGREEMENT_SOURCE_PRIVATE'),
    );
    assert.throws(
      () => store.projectAgreements.notice(privateTask.id),
      code('AGREEMENT_SOURCE_PRIVATE'),
    );
    const agent: Message = {
      id: randomUUID(),
      taskId: f.task.id,
      actorType: 'agent',
      actorName: 'Codex 模拟建议',
      body: '这是建议，尚未成为项目约定',
      createdAt: new Date().toISOString(),
      resultId: null,
    };
    store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(agent.id, f.task.id, JSON.stringify(agent));
    assert.equal(store.projectAgreements.list(f.projectId, allQuery).items.length, 1);
    const accepted = store.projectAgreements.create(
      f.projectId,
      input(store, f.task.id, agent.id),
      'accept-agent',
    );
    assert.equal(accepted.origin.actorType, 'agent');
    assert.equal(accepted.createdByName, store.actorName());
    assert.notEqual(accepted.createdByName, agent.actorName);
    const system = { ...agent, id: randomUUID(), actorType: 'system' };
    store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(system.id, f.task.id, JSON.stringify(system));
    assert.throws(
      () => store.projectAgreements.preview(f.task.id, system.id),
      code('AGREEMENT_SOURCE_UNSUPPORTED'),
    );
    const stale = input(store, f.task.id, f.message.id);
    store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.message, body: '来源已修改' }), f.message.id);
    assert.throws(
      () => store.projectAgreements.create(f.projectId, stale, 'stale'),
      code('AGREEMENT_SOURCE_CHANGED'),
    );
    const long = { ...agent, id: randomUUID(), body: '长'.repeat(12000) };
    store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(long.id, f.task.id, JSON.stringify(long));
    const preview = store.projectAgreements.preview(f.task.id, long.id);
    assert.equal(preview.origin.excerpt.length, 1000);
    assert.equal(preview.origin.truncated, true);
    assert.equal(preview.initialContent.length, 8000);
    assert.equal(preview.contentTruncated, true);
    assert.equal(
      store.messages(f.task.id).find((message) => message.id === agent.id)!.body,
      agent.body,
    );
  } finally {
    store.close();
  }
});

test('约定修改/停用/启用保留作者与历史，不改任务、原运行、目录锁或冻结接续', () => {
  const store = new Store();
  try {
    const f = discussion(store),
      project = store.project(f.projectId);
    const copy = store.registerWorkingCopy({
      id: randomUUID(),
      name: '无进程约定夹具',
      root: '/fictional/project-agreements',
      createdAt: new Date().toISOString(),
    });
    const body = {
      provider: 'native',
      requestedTool: 'claude-code',
      workingCopyId: copy.id,
      prompt: '固定要求',
      confirmExecution: true,
      expectedRevision: f.task.revision,
    };
    const run = store.createNativeRun(
      f.task.id,
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
      'native',
    );
    const operations = new ContinuationStore(store),
      op = operations.create(
        f.task.id,
        parseContinuation({
          ...body,
          sourceRunId: run.id,
          onActiveRun: 'wait',
          expectedRevision: store.getTask(f.task.id).revision,
        }),
        'op',
      );
    const before = store.getTask(f.task.id),
      locks = store.db.prepare('SELECT * FROM native_workspace_locks').all(),
      first = publish(store, f),
      changed = edit(store, first, '新的金额约定');
    assert.equal(changed.id, first.id);
    assert.deepEqual(changed.origin, first.origin);
    assert.equal(changed.createdAt, first.createdAt);
    assert.notEqual(changed.contentHash, first.contentHash);
    const inactive = store.projectAgreements.lifecycle(
      f.projectId,
      first.id,
      { action: 'deactivate', expectedRevision: 2, reason: '被现行接口规则覆盖' },
      'deactivate',
    );
    assert.equal(inactive.state, 'inactive');
    assert.equal(inactive.statusReason, '被现行接口规则覆盖');
    assert.equal(store.projectAgreements.notice(f.task.id).activeCount, 0);
    assert.throws(() => edit(store, inactive, '不能改停用记录'), code('AGREEMENT_NOT_ACTIVE'));
    const active = store.projectAgreements.lifecycle(
      f.projectId,
      first.id,
      { action: 'reactivate', expectedRevision: 3 },
      'reactivate',
    );
    assert.equal(active.state, 'active');
    assert.equal(active.statusReason, null);
    const notice = store.projectAgreements.notice(f.task.id);
    assert.equal(notice.activeCount, 1);
    assert.equal(notice.version, 4);
    assert.equal(edit(store, active, active.content).revision, 4);
    assert.deepEqual(store.projectAgreements.notice(f.task.id), notice);
    assert.deepEqual(
      store.projectAgreements
        .history(f.projectId, first.id, historyQuery)
        .items.map((item) => item.action),
      ['reactivated', 'deactivated', 'updated', 'created'],
    );
    assert.deepEqual(store.getTask(f.task.id), before);
    assert.deepEqual(store.project(f.projectId), project);
    assert.deepEqual(store.run(run.id), run);
    assert.deepEqual(operations.get(op.id), op);
    assert.deepEqual(store.db.prepare('SELECT * FROM native_workspace_locks').all(), locks);
  } finally {
    store.close();
  }
});

test('替代必须明确选择同项目有效约定，创建新记录与旧记录失效原子关联且不能复活旧约定', () => {
  const store = new Store();
  try {
    const f = discussion(store),
      first = publish(store, f),
      body = {
        ...input(store, f.task.id, f.message.id, '新金额规则', '明确替代先前规则'),
        replaces: { id: first.id, expectedRevision: 1 },
      };
    assert.equal(store.projectAgreements.get(f.projectId, first.id).state, 'active');
    const replacement = store.projectAgreements.create(f.projectId, body, 'replacement'),
      old = store.projectAgreements.get(f.projectId, first.id);
    assert.equal(replacement.replacesId, first.id);
    assert.equal(old.supersededById, replacement.id);
    assert.equal(old.state, 'superseded');
    assert.equal(old.revision, 2);
    assert.equal(old.content, first.content);
    assert.equal(store.projectAgreements.notice(f.task.id).activeCount, 1);
    assert.equal(store.projectAgreements.notice(f.task.id).version, 3);
    assert.throws(
      () =>
        store.projectAgreements.lifecycle(
          f.projectId,
          first.id,
          { expectedRevision: 2, action: 'reactivate' },
          'restore-old',
        ),
      code('AGREEMENT_SUPERSEDED'),
    );
    assert.throws(
      () =>
        store.projectAgreements.create(
          f.projectId,
          { ...body, replaces: { id: first.id, expectedRevision: 2 } },
          'replace-again',
        ),
      code('AGREEMENT_NOT_ACTIVE'),
    );
    store.projectAgreements.lifecycle(
      f.projectId,
      replacement.id,
      { expectedRevision: 1, action: 'deactivate' },
      'stop-new',
    );
    assert.equal(
      store.projectAgreements.create(f.projectId, body, 'replacement').id,
      replacement.id,
    );
    assert.equal(store.projectAgreements.get(f.projectId, replacement.id).state, 'inactive');
    assert.equal(store.projectAgreements.notice(f.task.id).activeCount, 0);
    const foreign = discussion(store, store.projects()[1]!.id),
      foreignRule = publish(store, foreign);
    assert.throws(
      () =>
        store.projectAgreements.create(
          f.projectId,
          { ...body, replaces: { id: foreignRule.id, expectedRevision: 1 } },
          'foreign',
        ),
      code('NOT_FOUND'),
    );
  } finally {
    store.close();
  }
});

test('并发约定修订只接受一次，HTTP 回执重放不重复发布或反转后来状态，历史分页稳定', async () => {
  const store = new Store(),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const f = discussion(store),
      base = `/api/v1/projects/${f.projectId}/agreements`,
      body = input(store, f.task.id, f.message.id);
    const call = (url: string, payload: unknown, key: string, method: 'POST' | 'PATCH' = 'POST') =>
      app.inject({
        url,
        method,
        payload: payload as object,
        headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
      });
    const response = await call(base, body, 'create');
    assert.equal(response.statusCode, 201, response.body);
    const agreement = response.json() as ProjectAgreement,
      url = base + '/' + agreement.id;
    assert.equal((await call(base, body, 'create')).json().id, agreement.id);
    const choices = ['one', 'two'].map((content) => ({
      expectedRevision: 1,
      title: agreement.title,
      content,
    }));
    const results = await Promise.all([
      call(url, choices[0], 'a', 'PATCH'),
      call(url, choices[1], 'b', 'PATCH'),
    ]);
    assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 409]);
    const winner = results[0]!.statusCode === 200 ? 0 : 1;
    const off = { expectedRevision: 2, action: 'deactivate' };
    await call(url + '/lifecycle', off, 'off');
    assert.equal(
      (await call(url, choices[winner], winner === 0 ? 'a' : 'b', 'PATCH')).json().revision,
      2,
    );
    assert.equal(store.projectAgreements.get(f.projectId, agreement.id).state, 'inactive');
    await call(url + '/lifecycle', { expectedRevision: 3, action: 'reactivate' }, 'on');
    await call(url + '/lifecycle', off, 'off');
    assert.equal(store.projectAgreements.get(f.projectId, agreement.id).state, 'active');
    assert.equal(
      (await call(base, { ...body, title: 'different' }, 'create')).json().error.code,
      'IDEMPOTENCY_CONFLICT',
    );
    const first = (await app.inject({ url: url + '/revisions?limit=2' })).json();
    assert.deepEqual(
      first.items.map((item: { agreement: { revision: number } }) => item.agreement.revision),
      [4, 3],
    );
    assert.equal(first.nextCursor, 3);
    const older = (await app.inject({ url: url + '/revisions?limit=2&before=3' })).json();
    assert.deepEqual(
      older.items.map((item: { agreement: { revision: number } }) => item.agreement.revision),
      [2, 1],
    );
    assert.equal(older.nextCursor, null);
    assert.equal(
      (await app.inject({ url: `/api/v1/tasks/${f.task.id}/agreements-notice` })).json()
        .activeCount,
      1,
    );
  } finally {
    await app.close();
  }
});

test('替代中的新旧记录、修订、项目版本、通知和幂等回执任一步失败全部回滚', () => {
  for (const [table, operation, condition] of [
    ['project_agreements', 'INSERT', ''],
    ['project_agreements', 'UPDATE', "WHEN json_extract(NEW.body,'$.state')='superseded'"],
    ['project_agreement_revisions', 'INSERT', "WHEN NEW.action='superseded'"],
    ['project_agreement_versions', 'UPDATE', ''],
    ['outbox', 'INSERT', ''],
    ['idempotency_records', 'INSERT', ''],
  ]) {
    const store = new Store();
    try {
      const f = discussion(store),
        first = publish(store, f),
        body = {
          ...input(store, f.task.id, f.message.id, '替代稿', '新内容'),
          replaces: { id: first.id, expectedRevision: 1 },
        };
      const rows = store.db.prepare('SELECT * FROM project_agreements').all(),
        events = store.db.prepare('SELECT * FROM outbox').all(),
        notice = store.projectAgreements.notice(f.task.id);
      store.db.exec(
        `CREATE TRIGGER failure BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'agreement fixture rollback'); END;`,
      );
      assert.throws(
        () => store.projectAgreements.create(f.projectId, body, 'retry'),
        /agreement fixture rollback/,
      );
      assert.deepEqual(store.db.prepare('SELECT * FROM project_agreements').all(), rows);
      assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
      assert.deepEqual(store.projectAgreements.notice(f.task.id), notice);
      assert.equal(
        store.projectAgreements.history(f.projectId, first.id, historyQuery).items.length,
        1,
      );
      assert.equal(
        store.db.prepare("SELECT 1 FROM idempotency_records WHERE key='retry'").get(),
        undefined,
      );
      store.db.exec('DROP TRIGGER failure');
      assert.ok(store.projectAgreements.create(f.projectId, body, 'retry').id);
    } finally {
      store.close();
    }
  }
});

test('真实项目角色控制发布、历史、提示、事件和回执；空间 owner 不可读取其他人的私有来源', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(bob),
      task = await f.task(bob, project.id),
      message = (await f.call(`tasks/${task.id}/messages`, bob, { body: '同项目公开讨论' })).json();
    const previewPath = `tasks/${task.id}/messages/${message.id}/agreement-preview`,
      base = `projects/${project.id}/agreements`;
    assert.equal((await f.call(previewPath, alice)).statusCode, 404);
    assert.equal((await f.call(base, alice)).statusCode, 404);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    const preview = (await f.call(previewPath, alice)).json();
    const body = {
      title: '团队约定',
      content: '人工确认的约定',
      sourceTaskId: task.id,
      sourceMessageId: message.id,
      expectedSourceHash: preview.origin.hash,
    };
    assert.equal((await f.call(base, alice, body)).statusCode, 403);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const cursor = f.store.as(alice, () => f.store.events(0).cursor),
      created = await f.call(base, alice, body, 'publish');
    assert.equal(created.statusCode, 201, created.body);
    const agreement = created.json(),
      url = base + '/' + agreement.id;
    assert.equal(agreement.createdByUserId, alice.user.id);
    assert.equal(agreement.origin.actorName, bob.user.name);
    const events = f.store.as(alice, () => f.store.events(cursor)).events;
    assert.ok(
      events.some(
        (event) => event.projectId === project.id && event.kind === 'project.agreement_changed',
      ),
    );
    assert.ok(!JSON.stringify(events).includes(body.content));
    const privateTask = await f.task(bob),
      privateMessage = (
        await f.call(`tasks/${privateTask.id}/messages`, bob, { body: '不能公开的私有讨论' })
      ).json();
    assert.equal(
      (
        await f.call(
          `tasks/${privateTask.id}/messages/${privateMessage.id}/agreement-preview`,
          alice,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/messages/${privateMessage.id}/agreement-preview`, bob))
        .statusCode,
      422,
    );
    assert.equal(
      (await f.call(url, { ...alice, spaceId: `personal-${alice.user.id}` })).statusCode,
      404,
    );
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(base, alice, body, 'publish')).statusCode, 403);
    assert.equal((await f.call(url + '/revisions', alice)).statusCode, 200);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null });
    for (const path of [
      base,
      url,
      url + '/revisions',
      `tasks/${task.id}/agreements-notice`,
      previewPath,
    ])
      assert.equal((await f.call(path, alice)).statusCode, 404);
    assert.equal((await f.call(base, alice, body, 'publish')).statusCode, 404);
    assert.ok(
      f.store
        .as(alice, () => f.store.events(cursor))
        .events.every((event) => event.projectId !== project.id),
    );
    assert.equal((await f.call(url, null)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('旧创建回执重新检查来源边界，归档允许人工约定，状态与关键词过滤后分页', () => {
  const store = new Store();
  try {
    const f = discussion(store),
      body = input(store, f.task.id, f.message.id),
      first = store.projectAgreements.create(f.projectId, body, 'publish');
    const project = store.project(f.projectId);
    store.projectLifecycle.change(
      f.projectId,
      { action: 'archive', expectedRevision: project.revision, activeRunAction: 'keep' },
      'archive',
    );
    const second = store.projectAgreements.create(
      f.projectId,
      { ...body, title: '分页二', content: 'Sigma 规则' },
      'second',
    );
    store.projectAgreements.lifecycle(
      f.projectId,
      first.id,
      { action: 'deactivate', expectedRevision: 1 },
      'off',
    );
    assert.deepEqual(
      store.projectAgreements
        .list(f.projectId, parseAgreementQuery({ state: 'inactive' }))
        .items.map((item) => item.id),
      [first.id],
    );
    assert.deepEqual(
      store.projectAgreements
        .list(f.projectId, parseAgreementQuery({ q: 'sigma' }))
        .items.map((item) => item.id),
      [second.id],
    );
    const page = store.projectAgreements.list(f.projectId, { ...allQuery, limit: 1 });
    assert.equal(page.nextCursor, second.id);
    assert.equal(
      store.projectAgreements.list(f.projectId, { ...allQuery, cursor: second.id }).items[0]!.id,
      first.id,
    );
    assert.throws(
      () => store.projectAgreements.list(f.projectId, parseAgreementQuery({ cursor: first.id })),
      code('INVALID_CURSOR'),
    );
    store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(
        JSON.stringify({ ...store.getTask(f.task.id), visibility: 'private', projectId: null }),
        f.task.id,
      );
    assert.throws(
      () => store.projectAgreements.create(f.projectId, body, 'publish'),
      code('AGREEMENT_SOURCE_PRIVATE'),
    );
    assert.equal(store.projectAgreements.get(f.projectId, first.id).state, 'inactive'); // Existing explicit publication is an independent project record.
  } finally {
    store.close();
  }
});

test('迁移不把旧消息或资料补成约定；来源、替代关系和修订跨 SQLite 重启保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hexu-agreements-')),
    path = join(directory, 'old.sqlite');
  let store: Store | undefined;
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((item) => item.version < 14)) {
      old.exec(migration.sql);
      old.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    old.close();
    store = new Store(path);
    const f = discussion(store);
    assert.equal(store.projectAgreements.notice(f.task.id).version, 0);
    store.projectSources.create(
      f.projectId,
      { kind: 'text', title: '一般资料', content: '不是约定' },
      'source',
    );
    assert.equal(store.projectAgreements.list(f.projectId, allQuery).items.length, 0);
    const first = publish(store, f),
      second = store.projectAgreements.create(
        f.projectId,
        {
          ...input(store, f.task.id, f.message.id, '后续约定', '后续内容'),
          replaces: { id: first.id, expectedRevision: 1 },
        },
        'replacement',
      );
    const history = store.projectAgreements.history(f.projectId, first.id, historyQuery);
    store.close();
    store = new Store(path);
    assert.equal(store.projectAgreements.get(f.projectId, first.id).supersededById, second.id);
    assert.deepEqual(store.projectAgreements.history(f.projectId, first.id, historyQuery), history);
    assert.equal(store.projectAgreements.notice(f.task.id).activeCount, 1);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
