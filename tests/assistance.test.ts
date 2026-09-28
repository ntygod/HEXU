import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError, type Message } from '../packages/contracts/src/index.js';
import {
  parseAssistanceCreate,
  parseAssistanceReply,
  parseAssistanceStateChange,
  parseAssistanceList,
  parseAssistanceHistory,
  selectedAssistanceText,
  type AssistanceDetail,
} from '../packages/contracts/src/assistance.js';
import { Store } from '../packages/db/src/store.js';
import { teamFixture, type Account } from './helpers/team.js';
const code = (value: string) => (error: unknown) =>
  error instanceof DomainError && error.code === value;
const visible = '仅分享的报错';
const hidden = '不要分享的尾部说明';
type Fixture = Awaited<ReturnType<typeof teamFixture>>;
async function source(f: Fixture, alice: Account, bob: Account, privateTask = false) {
  const project = privateTask ? null : await f.project(alice);
  const task = await f.task(alice, project?.id ?? null, '未分享任务标题');
  const m = await f.call(`tasks/${task.id}/messages`, alice, { body: visible + '\n' + hidden });
  assert.equal(m.statusCode, 201, m.body);
  const message = m.json();
  const preview = await f.call(`tasks/${task.id}/messages/${message.id}/assistance-preview`, alice);
  assert.equal(preview.statusCode, 200, preview.body);
  const input = {
    sourceMessageId: message.id,
    expectedSourceHash: preview.json().sourceHash,
    expectedTaskRevision: task.revision,
    recipientId: bob.user.id,
    range: { start: 0, end: visible.length },
    question: '能否帮忙分析这个错误？',
    shareConfirmed: true,
  };
  return { project, task, message, input };
}
async function create(
  f: Fixture,
  alice: Account,
  taskId: string,
  input: unknown,
  key: string = randomUUID(),
) {
  const r = await f.call(`tasks/${taskId}/assistances`, alice, input, key);
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as AssistanceDetail;
}

test('协助契约只接受显式片段/接收者，不接受权限、执行、正文或身份注入', () => {
  const input = {
    sourceMessageId: 'm',
    expectedSourceHash: 'a'.repeat(64),
    expectedTaskRevision: 1,
    range: { start: 0, end: 1 },
    recipientId: 'bob',
    question: '  问题\n',
    shareConfirmed: true,
  };
  assert.equal(parseAssistanceCreate(input).question, '  问题\n');
  for (const extra of [
    { taskId: 'other' },
    { provider: 'node' },
    { snapshot: {} },
    { createdBy: 'alice' },
    { expectedSourceHash: 'bad' },
    { range: { start: -1, end: 1 } },
    { range: { start: 0, end: 6001 } },
    { range: { start: 12000, end: 12001 } },
    { range: { start: 1, end: 1 } },
    { question: 'x'.repeat(2001) },
  ])
    assert.throws(() => parseAssistanceCreate({ ...input, ...extra }), code('INVALID_INPUT'));
  assert.throws(
    () => parseAssistanceCreate({ ...input, shareConfirmed: false }),
    code('SHARING_CONFIRMATION_REQUIRED'),
  );
  assert.throws(
    () => selectedAssistanceText('🙂好', { start: 1, end: 3 }),
    code('ASSISTANCE_RANGE_CHANGED'),
  );
  assert.throws(
    () => selectedAssistanceText('甲\r\n乙', { start: 0, end: 2 }),
    code('ASSISTANCE_RANGE_CHANGED'),
  );
  assert.equal(selectedAssistanceText('甲\r\n乙🙂', { start: 3, end: 6 }), '乙🙂');
  assert.throws(
    () => parseAssistanceReply({ body: 'x', expectedRevision: 1, authorId: 'other' }),
    code('INVALID_INPUT'),
  );
  assert.throws(
    () => parseAssistanceStateChange({ action: 'open', expectedRevision: 1 }),
    code('INVALID_INPUT'),
  );
  for (const q of [{ limit: '51' }, { taskId: 'outside' }, { box: 'everyone' }, { limit: 'NaN' }])
    assert.throws(() => parseAssistanceList(q), code('INVALID_INPUT'));
  assert.throws(() => parseAssistanceHistory({ before: '0' }), code('INVALID_INPUT'));
  const preview = new Store();
  try {
    assert.throws(() => preview.assistance.get('x'), code('TEAM_MODE_REQUIRED'));
  } finally {
    preview.close();
  }
});

