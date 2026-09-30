import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Result, Task } from '../packages/contracts/src/index.js';
import {
  parseMemberResultVersion,
  type MemberResultVersionInput,
  type MemberResultVersionPreview,
  type MemberResultVersionReceipt,
} from '../packages/contracts/src/member-result-versions.js';
import type { ResultDetail, ResultRevision } from '../packages/contracts/src/results.js';
import { MemberResultVersions } from '../packages/db/src/member-result-versions.js';
import { ResultFeedbackFollowUps } from '../packages/db/src/result-feedback-followups.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { ORIGIN, teamFixture } from './helpers/team.js';
import { branchResultFixture } from './helpers/branch-results.js';

const snapshots = (store: Store, tables: string[]) =>
  tables.map((table) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()));
const writeTables = ['results', 'result_revisions', 'outbox', 'idempotency_records'];
const untouchedTables = [
  'tasks',
  'messages',
  'runs',
  'task_next_inputs',
  'node_dispatches',
  'continuation_operations',
  'node_continuation_operations',
  'integration_operations',
  'work_branches',
  'work_branch_groups',
  'work_branch_events',
  'work_branch_choices',
  'result_code_differences',
  'assistance_grants',
  'collab_project_members',
];
const inputFor = (version: ResultRevision): MemberResultVersionInput => ({
  expectedRevision: version.revision,
  expectedRevisionId: version.id,
  title: '明确保存的新标题',
  body: '由当前成员编辑的新版正文',
});

async function fixture(privateTask = false) {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, privateTask ? null : project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() => api.store.createResult(task.id, '原始标题', '原始正文', randomUUID()));
    const version = as(() => new ResultRevisions(api.store).current(result));
    const feedback = as(() =>
      api.store.addMessage(task.id, '旧版反馈', result.id, randomUUID(), version.id),
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
      path: `results/${result.id}`,
      input: inputFor(version),
      close: api.close,
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

test('普通成果版本契约只接受固定基线与标题正文，拒绝来源/作者/执行等注入', () => {
  const input = {
    expectedRevision: 1,
    expectedRevisionId: randomUUID(),
    title: ' 标题 ',
    body: ' 正文 ',
  };
  assert.deepEqual(parseMemberResultVersion(input), { ...input, title: '标题', body: '正文' });
  assert.equal(parseMemberResultVersion({ ...input, body: '中'.repeat(12000) }).body.length, 12000);
  assert.equal(parseMemberResultVersion({ ...input, title: '题'.repeat(160) }).title.length, 160);
  for (const value of [null, [], {}, 'invalid'])
    assert.throws(() => parseMemberResultVersion(value), { code: 'INVALID_INPUT' });
  for (const extra of [
    { expectedRevision: 0 },
    { expectedRevision: 1.2 },
    { expectedRevision: '1' },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevisionId: '' },
    { expectedRevisionId: '../version' },
    { expectedRevisionId: 'a'.repeat(101) },
    { title: '' },
    { title: ' ' },
    { title: 'a'.repeat(161) },
    { body: '' },
    { body: null },
    { body: 'a'.repeat(12001) },
  ])
    assert.throws(() => parseMemberResultVersion({ ...input, ...extra }), {
      code: 'INVALID_INPUT',
    });
  for (const field of [
    'resultId',
    'taskId',
    'spaceId',
    'projectId',
    'kind',
    'source',
    'createdBy',
    'createdByUserId',
    'createdAt',
    'limitations',
    'code',
    'runId',
    'branchId',
    'status',
    'share',
    'execute',
  ])
    assert.throws(() => parseMemberResultVersion({ ...input, [field]: 'spoof' }), {
      code: 'INVALID_INPUT',
    });
});

