import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Message, Task } from '../packages/contracts/src/index.js';
import {
  parseResultFeedbackFollowUp,
  type ResultFeedbackFollowUpList,
  type ResultFeedbackFollowUpPreview,
} from '../packages/contracts/src/result-feedback-followups.js';
import { ResultFeedbackFollowUps } from '../packages/db/src/result-feedback-followups.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { ORIGIN, teamFixture } from './helpers/team.js';
import { codeFeedbackFixture } from './helpers/code-feedback.js';

const path = (resultId: string, revisionId: string, messageId: string) =>
  `results/${resultId}/versions/${revisionId}/feedback/${messageId}`;
const snapshots = (store: Store, tables: string[]) =>
  tables.map((table) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()));
const writeTables = ['tasks', 'metadata', 'outbox', 'idempotency_records'];
const input = { title: '处理这条反馈', description: '由人编辑的独立要求' };
async function fixture(privateTask = false, body = '固定版本的原始反馈', legacy = false) {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, privateTask ? null : project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() => api.store.createResult(task.id, '固定成果', '成果正文', randomUUID()));
    const version = as(() =>
      legacy
        ? api.store.atomic(() =>
            new ResultRevisions(api.store).append(
              { ...result, revision: 2 },
              { kind: 'legacy' },
              '',
              true,
            ),
          )
        : new ResultRevisions(api.store).current(result),
    );
    const feedback = as(() =>
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
      feedback,
      as,
      path: path(result.id, version.id, feedback.id),
      close: () => api.close(),
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

test('后续任务请求只接受标题和独立说明，复用160/12000字符规则并允许空说明', () => {
  assert.deepEqual(parseResultFeedbackFollowUp({ title: '  标题  ' }), {
    title: '标题',
    description: '',
  });
  assert.deepEqual(parseResultFeedbackFollowUp({ title: '标题', description: '   ' }), {
    title: '标题',
    description: '',
  });
  assert.deepEqual(
    parseResultFeedbackFollowUp({ title: 'a'.repeat(160), description: 'b'.repeat(12000) }),
    { title: 'a'.repeat(160), description: 'b'.repeat(12000) },
  );
  for (const value of [
    null,
    [],
    {},
    { title: '' },
    { title: '  ' },
    { title: 1 },
    { title: 'a'.repeat(161) },
    { title: '标题', description: null },
    { title: '标题', description: 1 },
    { title: '标题', description: 'a'.repeat(12001) },
  ])
    assert.throws(() => parseResultFeedbackFollowUp(value), { code: 'INVALID_INPUT' });
  for (const field of [
    'body',
    'taskId',
    'projectId',
    'spaceId',
    'visibility',
    'ownerUserId',
    'createdByUserId',
    'feedbackOrigin',
    'source',
    'resultId',
    'resultRevisionId',
    'messageId',
    'authorId',
    'codeAnchor',
    'status',
    'runId',
    'branchId',
    'execute',
  ])
    assert.throws(() => parseResultFeedbackFollowUp({ ...input, [field]: 'spoof' }), {
      code: 'INVALID_INPUT',
    });
});

test('HTTP多字节与JSON转义的最大说明可创建，超字符或请求字节预算仍拒绝且不写入', async () => {
  const f = await fixture();
  try {
    const title = '题'.repeat(160),
      description = '中'.repeat(12000);
    const response = await f.api.call(f.path + '/follow-ups', f.alice, { title, description });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json<Task>().description, description);
    const escaped = JSON.stringify({ title, description }).replace(
      /[题中]/g,
      (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    const escapedResponse = await f.api.app.inject({
      method: 'POST',
      url: '/api/v1/' + f.path + '/follow-ups',
      headers: {
        cookie: f.alice.cookie,
        'x-hexu-space': f.alice.spaceId,
        origin: ORIGIN,
        'x-hexu-client': 'web',
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      payload: escaped,
    });
    assert.equal(escapedResponse.statusCode, 201, escapedResponse.body);
    assert.equal(escapedResponse.json<Task>().description, description);
    const before = snapshots(f.api.store, writeTables);
    const tooMany = await f.api.call(f.path + '/follow-ups', f.alice, {
      title,
      description: description + '中',
    });
    assert.equal(tooMany.statusCode, 400, tooMany.body);
    const tooLarge = await f.api.call(f.path + '/follow-ups', f.alice, {
      title,
      description: '中'.repeat(40000),
    });
    assert.equal(tooLarge.statusCode, 413, tooLarge.body);
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
  } finally {
    await f.close();
  }
});

test('预览/关闭不写入；提交在原项目创建现有Task，负责人和创建者是当前操作者', async () => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const before = snapshots(f.api.store, writeTables);
    const preview = await f.api.call(f.path + '/follow-up-preview', f.bob);
    assert.equal(preview.statusCode, 200, preview.body);
    const source = preview.json<ResultFeedbackFollowUpPreview>();
    assert(source.available);
    assert.deepEqual(source.target, {
      spaceId: f.task.spaceId,
      projectId: f.project.id,
      projectName: f.project.name,
      visibility: 'project',
      ownerUserId: f.bob.user.id,
      ownerName: f.bob.user.name,
    });
    assert.deepEqual(source.origin, {
      version: 1,
      kind: 'result_feedback',
      sourceTaskId: f.task.id,
      sourceTaskShortId: f.task.shortId,
      sourceTaskTitle: f.task.title,
      resultId: f.result.id,
      resultRevisionId: f.version.id,
      resultRevision: f.version.revision,
      resultTitle: f.version.title,
      messageId: f.feedback.id,
      authorName: f.feedback.actorName,
      body: f.feedback.body,
      bodyHash: createHash('sha256').update(f.feedback.body).digest('hex'),
    });
    assert.deepEqual((await f.api.call(f.path + '/follow-ups', f.bob)).json(), {
      items: [],
      truncated: false,
    });
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    const unchanged = [
      'messages',
      'runs',
      'results',
      'result_revisions',
      'runner_nodes',
      'node_dispatches',
      'work_branches',
      'work_branch_groups',
      'task_next_inputs',
      'continuation_operations',
      'node_continuation_operations',
      'collab_project_members',
    ];
    const original = snapshots(f.api.store, unchanged);
    const r = await f.api.call(f.path + '/follow-ups', f.bob, input);
    assert.equal(r.statusCode, 201, r.body);
    const task = r.json<Task>();
    assert.notEqual(task.id, f.task.id);
    assert.notEqual(task.shortId, f.task.shortId);
    assert.equal(task.projectId, f.task.projectId);
    assert.equal(task.spaceId, f.task.spaceId);
    assert.equal(task.visibility, 'project');
    assert.equal(task.ownerUserId, f.bob.user.id);
    assert.equal(task.createdByUserId, f.bob.user.id);
    assert.equal(task.status, 'todo');
    assert.equal(task.title, input.title);
    assert.equal(task.description, input.description);
    assert.equal(task.revision, 1);
    assert.equal(task.attention, null);
    assert.deepEqual(task.feedbackOrigin, source.origin);
    assert.deepEqual(
      f.as(() => f.api.store.getTask(f.task.id)),
      f.task,
    );
    assert.deepEqual(snapshots(f.api.store, unchanged), original);
    assert.deepEqual((await f.api.call(`tasks/${task.id}`, f.alice)).json().task, {
      ...task,
      participantUserIds: [],
    });
    const events = f.api.store.db
      .prepare('SELECT task_id,kind FROM outbox WHERE task_id=?')
      .all(task.id);
    assert.deepEqual(
      events.map((event) => ({ ...event })),
      [{ task_id: task.id, kind: 'task.created' }],
    );
    assert.deepEqual((await f.api.call(f.path + '/follow-ups', f.alice)).json(), {
      items: [
        {
          id: task.id,
          shortId: task.shortId,
          title: task.title,
          status: task.status,
          ownerUserId: task.ownerUserId,
          createdAt: task.createdAt,
        },
      ],
      truncated: false,
    });
  } finally {
    await f.close();
  }
});

test('私有来源保持原空间及私有范围，空间所有者或项目成员不能读取别人的私有来源', async () => {
  const f = await fixture(true);
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const preview = (await f.api.call(f.path + '/follow-up-preview', f.alice)).json();
    assert.equal(preview.target.projectId, null);
    assert.equal(preview.target.projectName, null);
    assert.equal(preview.target.visibility, 'private');
    const r = await f.api.call(f.path + '/follow-ups', f.alice, input);
    assert.equal(r.statusCode, 201, r.body);
    const task = r.json<Task>();
    assert.equal(task.projectId, null);
    assert.equal(task.spaceId, f.alice.spaceId);
    assert.equal(task.visibility, 'private');
    assert.equal(task.ownerUserId, f.alice.user.id);
    for (const url of [f.path + '/follow-up-preview', f.path + '/follow-ups', `tasks/${task.id}`])
      assert.equal((await f.api.call(url, f.bob)).statusCode, 404);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.bob, input)).statusCode, 404);
    const bobsTask = await f.api.task(f.bob, null);
    const bobAs = <T>(action: () => T) =>
      f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, action);
    const result = bobAs(() =>
      f.api.store.createResult(bobsTask.id, '私有成果', '正文', randomUUID()),
    );
    const version = bobAs(() => new ResultRevisions(f.api.store).current(result));
    const feedback = bobAs(() =>
      f.api.store.addMessage(bobsTask.id, '私有反馈', result.id, randomUUID(), version.id),
    );
    assert.equal(
      (await f.api.call(path(result.id, version.id, feedback.id) + '/follow-ups', f.alice))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('HTTP拒绝范围/来源伪造和缺少幂等键，普通Task写入不能覆盖feedbackOrigin', async () => {
  const f = await fixture();
  try {
    const before = snapshots(f.api.store, writeTables);
    for (const field of [
      'projectId',
      'spaceId',
      'visibility',
      'ownerUserId',
      'createdByUserId',
      'feedbackOrigin',
      'resultRevisionId',
      'messageId',
      'codeAnchor',
      'status',
    ]) {
      const r = await f.api.call(f.path + '/follow-ups', f.alice, { ...input, [field]: 'spoof' });
      assert.equal(r.statusCode, 400, r.body);
    }
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input, '')).statusCode, 400);
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    const task = (await f.api.call(f.path + '/follow-ups', f.alice, input)).json<Task>();
    for (const feedbackOrigin of [null, { sourceTaskId: 'spoof' }]) {
      const r = await f.api.call(
        `tasks/${task.id}`,
        f.alice,
        { expectedRevision: 1, feedbackOrigin },
        randomUUID(),
        'PATCH',
      );
      assert.equal(r.statusCode, 400, r.body);
    }
    assert.equal(
      (
        await f.api.call(`spaces/${f.alice.spaceId}/tasks`, f.alice, {
          ...input,
          feedbackOrigin: task.feedbackOrigin,
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(
      f.as(() => f.api.store.getTask(task.id)),
      task,
    );
  } finally {
    await f.close();
  }
});

test('仅同Task/Result/固定版本的真人反馈有效，拒绝系统、普通聊天、无版本和错列来源', async () => {
  const f = await fixture();
  try {
    const otherTask = await f.api.task(f.alice, f.project.id);
    const otherResult = f.as(() =>
      f.api.store.createResult(f.task.id, '其他成果', '正文', randomUUID()),
    );
    const otherVersion = f.as(() => new ResultRevisions(f.api.store).current(otherResult));
    const newer = f.as(() =>
      f.api.store.atomic(() =>
        new ResultRevisions(f.api.store).append({ ...f.result, revision: 2 }, f.version.source),
      ),
    );
    const invalidIds = ['missing-message'];
    for (const source of [
      { ...f.feedback, resultRevisionId: undefined },
      { ...f.feedback, resultId: null, resultRevisionId: undefined },
      { ...f.feedback, actorType: 'system' },
      { ...f.feedback, actorType: 'agent' },
      { ...f.feedback, taskId: otherTask.id },
      { ...f.feedback, resultId: otherResult.id, resultRevisionId: otherVersion.id },
      { ...f.feedback, resultRevisionId: newer.id },
    ]) {
      const id = randomUUID();
      f.api.store.db
        .prepare('INSERT INTO messages VALUES(?,?,?)')
        .run(id, source.taskId, JSON.stringify({ ...source, id }));
      invalidIds.push(id);
    }
    for (const [columnTask, bodyTask] of [
      [f.task.id, otherTask.id],
      [otherTask.id, f.task.id],
    ]) {
      const id = randomUUID();
      f.api.store.db
        .prepare('INSERT INTO messages VALUES(?,?,?)')
        .run(id, columnTask!, JSON.stringify({ ...f.feedback, id, taskId: bodyTask }));
      invalidIds.push(id);
    }
    const urls = invalidIds.map((id) => path(f.result.id, f.version.id, id));
    urls.push(
      path(otherResult.id, f.version.id, f.feedback.id),
      path(f.result.id, otherVersion.id, f.feedback.id),
      path(f.result.id, newer.id, f.feedback.id),
    );
    const before = snapshots(f.api.store, writeTables);
    for (const url of urls) {
      for (const suffix of ['/follow-up-preview', '/follow-ups'])
        assert.equal((await f.api.call(url + suffix, f.alice)).statusCode, 404);
      assert.equal((await f.api.call(url + '/follow-ups', f.alice, input)).statusCode, 404);
    }
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
  } finally {
    await f.close();
  }
});

test('member与legacy固定版本可作为来源，旧作者不猜测且原文预算12000字符', async () => {
  const f = await fixture(false, '🙂'.repeat(6000), true);
  try {
    assert.equal(f.version.source.kind, 'legacy');
    assert.equal(f.version.createdBy, null);
    const r = await f.api.call(f.path + '/follow-ups', f.alice, input);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json<Task>().feedbackOrigin!.authorId, undefined);
    assert.equal(r.json<Task>().feedbackOrigin!.body, f.feedback.body);
    for (const authorId of ['known-former-author', null, '']) {
      const message = { ...f.feedback, actorName: '已记录的历史名字', createdByUserId: authorId };
      f.api.store.db
        .prepare('UPDATE messages SET body=? WHERE id=?')
        .run(JSON.stringify(message), message.id);
      const response = await f.api.call(f.path + '/follow-ups', f.alice, input);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json<Task>().feedbackOrigin!.authorName, message.actorName);
      assert.equal(response.json<Task>().feedbackOrigin!.authorId, authorId || undefined);
    }
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.feedback, body: 'a'.repeat(12001) }), f.feedback.id);
    const before = snapshots(f.api.store, writeTables);
    const unavailable = await f.api.call(f.path + '/follow-up-preview', f.alice);
    assert.equal(unavailable.statusCode, 200);
    assert.equal(unavailable.json().available, false);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input)).statusCode, 422);
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    // Over-budget legacy text does not hide an already-established relation.
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice)).json().items.length, 4);
  } finally {
    await f.close();
  }
});