test('真实接收者仅可查看所选片段并回复；无 Task/Project/消息/执行或其他协助权限', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, alice, bob);
    const detail = await create(f, alice, s.task.id, s.input),
      id = detail.assistance.id;
    const r = await f.call(`assistances/${id}`, bob);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().assistance.snapshot.text, visible);
    assert.equal(r.json().assistance.taskLink, null);
    for (const secret of [hidden, s.task.title, s.task.id, s.message.id, s.project.id])
      assert.equal(r.body.includes(secret), false);
    for (const path of [
      `tasks/${s.task.id}`,
      `projects/${s.project.id}`,
      `tasks/${s.task.id}/messages/${s.message.id}/assistance-preview`,
      `tasks/${s.task.id}/assistances`,
    ])
      assert.equal((await f.call(path, bob)).statusCode, 404, path);
    assert.equal(
      (await f.call(`tasks/${s.task.id}/messages`, bob, { body: '越界' })).statusCode,
      404,
    );
    const reply = await f.call(
      `assistances/${id}/replies`,
      bob,
      { expectedRevision: 1, body: '  可以检查请求超时\n' },
      'answer',
    );
    assert.equal(reply.statusCode, 201, reply.body);
    assert.equal(reply.json().assistance.state, 'responded');
    assert.equal(reply.json().replies[0].author.id, bob.user.id);
    assert.equal(reply.json().replies[0].body, '  可以检查请求超时\n');
    assert.equal((await f.call(`assistances/${id}`, null)).statusCode, 401);
    assert.equal(
      (await f.call(`assistances/${id}`, { ...bob, spaceId: `personal-${bob.user.id}` }))
        .statusCode,
      404,
    );
    const carol = await f.joinAccount(
      (await f.invite(alice, 'carol@example.invalid')).token,
      '测试丙',
    );
    assert.equal((await f.call(`assistances/${id}`, carol)).statusCode, 404);
    assert.equal((await f.call('assistances', carol)).json().items.length, 0);
    const received = await f.call('assistances?box=received', bob);
    assert.equal(received.json().items.length, 1);
    assert.equal(received.body.includes(hidden), false);
    assert.equal(received.body.includes(s.task.id), false);
    const candidates = await f.call(`tasks/${s.task.id}/assistance-recipients`, alice);
    assert.equal(candidates.json().items.length, 2);
    assert.equal(candidates.body.includes(bob.user.email), false);
    const events = f.store.as({ user: bob.user, spaceId: bob.spaceId }, () => f.store.events(0));
    assert.ok(events.events.some((e) => e.assistanceId === id));
    assert.equal(
      events.events.some((e) => e.taskId === s.task.id),
      false,
    );
    assert.equal(JSON.stringify(events).includes(s.task.id), false);
  } finally {
    await f.close();
  }
});

