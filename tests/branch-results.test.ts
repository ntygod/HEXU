import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../packages/db/src/store.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import {
  parseBranchResult,
  RESULT_OUTPUT_LIMIT,
  type ResultDetail,
  type BranchResultPreview,
} from '../packages/contracts/src/results.js';
import { branchResultFixture } from './helpers/branch-results.js';

test('固定成果契约限制内容和修订，拒绝伪造来源、状态、代码和超量正文', () => {
  const b = {
    expectedRevision: 1,
    expectedResultRevision: 0,
    expectedRunRevision: 1,
    sourceRunId: randomUUID(),
    title: '说明',
    body: '成果',
    limitations: '',
  };
  assert.equal(parseBranchResult(b).expectedResultRevision, 0);
  for (const extra of [
    { source: {} },
    { code: 'fixed' },
    { state: 'selected' },
    { resultId: randomUUID() },
    { expectedResultRevision: -1 },
    { body: 'a'.repeat(6001) },
    { limitations: 'a'.repeat(2001) },
    { body: '\u0001'.repeat(6000) },
  ])
    assert.throws(() => parseBranchResult({ ...b, ...extra }));
});

test('成果固定真实分支输入/终态/共享输出，同一容器追加版本，旧反馈不漂移', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin(),
      b = f.begin(1, 'codex');
    a.start();
    b.start();
    a.send('output', '仅方案A输出');
    b.send('output', '仅方案B输出');
    a.finish();
    b.finish('failed', 'B保留部分输出');
    const beforeTask = f.as(() => f.api.store.getTask(f.task.id)),
      body = await f.draft(),
      key = randomUUID();
    const first = await f.api.call(f.path() + '/results', f.alice, body, key);
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(
      (await f.api.call(f.path() + '/results', f.alice, body, key)).json(),
      first.json(),
    );
    const { resultId, revisionId } = first.json();
    let detail = (await f.api.call(`results/${resultId}`, f.alice)).json() as ResultDetail;
    assert.equal(detail.version.source.kind, 'work_branch');
    if (detail.version.source.kind !== 'work_branch') throw new Error('missing source');
    assert.equal(detail.version.source.code, 'not_captured');
    assert.equal(detail.version.source.run.id, a.run.id);
    assert.equal(detail.version.source.run.model, 'protocol-test-model');
    assert(detail.version.source.run.context.includes('RESULT_INPUT_0'));
    assert(!detail.version.source.run.context.includes('RESULT_INPUT_1'));
    assert(detail.version.source.output.text.includes('仅方案A输出'));
    assert(!detail.version.source.output.text.includes('仅方案B输出'));
    const original = structuredClone(detail.version);
    const comment = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: '针对第一版的反馈',
      resultId,
      resultRevisionId: revisionId,
    });
    assert.equal(comment.statusCode, 201);
    await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: '未指定版本的旧反馈',
      resultId,
    });
    a.send('output', '终态之后不能混入');
    const next = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '第二版人工说明',
    });
    assert.equal(next.statusCode, 201, next.body);
    assert.equal(next.json().resultId, resultId);
    detail = (await f.api.call(`results/${resultId}`, f.alice)).json();
    assert.equal(detail.version.revision, 2);
    assert.equal(detail.messages.length, 0);
    assert.equal(detail.unversionedMessages.length, 1);
    const old = (
      await f.api.call(`results/${resultId}/versions/${revisionId}`, f.alice)
    ).json() as ResultDetail;
    assert.deepEqual(old.version, original);
    assert.equal(old.messages[0]!.body, '针对第一版的反馈');
    assert.equal(f.read().branches[0]!.state, 'ready');
    assert.equal(f.read().branches[1]!.state, 'active');
    assert.deepEqual(
      f.as(() => f.api.store.getTask(f.task.id)),
      beforeTask,
    );
    const second = await f.api.call(f.path(1) + '/results', f.alice, await f.draft(1));
    const failed = (
      await f.api.call(`results/${second.json().resultId}`, f.alice)
    ).json() as ResultDetail;
    assert.equal(
      failed.version.source.kind === 'work_branch' && failed.version.source.run.state,
      'failed',
    );
    assert.throws(
      () =>
        f.api.store.db
          .prepare('UPDATE result_revisions SET body=? WHERE id=?')
          .run('{}', revisionId),
      /immutable/,
    );
    assert.throws(
      () => f.api.store.db.prepare('DELETE FROM result_revisions WHERE id=?').run(revisionId),
      /immutable/,
    );
  } finally {
    await f.close();
  }
});

