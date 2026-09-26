import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/db/src/store.js';
import { createApp } from '../apps/control/src/app.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import type { ContinuationOperation } from '../packages/contracts/src/continuation.js';
import type { Run } from '../packages/contracts/src/index.js';
import { teamFixture, ORIGIN, type Account } from './helpers/team.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('个人任务与无项目授权任务不通过直接 ID、列表、搜索和成果泄露', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      personal = { ...bob, spaceId: `personal-${bob.user.id}` };
    const privateTask = await f.task(bob, null, '私有关键词'),
      personalTask = await f.task(personal, null, '个人关键词');
    const project = await f.project(bob),
      projectTask = await f.task(bob, project.id, '隐藏项目关键词');
    const result = await f.call(`tasks/${privateTask.id}/results`, bob, {
      title: '私有成果',
      body: '不能泄露',
    });
    assert.equal(result.statusCode, 201, result.body);
    for (const task of [privateTask, personalTask, projectTask])
      for (const suffix of ['', '/messages', '/continuations', '/events']) {
        const r = await f.call(`tasks/${task.id}${suffix}`, alice);
        assert.equal(r.statusCode, 404, r.body);
      }
    assert.equal((await f.call(`results/${result.json().id}`, alice)).statusCode, 404);
    assert.equal((await f.call(`projects/${project.id}`, alice)).statusCode, 404);
    const work = (await f.call('workbench', alice)).json();
    assert.deepEqual(work.tasks, []);
    assert.deepEqual(work.projects, []);
    assert.deepEqual(work.results, []);
    assert.deepEqual(
      (await f.call('search?q=' + encodeURIComponent('关键词'), alice)).json().items,
      [],
    );
    assert.deepEqual((await f.call(`spaces/${alice.spaceId}/tasks`, alice)).json().items, []);
    assert.deepEqual((await f.call('results', alice)).json().items, []);
    // owner role does not grant either another member's personal work or their explicit project membership.
    assert.equal(work.space.role, 'owner');
  } finally {
    await f.close();
  }
});

test('项目只读可以查看任务，但编辑、讨论、状态、成果、管理和旧幂等写均受限制', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id);
    const rolePath = `projects/${project.id}/members/${bob.user.id}`;
    assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
    const writePath = `tasks/${task.id}/messages`,
      payload = { body: '之前的合法评论' },
      replayKey = 'before-downgrade';
    assert.equal((await f.call(writePath, bob, payload, replayKey)).statusCode, 201);
    await f.call(rolePath, alice, { role: 'view' });
    assert.equal((await f.call(`tasks/${task.id}`, bob)).statusCode, 200);
    assert.equal((await f.call(`projects/${project.id}`, bob)).json().access, 'view');
    assert.equal((await f.call(writePath, bob, payload, replayKey)).statusCode, 403);
    assert.equal(
      (
        await f.call(
          `tasks/${task.id}`,
          bob,
          { title: '越权编辑', expectedRevision: task.revision },
          randomUUID(),
          'PATCH',
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.call(`tasks/${task.id}/complete`, bob, { expectedRevision: task.revision }))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.call(`tasks/${task.id}/results`, bob, { title: '越权', body: '越权' })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.call(`spaces/${bob.spaceId}/tasks`, bob, {
          title: '越权新任务',
          projectId: project.id,
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.call(rolePath, bob, { role: 'manage' })).statusCode, 403);
    assert.equal(
      (await f.call(`spaces/${bob.spaceId}/invitations`, bob, { email: 'other@example.invalid' }))
        .statusCode,
      403,
    );
    const messages = (await f.call(writePath, bob)).json().items;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].actorName, bob.user.name);
  } finally {
    await f.close();
  }
});

test('项目可编辑成员可完成真实任务、讨论和成果，而不会自动完成或继承执行权限', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const task = await f.task(bob, project.id, '共同实现');
    assert.equal(task.ownerUserId, bob.user.id);
    const msg = await f.call(`tasks/${task.id}/messages`, alice, { body: '只讨论，不审批' });
    assert.equal(msg.statusCode, 201, msg.body);
    const result = await f.call(`tasks/${task.id}/results`, bob, {
      title: '第一版成果',
      body: '这里是内容',
    });
    assert.equal(result.statusCode, 201, result.body);
    assert.equal((await f.call(`results/${result.json().id}`, alice)).statusCode, 200);
    let current = (await f.call(`tasks/${task.id}`, alice)).json().task;
    assert.equal(current.status, 'todo');
    const completed = await f.call(`tasks/${task.id}/complete`, bob, {
      expectedRevision: current.revision,
    });
    assert.equal(completed.statusCode, 200, completed.body);
    current = completed.json();
    assert.equal(current.status, 'done');
    assert.equal(
      (
        await f.call(`tasks/${task.id}/reopen`, alice, { expectedRevision: current.revision })
      ).json().status,
      'todo',
    );
    const work = (await f.call('workbench', alice)).json();
    assert.equal(work.tasks[0].id, task.id);
    assert.equal(work.projects[0].memberIds.length, 2);
  } finally {
    await f.close();
  }
});

