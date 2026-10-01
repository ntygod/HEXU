import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '../packages/contracts/src/index.js';
import {
  normalizeResultReferenceUrl,
  parseResultReferenceCreate,
  parseResultReferenceLifecycle,
  parseResultReferenceListQuery,
  type ResultReference,
  type ResultReferenceCreate,
  type ResultReferencePage,
} from '../packages/contracts/src/result-references.js';
import { MemberResultVersions } from '../packages/db/src/member-result-versions.js';
import { ResultReferences } from '../packages/db/src/result-references.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { ORIGIN, teamFixture } from './helpers/team.js';

const snapshots = (store: Store, tables: string[]) =>
  tables.map((table) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()));
const writeTables = [
  'result_references',
  'result_reference_events',
  'outbox',
  'idempotency_records',
];
const untouchedTables = [
  'tasks',
  'messages',
  'runs',
  'results',
  'result_revisions',
  'completion_events',
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
const input: ResultReferenceCreate = {
  action: 'register',
  expectedResultRevision: 1,
  kind: 'report',
  title: '人工关联的检查说明',
  url: 'https://reports.example.invalid/builds/42#summary',
  environment: '本地手工检查',
};
const withdrawal = {
  action: 'withdraw',
  expectedResultRevision: 1,
  expectedRevision: 1,
};
const referencePath = (resultId: string, revisionId: string) =>
  `results/${resultId}/versions/${revisionId}/references`;

async function fixture(privateTask = false) {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, privateTask ? null : project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() => api.store.createResult(task.id, '固定成果', '原始正文', randomUUID()));
    const version = as(() => new ResultRevisions(api.store).current(result));
    return {
      api,
      alice,
      bob,
      project,
      task,
      result,
      version,
      as,
      refs: new ResultReferences(api.store),
      path: referencePath(result.id, version.id),
      close: api.close,
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

test('关联契约只接受人工登记字段与单行有界文字，不接受执行、身份、发布事实或环境配置', () => {
  assert.deepEqual(
    parseResultReferenceCreate({ ...input, title: ' 标题 ', environment: ' 测试环境 ' }),
    {
      ...input,
      title: '标题',
      environment: '测试环境',
    },
  );
  assert.equal(parseResultReferenceCreate({ ...input, environment: undefined }).environment, '');
  assert.equal(parseResultReferenceCreate({ ...input, title: '题'.repeat(160) }).title.length, 160);
  assert.equal(
    parseResultReferenceCreate({ ...input, environment: '中'.repeat(240) }).environment!.length,
    240,
  );
  assert.equal(parseResultReferenceCreate({ ...input, kind: 'release' }).kind, 'release');
  for (const value of [null, [], {}, 'invalid'])
    assert.throws(() => parseResultReferenceCreate(value), { code: 'INVALID_INPUT' });
  for (const extra of [
    { action: 'deploy' },
    { kind: 'preview' },
    { expectedResultRevision: 0 },
    { expectedResultRevision: 1.5 },
    { expectedResultRevision: '1' },
    { expectedResultRevision: Number.MAX_SAFE_INTEGER + 1 },
    { title: '' },
    { title: ' ' },
    { title: null },
    { title: '题'.repeat(161) },
    { environment: null },
    { environment: '中'.repeat(241) },
    { environment: '{"NODE_ENV":"production"}' },
    { environment: '["configuration"]' },
    { environment: 'NODE_ENV=production' },
    { environment: 'staging; API_KEY=fake-test-key' },
    { environment: 'token: fictional-token' },
    { environment: 'Bearer fictional-token' },
  ])
    assert.throws(() => parseResultReferenceCreate({ ...input, ...extra }), {
      code: 'INVALID_INPUT',
    });
  for (const control of ['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'])
    for (const field of ['title', 'environment'])
      assert.throws(() => parseResultReferenceCreate({ ...input, [field]: `文字${control}说明` }), {
        code: 'INVALID_INPUT',
      });
  for (const field of [
    'id',
    'taskId',
    'resultId',
    'resultRevisionId',
    'resultRevision',
    'revision',
    'source',
    'actor',
    'createdBy',
    'createdAt',
    'spaceId',
    'projectId',
    'status',
    'availability',
    'publication',
    'withdrawnAt',
    'withdrawnBy',
    'code',
    'runId',
    'nodeId',
    'share',
    'execute',
    'deploy',
  ])
    assert.throws(() => parseResultReferenceCreate({ ...input, [field]: '伪造' }), {
      code: 'INVALID_INPUT',
    });
});

test('关联URL只接受有界HTTP/HTTPS稳定链接，拒绝查询、凭证、控制符和多层编码绕过', () => {
  for (const [raw, expected] of [
    [' HTTPS://EXAMPLE.INVALID:443/report#section ', 'https://example.invalid/report#section'],
    ['http://localhost:4310/report', 'http://localhost:4310/report'],
    ['http://127.0.0.1:4310/report', 'http://127.0.0.1:4310/report'],
    [
      'https://example.invalid/报告#说明',
      'https://example.invalid/%E6%8A%A5%E5%91%8A#%E8%AF%B4%E6%98%8E',
    ],
    ['https://example.invalid/release#v1.2.3', 'https://example.invalid/release#v1.2.3'],
  ])
    assert.equal(normalizeResultReferenceUrl(raw), expected);
  const prefix = 'https://example.invalid/';
  const max = prefix + 'a'.repeat(2048 - prefix.length);
  assert.equal(normalizeResultReferenceUrl(max), max);
  const invalid: unknown[] = [
    undefined,
    null,
    123,
    '',
    ' ',
    'example.invalid/report',
    '//example.invalid/report',
    'javascript:alert(1)',
    'data:text/html,content',
    'file:///tmp/report',
    'ftp://example.invalid/report',
    'https:example.invalid',
    'https:///example.invalid',
    'https://',
    'https://user@example.invalid/report',
    'https://user:password@example.invalid/report',
    'https://:password@example.invalid/report',
    'https://@example.invalid/report',
    'https://example.invalid/report?',
    'https://example.invalid/report?build=1',
    'https://example.invalid/report?#summary',
    'https://example.invalid/report?token=fictional',
    'https://example.invalid/\\report',
    'https://example.invalid/%5creport',
    'https://example.invalid/%255creport',
    'https://example.invalid/%0areport',
    'https://example.invalid/%250Dreport',
    'https://example.invalid/%C2%85report',
    'https://example.invalid/%E2%80%A8report',
    'https://example.invalid/%FF',
    'https://example.invalid/#token=fictional',
    'https://example.invalid/#access_token=fake',
    'https://example.invalid/#api-key:fake',
    'https://example.invalid/#authorization/bearer',
    'https://example.invalid/#github_pat_fictional',
    'https://example.invalid/#ghp_fictional',
    'https://example.invalid/#sk-fictional',
    'https://example.invalid/#eyJabc.def.ghi',
    'https://example.invalid/#%74oken%3Dfictional',
    'https://example.invalid/#%2574oken%253Dfictional',
    'https://example.invalid/#%252525252574oken%25252525253Dfictional',
    max + 'a',
    prefix + '中'.repeat(226),
  ];
  for (const control of ['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'])
    invalid.push(`${prefix}${control}report`);
  for (const value of invalid)
    assert.throws(
      () => normalizeResultReferenceUrl(value),
      { code: 'INVALID_INPUT' },
      String(value),
    );
});

test('撤回和分页契约拒绝重登记、编辑、伪造目标及非规范分页', () => {
  assert.deepEqual(parseResultReferenceLifecycle(withdrawal), withdrawal);
  for (const value of [
    null,
    [],
    {},
    { ...withdrawal, action: 'restore' },
    { ...withdrawal, title: '覆盖' },
    { ...withdrawal, url: input.url },
    { ...withdrawal, resultRevisionId: randomUUID() },
    { ...withdrawal, expectedRevision: 0 },
    { ...withdrawal, expectedRevision: 1.1 },
    { ...withdrawal, expectedRevision: '1' },
    { ...withdrawal, expectedResultRevision: 0 },
    { ...withdrawal, expectedResultRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => parseResultReferenceLifecycle(value), { code: 'INVALID_INPUT' });
  assert.deepEqual(parseResultReferenceListQuery({}), { cursor: null, limit: 20 });
  const cursor = randomUUID();
  assert.deepEqual(parseResultReferenceListQuery({ cursor, limit: '50' }), { cursor, limit: 50 });
  for (const value of [
    null,
    [],
    { extra: true },
    { cursor: '' },
    { cursor: '../cursor' },
    { cursor: 'a'.repeat(101) },
    { cursor: 1 },
    { limit: 1 },
    { limit: '0' },
    { limit: '01' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: ' 1' },
    { limit: '1e1' },
    { limit: '51' },
    { limit: String(Number.MAX_SAFE_INTEGER + 1) },
  ])
    assert.throws(() => parseResultReferenceListQuery(value), { code: 'INVALID_INPUT' });
});

test('登记固定版本与当前作者，仅保存未核验元数据，不联网或修改Task/Run/成果与执行状态', async (t) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const before = snapshots(f.api.store, untouchedTables);
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Manual result references must not fetch external content');
    });
    for (const kind of ['report', 'release'] as const) {
      const response = await f.api.call(f.path, f.bob, { ...input, kind });
      assert.equal(response.statusCode, 201, response.body);
      const reference = response.json<ResultReference>();
      assert.equal(reference.taskId, f.task.id);
      assert.equal(reference.resultId, f.result.id);
      assert.equal(reference.resultRevisionId, f.version.id);
      assert.equal(reference.resultRevision, 1);
      assert.equal(reference.kind, kind);
      assert.equal(reference.title, input.title);
      assert.equal(reference.url, input.url);
      assert.equal(reference.environment, input.environment);
      assert.equal(reference.revision, 1);
      assert.equal(reference.status, 'active');
      assert.equal(reference.availability, 'unverified');
      assert.equal(reference.publication, 'unverified');
      assert.equal(reference.withdrawnAt, null);
      assert.equal(reference.withdrawnBy, null);
      assert.deepEqual(reference.source, {
        kind: 'member',
        actor: { id: f.bob.user.id, name: f.bob.user.name },
      });
      assert(Number.isFinite(Date.parse(reference.createdAt)));
      assert.deepEqual((await f.api.call(`${f.path}/${reference.id}`, f.alice)).json(), reference);
    }
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(snapshots(f.api.store, untouchedTables), before);
    const allBeforeRead = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    const page = await f.api.call(f.path, f.bob);
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json<ResultReferencePage>().items.length, 2);
    assert.equal(page.json<ResultReferencePage>().nextCursor, null);
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), allBeforeRead);
    const events = f.api.store.db
      .prepare("SELECT task_id,space_id FROM outbox WHERE kind='result.reference_registered'")
      .all();
    assert.deepEqual(
      events.map((event) => ({ ...event })),
      Array.from({ length: 2 }, () => ({ task_id: f.task.id, space_id: f.task.spaceId })),
    );
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('新成果版本不挪动旧关联；跨Task/Result/版本身份及错误版本号拒绝且无写入', async () => {
  const f = await fixture();
  try {
    const reference = f.as(() => f.refs.create(f.result.id, f.version.id, input, randomUUID()));
    const next = f.as(() =>
      new MemberResultVersions(f.api.store).save(
        f.result.id,
        {
          expectedRevision: 1,
          expectedRevisionId: f.version.id,
          title: '第二版',
          body: '新的正文',
        },
        randomUUID(),
      ),
    );
    const nextPath = referencePath(f.result.id, next.revisionId);
    assert.deepEqual((await f.api.call(nextPath, f.alice)).json(), { items: [], nextCursor: null });
    const old = await f.api.call(f.path, f.alice, { ...input, title: '仍然适用于第一版' });
    assert.equal(old.statusCode, 201, old.body);
    assert.equal(old.json<ResultReference>().resultRevisionId, f.version.id);
    assert.equal(old.json<ResultReference>().resultRevision, 1);
    const otherTask = await f.api.task(f.alice, f.project.id);
    const otherResult = f.as(() =>
      f.api.store.createResult(otherTask.id, '另一个成果', '正文', randomUUID()),
    );
    const otherVersion = f.as(() => new ResultRevisions(f.api.store).current(otherResult));
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const path of [
      referencePath(otherResult.id, f.version.id),
      referencePath(f.result.id, otherVersion.id),
      referencePath(f.result.id, randomUUID()),
      referencePath(randomUUID(), f.version.id),
    ]) {
      assert.equal((await f.api.call(path, f.alice)).statusCode, 404);
      assert.equal((await f.api.call(path, f.alice, input)).statusCode, 404);
      assert.equal((await f.api.call(`${path}/${reference.id}`, f.alice)).statusCode, 404);
      assert.equal(
        (await f.api.call(`${path}/${reference.id}/lifecycle`, f.alice, withdrawal)).statusCode,
        404,
      );
    }
    assert.equal((await f.api.call(`${nextPath}/${reference.id}`, f.alice)).statusCode, 404);
    assert.equal(
      (
        await f.api.call(`${nextPath}/${reference.id}/lifecycle`, f.alice, {
          ...withdrawal,
          expectedResultRevision: 2,
        })
      ).statusCode,
      404,
    );
    for (const [path, version] of [
      [f.path, 2],
      [nextPath, 1],
    ] as const) {
      const response = await f.api.call(path, f.alice, {
        ...input,
        expectedResultRevision: version,
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'REVISION_CONFLICT');
    }
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    const current = await f.api.call(nextPath, f.alice, {
      ...input,
      expectedResultRevision: 2,
      kind: 'release',
    });
    assert.equal(current.statusCode, 201, current.body);
    assert.equal(current.json<ResultReference>().resultRevision, 2);
    assert.deepEqual(
      f.as(() => new ResultRevisions(f.api.store).get(f.result.id, f.version.id)),
      f.version,
    );
  } finally {
    await f.close();
  }
});