test('只读预览不写入；新版本保留容器、原版、反馈回复及后续任务，作者为当前编辑者', async () => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const reply = f.as(() =>
      f.api.store.addFeedbackReply(
        f.result.id,
        f.version.id,
        f.feedback.id,
        { body: '仍然针对原版的回复' },
        randomUUID(),
      ),
    );
    const followUp = f.as(() =>
      new ResultFeedbackFollowUps(f.api.store).create(
        f.result.id,
        f.version.id,
        f.feedback.id,
        { title: '原反馈后续任务', description: '独立处理' },
        randomUUID(),
      ),
    );
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    const preview = await f.api.call(f.path + '/member-version-preview', f.bob);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json<MemberResultVersionPreview>(), {
      available: true,
      version: f.version,
    });
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    const untouched = snapshots(f.api.store, untouchedTables);
    const response = await f.api.call(f.path + '/versions', f.bob, f.input);
    assert.equal(response.statusCode, 201, response.body);
    const receipt = response.json<MemberResultVersionReceipt>();
    assert.equal(receipt.resultId, f.result.id);
    assert.equal(receipt.revision, 2);
    assert.notEqual(receipt.revisionId, f.version.id);
    const current = (await f.api.call(f.path, f.bob)).json<ResultDetail>();
    assert.equal(current.result.id, f.result.id);
    assert.equal(current.result.taskId, f.task.id);
    assert.equal(current.result.createdAt, f.result.createdAt);
    assert.equal(current.result.title, f.input.title);
    assert.equal(current.result.body, f.input.body);
    assert.equal(current.version.id, receipt.revisionId);
    assert.equal(current.version.revision, 2);
    assert.deepEqual(current.version.createdBy, { id: f.bob.user.id, name: f.bob.user.name });
    assert.deepEqual(current.version.source, { kind: 'member' });
    assert.equal(current.version.limitations, '');
    assert.deepEqual(current.messages, []);
    assert.deepEqual(
      current.revisions.map((r) => r.id),
      [receipt.revisionId, f.version.id],
    );
    const historical = (
      await f.api.call(f.path + `/versions/${f.version.id}`, f.bob)
    ).json<ResultDetail>();
    assert.deepEqual(historical.version, f.version);
    assert.deepEqual(
      historical.messages.map((m) => m.id),
      [f.feedback.id, reply.id],
    );
    assert.equal(historical.messages[1]!.replyTo!.messageId, f.feedback.id);
    assert.deepEqual(
      f.as(() => f.api.store.getTask(followUp.id)),
      followUp,
    );
    assert.deepEqual(snapshots(f.api.store, untouchedTables), untouched);
    const event = f.api.store.db
      .prepare("SELECT task_id,space_id FROM outbox WHERE kind='result.version_created'")
      .all();
    assert.deepEqual(
      event.map((e) => ({ ...e })),
      [{ task_id: f.task.id, space_id: f.task.spaceId }],
    );
    assert.throws(() =>
      f.api.store.db
        .prepare('UPDATE result_revisions SET body=? WHERE id=?')
        .run('{}', f.version.id),
    );
  } finally {
    await f.close();
  }
});

test('HTTP允许12000字符CJK和JSON转义，拒绝超字符/96KiB/未知字段及空幂等键且不写入', async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, title: '题'.repeat(160), body: '中'.repeat(12000) };
    const first = await f.api.call(f.path + '/versions', f.alice, input);
    assert.equal(first.statusCode, 201, first.body);
    const current = (await f.api.call(f.path, f.alice)).json<ResultDetail>().version;
    const escapedInput = { ...input, expectedRevision: 2, expectedRevisionId: current.id };
    const escaped = JSON.stringify(escapedInput).replace(
      /[题中]/g,
      (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    const second = await f.api.app.inject({
      method: 'POST',
      url: '/api/v1/' + f.path + '/versions',
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
    assert.equal(second.statusCode, 201, second.body);
    assert.equal((await f.api.call(f.path, f.alice)).json<ResultDetail>().version.body, input.body);
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const [value, status] of [
      [{ ...input, body: '中'.repeat(12001) }, 400],
      [{ ...input, body: '中'.repeat(40000) }, 413],
      [{ ...input, source: { kind: 'member' } }, 400],
      [{ ...input, createdBy: f.bob.user }, 400],
    ] as const) {
      const response = await f.api.call(f.path + '/versions', f.alice, value);
      assert.equal(response.statusCode, status, response.body);
    }
    assert.equal((await f.api.call(f.path + '/versions', f.alice, input, '')).statusCode, 400);
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
  } finally {
    await f.close();
  }
});