test('私有片段明确分享不公开任务；同项目查看者可读协助但不能冒充双方回复', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, bob, alice, true);
    const result = await create(f, bob, s.task.id, s.input);
    assert.equal((await f.call(`tasks/${s.task.id}`, alice)).statusCode, 404);
    assert.equal(
      (await f.call(`assistances/${result.assistance.id}`, alice)).json().assistance.snapshot.text,
      visible,
    );
    const publicSource = await source(f, alice, bob);
    const third = await f.joinAccount(
      (await f.invite(alice, 'viewer@example.invalid')).token,
      '项目只读',
    );
    assert.equal(
      (
        await f.call(`projects/${publicSource.project.id}/members/${third.user.id}`, alice, {
          role: 'view',
        })
      ).statusCode,
      200,
    );
    const shared = await create(f, alice, publicSource.task.id, publicSource.input);
    const thirdRead = await f.call(`assistances/${shared.assistance.id}`, third);
    assert.equal(thirdRead.statusCode, 200);
    assert.equal(thirdRead.json().assistance.canReply, false);
    assert.equal(
      (
        await f.call(`assistances/${shared.assistance.id}/replies`, third, {
          body: '冒充',
          expectedRevision: 1,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.call(`tasks/${publicSource.task.id}/assistances`, third, publicSource.input))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.call(`assistances/${shared.assistance.id}/state`, bob, {
          action: 'cancel',
          expectedRevision: 1,
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('来源/任务版本与范围在创建时复核；后来变化只提示，不改写固定片段', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, alice, bob);
    const created = await create(f, alice, s.task.id, s.input);
    f.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...s.message, body: '更新后的未授权材料' }), s.message.id);
    assert.equal((await f.call(`tasks/${s.task.id}/assistances`, alice, s.input)).statusCode, 409);
    const ownerRead = await f.call(`assistances/${created.assistance.id}`, alice),
      recipientRead = await f.call(`assistances/${created.assistance.id}`, bob);
    assert.equal(ownerRead.json().assistance.sourceChanged, true);
    assert.equal(recipientRead.json().assistance.sourceChanged, null);
    assert.equal(recipientRead.json().assistance.snapshot.text, visible);
    assert.equal(recipientRead.body.includes('更新后的未授权材料'), false);
    const otherTask = await f.task(alice, s.project.id);
    assert.equal(
      (await f.call(`tasks/${otherTask.id}/assistances`, alice, s.input)).statusCode,
      404,
    );
    const system: Message = { ...s.message, id: randomUUID(), actorType: 'system' };
    f.store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(system.id, s.task.id, JSON.stringify(system));
    assert.equal(
      (await f.call(`tasks/${s.task.id}/messages/${system.id}/assistance-preview`, alice))
        .statusCode,
      422,
    );
    assert.equal(
      (
        await f.call(`tasks/${s.task.id}/assistances`, alice, {
          ...s.input,
          recipientId: alice.user.id,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test('创建/回复/结束回执仅重查当前记录；并发只写一次，旧回执不重复追加或重开', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, alice, bob);
    const created = await create(f, alice, s.task.id, s.input, 'create'),
      id = created.assistance.id;
    assert.equal((await create(f, alice, s.task.id, s.input, 'create')).assistance.id, id);
    const body = { body: '同一个建议', expectedRevision: 1 };
    const answer = await f.call(`assistances/${id}/replies`, bob, body, 'answer');
    assert.equal(answer.statusCode, 201);
    const concurrent = await Promise.all(
      ['甲', '乙'].map((body) =>
        f.call(`assistances/${id}/replies`, alice, { body, expectedRevision: 2 }),
      ),
    );
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [201, 409]);
    const ended = await f.call(
      `assistances/${id}/state`,
      alice,
      { action: 'close', expectedRevision: 3 },
      'close',
    );
    assert.equal(ended.statusCode, 200, ended.body);
    const replay = await f.call(`assistances/${id}/replies`, bob, body, 'answer');
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().assistance.state, 'closed');
    assert.equal(replay.json().replies.length, 2);
    assert.equal(
      (await f.call(`assistances/${id}/replies`, bob, { ...body, body: '新建议' }, 'answer'))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.call(`assistances/${id}/replies`, bob, { body: '新回复', expectedRevision: 4 }))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.call(`assistances/${id}/state`, alice, { action: 'cancel', expectedRevision: 4 }))
        .statusCode,
      200,
    );
    assert.equal((await f.call(`assistances/${id}`, bob)).statusCode, 404);
    assert.equal((await f.call(`assistances/${id}/replies`, bob, body, 'answer')).statusCode, 404);
    const oldClose = await f.call(
      `assistances/${id}/state`,
      alice,
      { action: 'close', expectedRevision: 3 },
      'close',
    );
    assert.equal(oldClose.json().assistance.state, 'cancelled');
    assert.equal(
      (await create(f, alice, s.task.id, s.input, 'create')).assistance.state,
      'cancelled',
    );
    const records = f.store.db
      .prepare("SELECT result FROM idempotency_records WHERE scope LIKE '%assistance.%'")
      .all();
    for (const record of records)
      assert.deepEqual(Object.keys(JSON.parse(record.result as string)), ['id']);
  } finally {
    await f.close();
  }
});

