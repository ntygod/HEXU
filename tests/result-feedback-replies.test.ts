import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseResultFeedbackReply } from '../packages/contracts/src/result-feedback-replies.js';
import type { Message } from '../packages/contracts/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { teamFixture } from './helpers/team.js';
import { codeFeedbackFixture } from './helpers/code-feedback.js';
import { codeSnapshot } from './helpers/result-code.js';

const snapshots = (store: Store, tables: string[]) =>
  tables.map((table) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()));
const replyPath = (resultId: string, revisionId: string, messageId: string) =>
  `results/${resultId}/versions/${revisionId}/feedback/${messageId}/replies`;
async function replyFixture(body = '请解释此固定版本') {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice),
      task = await api.task(alice, project.id);
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() => api.store.createResult(task.id, '固定成果', '版本正文', randomUUID()));
    const version = as(() => new ResultRevisions(api.store).current(result));
    const source = as(() =>
      api.store.addMessage(task.id, body, result.id, randomUUID(), version.id),
    );
    return {
      api,
      alice,
      bob,
      project,
      task,
      result,
      version,
      source,
      as,
      path: replyPath(result.id, version.id, source.id),
      close: () => api.close(),
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

test('反馈回复严格只接受正文，不能覆盖目标、锚点、任务或作者', () => {
  assert.deepEqual(parseResultFeedbackReply({ body: '  回复\n' }), { body: '回复' });
  assert.equal(parseResultFeedbackReply({ body: 'a'.repeat(12000) }).body.length, 12000);
  for (const value of [
    null,
    [],
    {},
    { body: '' },
    { body: '  ' },
    { body: 1 },
    { body: 'a'.repeat(12001) },
  ])
    assert.throws(() => parseResultFeedbackReply(value), { code: 'INVALID_INPUT' });
  for (const name of [
    'taskId',
    'resultId',
    'resultRevisionId',
    'messageId',
    'replyTo',
    'codeAnchor',
    'actorName',
    'actorType',
    'createdByUserId',
    'bodyPreview',
    'bodyTruncated',
    'apply',
  ])
    assert.throws(() => parseResultFeedbackReply({ body: '回复', [name]: '伪造' }), {
      code: 'INVALID_INPUT',
    });
});

test('普通版本反馈的回复记录当前作者，保留未知旧作者，直接回复另一条回复', async () => {
  const f = await replyFixture();
  try {
    assert.equal(f.source.createdByUserId, undefined);
    assert.equal(f.source.replyTo, undefined);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const before = snapshots(f.api.store, ['tasks', 'runs', 'results', 'result_revisions']);
    const response = await f.api.call(f.path, f.bob, { body: '  这是说明  ' });
    assert.equal(response.statusCode, 201, response.body);
    const reply = response.json<Message>();
    assert.equal(reply.body, '这是说明');
    assert.equal(reply.taskId, f.task.id);
    assert.equal(reply.resultId, f.result.id);
    assert.equal(reply.resultRevisionId, f.version.id);
    assert.equal(reply.actorType, 'human');
    assert.equal(reply.actorName, f.bob.user.name);
    assert.equal(reply.createdByUserId, f.bob.user.id);
    assert.equal(reply.codeAnchor, undefined);
    assert.deepEqual(reply.replyTo, {
      messageId: f.source.id,
      actorName: f.source.actorName,
      bodyPreview: f.source.body,
      bodyTruncated: false,
    });
    const nested = await f.api.call(replyPath(f.result.id, f.version.id, reply.id), f.alice, {
      body: '谢谢，继续讨论这条说明',
    });
    assert.equal(nested.statusCode, 201, nested.body);
    assert.deepEqual(nested.json<Message>().replyTo, {
      messageId: reply.id,
      actorName: f.bob.user.name,
      createdByUserId: f.bob.user.id,
      bodyPreview: reply.body,
      bodyTruncated: false,
    });
    assert.equal(nested.json<Message>().createdByUserId, f.alice.user.id);
    assert.deepEqual(
      snapshots(f.api.store, ['tasks', 'runs', 'results', 'result_revisions']),
      before,
    );
    const detail = await f.api.call(`results/${f.result.id}/versions/${f.version.id}`, f.alice);
    assert.deepEqual(detail.json().messages, [f.source, reply, nested.json()]);
    assert.deepEqual(
      f.as(() => f.api.store.messages(f.task.id)),
      [f.source, reply, nested.json()],
    );
  } finally {
    await f.close();
  }
});

test('回复引用正文预览有界且不切断Unicode字符，历史名称和旧作者ID不重新推断', async () => {
  const f = await replyFixture();
  try {
    for (const [body, expected, truncated] of [
      ['a'.repeat(240), 'a'.repeat(240), false],
      ['a'.repeat(241), 'a'.repeat(240), true],
      ['a'.repeat(239) + '🙂尾部', 'a'.repeat(239), true],
      ['🙂'.repeat(120), '🙂'.repeat(120), false],
    ] as const) {
      const source = f.as(() =>
        f.api.store.addMessage(f.task.id, body, f.result.id, randomUUID(), f.version.id),
      );
      const r = await f.api.call(replyPath(f.result.id, f.version.id, source.id), f.alice, {
        body: '回复',
      });
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json<Message>().replyTo!.bodyPreview, expected);
      assert.equal(r.json<Message>().replyTo!.bodyTruncated, truncated);
      assert.equal(r.json<Message>().replyTo!.createdByUserId, undefined);
    }
    const old = { ...f.source, actorName: '历史记录姓名', createdByUserId: 'explicit-former-user' };
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify(old), old.id);
    const r = await f.api.call(f.path, f.alice, { body: '保留历史作者' });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json<Message>().replyTo!.actorName, old.actorName);
    assert.equal(r.json<Message>().replyTo!.createdByUserId, old.createdByUserId);
    assert.equal(r.json<Message>().createdByUserId, f.alice.user.id);
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify(f.source), old.id);
    assert.deepEqual(f.as(() => f.api.store.messages(f.task.id)).at(-1), r.json());
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.source, createdByUserId: null }), old.id);
    const unknownAuthor = await f.api.call(f.path, f.alice, { body: '未知旧作者' });
    assert.equal(unknownAuthor.statusCode, 201, unknownAuthor.body);
    assert.equal(unknownAuthor.json<Message>().replyTo!.createdByUserId, undefined);
  } finally {
    await f.close();
  }
});