test('同键重试返回原不可变版本回执，后续版本和重启不把旧回执替换成最新版', async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const key = randomUUID();
    const first = await f.api.call(f.path + '/versions', f.alice, f.input, key);
    assert.equal(first.statusCode, 201, first.body);
    const receipt = first.json<MemberResultVersionReceipt>();
    const version = (await f.api.call(f.path, f.alice)).json<ResultDetail>().version;
    assert.equal(
      (await f.api.call(f.path + '/versions', f.alice, { ...inputFor(version), body: '第三版' }))
        .statusCode,
      201,
    );
    const before = snapshots(f.api.store, writeTables);
    assert.deepEqual(
      (await f.api.call(f.path + '/versions', f.alice, f.input, key)).json(),
      receipt,
    );
    const conflict = await f.api.call(
      f.path + '/versions',
      f.alice,
      { ...f.input, body: '换内容' },
      key,
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    await f.api.app.close();
    reopened = new Store(f.api.dbPath, undefined, { team: true });
    const store = reopened;
    const recovered = store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
      assert.equal(store.result(f.result.id).revision, 3);
      assert.deepEqual(new ResultRevisions(store).get(f.result.id, f.version.id), f.version);
      return new MemberResultVersions(store).save(f.result.id, f.input, key);
    });
    assert.deepEqual(recovered, receipt);
    assert.deepEqual(snapshots(store, writeTables), before);
  } finally {
    reopened?.close();
    await f.close();
  }
});

test('固定数字和版本ID都必须相符；并发同基线只能提交一个，同键只能创建一个版本', async () => {
  const f = await fixture();
  try {
    const before = snapshots(f.api.store, writeTables);
    for (const input of [
      { ...f.input, expectedRevision: 2 },
      { ...f.input, expectedRevisionId: randomUUID() },
    ]) {
      const r = await f.api.call(f.path + '/versions', f.alice, input);
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error.code, 'REVISION_CONFLICT');
    }
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    const keys = [randomUUID(), randomUUID()];
    const inputs = [
      { ...f.input, body: '并发甲' },
      { ...f.input, body: '并发乙' },
    ];
    const replies = await Promise.all(
      inputs.map((value, i) => f.api.call(f.path + '/versions', f.alice, value, keys[i]!)),
    );
    assert.deepEqual(replies.map((r) => r.statusCode).sort(), [201, 409]);
    const winner = replies.findIndex((r) => r.statusCode === 201);
    const receipt = replies[winner]!.json<MemberResultVersionReceipt>();
    const current = (await f.api.call(f.path, f.alice)).json<ResultDetail>();
    assert.equal(current.version.body, inputs[winner]!.body);
    assert.equal(current.revisions.length, 2);
    assert.deepEqual(
      (await f.api.call(f.path + '/versions', f.alice, inputs[winner]!, keys[winner]!)).json(),
      receipt,
    );
    const sameKey = randomUUID();
    const sameInput = inputFor(current.version);
    const same = await Promise.all([
      f.api.call(f.path + '/versions', f.alice, sameInput, sameKey),
      f.api.call(f.path + '/versions', f.alice, sameInput, sameKey),
    ]);
    assert(same.every((r) => r.statusCode === 201));
    assert.deepEqual(same[0]!.json(), same[1]!.json());
    assert.equal((await f.api.call(f.path, f.alice)).json<ResultDetail>().revisions.length, 3);
  } finally {
    await f.close();
  }
});