test('项目/空间撤权永久撤销原协助，重新加入不恢复读取或旧回执；无权事件被过滤', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      p = await f.project(alice);
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const task = await f.task(bob, p.id);
    const msg = (await f.call(`tasks/${task.id}/messages`, bob, { body: visible })).json();
    const preview = (
      await f.call(`tasks/${task.id}/messages/${msg.id}/assistance-preview`, bob)
    ).json();
    const third = await f.joinAccount(
      (await f.invite(alice, 'recipient@example.invalid')).token,
      '受邀同事',
    );
    const input = {
      sourceMessageId: msg.id,
      expectedSourceHash: preview.sourceHash,
      expectedTaskRevision: 1,
      recipientId: third.user.id,
      range: { start: 0, end: visible.length },
      question: '请帮忙',
      shareConfirmed: true,
    };
    const item = await create(f, bob, task.id, input, 'create'),
      id = item.assistance.id;
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: null });
    assert.equal((await f.call(`assistances/${id}`, third)).statusCode, 404);
    await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    assert.equal((await f.call(`assistances/${id}`, third)).statusCode, 404);
    assert.equal((await create(f, bob, task.id, input, 'create')).assistance.state, 'cancelled');
    const batch = f.store.as({ user: third.user, spaceId: third.spaceId }, () => f.store.events(0));
    assert.equal(
      batch.events.some((event) => event.assistanceId === id),
      false,
    );
    const newItem = await create(f, bob, task.id, input);
    await f.call(`spaces/${alice.spaceId}/members/${third.user.id}/remove`, alice, {});
    const invite = await f.invite(alice, third.user.email);
    assert.equal((await f.call('identity/join', third, { token: invite.token })).statusCode, 200);
    assert.equal((await f.call(`assistances/${newItem.assistance.id}`, third)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('任务/运行/固定接续材料与未知目录锁不被协助创建、追问和取消改写', () => {
  const store = new Store(':memory:', undefined, { team: true });
  const alice = { id: 'alice', email: 'alice@example.invalid', name: '甲' },
    bob = { id: 'bob', email: 'bob@example.invalid', name: '乙' };
  store.collaboration.ensurePerson(alice);
  store.collaboration.ensurePerson(bob);
  const space = store.as({ user: alice, spaceId: 'personal-alice' }, () =>
    store.collaboration.createSpace('空间', 'space'),
  );
  store.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(space.id, bob.id, 'member');
  const as = <T>(user: typeof alice, fn: () => T) => store.as({ user, spaceId: space.id }, fn);
  try {
    as(alice, () => {
      const task = store.createTask(
        { title: '私有任务', description: '保留原说明', projectId: null },
        'task',
      );
      const message = store.addMessage(task.id, visible, null, 'msg');
      store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(
        'run',
        task.id,
        JSON.stringify({
          id: 'run',
          taskId: task.id,
          provider: 'native',
          state: 'running',
          observation: 'unknown',
        }),
      );
      store.db
        .prepare('INSERT INTO native_workspaces VALUES(?,?,?)')
        .run('wc', '/fictional-only', '{}');
      store.db.prepare('INSERT INTO native_workspace_locks VALUES(?,?)').run('wc', 'run');
      store.db
        .prepare('INSERT INTO continuation_operations VALUES(?,?,?,?,?)')
        .run(
          'op',
          task.id,
          'wc',
          'waiting_for_stop',
          JSON.stringify({ revision: 1, material: '原固定材料', stopRequested: true }),
        );
      const tables = [
        'tasks',
        'messages',
        'runs',
        'continuation_operations',
        'native_workspace_locks',
      ];
      const snapshot = () => tables.map((t) => store.db.prepare(`SELECT * FROM ${t}`).all());
      const before = snapshot();
      const preview = store.assistance.preview(task.id, message.id);
      const item = store.assistance.create(
        task.id,
        {
          sourceMessageId: message.id,
          expectedSourceHash: preview.sourceHash,
          expectedTaskRevision: 1,
          range: { start: 0, end: visible.length },
          recipientId: bob.id,
          question: '请分析',
          shareConfirmed: true,
        },
        'create',
      );
      as(bob, () =>
        store.assistance.reply(item.assistance.id, { expectedRevision: 1, body: '建议' }, 'reply'),
      );
      store.assistance.reply(
        item.assistance.id,
        { expectedRevision: 2, body: '再请看一下' },
        'follow',
      );
      store.assistance.change(
        item.assistance.id,
        { expectedRevision: 3, action: 'cancel' },
        'cancel',
      );
      assert.deepEqual(snapshot(), before);
    });
  } finally {
    store.close();
  }
});

test('协助/有限授权/事件/回执任一步故障全部回滚；回复故障不留下半条历史', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, alice, bob);
    for (const table of [
      'assistances',
      'assistance_grants',
      'assistance_events',
      'outbox',
      'idempotency_records',
    ]) {
      const tables = [
        'assistances',
        'assistance_grants',
        'assistance_events',
        'outbox',
        'idempotency_records',
      ];
      const counts = () =>
        tables.map(
          (t) => (f.store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
        );
      const before = counts(),
        key = randomUUID();
      f.store.db.exec(
        `CREATE TRIGGER fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      const failed = await f.call(`tasks/${s.task.id}/assistances`, alice, s.input, key);
      assert.equal(failed.statusCode, 500, table + failed.body);
      assert.deepEqual(counts(), before);
      f.store.db.exec('DROP TRIGGER fail');
      await create(f, alice, s.task.id, s.input, key);
    }
    const item = await create(f, alice, s.task.id, s.input),
      id = item.assistance.id;
    f.store.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON assistance_events BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    const failed = await f.call(
      `assistances/${id}/replies`,
      bob,
      { expectedRevision: 1, body: '不能半写' },
      'reply',
    );
    assert.equal(failed.statusCode, 500);
    assert.equal((await f.call(`assistances/${id}`, bob)).json().replies.length, 0);
    f.store.db.exec('DROP TRIGGER fail');
    assert.equal(
      (
        await f.call(
          `assistances/${id}/replies`,
          bob,
          { expectedRevision: 1, body: '不能半写' },
          'reply',
        )
      ).statusCode,
      201,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail BEFORE UPDATE ON assistance_grants BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      500,
    );
    assert.equal((await f.call(`assistances/${id}`, bob)).statusCode, 200);
    f.store.db.exec('DROP TRIGGER fail');
  } finally {
    await f.close();
  }
});

test('已结束/归档协作与稳定分页；SQLite 重开保留快照、回复和已撤销授权', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      s = await source(f, alice, bob);
    const a = await create(f, alice, s.task.id, s.input),
      id = a.assistance.id;
    for (let revision = 1; revision <= 4; revision++)
      assert.equal(
        (
          await f.call(`assistances/${id}/replies`, bob, {
            expectedRevision: revision,
            body: `回复 ${revision}`,
          })
        ).statusCode,
        201,
      );
    const page = (await f.call(`assistances/${id}?limit=2`, bob)).json();
    assert.deepEqual(
      page.replies.map((v: { revision: number }) => v.revision),
      [4, 5],
    );
    assert.equal(page.nextBefore, 4);
    const older = (await f.call(`assistances/${id}?limit=2&before=4`, bob)).json();
    assert.deepEqual(
      older.replies.map((v: { revision: number }) => v.revision),
      [2, 3],
    );
    assert.equal(older.nextBefore, null);
    const second = await create(f, alice, s.task.id, s.input);
    const list = (await f.call('assistances?limit=1', bob)).json();
    assert.equal(list.items[0].id, second.assistance.id);
    assert.equal(
      (await f.call(`assistances?limit=1&cursor=${list.nextCursor}`, bob)).json().items[0].id,
      id,
    );
    await f.call(`assistances/${second.assistance.id}/state`, alice, {
      action: 'cancel',
      expectedRevision: 1,
    });
    // A second connection exercises real on-disk migration/reopening without restarting auth.
    const reopened = new Store(f.dbPath, undefined, { team: true });
    try {
      reopened.as({ user: bob.user, spaceId: bob.spaceId }, () => {
        assert.equal(reopened.assistance.get(id).replies.length, 4);
        assert.equal(reopened.assistance.get(id).assistance.snapshot.text, visible);
        assert.throws(() => reopened.assistance.get(second.assistance.id), code('NOT_FOUND'));
      });
      assert.equal(
        reopened.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()!.version,
        21,
      );
    } finally {
      reopened.close();
    }
    f.store.db
      .prepare(
        "UPDATE projects SET body=json_set(body,'$.archivedAt','2026-09-27T00:00:00Z') WHERE id=?",
      )
      .run(s.project.id);
    const archived = await create(f, alice, s.task.id, s.input);
    assert.equal(
      (
        await f.call(`assistances/${archived.assistance.id}/replies`, bob, {
          body: '归档后仍可普通讨论',
          expectedRevision: 1,
        })
      ).statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});