test('项目管理者与空间所有者不得移除最后管理者，成员退出不删除历史', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(bob),
      task = await f.task(bob, project.id);
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${alice.user.id}/remove`, alice, {}))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, bob, { role: 'view' }))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      409,
    );
    assert.equal(
      (await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'manage' }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.call(`spaces/${bob.spaceId}/members/${bob.user.id}/remove`, bob, {})).statusCode,
      200,
    );
    assert.equal((await f.call(`tasks/${task.id}`, bob)).statusCode, 403);
    assert.equal((await f.call(`tasks/${task.id}`, alice)).statusCode, 200);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS n FROM tasks WHERE id=?').get(task.id)!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test('空间与项目权限撤销后，直接 URL、搜索、写请求重放均不可继续访问', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id, '撤销关键词');
    const roles = `projects/${project.id}/members/${bob.user.id}`;
    await f.call(roles, alice, { role: 'edit' });
    const path = `tasks/${task.id}/messages`,
      body = { body: '已发的评论' };
    await f.call(path, bob, body, 'old-comment');
    await f.call(roles, alice, { role: null });
    assert.equal((await f.call(path, bob, body, 'old-comment')).statusCode, 404);
    assert.equal((await f.call(`tasks/${task.id}`, bob)).statusCode, 404);
    assert.deepEqual(
      (await f.call('search?q=' + encodeURIComponent('撤销关键词'), bob)).json().items,
      [],
    );
    await f.call(roles, alice, { role: 'view' });
    await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {});
    const r = await f.call('workbench', bob);
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, 'SPACE_ACCESS_REVOKED');
    assert.equal((await f.call(`spaces/${alice.spaceId}/projects`, bob)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('不同账号与空间使用相同幂等键，不混用结果、身份或范围', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      path = `spaces/${alice.spaceId}/tasks`,
      body = { title: '相同键的个人任务' };
    const [ra, rb] = await Promise.all([
      f.call(path, alice, body, 'same-key'),
      f.call(path, bob, body, 'same-key'),
    ]);
    assert.equal(ra.statusCode, 201, ra.body);
    assert.equal(rb.statusCode, 201, rb.body);
    assert.notEqual(ra.json().id, rb.json().id);
    assert.equal(ra.json().ownerUserId, alice.user.id);
    assert.equal(rb.json().ownerUserId, bob.user.id);
    const personal = { ...alice, spaceId: `personal-${alice.user.id}` };
    const rp = await f.call(`spaces/${personal.spaceId}/tasks`, personal, body, 'same-key');
    assert.equal(rp.statusCode, 201, rp.body);
    assert.notEqual(rp.json().id, ra.json().id);
    assert.equal((await f.call(`spaces/${alice.spaceId}/tasks`, personal)).statusCode, 404);
    const checks = await Promise.all(
      Array.from({ length: 12 }, (_, i) => f.call('workbench', i % 2 ? alice : bob)),
    );
    checks.forEach((r, i) => {
      assert.equal(r.json().user.id, i % 2 ? alice.user.id : bob.user.id);
      assert.equal(r.json().tasks.length, 1);
      assert.equal(r.json().tasks[0].id, i % 2 ? ra.json().id : rb.json().id);
    });
  } finally {
    await f.close();
  }
});

test('私有 Run 与 Operation 同样遵守父任务范围，操作取消也检查写权限', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    const at = new Date().toISOString(),
      copyId = randomUUID(),
      runId = randomUUID(),
      opId = randomUUID();
    // Persistence fixture only. Team routes never execute either a mock or real process.
    f.store.registerWorkingCopy({
      id: copyId,
      name: 'non-executing fixture',
      root: '/fictional/no-process',
      createdAt: at,
    });
    const run = {
      id: runId,
      taskId: task.id,
      provider: 'native',
      state: 'succeeded',
      requestedTool: 'codex',
    } as Run;
    f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(runId, task.id, JSON.stringify(run));
    const op = {
      id: opId,
      kind: 'continue',
      taskId: task.id,
      state: 'needs_attention',
      runId: null,
      revision: 1,
      input: {},
      workingCopyId: copyId,
    } as ContinuationOperation;
    f.store.db
      .prepare('INSERT INTO continuation_operations VALUES(?,?,?,?,?)')
      .run(opId, task.id, copyId, op.state, JSON.stringify(op));
    assert.equal((await f.call(`runs/${runId}`, bob)).statusCode, 200);
    assert.equal((await f.call(`operations/${opId}`, bob)).statusCode, 200);
    assert.equal(
      (await f.call(`operations/${opId}/cancel`, bob, { expectedRevision: 1 })).statusCode,
      403,
    );
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null });
    for (const path of [`runs/${runId}`, `runs/${runId}/native-events`, `operations/${opId}`])
      assert.equal((await f.call(path, bob)).statusCode, 404);
    assert.equal(
      f.store.as(
        { user: alice.user, spaceId: alice.spaceId },
        () => new ContinuationStore(f.store).get(opId).state,
      ),
      'needs_attention',
    );
  } finally {
    await f.close();
  }
});

test('团队模式拒绝宿主机目录、能力、密钥和模拟或原生执行入口', async () => {
  const f = await teamFixture();
  try {
    const alice = await f.setup(),
      task = await f.task(alice);
    for (const path of [
      'native',
      'native/workspaces/guess',
      'native/workspaces/guess/diff',
      `tasks/${task.id}/native-context`,
      `tasks/${task.id}/continuation-preview?sourceRunId=guess`,
    ]) {
      assert.equal((await f.call(path, alice)).statusCode, 422, path);
    }
    for (const provider of ['native', 'mock'])
      assert.equal((await f.call(`tasks/${task.id}/runs`, alice, { provider })).statusCode, 422);
    assert.equal((await f.call(`tasks/${task.id}/continuations`, alice, {})).statusCode, 422);
    await assert.rejects(
      createApp({ identity: f.options, native: { enabled: true, roots: ['/fictional'] } }),
      /宿主机/,
    );
    assert.throws(
      () =>
        f.store.as({ user: alice.user, spaceId: alice.spaceId }, () =>
          f.store.createRun(task.id, {} as never, 'guard'),
        ),
      /独立节点/,
    );
    assert.throws(
      () =>
        f.store.as({ user: alice.user, spaceId: alice.spaceId }, () =>
          f.store.createNativeRun(task.id, {} as never, {} as never, 'guard'),
        ),
      /独立节点/,
    );
  } finally {
    await f.close();
  }
});

async function stream(account: Account, url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { cookie: account.cookie, origin: ORIGIN },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let content = '';
  const readUntil = async (text: string) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const next = await Promise.race([
        reader.read(),
        wait(3000).then(() => {
          throw new Error('SSE fixture timeout');
        }),
      ]);
      if (next.done) break;
      content += new TextDecoder().decode(next.value);
      if (content.includes(text)) return content;
    }
    throw new Error('Stream did not include ' + text + ': ' + content);
  };
  return { readUntil, close: () => controller.abort() };
}

test('真实 HTTP 事件流不发送其他成员私有事件，项目撤权后不再发送该任务事件', async () => {
  const f = await teamFixture();
  let live: Awaited<ReturnType<typeof stream>> | undefined;
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    live = await stream(bob, `${address}/api/v1/events?spaceId=${bob.spaceId}`);
    await live.readUntil('event: ready');
    const hidden = await f.task(alice, null, '不能发送的私有事件'),
      visible = await f.task(alice, project.id, '可以发送的任务');
    const content = await live.readUntil(visible.id);
    assert.ok(!content.includes(hidden.id));
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null });
    const onlyAlice = await f.task(alice, project.id, '不再可见');
    const visiblePrivate = await f.task(bob, null, '自己仍然可见');
    const after = await live.readUntil(visiblePrivate.id);
    assert.ok(!after.includes(onlyAlice.id));
  } finally {
    live?.close();
    await f.close();
  }
});

for (const reason of ['membership', 'session'] as const)
  test(`事件流在${reason === 'session' ? '会话' : '空间成员'}撤销后结束，不能沿用旧连接`, async () => {
    const f = await teamFixture();
    let live: Awaited<ReturnType<typeof stream>> | undefined;
    try {
      const { alice, bob } = await f.pair();
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      live = await stream(bob, `${address}/api/v1/events?spaceId=${bob.spaceId}`);
      await live.readUntil('event: ready');
      if (reason === 'session') await f.call('identity/revoke-sessions', bob, {});
      else await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {});
      const content = await live.readUntil('event: access-ended');
      assert.match(
        content,
        new RegExp(reason === 'session' ? '"reason":"session"' : '"reason":"permission"'),
      );
    } finally {
      live?.close();
      await f.close();
    }
  });