test('撤回保留登记原文与双方历史署名，旧登记回执返回现状，不能恢复或覆盖原关联', async () => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const registerKey = randomUUID(),
      withdrawKey = randomUUID();
    const original = (
      await f.api.call(f.path, f.alice, input, registerKey)
    ).json<ResultReference>();
    const originalBody = f.api.store.db
      .prepare('SELECT body FROM result_references WHERE id=?')
      .get(original.id);
    const untouched = snapshots(f.api.store, untouchedTables);
    const path = `${f.path}/${original.id}/lifecycle`;
    const response = await f.api.call(path, f.bob, withdrawal, withdrawKey);
    assert.equal(response.statusCode, 200, response.body);
    const withdrawn = response.json<ResultReference>();
    assert.deepEqual(withdrawn, {
      ...original,
      revision: 2,
      status: 'withdrawn',
      withdrawnAt: withdrawn.withdrawnAt,
      withdrawnBy: { id: f.bob.user.id, name: f.bob.user.name },
    });
    assert(Number.isFinite(Date.parse(withdrawn.withdrawnAt!)));
    assert.deepEqual(
      f.api.store.db.prepare('SELECT body FROM result_references WHERE id=?').get(original.id),
      originalBody,
    );
    const events = f.api.store.db
      .prepare(
        'SELECT revision,action,body FROM result_reference_events WHERE reference_id=? ORDER BY revision',
      )
      .all(original.id);
    assert.deepEqual(
      events.map((event) => ({
        revision: event.revision,
        action: event.action,
        body: JSON.parse(event.body as string),
      })),
      [
        { revision: 1, action: 'registered', body: original },
        { revision: 2, action: 'withdrawn', body: withdrawn },
      ],
    );
    const beforeReplay = snapshots(f.api.store, writeTables);
    assert.deepEqual((await f.api.call(f.path, f.alice, input, registerKey)).json(), withdrawn);
    assert.deepEqual((await f.api.call(path, f.bob, withdrawal, withdrawKey)).json(), withdrawn);
    assert.deepEqual((await f.api.call(`${f.path}/${original.id}`, f.alice)).json(), withdrawn);
    assert.deepEqual((await f.api.call(f.path, f.alice)).json<ResultReferencePage>().items, [
      withdrawn,
    ]);
    const stale = await f.api.call(path, f.bob, withdrawal);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'REVISION_CONFLICT');
    const repeated = await f.api.call(path, f.bob, { ...withdrawal, expectedRevision: 2 });
    assert.equal(repeated.statusCode, 409, repeated.body);
    assert.equal(repeated.json().error.code, 'REFERENCE_WITHDRAWN');
    assert.equal(
      (await f.api.call(path, f.bob, { ...withdrawal, action: 'restore' })).statusCode,
      400,
    );
    const changedReplay = await f.api.call(
      path,
      f.bob,
      { ...withdrawal, expectedRevision: 2 },
      withdrawKey,
    );
    assert.equal(changedReplay.statusCode, 409, changedReplay.body);
    assert.equal(changedReplay.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(snapshots(f.api.store, writeTables), beforeReplay);
    assert.deepEqual(snapshots(f.api.store, untouchedTables), untouched);
    const replacement = await f.api.call(f.path, f.alice, {
      ...input,
      url: 'https://reports.example.invalid/corrected',
    });
    assert.equal(replacement.statusCode, 201, replacement.body);
    assert.notEqual(replacement.json<ResultReference>().id, original.id);
    assert.equal((await f.api.call(f.path, f.alice)).json<ResultReferencePage>().items.length, 2);
    const outbox = f.api.store.db
      .prepare("SELECT task_id,space_id FROM outbox WHERE kind='result.reference_withdrawn'")
      .all();
    assert.deepEqual(
      outbox.map((event) => ({ ...event })),
      [{ task_id: f.task.id, space_id: f.task.spaceId }],
    );
  } finally {
    await f.close();
  }
});