test('HTTP拒绝伪造字段与缺少幂等键，拒绝后不写消息或回执', async () => {
  const f = await replyFixture();
  try {
    const before = snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']);
    for (const name of [
      'taskId',
      'resultId',
      'resultRevisionId',
      'messageId',
      'replyTo',
      'codeAnchor',
      'actorName',
      'actorType',
      'createdByUserId',
    ]) {
      const r = await f.api.call(f.path, f.alice, { body: '回复', [name]: f.source.id });
      assert.equal(r.statusCode, 400, r.body);
    }
    assert.equal((await f.api.call(f.path, f.alice, { body: '回复' }, '')).statusCode, 400);
    assert.deepEqual(snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']), before);
  } finally {
    await f.close();
  }
});

test('只能回复同一Task/Result/版本的真人反馈，普通聊天与未绑定版本及系统消息均拒绝', async () => {
  const f = await replyFixture();
  try {
    const otherTask = await f.api.task(f.alice, f.project.id);
    const otherResult = f.as(() =>
      f.api.store.createResult(f.task.id, '另一个成果', '正文', randomUUID()),
    );
    const otherVersion = f.as(() => new ResultRevisions(f.api.store).current(otherResult));
    const newerVersion = f.as(() =>
      f.api.store.atomic(() =>
        new ResultRevisions(f.api.store).append(
          { ...f.result, revision: f.result.revision + 1 },
          f.version.source,
        ),
      ),
    );
    const sources = [
      { ...f.source, resultRevisionId: undefined },
      { ...f.source, resultId: null, resultRevisionId: undefined },
      { ...f.source, actorType: 'system' },
      { ...f.source, actorType: 'agent' },
      { ...f.source, taskId: otherTask.id },
      { ...f.source, resultId: otherResult.id, resultRevisionId: otherVersion.id },
      { ...f.source, resultRevisionId: newerVersion.id },
    ];
    const invalidIds = ['nonexistent'];
    for (const source of sources) {
      const id = randomUUID();
      f.api.store.db
        .prepare('INSERT INTO messages VALUES(?,?,?)')
        .run(id, source.taskId, JSON.stringify({ ...source, id }));
      invalidIds.push(id);
    }
    // Verify the physical Task column and the stored Message Task are both enforced.
    const forgedId = randomUUID();
    f.api.store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(
        forgedId,
        f.task.id,
        JSON.stringify({ ...f.source, id: forgedId, taskId: otherTask.id }),
      );
    invalidIds.push(forgedId);
    const wrongColumnId = randomUUID();
    f.api.store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(wrongColumnId, otherTask.id, JSON.stringify({ ...f.source, id: wrongColumnId }));
    invalidIds.push(wrongColumnId);
    const before = snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']);
    for (const id of invalidIds) {
      const r = await f.api.call(replyPath(f.result.id, f.version.id, id), f.alice, {
        body: '回复',
      });
      assert.equal(r.statusCode, 404, r.body);
    }
    for (const [resultId, versionId] of [
      [otherResult.id, f.version.id],
      [f.result.id, newerVersion.id],
      [f.result.id, otherVersion.id],
    ]) {
      const r = await f.api.call(replyPath(resultId!, versionId!, f.source.id), f.alice, {
        body: '回复',
      });
      assert.equal(r.statusCode, 404, r.body);
    }
    assert.deepEqual(snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']), before);
  } finally {
    await f.close();
  }
});

test('相同键并发只保存一条回复，改正文409，重开数据库恢复原消息和快照', async () => {
  const f = await replyFixture();
  try {
    const key = randomUUID(),
      input = { body: '原回复' };
    const [a, b] = await Promise.all([
      f.api.call(f.path, f.alice, input, key),
      f.api.call(f.path, f.alice, input, key),
    ]);
    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 201, b.body);
    assert.deepEqual(a.json(), b.json());
    const changed = await f.api.call(f.path, f.alice, { body: '更改回复' }, key);
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const db = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const restored = db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        db.addFeedbackReply(f.result.id, f.version.id, f.source.id, input, key),
      );
      assert.deepEqual(restored, a.json());
      assert.deepEqual(
        db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => db.messages(f.task.id)),
        [f.source, restored],
      );
    } finally {
      db.close();
    }
    const nextKey = randomUUID();
    const different = await Promise.all(
      ['并发正文甲', '并发正文乙'].map((body) => f.api.call(f.path, f.alice, { body }, nextKey)),
    );
    assert.deepEqual(different.map((r) => r.statusCode).sort(), [201, 409]);
    const winner = different.find((r) => r.statusCode === 201)!.json<Message>();
    assert.deepEqual(
      (await f.api.call(f.path, f.alice, { body: winner.body }, nextKey)).json(),
      winner,
    );
    assert.equal(f.as(() => f.api.store.messages(f.task.id)).filter((m) => m.replyTo).length, 2);
  } finally {
    await f.close();
  }
});