test('活动/未知来源不能保存，不同Run或不同任务不可混用', async () => {
  const f = await branchResultFixture();
  try {
    assert.equal((await f.api.call(f.path() + '/result-preview', f.alice)).statusCode, 409);
    const a = f.begin(),
      b = f.begin(1);
    a.start();
    b.start();
    assert.equal((await f.api.call(f.path() + '/result-preview', f.alice)).statusCode, 409);
    a.send('unknown', '进程未知');
    assert.equal((await f.api.call(f.path() + '/result-preview', f.alice)).statusCode, 409);
    a.finish('cancelled');
    b.finish();
    const body = await f.draft();
    assert.equal(
      (await f.api.call(f.path() + '/results', f.alice, { ...body, sourceRunId: b.run.id }))
        .statusCode,
      409,
    );
    const other = await f.api.task(f.alice, f.project.id);
    assert.equal(
      (
        await f.api.call(
          `tasks/${other.id}/work-branches/${f.view.branches[0]!.id}/results`,
          f.alice,
          body,
        )
      ).statusCode,
      404,
    );
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('并发保存只接受同一基线的一次更新，原回执固定版本而非最新版本', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin();
    a.start();
    a.finish();
    const initial = await f.draft();
    const attempts = [
      { body: initial, key: randomUUID() },
      { body: { ...initial, body: '另一人同时保存' }, key: randomUUID() },
    ];
    const replies = await Promise.all(
      attempts.map((a) => f.api.call(f.path() + '/results', f.alice, a.body, a.key)),
    );
    assert.deepEqual(replies.map((r) => r.statusCode).sort(), [201, 409]);
    // Either request may win authentication/dispatch; only one may commit.
    const winner = replies.findIndex((r) => r.statusCode === 201);
    const first = replies[winner]!.json(),
      { body, key } = attempts[winner]!;
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM result_revisions').get()!.n, 1);
    const second = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '新的版本',
    });
    assert.equal(second.statusCode, 201);
    assert.deepEqual((await f.api.call(f.path() + '/results', f.alice, body, key)).json(), first);
    assert.equal(
      (await f.api.call(f.path() + '/results', f.alice, { ...body, title: '改变原请求' }, key))
        .statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('历史事件失败时成果/版本/分支/outbox/回执共同回滚，原请求可重试', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin();
    a.start();
    a.finish();
    const body = await f.draft(),
      key = randomUUID();
    const tables = [
      'results',
      'result_revisions',
      'work_branches',
      'work_branch_events',
      'outbox',
      'idempotency_records',
    ];
    const state = () =>
      tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = state();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_result BEFORE INSERT ON work_branch_events WHEN json_extract(NEW.body,'$.action')='result_saved' BEGIN SELECT RAISE(ABORT,'fixture result failure'); END;",
    );
    assert.equal((await f.api.call(f.path() + '/results', f.alice, body, key)).statusCode, 500);
    assert.deepEqual(state(), before);
    f.api.store.db.exec('DROP TRIGGER fail_result');
    assert.equal((await f.api.call(f.path() + '/results', f.alice, body, key)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test('输出预算保留终态优先、Unicode边界和截取事实，排除撤权或迟到输出', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin();
    a.start();
    a.send('output', 'a'.repeat(5997) + '😀');
    a.send('output', '不能全部带入'.repeat(800));
    a.finish('failed', '末');
    a.send('output', 'LATE_PRIVATE');
    let preview = (
      await f.api.call(f.path() + '/result-preview', f.alice)
    ).json() as BranchResultPreview;
    assert(preview.source.output.text.startsWith('末\n'));
    assert(preview.source.output.truncated);
    assert(preview.source.output.text.length <= RESULT_OUTPUT_LIMIT);
    assert(!/[\uD800-\uDBFF]$/.test(preview.source.output.text));
    assert(!preview.source.output.text.includes('LATE_PRIVATE'));
    const b = f.begin(1);
    b.start();
    b.send('output', '撤权前已公开');
    f.as(() => f.nodes.revoke(f.ns[1]!.nodeId, 1, randomUUID()));
    b.send('output', 'REVOKED_PRIVATE');
    b.finish('cancelled', 'REVOKED_FINAL');
    preview = (await f.api.call(f.path(1) + '/result-preview', f.alice)).json();
    assert.equal(preview.source.output.text, '撤权前已公开');
    f.api.store.db
      .prepare('UPDATE node_dispatches SET terminal_sequence=NULL WHERE id=?')
      .run(a.command.id);
    preview = (await f.api.call(f.path() + '/result-preview', f.alice)).json();
    assert.equal(preview.source.output.availability, 'legacy_unavailable');
    assert.equal(preview.source.output.text, '');
  } finally {
    await f.close();
  }
});

test('只读可看固定版本，撤权后版本、SSE、反馈和旧保存回执都受当前权限保护', async () => {
  const f = await branchResultFixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const a = f.begin();
    a.start();
    a.finish();
    const body = await f.draft(),
      key = randomUUID();
    const saved = await f.api.call(f.path() + '/results', f.bob, body, key);
    assert.equal(saved.statusCode, 201);
    const { resultId, revisionId } = saved.json(),
      path = `results/${resultId}/versions/${revisionId}`;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(path, f.bob)).statusCode, 200);
    assert.equal((await f.api.call(f.path() + '/results', f.bob, body, key)).statusCode, 403);
    assert.equal(
      (
        await f.api.call(`tasks/${f.task.id}/messages`, f.bob, {
          resultId,
          resultRevisionId: revisionId,
          body: '无写权限',
        })
      ).statusCode,
      403,
    );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    assert.equal((await f.api.call(path, f.bob)).statusCode, 404);
    assert.equal((await f.api.call(f.path() + '/results', f.bob, body, key)).statusCode, 404);
    assert(!JSON.stringify((await f.api.call('workbench', f.bob)).json()).includes(resultId));
    const visibleEvents = f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () =>
      f.api.store.events(0),
    );
    assert(!JSON.stringify(visibleEvents).includes('result_saved'));
    const other = f.as(() =>
      f.api.store.createResult(f.task.id, '另一成果', '另一说明', randomUUID()),
    );
    assert.equal(
      (await f.api.call(`results/${other.id}/versions/${revisionId}`, f.alice)).statusCode,
      404,
    );
    assert.equal(
      (
        await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
          resultId: other.id,
          resultRevisionId: revisionId,
          body: '错误版本',
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('迁移只保存旧成果的已知版本与无版本反馈，保留方案现场和真实重开读取', async () => {
  const f = await branchResultFixture();
  try {
    const r = f.as(() =>
      f.api.store.createResult(f.task.id, '历史记录', '只知道第三版正文', randomUUID()),
    );
    const comment = f.as(() => f.api.store.addMessage(f.task.id, '旧反馈', r.id, randomUUID()));
    const path = join(f.api.dir, 'migration.sqlite');
    f.api.store.db.prepare('VACUUM INTO ?').run(path);
    const db = new DatabaseSync(path);
    db.exec(
      'DROP TABLE work_branch_choices; DROP TABLE result_revisions; ALTER TABLE node_dispatches DROP COLUMN terminal_sequence; DELETE FROM schema_migrations WHERE version=29;',
    );
    db.prepare('UPDATE results SET body=? WHERE id=?').run(
      JSON.stringify({ ...r, revision: 3 }),
      r.id,
    );
    db.close();
    const upgraded = new Store(path, undefined, { team: true });
    try {
      upgraded.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        const detail = new ResultRevisions(upgraded).detail(r.id);
        assert.equal(detail.revisions.length, 1);
        assert.equal(detail.version.revision, 3);
        assert.deepEqual(detail.version.source, { kind: 'legacy' });
        assert.equal(detail.version.createdBy, null);
        assert.deepEqual(detail.unversionedMessages, [comment]);
      });
      for (const table of ['work_branches', 'work_branch_events', 'work_branch_workspaces'])
        assert.deepEqual(
          upgraded.db.prepare(`SELECT * FROM ${table}`).all(),
          f.api.store.db.prepare(`SELECT * FROM ${table}`).all(),
        );
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      upgraded.close();
    }
    const reopened = new Store(path, undefined, { team: true });
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM result_revisions').get()!.n, 1);
    reopened.close();
  } finally {
    await f.close();
  }
});