test('当前只读/撤权/跨空间/会话边界阻止预览、新写入与原回执，历史读取仍受当前权限控制', async () => {
  const f = await fixture();
  try {
    const member = `projects/${f.project.id}/members/${f.bob.user.id}`;
    await f.api.call(member, f.alice, { role: 'edit' });
    const key = randomUUID();
    assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input, key)).statusCode, 201);
    await f.api.call(member, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.path, f.bob)).statusCode, 200);
    assert.equal((await f.api.call(f.path + `/versions/${f.version.id}`, f.bob)).statusCode, 200);
    const before = snapshots(f.api.store, writeTables);
    assert.equal((await f.api.call(f.path + '/member-version-preview', f.bob)).statusCode, 403);
    for (const id of [key, randomUUID()])
      assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input, id)).statusCode, 403);
    await f.api.call(member, f.alice, { role: null });
    for (const suffix of ['', `/versions/${f.version.id}`, '/member-version-preview'])
      assert.equal((await f.api.call(f.path + suffix, f.bob)).statusCode, 404);
    assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input, key)).statusCode, 404);
    const outsiderSpace = { ...f.alice, spaceId: `personal-${f.alice.user.id}` };
    for (const [account, status] of [
      [null, 401],
      [outsiderSpace, 404],
    ] as const) {
      assert.equal(
        (await f.api.call(f.path + '/member-version-preview', account)).statusCode,
        status,
      );
      assert.equal(
        (await f.api.call(f.path + '/versions', account, f.input, key)).statusCode,
        status,
      );
    }
    // Role changes themselves write receipts; the result and its version history stay fixed.
    assert.deepEqual(snapshots(f.api.store, ['results', 'result_revisions']), before.slice(0, 2));
    await f.api.call(member, f.alice, { role: 'edit' });
    f.api.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(f.bob.spaceId, f.bob.user.id);
    assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input, key)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('私有文字成果保持私有，空间所有者和其他项目成员不能访问别人的成果或版本入口', async () => {
  const f = await fixture(true);
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(f.path + '/versions', f.alice, f.input)).statusCode, 201);
    for (const suffix of ['', '/member-version-preview', `/versions/${f.version.id}`])
      assert.equal((await f.api.call(f.path + suffix, f.bob)).statusCode, 404);
    assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input)).statusCode, 404);
    const privateTask = await f.api.task(f.bob);
    const bobsResult = f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () =>
      f.api.store.createResult(privateTask.id, '乙的私有成果', '正文', randomUUID()),
    );
    assert.equal(
      (await f.api.call(`results/${bobsResult.id}/member-version-preview`, f.alice)).statusCode,
      404,
    );
    assert.equal(
      (await f.api.call(`results/${bobsResult.id}/versions`, f.alice, f.input)).statusCode,
      404,
    );
    assert.deepEqual(
      f.as(() => f.api.store.getTask(f.task.id)),
      f.task,
    );
  } finally {
    await f.close();
  }
});