test('当前编辑权限先于旧回执，降权、移除项目和未登录不能借回复扩大访问', async () => {
  const f = await replyFixture();
  try {
    const memberPath = `projects/${f.project.id}/members/${f.bob.user.id}`;
    const input = { body: '回复' },
      key = randomUUID();
    await f.api.call(memberPath, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.path, f.bob, input)).statusCode, 403);
    await f.api.call(memberPath, f.alice, { role: 'edit' });
    const response = await f.api.call(f.path, f.bob, input, key);
    assert.equal(response.statusCode, 201, response.body);
    await f.api.call(memberPath, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.path, f.bob, input, key)).statusCode, 403);
    assert.equal((await f.api.call(f.path, f.bob, { body: '不同正文' }, key)).statusCode, 403);
    await f.api.call(memberPath, f.alice, { role: null });
    assert.equal((await f.api.call(f.path, f.bob, input, key)).statusCode, 404);
    assert.equal(
      (await f.api.call(`results/${f.result.id}/versions/${f.version.id}`, f.bob)).statusCode,
      404,
    );
    assert.equal((await f.api.call(f.path, null, input, key)).statusCode, 401);
    assert.equal(f.as(() => f.api.store.messages(f.task.id)).filter((m) => m.replyTo).length, 1);
  } finally {
    await f.close();
  }
});

