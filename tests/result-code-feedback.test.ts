import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseResultCodeFeedback } from '../packages/contracts/src/result-code-feedback.js';
import { codeFeedbackFixture } from './helpers/code-feedback.js';
import { codeSnapshot } from './helpers/result-code.js';
import { Store } from '../packages/db/src/store.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { countTextLines } from '../packages/domain/src/line-difference.js';
const snapshots = (f: Awaited<ReturnType<typeof codeFeedbackFixture>>, tables: string[]) =>
  tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
test('代码反馈严格固定文件/侧/对象与完整范围，不接受调用者身份或来源覆盖', () => {
  const input = {
    body: '反馈',
    path: 'nested/file.txt',
    side: 'after',
    objectId: 'a'.repeat(40),
    range: { start: 1, end: 3 },
  };
  assert.deepEqual(parseResultCodeFeedback(input), input);
  for (const change of [
    { side: 'latest' },
    { objectId: 'short' },
    { range: undefined },
    { range: { start: 0, end: 1 } },
    { range: { start: 3, end: 2 } },
    { range: { start: 1, end: 2, force: true } },
    { path: '../private' },
    { path: 'a\\b' },
    { path: 'a\u202eb' },
    { range: { start: 1.2, end: 3 } },
    { taskId: randomUUID() },
    { actorName: 'other' },
    { createdByUserId: 'other' },
    { differenceHash: 'b'.repeat(64) },
    { apply: true },
  ])
    assert.throws(() => parseResultCodeFeedback({ ...input, ...change }));
  assert.equal(countTextLines(''), 0);
  assert.equal(countTextLines('one\r\ntwo\rthree\n'), 3);
  assert.equal(countTextLines('one\n\nlast'), 3);
});
test('反馈保存原版本/文件/blob/报告锚点，后来新版本不改变原反馈或任务执行', async () => {
  const f = await codeFeedbackFixture();
  try {
    const unchanged = [
      'tasks',
      'runs',
      'work_branches',
      'work_branch_choices',
      'result_revisions',
      'result_code_differences',
    ];
    const before = snapshots(f, unchanged);
    const r = await f.api.call(f.feedbackPath, f.alice, f.input);
    assert.equal(r.statusCode, 201, r.body);
    const m = r.json();
    assert.equal(m.taskId, f.task.id);
    assert.equal(m.resultId, f.saved.resultId);
    assert.equal(m.resultRevisionId, f.saved.revisionId);
    assert.equal(m.actorName, f.alice.user.name);
    assert.equal(m.createdByUserId, f.alice.user.id);
    assert.equal(m.body, f.input.body);
    assert.deepEqual(m.codeAnchor, {
      version: 1,
      kind: 'result_code_file',
      path: f.input.path,
      side: 'after',
      objectId: f.input.objectId,
      referenceHash: f.saved.difference.referenceHash,
      differenceHash: f.saved.receipt.hash,
      range: { start: 2, end: 3 },
    });
    assert.deepEqual(snapshots(f, unchanged), before);
    const next = await f.save(
      await codeSnapshot([{ name: 'README.md', text: 'a new unrelated version\n' }]),
    );
    const older = (
      await f.api.call(`results/${f.saved.resultId}/versions/${f.saved.revisionId}`, f.alice)
    ).json();
    assert.deepEqual(
      older.messages.find((x: { id: string }) => x.id === m.id),
      m,
    );
    assert.equal(
      (await f.api.call(`results/${next.resultId}/versions/${next.revisionId}`, f.alice)).json()
        .messages.length,
      0,
    );
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/messages`, f.alice))
        .json()
        .items.filter((x: { id: string }) => x.id === m.id).length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('只能定位已共享文件的实际侧；空文件/二进制只支持文件锚点，行号不凭空生成', async () => {
  const f = await codeFeedbackFixture();
  try {
    for (const change of [
      { path: 'not-shared.txt' },
      { side: 'before', objectId: f.input.objectId },
      { objectId: 'f'.repeat(40) },
      { range: { start: 1, end: 4 } },
    ]) {
      const r = await f.api.call(f.feedbackPath, f.alice, { ...f.input, ...change });
      assert([400, 409].includes(r.statusCode), r.body);
    }
    for (const name of ['binary.dat', 'empty.txt', 'added.txt']) {
      const file = f.saved.difference.files.find((x) => x.path === name)!;
      const input = { ...f.input, path: name, objectId: file.after!.objectId, range: null };
      const r = await f.api.call(f.feedbackPath, f.alice, input);
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json().codeAnchor.range, null);
      if (name !== 'added.txt')
        assert(
          [400, 409].includes(
            (await f.api.call(f.feedbackPath, f.alice, { ...input, range: { start: 1, end: 1 } }))
              .statusCode,
          ),
        );
      if (name === 'added.txt')
        assert.equal(
          (await f.api.call(f.feedbackPath, f.alice, { ...input, side: 'before' })).statusCode,
          409,
        );
    }
    const old = f.saved.difference.files.find((x) => x.path === 'removed.txt')!;
    assert.equal(
      (
        await f.api.call(f.feedbackPath, f.alice, {
          ...f.input,
          path: old.path,
          side: 'before',
          objectId: old.before!.objectId,
          range: { start: 1, end: 1 },
        })
      ).statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});
test('同键重复并发只发一条原反馈，换正文/范围冲突，SQLite重开返回同一原记录', async () => {
  const f = await codeFeedbackFixture();
  try {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      f.api.call(f.feedbackPath, f.alice, f.input, key),
      f.api.call(f.feedbackPath, f.alice, f.input, key),
    ]);
    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 201, b.body);
    assert.deepEqual(a.json(), b.json());
    assert.equal(
      (await f.api.call(f.feedbackPath, f.alice, { ...f.input, body: 'changed' }, key)).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(f.feedbackPath, f.alice, { ...f.input, range: null }, key)).statusCode,
      409,
    );
    const db = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const m = db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        db.addCodeFeedback(f.saved.resultId, f.saved.revisionId, f.input, key),
      );
      assert.deepEqual(m, a.json());
    } finally {
      db.close();
    }
    assert.equal(f.as(() => f.api.store.messages(f.task.id)).filter((m) => m.codeAnchor).length, 1);
  } finally {
    await f.close();
  }
});
test('当前编辑/读取权限覆盖新增与旧回执，来源节点撤权不撤回已经共享的历史代码', async () => {
  const f = await codeFeedbackFixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(f.feedbackPath, f.bob, f.input)).statusCode, 403);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const key = randomUUID(),
      r = await f.api.call(f.feedbackPath, f.bob, f.input, key);
    assert.equal(r.statusCode, 201, r.body);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal(
      (await f.api.call(f.feedbackPath, f.bob, { ...f.input, body: '仍评论原来已经共享的代码' }))
        .statusCode,
      201,
    );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(f.feedbackPath, f.bob, f.input, key)).statusCode, 403);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    assert.equal((await f.api.call(f.feedbackPath, f.bob, f.input, key)).statusCode, 404);
    assert.equal(
      (await f.api.call(`results/${f.saved.resultId}/versions/${f.saved.revisionId}`, f.bob))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
test('消息、outbox或回执故障全事务回滚，不改固定来源与Task状态', async () => {
  const f = await codeFeedbackFixture();
  try {
    const tables = [
      'messages',
      'outbox',
      'idempotency_records',
      'tasks',
      'result_revisions',
      'result_code_differences',
    ];
    for (const table of ['messages', 'outbox', 'idempotency_records']) {
      const key = randomUUID(),
        before = snapshots(f, tables);
      f.api.store.db.exec(
        `CREATE TRIGGER fail_code_feedback BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
      );
      const response = await f.api.call(f.feedbackPath, f.alice, f.input, key);
      assert.equal(response.statusCode, 500, response.body);
      f.api.store.db.exec('DROP TRIGGER fail_code_feedback');
      assert.deepEqual(snapshots(f, tables), before);
      assert.equal((await f.api.call(f.feedbackPath, f.alice, f.input, key)).statusCode, 201);
    }
    const other = await f.api.project(f.alice),
      task = await f.api.task(f.alice, other.id);
    const result = f.as(() => f.api.store.createResult(task.id, 'other', 'other', randomUUID()));
    assert.throws(
      () => f.as(() => new ResultRevisions(f.api.store).get(result.id, f.saved.revisionId)),
      { code: 'NOT_FOUND' },
    );
    assert.equal(
      (
        await f.api.call(
          `results/${result.id}/versions/${f.saved.revisionId}/code-feedback`,
          f.alice,
          f.input,
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('SHA-256来源对象与CR行号保持原锚点，不把SHA-1形状或未共享新版本当同一位置', async () => {
  const before = await codeSnapshot([{ name: 'README.md', text: 'one\rtwo\rthree' }], 'sha256');
  const after = await codeSnapshot(
    [{ name: 'README.md', text: 'one\rchanged\rthree\r' }],
    'sha256',
  );
  const f = await codeFeedbackFixture(undefined, { before, after });
  try {
    assert.equal(f.input.objectId.length, 64);
    const r = await f.api.call(f.feedbackPath, f.alice, f.input);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().codeAnchor.objectId, f.input.objectId);
    assert.equal(
      (
        await f.api.call(f.feedbackPath, f.alice, {
          ...f.input,
          objectId: f.input.objectId.slice(0, 40),
        })
      ).statusCode,
      409,
    );
    const noCode = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '文字版本，没有共享代码',
    });
    assert.equal(noCode.statusCode, 201, noCode.body);
    assert.equal(
      (
        await f.api.call(
          `results/${f.saved.resultId}/versions/${noCode.json().revisionId}/code-feedback`,
          f.alice,
          f.input,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(f.feedbackPath, f.alice, { ...f.input, body: '仍评论原SHA-256版本' }))
        .statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});