test('事务内再次核对当前编辑权与普通成果资格，原回执和新写入均不能绕过', async (t) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const key = randomUUID();
    assert.equal((await f.api.call(f.path + '/versions', f.bob, f.input, key)).statusCode, 201);
    const original = f.api.store.mutate.bind(f.api.store);
    for (const failure of ['permission', 'source'] as const) {
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
              else {
                const result = f.api.store.result(f.result.id);
                f.api.store.db
                  .prepare('UPDATE results SET body=? WHERE id=?')
                  .run(JSON.stringify({ ...result, kind: 'demo-preview' }), result.id);
              }
              beforeReplay?.();
            },
            onReplay,
          ),
      );
      const before = snapshots(f.api.store, [...writeTables, 'collab_project_members']);
      for (const k of [key, randomUUID()]) {
        const response = await f.api.call(f.path + '/versions', f.bob, f.input, k);
        assert.equal(response.statusCode, failure === 'permission' ? 403 : 422, response.body);
        assert.deepEqual(
          snapshots(f.api.store, [...writeTables, 'collab_project_members']),
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

test('容器投影、不可变版本、outbox及回执任一步失败均原子回滚，原键可重试', async () => {
  const f = await fixture();
  try {
    for (const table of writeTables) {
      const current = (await f.api.call(f.path, f.alice)).json<ResultDetail>().version;
      const input = inputFor(current);
      const key = randomUUID();
      const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
      f.api.store.db
        .exec(`CREATE TRIGGER fail_member_version BEFORE ${table === 'results' ? 'UPDATE' : 'INSERT'} ON ${table}
        BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
      const failed = await f.api.call(f.path + '/versions', f.alice, input, key);
      assert.equal(failed.statusCode, 500, failed.body);
      f.api.store.db.exec('DROP TRIGGER fail_member_version');
      assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
      const retry = await f.api.call(f.path + '/versions', f.alice, input, key);
      assert.equal(retry.statusCode, 201, retry.body);
      assert.equal(retry.json<MemberResultVersionReceipt>().revision, current.revision + 1);
    }
  } finally {
    await f.close();
  }
});

test('普通legacy文字只追加明确成员版本，不猜旧作者或补造未知早期版本；演示成果不可改', async () => {
  const f = await fixture();
  try {
    const legacy: Result = { ...f.result, id: randomUUID(), revision: 7, title: '旧成果' };
    const old = f.as(() =>
      f.api.store.atomic(() => {
        f.api.store.db
          .prepare('INSERT INTO results VALUES(?,?,?)')
          .run(legacy.id, legacy.taskId, JSON.stringify(legacy));
        return new ResultRevisions(f.api.store).append(legacy, { kind: 'legacy' }, '', true);
      }),
    );
    const response = await f.api.call(`results/${legacy.id}/versions`, f.alice, inputFor(old));
    assert.equal(response.statusCode, 201, response.body);
    const detail = (await f.api.call(`results/${legacy.id}`, f.alice)).json<ResultDetail>();
    assert.deepEqual(
      detail.revisions.map((r) => r.revision),
      [8, 7],
    );
    assert.deepEqual(detail.version.source, { kind: 'member' });
    assert.deepEqual(detail.version.createdBy, { id: f.alice.user.id, name: f.alice.user.name });
    assert.deepEqual(
      f.as(() => new ResultRevisions(f.api.store).get(legacy.id, old.id)),
      old,
    );
    assert.equal(old.createdBy, null);
    assert.deepEqual(old.source, { kind: 'legacy' });
    const demo = { ...f.result, id: randomUUID(), kind: 'demo-preview' as const };
    const demoVersion = f.as(() =>
      f.api.store.atomic(() => {
        f.api.store.db
          .prepare('INSERT INTO results VALUES(?,?,?)')
          .run(demo.id, demo.taskId, JSON.stringify(demo));
        return new ResultRevisions(f.api.store).append(demo, { kind: 'legacy' }, '', true);
      }),
    );
    const before = snapshots(f.api.store, writeTables);
    assert.equal(
      (
        await f.api.call(`results/${demo.id}/member-version-preview`, f.alice)
      ).json<MemberResultVersionPreview>().available,
      false,
    );
    assert.equal(
      (await f.api.call(`results/${demo.id}/versions`, f.alice, inputFor(demoVersion))).statusCode,
      422,
    );
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
  } finally {
    await f.close();
  }
});

test('当前/历史方案来源及持久方案关联即使标为legacy也不可转成普通成果', async () => {
  const f = await branchResultFixture();
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const saved = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    assert.equal(saved.statusCode, 201, saved.body);
    const receipt = saved.json<MemberResultVersionReceipt>();
    const branchVersion = f.as(() =>
      new ResultRevisions(f.api.store).get(receipt.resultId, receipt.revisionId),
    );
    const originalBranch = f.read().branches[0]!;
    const cases = [branchVersion];
    for (const mode of ['result-link', 'version-link', 'history'] as const) {
      const result = f.as(() => f.api.store.createResult(f.task.id, mode, '正文', randomUUID()));
      const version = f.as(() =>
        f.api.store.atomic(() => {
          const current = { ...result, revision: 2 };
          f.api.store.db
            .prepare('UPDATE results SET body=? WHERE id=?')
            .run(JSON.stringify(current), result.id);
          return new ResultRevisions(f.api.store).append(current, { kind: 'legacy' }, '', true);
        }),
      );
      if (mode === 'history') {
        f.as(() =>
          f.api.store.atomic(() => {
            const branchSnapshot = { ...result, id: result.id, revision: 3 };
            new ResultRevisions(f.api.store).append(branchSnapshot, branchVersion.source);
            const current = { ...result, revision: 4 };
            f.api.store.db
              .prepare('UPDATE results SET body=? WHERE id=?')
              .run(JSON.stringify(current), result.id);
            cases.push(new ResultRevisions(f.api.store).append(current, { kind: 'member' }));
          }),
        );
      } else {
        f.api.store.db.prepare('UPDATE work_branches SET body=? WHERE id=?').run(
          JSON.stringify({
            ...originalBranch,
            resultId: mode === 'result-link' ? result.id : receipt.resultId,
            resultRevisionId: mode === 'version-link' ? version.id : receipt.revisionId,
          }),
          originalBranch.id,
        );
        const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
        assert.equal(
          (
            await f.api.call(`results/${result.id}/member-version-preview`, f.alice)
          ).json<MemberResultVersionPreview>().available,
          false,
        );
        assert.equal(
          (await f.api.call(`results/${result.id}/versions`, f.alice, inputFor(version)))
            .statusCode,
          422,
        );
        assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
      }
    }
    f.api.store.db
      .prepare('UPDATE work_branches SET body=? WHERE id=?')
      .run(JSON.stringify(originalBranch), originalBranch.id);
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const version of cases) {
      assert.equal(
        (
          await f.api.call(`results/${version.resultId}/member-version-preview`, f.alice)
        ).json<MemberResultVersionPreview>().available,
        false,
      );
      assert.equal(
        (await f.api.call(`results/${version.resultId}/versions`, f.alice, inputFor(version)))
          .statusCode,
        422,
      );
    }
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    const branchSave = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    assert.equal(branchSave.statusCode, 201, branchSave.body);
    assert.equal(branchSave.json<MemberResultVersionReceipt>().revision, 2);
  } finally {
    await f.close();
  }
});

test('归档项目和已完成任务允许人明确追加文字版本，不重开任务/执行/分享', async () => {
  const f = await fixture();
  try {
    f.as(() => {
      f.api.store.changeTask(f.task.id, 'done', f.task.revision, 'keep', randomUUID());
      f.api.store.projectLifecycle.change(
        f.project.id,
        { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
        randomUUID(),
      );
    });
    const before = snapshots(f.api.store, untouchedTables);
    assert.equal(
      (
        await f.api.call(f.path + '/member-version-preview', f.alice)
      ).json<MemberResultVersionPreview>().available,
      true,
    );
    const response = await f.api.call(f.path + '/versions', f.alice, f.input);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'done');
    assert(f.as(() => f.api.store.project(f.project.id)).archivedAt);
    assert.deepEqual(snapshots(f.api.store, untouchedTables), before);
  } finally {
    await f.close();
  }
});

test('100版本边界阻止新提交但保留原版和原回执，普通preview文字保持同一追加行为', () => {
  const store = new Store();
  try {
    const task = store.createTask(
      { title: '普通预览任务', description: '', projectId: null },
      randomUUID(),
    );
    const result = store.createResult(task.id, '普通预览文字', '正文', randomUUID());
    const service = new MemberResultVersions(store);
    const original = new ResultRevisions(store).current(result);
    const firstInput = inputFor(original);
    const first = service.save(result.id, firstInput, 'first');
    let lastInput = firstInput;
    let last = first;
    for (let revision = 3; revision <= 100; revision++) {
      lastInput = inputFor(new ResultRevisions(store).current(store.result(result.id)));
      last = service.save(result.id, lastInput, `version-${revision}`);
    }
    assert.equal(last.revision, 100);
    assert.deepEqual(service.preview(result.id), {
      available: false,
      reason: '此成果已达100个固定版本',
    });
    const before = snapshots(store, writeTables);
    assert.deepEqual(service.save(result.id, firstInput, 'first'), first);
    assert.deepEqual(service.save(result.id, lastInput, 'version-100'), last);
    assert.deepEqual(new ResultRevisions(store).get(result.id, original.id), original);
    assert.throws(
      () =>
        service.save(
          result.id,
          inputFor(new ResultRevisions(store).current(store.result(result.id))),
          randomUUID(),
        ),
      { code: 'RESULT_VERSION_LIMIT' },
    );
    assert.deepEqual(snapshots(store, writeTables), before);
    assert.equal(new ResultRevisions(store).list(result.id).length, 100);
  } finally {
    store.close();
  }
});