test('真人回复采用该回复原文及明确作者，复制旧版代码锚点但不查询节点/目录/代码', async () => {
  const f = await codeFeedbackFixture();
  try {
    const original = (await f.api.call(f.feedbackPath, f.alice, f.input)).json<Message>();
    const reply = (
      await f.api.call(
        path(f.saved.resultId, f.saved.revisionId, original.id) + '/replies',
        f.alice,
        { body: '来自选中回复的要求' },
      )
    ).json<Message>();
    const newer = await f.save();
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    const unchanged = [
      'messages',
      'runs',
      'node_dispatches',
      'runner_nodes',
      'work_branches',
      'work_branch_choices',
      'work_branch_workspaces',
      'result_revisions',
      'result_code_differences',
      'task_next_inputs',
      'continuation_operations',
      'node_continuation_operations',
    ];
    const before = snapshots(f.api.store, unchanged);
    const url = path(f.saved.resultId, f.saved.revisionId, reply.id);
    const response = await f.api.call(url + '/follow-ups', f.alice, input);
    assert.equal(response.statusCode, 201, response.body);
    const task = response.json<Task>();
    assert.equal(task.feedbackOrigin!.messageId, reply.id);
    assert.equal(task.feedbackOrigin!.body, reply.body);
    assert.equal(task.feedbackOrigin!.authorId, f.alice.user.id);
    assert.equal(task.feedbackOrigin!.resultRevisionId, f.saved.revisionId);
    assert.deepEqual(task.feedbackOrigin!.codeAnchor, original.codeAnchor);
    assert.deepEqual(snapshots(f.api.store, unchanged), before);
    assert.equal(
      (
        await f.api.call(
          path(newer.resultId, newer.revisionId, reply.id) + '/follow-ups',
          f.alice,
          input,
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('并发同键只建一Task，改标题/说明409；重新打开数据库及普通编辑/改派/状态保留来源', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const responses = await Promise.all([
      f.api.call(f.path + '/follow-ups', f.alice, input, key),
      f.api.call(f.path + '/follow-ups', f.alice, input, key),
    ]);
    responses.forEach((r) => assert.equal(r.statusCode, 201, r.body));
    assert.deepEqual(responses[0]!.json(), responses[1]!.json());
    const task = responses[0]!.json<Task>();
    for (const change of [{ title: '不同标题' }, { description: '不同说明' }])
      assert.equal(
        (await f.api.call(f.path + '/follow-ups', f.alice, { ...input, ...change }, key))
          .statusCode,
        409,
      );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const edited = await f.api.call(
      `tasks/${task.id}`,
      f.alice,
      { expectedRevision: 1, title: '现任务标题', description: '现任务说明' },
      randomUUID(),
      'PATCH',
    );
    assert.equal(edited.statusCode, 200, edited.body);
    const assigned = await f.api.call(`tasks/${task.id}/assignment`, f.alice, {
      expectedRevision: 2,
      ownerUserId: f.bob.user.id,
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    const completed = await f.api.call(`tasks/${task.id}/complete`, f.alice, {
      expectedRevision: 3,
      activeRunAction: 'keep',
    });
    assert.equal(completed.statusCode, 200, completed.body);
    const current = f.as(() => f.api.store.getTask(task.id));
    assert.equal(current.status, 'done');
    assert.equal(current.ownerUserId, f.bob.user.id);
    assert.equal(current.createdByUserId, f.alice.user.id);
    assert.deepEqual(current.feedbackOrigin, task.feedbackOrigin);
    f.as(() =>
      f.api.store.patchTask(
        f.task.id,
        { expectedRevision: f.task.revision, title: '来源任务后来改名' },
        randomUUID(),
      ),
    );
    const beforeReplay = snapshots(f.api.store, writeTables);
    assert.deepEqual(
      (await f.api.call(f.path + '/follow-ups', f.alice, input, key)).json(),
      current,
    );
    assert.deepEqual(snapshots(f.api.store, writeTables), beforeReplay);
    const db = new Store(f.api.dbPath, undefined, { team: true });
    try {
      db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        assert.deepEqual(db.getTask(task.id), current);
        assert.deepEqual(
          new ResultFeedbackFollowUps(db).create(
            f.result.id,
            f.version.id,
            f.feedback.id,
            input,
            key,
          ),
          current,
        );
        assert.equal(
          new ResultFeedbackFollowUps(db).list(f.result.id, f.version.id, f.feedback.id).items[0]!
            .title,
          current.title,
        );
      });
    } finally {
      db.close();
    }
    const otherKey = randomUUID();
    const different = await Promise.all(
      ['并发甲', '并发乙'].map((title) =>
        f.api.call(f.path + '/follow-ups', f.alice, { ...input, title }, otherKey),
      ),
    );
    assert.deepEqual(different.map((r) => r.statusCode).sort(), [201, 409]);
    const winner = different.find((r) => r.statusCode === 201)!.json<Task>();
    assert.deepEqual(
      (
        await f.api.call(
          f.path + '/follow-ups',
          f.alice,
          { ...input, title: winner.title },
          otherKey,
        )
      ).json(),
      winner,
    );
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice)).json().items.length, 2);
  } finally {
    await f.close();
  }
});

test('只读成员可列相关任务；预览/提交/旧回执需要当前编辑权，项目/空间撤权与跨空间均拒绝', async () => {
  const f = await fixture();
  try {
    const memberPath = `projects/${f.project.id}/members/${f.bob.user.id}`;
    await f.api.call(memberPath, f.alice, { role: 'edit' });
    const key = randomUUID();
    const task = (await f.api.call(f.path + '/follow-ups', f.bob, input, key)).json<Task>();
    await f.api.call(memberPath, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.path + '/follow-up-preview', f.bob)).statusCode, 403);
    for (const k of [key, randomUUID()])
      assert.equal((await f.api.call(f.path + '/follow-ups', f.bob, input, k)).statusCode, 403);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.bob)).json().items[0].id, task.id);
    await f.api.call(memberPath, f.alice, { role: null });
    for (const suffix of ['/follow-up-preview', '/follow-ups']) {
      assert.equal((await f.api.call(f.path + suffix, f.bob)).statusCode, 404);
      assert.equal((await f.api.call(f.path + suffix, null)).statusCode, 401);
      assert.equal(
        (await f.api.call(f.path + suffix, { ...f.alice, spaceId: `personal-${f.alice.user.id}` }))
          .statusCode,
        404,
      );
    }
    assert.equal((await f.api.call(f.path + '/follow-ups', f.bob, input, key)).statusCode, 404);
    await f.api.call(memberPath, f.alice, { role: 'edit' });
    f.api.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(f.bob.spaceId, f.bob.user.id);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.bob, input, key)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('事务内重新核对来源编辑权和固定版本，不能借旧回执绕过', async (t) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const key = randomUUID();
    assert.equal((await f.api.call(f.path + '/follow-ups', f.bob, input, key)).statusCode, 201);
    const original = f.api.store.mutate.bind(f.api.store);
    for (const failure of ['permission', 'version'] as const) {
      t.mock.method(
        f.api.store,
        'mutate',
        <T>(
          scope: string,
          k: string,
          payload: unknown,
          action: () => T,
          beforeReplay?: () => void,
          onReplay?: (result: T) => T,
        ): T =>
          original(
            scope,
            k,
            payload,
            action,
            () => {
              if (failure === 'permission')
                f.api.store.db
                  .prepare(
                    "UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?",
                  )
                  .run(f.project.id, f.bob.user.id);
              else
                f.api.store.db
                  .prepare('UPDATE messages SET body=? WHERE id=?')
                  .run(
                    JSON.stringify({ ...f.feedback, resultRevisionId: 'wrong-version' }),
                    f.feedback.id,
                  );
              beforeReplay?.();
            },
            onReplay,
          ),
      );
      const before = snapshots(f.api.store, [...writeTables, 'messages', 'collab_project_members']);
      for (const k of [key, randomUUID()]) {
        const r = await f.api.call(f.path + '/follow-ups', f.bob, input, k);
        assert.equal(r.statusCode, failure === 'permission' ? 403 : 404, r.body);
        assert.deepEqual(
          snapshots(f.api.store, [...writeTables, 'messages', 'collab_project_members']),
          before,
        );
      }
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('旧回执在事务内检查目标Task当前可见性，失去目标访问或目标缺失时不泄漏/重建', async (t) => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const task = (await f.api.call(f.path + '/follow-ups', f.alice, input, key)).json<Task>();
    const hidden = { ...task, visibility: 'private', projectId: null, ownerUserId: f.bob.user.id };
    const original = f.api.store.mutate.bind(f.api.store);
    t.mock.method(
      f.api.store,
      'mutate',
      <T>(
        scope: string,
        k: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
        onReplay?: (result: T) => T,
      ): T =>
        original(
          scope,
          k,
          payload,
          action,
          () => {
            beforeReplay?.();
            f.api.store.db
              .prepare('UPDATE tasks SET project_id=NULL,body=? WHERE id=?')
              .run(JSON.stringify(hidden), task.id);
          },
          onReplay,
        ),
    );
    const before = snapshots(f.api.store, writeTables);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input, key)).statusCode, 404);
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    t.mock.restoreAll();
    f.api.store.db
      .prepare('UPDATE tasks SET project_id=NULL,body=? WHERE id=?')
      .run(JSON.stringify(hidden), task.id);
    assert.deepEqual((await f.api.call(f.path + '/follow-ups', f.alice)).json(), {
      items: [],
      truncated: false,
    });
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input, key)).statusCode, 404);
    f.api.store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    const missing = snapshots(f.api.store, writeTables);
    assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input, key)).statusCode, 404);
    assert.deepEqual(snapshots(f.api.store, writeTables), missing);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('计数器、Task及来源、outbox和回执任一步失败均完整回滚，原键可安全重试', async () => {
  const f = await fixture();
  try {
    for (const point of ['metadata', 'tasks', 'outbox', 'idempotency_records']) {
      const before = snapshots(f.api.store, writeTables);
      const key = randomUUID();
      f.api.store.db.exec(
        `CREATE TRIGGER fail_follow_up BEFORE ${point === 'metadata' ? 'UPDATE' : 'INSERT'} ON ${point}
        BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
      );
      assert.equal((await f.api.call(f.path + '/follow-ups', f.alice, input, key)).statusCode, 500);
      f.api.store.db.exec('DROP TRIGGER fail_follow_up');
      assert.deepEqual(snapshots(f.api.store, writeTables), before);
      const counter = Number(
        f.api.store.db.prepare("SELECT value FROM metadata WHERE key='task_counter'").get()!.value,
      );
      const retry = await f.api.call(f.path + '/follow-ups', f.alice, input, key);
      assert.equal(retry.statusCode, 201, retry.body);
      assert.equal(retry.json<Task>().shortId, `HX-${String(counter + 1).padStart(3, '0')}`);
      assert.equal(retry.json<Task>().feedbackOrigin!.messageId, f.feedback.id);
    }
  } finally {
    await f.close();
  }
});

test('相关列表返回最多50个可访问的当前Task摘要，隐藏目标不计入截断或泄漏正文', async () => {
  const f = await fixture();
  try {
    const created = f.as(() => {
      const service = new ResultFeedbackFollowUps(f.api.store);
      return Array.from({ length: 52 }, (_, i) =>
        service.create(
          f.result.id,
          f.version.id,
          f.feedback.id,
          { ...input, title: `后续${i}` },
          `bounded-${i}`,
        ),
      );
    });
    const r = await f.api.call(f.path + '/follow-ups', f.alice);
    const list = r.json<ResultFeedbackFollowUpList>();
    assert.equal(list.items.length, 50);
    assert.equal(list.truncated, true);
    assert.equal(list.items[0]!.id, created[51]!.id);
    assert.equal(list.items[49]!.id, created[2]!.id);
    assert(!r.body.includes(f.feedback.body));
    for (const task of created.slice(-2))
      f.api.store.db.prepare('UPDATE tasks SET project_id=NULL,body=? WHERE id=?').run(
        JSON.stringify({
          ...task,
          projectId: null,
          visibility: 'private',
          ownerUserId: f.bob.user.id,
        }),
        task.id,
      );
    const visible = (
      await f.api.call(f.path + '/follow-ups', f.alice)
    ).json<ResultFeedbackFollowUpList>();
    assert.equal(visible.items.length, 50);
    assert.equal(visible.truncated, false);
    assert.equal(visible.items[0]!.id, created[49]!.id);
    assert.equal(visible.items[49]!.id, created[0]!.id);
  } finally {
    await f.close();
  }
});

test('项目归档仍允许明确建立人工作业任务，不恢复执行或改变来源Task状态', async () => {
  const f = await fixture();
  try {
    f.as(() =>
      f.api.store.projectLifecycle.change(
        f.project.id,
        { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
        randomUUID(),
      ),
    );
    const originalTask = f.as(() => f.api.store.getTask(f.task.id));
    const before = snapshots(f.api.store, [
      'runs',
      'node_dispatches',
      'continuation_operations',
      'node_continuation_operations',
    ]);
    const r = await f.api.call(f.path + '/follow-ups', f.alice, input);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json<Task>().status, 'todo');
    assert.equal(r.json<Task>().projectId, f.project.id);
    assert(f.as(() => f.api.store.project(f.project.id)).archivedAt);
    assert.deepEqual(
      f.as(() => f.api.store.getTask(f.task.id)),
      originalTask,
    );
    assert.deepEqual(
      snapshots(f.api.store, [
        'runs',
        'node_dispatches',
        'continuation_operations',
        'node_continuation_operations',
      ]),
      before,
    );
  } finally {
    await f.close();
  }
});

test('普通createTask仍按原计数/默认值/幂等行为创建，不自动携带反馈来源', () => {
  const store = new Store();
  try {
    const data = { title: '普通任务', description: '', projectId: null };
    const task = store.createTask(data, 'ordinary-create');
    assert.equal(task.ownerUserId, store.actorId);
    assert.equal(task.createdByUserId, store.actorId);
    assert.equal(task.status, 'todo');
    assert.equal(task.visibility, 'private');
    assert.equal(task.feedbackOrigin, undefined);
    assert.deepEqual(store.createTask(data, 'ordinary-create'), task);
    assert.equal(store.tasks().filter((t) => t.id === task.id).length, 1);
  } finally {
    store.close();
  }
});