test('数据库强制原始正文与锚点不可变、不可删除，事件不可改写且撤回不能倒退', async () => {
  const f = await fixture();
  try {
    const reference = f.as(() => f.refs.create(f.result.id, f.version.id, input, randomUUID()));
    const before = snapshots(f.api.store, writeTables);
    for (const field of ['id', 'task_id', 'result_id', 'result_revision_id', 'body'])
      assert.throws(() =>
        f.api.store.db
          .prepare(`UPDATE result_references SET ${field}=? WHERE id=?`)
          .run(field === 'body' ? '{}' : randomUUID(), reference.id),
      );
    assert.throws(() =>
      f.api.store.db.prepare('DELETE FROM result_references WHERE id=?').run(reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare('UPDATE result_references SET revision=2 WHERE id=?')
        .run(reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare("UPDATE result_references SET status='withdrawn' WHERE id=?")
        .run(reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare("UPDATE result_reference_events SET body='{}' WHERE reference_id=?")
        .run(reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare('DELETE FROM result_reference_events WHERE reference_id=?')
        .run(reference.id),
    );
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    f.as(() => f.refs.lifecycle(f.result.id, f.version.id, reference.id, withdrawal, randomUUID()));
    const withdrawn = snapshots(f.api.store, writeTables);
    assert.throws(() =>
      f.api.store.db
        .prepare(
          "UPDATE result_references SET revision=1,status='active',withdrawn_at=NULL,withdrawn_by=NULL WHERE id=?",
        )
        .run(reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare('UPDATE result_references SET withdrawn_at=? WHERE id=?')
        .run('2099-01-01', reference.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare(
          "UPDATE result_reference_events SET action='registered' WHERE reference_id=? AND revision=2",
        )
        .run(reference.id),
    );
    assert.deepEqual(snapshots(f.api.store, writeTables), withdrawn);
  } finally {
    await f.close();
  }
});

test('HTTP允许上限CJK及JSON转义，拒绝超字符/24KiB/4KiB、未知字段与无效幂等键', async () => {
  const f = await fixture();
  try {
    const prefix = 'https://reports.example.invalid/';
    const full = {
      ...input,
      title: '题'.repeat(160),
      environment: '中'.repeat(240),
      url: prefix + 'a'.repeat(2048 - prefix.length),
    };
    const first = await f.api.call(f.path, f.alice, full);
    assert.equal(first.statusCode, 201, first.body);
    const escaped = JSON.stringify(full).replace(
      /[题中]/g,
      (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    const inject = (path: string, payload: string) =>
      f.api.app.inject({
        method: 'POST',
        url: '/api/v1/' + path,
        headers: {
          cookie: f.alice.cookie,
          'x-hexu-space': f.alice.spaceId,
          origin: ORIGIN,
          'x-hexu-client': 'web',
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload,
      });
    assert.equal((await inject(f.path, escaped)).statusCode, 201);
    const lifecyclePath = `${f.path}/${first.json<ResultReference>().id}/lifecycle`;
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const [body, status] of [
      [{ ...input, title: '题'.repeat(161) }, 400],
      [{ ...input, environment: '中'.repeat(241) }, 400],
      [{ ...input, url: full.url + 'a' }, 400],
      [{ ...input, environment: '中'.repeat(9000) }, 413],
      [{ ...input, source: { kind: 'member' } }, 400],
      [{ ...input, publication: 'published' }, 400],
      [{ ...input, status: 'active' }, 400],
    ] as const) {
      const response = await f.api.call(f.path, f.alice, body);
      assert.equal(response.statusCode, status, response.body);
    }
    assert.equal(
      (await inject(f.path, JSON.stringify(input) + ' '.repeat(24 * 1024))).statusCode,
      413,
    );
    assert.equal(
      (await inject(lifecyclePath, JSON.stringify(withdrawal) + ' '.repeat(4096))).statusCode,
      413,
    );
    assert.equal(
      (await f.api.call(lifecyclePath, f.alice, { ...withdrawal, url: input.url })).statusCode,
      400,
    );
    for (const key of ['', 'a'.repeat(129), 'invalid/key']) {
      assert.equal((await f.api.call(f.path, f.alice, input, key)).statusCode, 400);
      assert.equal((await f.api.call(lifecyclePath, f.alice, withdrawal, key)).statusCode, 400);
    }
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    const exactRegister = await inject(
      f.path,
      JSON.stringify(input) + ' '.repeat(24 * 1024 - Buffer.byteLength(JSON.stringify(input))),
    );
    assert.equal(exactRegister.statusCode, 201, exactRegister.body);
    const exactWithdraw = await inject(lifecyclePath, JSON.stringify(withdrawal).padEnd(4096, ' '));
    assert.equal(exactWithdraw.statusCode, 200, exactWithdraw.body);
  } finally {
    await f.close();
  }
});

test('当前只读、撤权、跨空间与会话边界约束列表/直接读取/新写入和登记及撤回旧回执', async () => {
  const f = await fixture();
  try {
    const member = `projects/${f.project.id}/members/${f.bob.user.id}`;
    await f.api.call(member, f.alice, { role: 'edit' });
    const key = randomUUID(),
      withdrawKey = randomUUID();
    const reference = (await f.api.call(f.path, f.bob, input, key)).json<ResultReference>();
    const path = `${f.path}/${reference.id}/lifecycle`;
    assert.equal((await f.api.call(path, f.bob, withdrawal, withdrawKey)).statusCode, 200);
    await f.api.call(member, f.alice, { role: 'view' });
    const before = snapshots(f.api.store, writeTables);
    for (const suffix of ['', `/${reference.id}`, `?cursor=${reference.id}`])
      assert.equal((await f.api.call(f.path + suffix, f.bob)).statusCode, 200);
    for (const k of [key, randomUUID()])
      assert.equal((await f.api.call(f.path, f.bob, input, k)).statusCode, 403);
    for (const k of [withdrawKey, randomUUID()])
      assert.equal((await f.api.call(path, f.bob, withdrawal, k)).statusCode, 403);
    assert.deepEqual(snapshots(f.api.store, writeTables), before);
    await f.api.call(member, f.alice, { role: null });
    const revoked = snapshots(f.api.store, writeTables);
    for (const [account, status] of [
      [f.bob, 404],
      [null, 401],
      [{ ...f.alice, spaceId: `personal-${f.alice.user.id}` }, 404],
    ] as const) {
      for (const suffix of ['', `/${reference.id}`, `?cursor=${reference.id}`])
        assert.equal((await f.api.call(f.path + suffix, account)).statusCode, status);
      assert.equal((await f.api.call(f.path, account, input, key)).statusCode, status);
      assert.equal((await f.api.call(path, account, withdrawal, withdrawKey)).statusCode, status);
    }
    assert.deepEqual(snapshots(f.api.store, writeTables), revoked);
    await f.api.call(member, f.alice, { role: 'edit' });
    f.api.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(f.bob.spaceId, f.bob.user.id);
    assert.equal((await f.api.call(f.path, f.bob)).statusCode, 403);
    assert.equal((await f.api.call(f.path, f.bob, input, key)).statusCode, 403);
    assert.equal((await f.api.call(path, f.bob, withdrawal, withdrawKey)).statusCode, 403);
    assert.equal((await f.api.call('identity/sign-out', f.alice, {})).statusCode, 200);
    assert.equal((await f.api.call(f.path, f.alice)).statusCode, 401);
    assert.equal((await f.api.call(f.path, f.alice, input, key)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('私有Task关联不向项目成员或空间所有者泄露', async () => {
  const f = await fixture(true);
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const reference = f.as(() => f.refs.create(f.result.id, f.version.id, input, randomUUID()));
    const bobsTask = await f.api.task(f.bob);
    const bobs = f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () => {
      const result = f.api.store.createResult(bobsTask.id, '乙的私有成果', '正文', randomUUID());
      const version = new ResultRevisions(f.api.store).current(result);
      return {
        result,
        version,
        reference: f.refs.create(result.id, version.id, input, randomUUID()),
      };
    });
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const [path, id, account] of [
      [f.path, reference.id, f.bob],
      [referencePath(bobs.result.id, bobs.version.id), bobs.reference.id, f.alice],
    ] as const) {
      assert.equal((await f.api.call(path, account)).statusCode, 404);
      assert.equal((await f.api.call(`${path}/${id}`, account)).statusCode, 404);
      assert.equal((await f.api.call(`${path}?cursor=${id}`, account)).statusCode, 404);
      assert.equal((await f.api.call(path, account, input)).statusCode, 404);
      assert.equal(
        (await f.api.call(`${path}/${id}/lifecycle`, account, withdrawal)).statusCode,
        404,
      );
    }
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
  } finally {
    await f.close();
  }
});

test('事务内再次核对编辑权，新登记/撤回与两类原回执均不能越过同时撤权', async (t) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const key = randomUUID(),
      withdrawKey = randomUUID();
    const reference = (await f.api.call(f.path, f.bob, input, key)).json<ResultReference>();
    const path = `${f.path}/${reference.id}/lifecycle`;
    assert.equal((await f.api.call(path, f.bob, withdrawal, withdrawKey)).statusCode, 200);
    const active = (await f.api.call(f.path, f.bob, input)).json<ResultReference>();
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
            f.api.store.db
              .prepare(
                "UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?",
              )
              .run(f.project.id, f.bob.user.id);
            beforeReplay?.();
          },
          onReplay,
        ),
    );
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const k of [key, randomUUID()]) {
      const response = await f.api.call(f.path, f.bob, input, k);
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    }
    for (const [id, k] of [
      [reference.id, withdrawKey],
      [active.id, randomUUID()],
    ] as const) {
      const response = await f.api.call(`${f.path}/${id}/lifecycle`, f.bob, withdrawal, k);
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('登记和撤回的投影、事件、outbox或回执任一步失败均回滚，原键可安全重试', async () => {
  const f = await fixture();
  try {
    for (const action of ['register', 'withdraw'] as const) {
      for (const table of writeTables) {
        const reference =
          action === 'withdraw'
            ? f.as(() => f.refs.create(f.result.id, f.version.id, input, randomUUID()))
            : null;
        const path = reference ? `${f.path}/${reference.id}/lifecycle` : f.path;
        const body = reference ? withdrawal : input;
        const key = randomUUID();
        const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
        f.api.store.db
          .exec(`CREATE TRIGGER fail_reference BEFORE ${table === 'result_references' && reference ? 'UPDATE' : 'INSERT'} ON ${table}
          BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
        const failed = await f.api.call(path, f.alice, body, key);
        assert.equal(failed.statusCode, 500, `${action}/${table}: ${failed.body}`);
        f.api.store.db.exec('DROP TRIGGER fail_reference');
        assert.deepEqual(
          snapshots(f.api.store, [...writeTables, ...untouchedTables]),
          before,
          `${action}/${table}`,
        );
        const retry = await f.api.call(path, f.alice, body, key);
        assert.equal(retry.statusCode, reference ? 200 : 201, retry.body);
        assert.equal(retry.json<ResultReference>().status, reference ? 'withdrawn' : 'active');
      }
    }
  } finally {
    await f.close();
  }
});

test('并发同键登记只提交一份，相同键不同内容冲突；并发撤回只提交一次且作用域按作者隔离', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const same = await Promise.all([
      f.api.call(f.path, f.alice, input, key),
      f.api.call(f.path, f.alice, input, key),
    ]);
    assert(same.every((response) => response.statusCode === 201));
    assert.deepEqual(same[0]!.json(), same[1]!.json());
    assert.equal((await f.api.call(f.path, f.alice)).json<ResultReferencePage>().items.length, 1);
    const conflictKey = randomUUID();
    const inputs = [
      { ...input, title: '并发甲' },
      { ...input, title: '并发乙' },
    ];
    const competing = await Promise.all(
      inputs.map((value) => f.api.call(f.path, f.alice, value, conflictKey)),
    );
    assert.deepEqual(competing.map((response) => response.statusCode).sort(), [201, 409]);
    const winner = competing.findIndex((response) => response.statusCode === 201);
    const loser = competing.find((response) => response.statusCode === 409)!;
    assert.equal(loser.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(
      (await f.api.call(f.path, f.alice, inputs[winner]!, conflictKey)).json(),
      competing[winner]!.json(),
    );
    const reference = same[0]!.json<ResultReference>();
    const path = `${f.path}/${reference.id}/lifecycle`;
    const withdrawals = await Promise.all([
      f.api.call(path, f.alice, withdrawal),
      f.api.call(path, f.alice, withdrawal),
    ]);
    assert.deepEqual(withdrawals.map((response) => response.statusCode).sort(), [200, 409]);
    const second = competing[winner]!.json<ResultReference>();
    const withdrawKey = randomUUID();
    const sameWithdrawal = await Promise.all([
      f.api.call(`${f.path}/${second.id}/lifecycle`, f.alice, withdrawal, withdrawKey),
      f.api.call(`${f.path}/${second.id}/lifecycle`, f.alice, withdrawal, withdrawKey),
    ]);
    assert(sameWithdrawal.every((response) => response.statusCode === 200));
    assert.deepEqual(sameWithdrawal[0]!.json(), sameWithdrawal[1]!.json());
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const bob = await f.api.call(f.path, f.bob, input, key);
    assert.equal(bob.statusCode, 201, bob.body);
    assert.notEqual(bob.json<ResultReference>().id, reference.id);
    assert.equal(bob.json<ResultReference>().source.actor.id, f.bob.user.id);
    assert.equal((await f.api.call(f.path, f.alice)).json<ResultReferencePage>().items.length, 3);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS count FROM result_reference_events').get()!.count,
      5,
    );
  } finally {
    await f.close();
  }
});

test('重启后登记/撤回原键保留原身份及当前撤回状态，原始事件和回执不追加', async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const key = randomUUID(),
      withdrawKey = randomUUID();
    const original = (await f.api.call(f.path, f.alice, input, key)).json<ResultReference>();
    const withdrawn = (
      await f.api.call(`${f.path}/${original.id}/lifecycle`, f.alice, withdrawal, withdrawKey)
    ).json<ResultReference>();
    f.as(() =>
      new MemberResultVersions(f.api.store).save(
        f.result.id,
        {
          expectedRevision: 1,
          expectedRevisionId: f.version.id,
          title: '第二版',
          body: '新的正文',
        },
        randomUUID(),
      ),
    );
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    await f.api.app.close();
    reopened = new Store(f.api.dbPath, undefined, { team: true });
    const store = reopened;
    store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
      const refs = new ResultReferences(store);
      assert.deepEqual(refs.create(f.result.id, f.version.id, input, key), withdrawn);
      assert.deepEqual(
        refs.lifecycle(f.result.id, f.version.id, original.id, withdrawal, withdrawKey),
        withdrawn,
      );
      assert.deepEqual(refs.list(f.result.id, f.version.id, { cursor: null, limit: 20 }), {
        items: [withdrawn],
        nextCursor: null,
      });
      assert.equal(store.result(f.result.id).revision, 2);
      assert.deepEqual(new ResultRevisions(store).get(f.result.id, f.version.id), f.version);
    });
    assert.deepEqual(snapshots(store, [...writeTables, ...untouchedTables]), before);
  } finally {
    reopened?.close();
    await f.close();
  }
});

test('游标分页有界且稳定，包含撤回历史；新增记录不挤乱后页，跨版本/跨任务游标和撤权拒绝', async () => {
  const f = await fixture();
  try {
    const references = Array.from({ length: 53 }, (_, i) =>
      f.as(() =>
        f.refs.create(f.result.id, f.version.id, { ...input, title: `报告 ${i}` }, randomUUID()),
      ),
    );
    const first = (await f.api.call(f.path, f.alice)).json<ResultReferencePage>();
    assert.deepEqual(
      first.items.map((item) => item.id),
      references
        .slice(-20)
        .reverse()
        .map((item) => item.id),
    );
    assert.equal(first.nextCursor, references[33]!.id);
    const withdrawn = f.as(() =>
      f.refs.lifecycle(f.result.id, f.version.id, references[32]!.id, withdrawal, randomUUID()),
    );
    f.as(() =>
      f.refs.create(f.result.id, f.version.id, { ...input, title: '分页之后新增' }, randomUUID()),
    );
    const second = (
      await f.api.call(`${f.path}?cursor=${first.nextCursor}`, f.alice)
    ).json<ResultReferencePage>();
    assert.deepEqual(
      second.items.map((item) => item.id),
      references
        .slice(13, 33)
        .reverse()
        .map((item) => item.id),
    );
    assert.deepEqual(second.items[0], withdrawn);
    assert.equal(second.nextCursor, references[13]!.id);
    const third = (
      await f.api.call(`${f.path}?cursor=${second.nextCursor}`, f.alice)
    ).json<ResultReferencePage>();
    assert.deepEqual(
      third.items.map((item) => item.id),
      references
        .slice(0, 13)
        .reverse()
        .map((item) => item.id),
    );
    assert.equal(third.nextCursor, null);
    assert.equal(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size,
      53,
    );
    assert.deepEqual((await f.api.call(`${f.path}?cursor=${references[0]!.id}`, f.alice)).json(), {
      items: [],
      nextCursor: null,
    });
    const maximum = (await f.api.call(`${f.path}?limit=50`, f.alice)).json<ResultReferencePage>();
    assert.equal(maximum.items.length, 50);
    assert(maximum.nextCursor);
    const one = (await f.api.call(`${f.path}?limit=1`, f.alice)).json<ResultReferencePage>();
    assert.equal(one.items.length, 1);
    assert.equal(one.nextCursor, one.items[0]!.id);
    const next = f.as(() =>
      new MemberResultVersions(f.api.store).save(
        f.result.id,
        {
          expectedRevision: 1,
          expectedRevisionId: f.version.id,
          title: '第二版',
          body: '下一版正文',
        },
        randomUUID(),
      ),
    );
    const otherTask = await f.api.task(f.alice, f.project.id);
    const otherResult = f.as(() =>
      f.api.store.createResult(otherTask.id, '其他成果', '正文', randomUUID()),
    );
    const otherVersion = f.as(() => new ResultRevisions(f.api.store).current(otherResult));
    const before = snapshots(f.api.store, [...writeTables, ...untouchedTables]);
    for (const path of [
      referencePath(f.result.id, next.revisionId),
      referencePath(otherResult.id, otherVersion.id),
    ])
      assert.equal(
        (await f.api.call(`${path}?cursor=${first.nextCursor}`, f.alice)).statusCode,
        404,
      );
    assert.equal((await f.api.call(`${f.path}?cursor=${randomUUID()}`, f.alice)).statusCode, 404);
    for (const query of [
      'limit=51',
      'limit=0',
      'limit=01',
      'limit=1.5',
      'limit=1&limit=2',
      'cursor=..%2Fbad',
      'extra=true',
    ])
      assert.equal((await f.api.call(`${f.path}?${query}`, f.alice)).statusCode, 400);
    assert.deepEqual(snapshots(f.api.store, [...writeTables, ...untouchedTables]), before);
    const member = `projects/${f.project.id}/members/${f.bob.user.id}`;
    await f.api.call(member, f.alice, { role: 'view' });
    assert.equal((await f.api.call(`${f.path}?cursor=${first.nextCursor}`, f.bob)).statusCode, 200);
    await f.api.call(member, f.alice, { role: null });
    assert.equal((await f.api.call(`${f.path}?cursor=${first.nextCursor}`, f.bob)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('迁移37保留既有成果/版本/反馈和任务状态，不推断报告或发布事实，重开不重复迁移', async () => {
  const f = await fixture();
  try {
    const feedback = f.as(() =>
      f.api.store.addMessage(f.task.id, '固定旧版的反馈', f.result.id, randomUUID(), f.version.id),
    );
    const before = snapshots(f.api.store, [...untouchedTables, 'outbox', 'idempotency_records']);
    const path = join(f.api.dir, 'migration36.sqlite');
    f.api.store.db.prepare('VACUUM INTO ?').run(path);
    const db = new DatabaseSync(path);
    try {
      // Migration 37 is additive; removing only its empty objects recreates the prior schema.
      db.exec(
        'DROP TABLE result_reference_events; DROP TABLE result_references; DELETE FROM schema_migrations WHERE version=37;',
      );
      assert.equal(
        db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version,
        36,
      );
    } finally {
      db.close();
    }
    for (let opening = 0; opening < 2; opening++) {
      const upgraded = new Store(path, undefined, { team: true });
      try {
        assert.equal(
          upgraded.db
            .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=37')
            .get()!.count,
          1,
        );
        assert.deepEqual(
          snapshots(upgraded, [...untouchedTables, 'outbox', 'idempotency_records']),
          before,
        );
        assert.equal(
          upgraded.db.prepare('SELECT COUNT(*) AS count FROM result_references').get()!.count,
          0,
        );
        assert.equal(
          upgraded.db.prepare('SELECT COUNT(*) AS count FROM result_reference_events').get()!.count,
          0,
        );
        upgraded.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
          assert.deepEqual(
            new ResultReferences(upgraded).list(f.result.id, f.version.id, {
              cursor: null,
              limit: 20,
            }),
            { items: [], nextCursor: null },
          );
          const detail = new ResultRevisions(upgraded).detail(f.result.id, f.version.id);
          assert.deepEqual(detail.version, f.version);
          assert.deepEqual(detail.messages, [feedback]);
        });
        assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        upgraded.close();
      }
    }
  } finally {
    await f.close();
  }
});