test('事务开始后再次核对当前编辑权限，新增和旧回执均不能跨越降权边界', async (t) => {
  const f = await replyFixture();
  try {
    const input = { body: '回复' },
      oldKey = randomUUID();
    const member = () =>
      f.api.store.db
        .prepare("UPDATE collab_project_members SET role='edit' WHERE project_id=? AND user_id=?")
        .run(f.project.id, f.bob.user.id);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(f.path, f.bob, input, oldKey)).statusCode, 201);
    const before = snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']);
    const original = f.api.store.mutate.bind(f.api.store);
    t.mock.method(
      f.api.store,
      'mutate',
      <T>(
        scope: string,
        key: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
      ): T => {
        f.api.store.db
          .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
          .run(f.project.id, f.bob.user.id);
        return original(scope, key, payload, action, beforeReplay);
      },
    );
    for (const key of [randomUUID(), oldKey]) {
      member();
      const r = await f.api.call(f.path, f.bob, input, key);
      assert.equal(r.statusCode, 403, r.body);
      assert.deepEqual(
        snapshots(f.api.store, ['messages', 'outbox', 'idempotency_records']),
        before,
      );
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('事务内再次核对消息来源，原反馈被换版后不能新增或重放旧回复', async (t) => {
  const f = await replyFixture();
  try {
    const input = { body: '回复' },
      oldKey = randomUUID();
    assert.equal((await f.api.call(f.path, f.alice, input, oldKey)).statusCode, 201);
    const before = snapshots(f.api.store, ['outbox', 'idempotency_records']);
    const original = f.api.store.mutate.bind(f.api.store);
    t.mock.method(
      f.api.store,
      'mutate',
      <T>(
        scope: string,
        key: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
      ): T => {
        f.api.store.db
          .prepare('UPDATE messages SET body=? WHERE id=?')
          .run(JSON.stringify({ ...f.source, resultRevisionId: 'other-version' }), f.source.id);
        return original(scope, key, payload, action, beforeReplay);
      },
    );
    for (const key of [randomUUID(), oldKey]) {
      f.api.store.db
        .prepare('UPDATE messages SET body=? WHERE id=?')
        .run(JSON.stringify(f.source), f.source.id);
      const r = await f.api.call(f.path, f.alice, input, key);
      assert.equal(r.statusCode, 404, r.body);
      assert.deepEqual(snapshots(f.api.store, ['outbox', 'idempotency_records']), before);
      assert.equal(f.as(() => f.api.store.messages(f.task.id)).filter((m) => m.replyTo).length, 1);
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('消息、outbox和回执任一步故障整体回滚，固定来源及执行状态不改变', async () => {
  const f = await replyFixture();
  try {
    const tables = [
      'messages',
      'outbox',
      'idempotency_records',
      'tasks',
      'runs',
      'results',
      'result_revisions',
    ];
    for (const table of ['messages', 'outbox', 'idempotency_records']) {
      const key = randomUUID(),
        before = snapshots(f.api.store, tables);
      f.api.store.db.exec(
        `CREATE TRIGGER fail_feedback_reply BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
      );
      const r = await f.api.call(f.path, f.alice, { body: '回复' }, key);
      assert.equal(r.statusCode, 500, r.body);
      f.api.store.db.exec('DROP TRIGGER fail_feedback_reply');
      assert.deepEqual(snapshots(f.api.store, tables), before);
      assert.equal((await f.api.call(f.path, f.alice, { body: '回复' }, key)).statusCode, 201);
    }
  } finally {
    await f.close();
  }
});

test('代码回复和再次回复继承原锚点，节点撤权与新版本不改变旧版本历史', async () => {
  const f = await codeFeedbackFixture();
  try {
    const initial = await f.api.call(f.feedbackPath, f.alice, f.input);
    assert.equal(initial.statusCode, 201, initial.body);
    const source = initial.json<Message>();
    const next = await f.save(await codeSnapshot([{ name: 'README.md', text: '新版本\n' }]));
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    const tables = [
      'tasks',
      'runs',
      'results',
      'work_branches',
      'work_branch_choices',
      'result_revisions',
      'result_code_differences',
      'runner_nodes',
    ];
    const before = snapshots(f.api.store, tables);
    const path = replyPath(f.saved.resultId, f.saved.revisionId, source.id);
    const r = await f.api.call(path, f.alice, { body: '说明旧版这些行' });
    assert.equal(r.statusCode, 201, r.body);
    const reply = r.json<Message>();
    assert.deepEqual(reply.codeAnchor, source.codeAnchor);
    assert.equal(reply.replyTo!.createdByUserId, f.alice.user.id);
    const nestedResponse = await f.api.call(
      replyPath(f.saved.resultId, f.saved.revisionId, reply.id),
      f.alice,
      { body: '继续回复这条说明' },
    );
    assert.equal(nestedResponse.statusCode, 201, nestedResponse.body);
    const nested = nestedResponse.json<Message>();
    assert.equal(nested.replyTo!.messageId, reply.id);
    assert.deepEqual(nested.codeAnchor, source.codeAnchor);
    assert.deepEqual(snapshots(f.api.store, tables), before);
    const older = await f.api.call(
      `results/${f.saved.resultId}/versions/${f.saved.revisionId}`,
      f.alice,
    );
    assert.deepEqual(older.json().messages, [source, reply, nested]);
    const current = await f.api.call(
      `results/${next.resultId}/versions/${next.revisionId}`,
      f.alice,
    );
    assert.deepEqual(current.json().messages, []);
    assert.equal(
      (
        await f.api.call(replyPath(next.resultId, next.revisionId, source.id), f.alice, {
          body: '错版回复',
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
