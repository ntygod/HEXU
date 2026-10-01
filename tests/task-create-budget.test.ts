import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseTaskCreate, type Task } from '../packages/contracts/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { createApp } from '../apps/control/src/app.js';
import { ORIGIN, teamFixture, type Account } from './helpers/team.js';

const headers = (key: string = randomUUID()) => ({
  'content-type': 'application/json',
  'x-hexu-client': 'web',
  'idempotency-key': key,
});
const maximum = { title: '题'.repeat(160), description: '文'.repeat(12000) };
const writeTables = [
  'tasks',
  'task_content_revisions',
  'metadata',
  'outbox',
  'idempotency_records',
];
function snapshot(store: Store, except: string[] = []) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables
      .filter(({ name }) => !except.includes(name))
      .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
  );
}
// Escape every UTF-16 code unit in both keys and values, including surrogate pairs.
function escapedJson(value: unknown): string {
  return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, (token) => {
    const decoded = JSON.parse(token) as string;
    return `"${decoded
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')}"`;
  });
}
function padBody(body: string, bytes: number) {
  const padded = body + ' '.repeat(bytes - Buffer.byteLength(body));
  assert.equal(Buffer.byteLength(padded), bytes);
  return padded;
}

test('创建契约仍以UTF-16长度限制160/12000/100，最坏JSON转义包含键仍小于96KiB', () => {
  for (const unit of ['字', '😀']) {
    const payload = {
      title: unit.repeat(160 / unit.length),
      description: unit.repeat(12000 / unit.length),
      projectId: unit.repeat(100 / unit.length),
    };
    const escaped = escapedJson(payload);
    assert.equal(Buffer.byteLength(escaped), (160 + 12000 + 100 + 5 + 11 + 9) * 6 + 19);
    assert.ok(Buffer.byteLength(escaped) < 96 * 1024);
    assert.deepEqual(JSON.parse(escaped), payload);
    assert.deepEqual(parseTaskCreate(JSON.parse(escaped)), payload);
    for (const field of ['title', 'description', 'projectId'] as const)
      assert.throws(() => parseTaskCreate({ ...payload, [field]: payload[field] + '字' }), {
        code: 'INVALID_INPUT',
      });
  }
  assert.deepEqual(parseTaskCreate({ title: ' 标题 ' }), {
    title: '标题',
    description: '',
    projectId: null,
  });
});

test('真实HTTP接受最大原文及全JSON转义，保持私有/项目归属、默认值及同请求幂等', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const project = store.createProject({ name: '预算测试项目', description: '' }, 'project');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${origin}/api/v1/spaces/${store.spaceId}/tasks`;
    const unaffected = snapshot(store, writeTables);
    for (const projectId of [null, project.id]) {
      for (const values of [maximum, { title: '😀'.repeat(80), description: '😀'.repeat(6000) }]) {
        const payload = { ...values, projectId };
        for (const serialize of [JSON.stringify, escapedJson]) {
          const body = serialize(payload);
          if (values === maximum || serialize === escapedJson)
            assert.ok(Buffer.byteLength(body) > 32768);
          assert.ok(Buffer.byteLength(body) < 96 * 1024);
          const key = randomUUID();
          const count = store.tasks().length;
          const cursor = store.events(0).cursor;
          const response = await fetch(url, { method: 'POST', headers: headers(key), body });
          assert.equal(response.status, 201, await response.clone().text());
          const created = (await response.json()) as Task;
          assert.equal(created.title, payload.title);
          assert.equal(created.description, payload.description);
          assert.equal(created.projectId, projectId);
          assert.equal(created.spaceId, store.spaceId);
          assert.equal(created.visibility, projectId ? 'project' : 'private');
          assert.equal(created.ownerUserId, store.actorId);
          assert.equal(created.createdByUserId, store.actorId);
          assert.equal(created.status, 'todo');
          assert.equal(created.attention, null);
          assert.equal(created.revision, 1);
          assert.equal(created.feedbackOrigin, undefined);
          const history = store.taskContentHistory.history(created.id, {
            limit: 10,
            before: null,
          }).items;
          assert.equal(history.length, 1);
          assert.equal(history[0]!.title, payload.title);
          assert.equal(history[0]!.description, payload.description);
          assert.equal(history[0]!.actorId, store.actorId);
          assert.equal(history[0]!.source, 'created');
          assert.equal(store.tasks().length, count + 1);
          assert.deepEqual(
            store.events(cursor).events.map((event) => [event.taskId, event.kind]),
            [[created.id, 'task.created']],
          );
          assert.deepEqual(snapshot(store, writeTables), unaffected);
          const after = snapshot(store);
          const replay = await fetch(url, {
            method: 'POST',
            headers: headers(key),
            body: escapedJson(payload),
          });
          assert.equal(replay.status, 201, await replay.clone().text());
          assert.deepEqual(await replay.json(), created);
          const conflict = await fetch(url, {
            method: 'POST',
            headers: headers(key),
            body: JSON.stringify({ ...payload, title: '不同内容' }),
          });
          assert.equal(conflict.status, 409, await conflict.text());
          assert.deepEqual(snapshot(store), after);
        }
      }
    }
  } finally {
    await app.close();
  }
});

test('真实HTTP创建只接受至98304字节，无关评论路由仍严格保持32768字节', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${origin}/api/v1/spaces/${store.spaceId}/tasks`;
    const body = padBody(escapedJson({ ...maximum, projectId: null }), 98304);
    const accepted = await fetch(url, { method: 'POST', headers: headers(), body });
    assert.equal(accepted.status, 201, await accepted.clone().text());
    const created = (await accepted.json()) as Task;
    const before = snapshot(store);
    const rejected = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: body + ' ',
    });
    assert.equal(rejected.status, 413, await rejected.text());
    assert.deepEqual(snapshot(store), before);
    const commentUrl = `${origin}/api/v1/tasks/${created.id}/messages`;
    const comment = padBody(JSON.stringify({ body: '仍使用默认预算' }), 32768);
    const acceptedComment = await fetch(commentUrl, {
      method: 'POST',
      headers: headers(),
      body: comment,
    });
    assert.equal(acceptedComment.status, 201, await acceptedComment.text());
    const afterComment = snapshot(store);
    const rejectedComment = await fetch(commentUrl, {
      method: 'POST',
      headers: headers(),
      body: comment + ' ',
    });
    assert.equal(rejectedComment.status, 413, await rejectedComment.text());
    assert.deepEqual(snapshot(store), afterComment);
  } finally {
    await app.close();
  }
});

test('更大预算不放宽创建字段、类型、字符上限或幂等标识，拒绝时完全不写入', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const url = `/api/v1/spaces/${store.spaceId}/tasks`;
    const payloads = [
      null,
      [],
      {},
      { title: '' },
      { title: ' ' },
      { title: null },
      { title: 1 },
      { title: '字'.repeat(161) },
      { title: '😀'.repeat(80) + '字' },
      { title: ' 标题' + ' '.repeat(160) },
      { ...maximum, description: null },
      { ...maximum, description: 1 },
      { ...maximum, description: '文'.repeat(12001) },
      { ...maximum, description: '😀'.repeat(6000) + '字' },
      ...['', 1, {}, '项'.repeat(101), '😀'.repeat(50) + '字'].map((projectId) => ({
        ...maximum,
        projectId,
      })),
      ...[
        'id',
        'spaceId',
        'visibility',
        'ownerUserId',
        'createdByUserId',
        'status',
        'attention',
        'access',
        'participantUserIds',
        'feedbackOrigin',
        'run',
        'operation',
        'command',
        'revision',
        'expectedRevision',
        'updatedAt',
      ].map((field) => ({ ...maximum, [field]: 'forged' })),
    ];
    const before = snapshot(store);
    for (const payload of payloads) {
      const body = escapedJson(payload);
      assert.ok(Buffer.byteLength(body) < 96 * 1024);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: body,
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(snapshot(store), before);
    }
    for (const key of ['', 'invalid key', 'x'.repeat(129)]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: headers(key),
        payload: escapedJson(maximum),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(snapshot(store), before);
    }
    const response = await app.inject({
      method: 'POST',
      url,
      headers: headers(),
      payload: { title: ' 标题 ', description: '  ', projectId: null },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json<Task>().title, '标题');
    assert.equal(response.json<Task>().description, '');
  } finally {
    await app.close();
  }
});

test('普通与大正文仍拒绝跨站、伪造Host、缺少客户端标识和错误空间', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const before = snapshot(store);
    for (const payload of [JSON.stringify({ title: '普通标题' }), escapedJson(maximum)]) {
      for (const requestHeaders of [
        { ...headers(), origin: 'https://untrusted.example' },
        { ...headers(), host: 'untrusted.example' },
        { ...headers(), 'sec-fetch-site': 'cross-site' },
        { ...headers(), 'x-hexu-client': '' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/spaces/${store.spaceId}/tasks`,
          headers: requestHeaders,
          payload,
        });
        assert.equal(response.statusCode, 403, response.body);
        assert.deepEqual(snapshot(store), before);
      }
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/spaces/other-space/tasks',
        headers: headers(),
        payload,
      });
      assert.equal(response.statusCode, 404, response.body);
      assert.deepEqual(snapshot(store), before);
    }
  } finally {
    await app.close();
  }
});

test('最大ASCII/中文/转义正文仍检查会话、空间及当前项目权限，撤权后拒绝旧回执', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const hiddenProject = await f.project(bob);
    const bodies = [
      JSON.stringify({
        title: 'a'.repeat(160),
        description: 'b'.repeat(12000),
        projectId: project.id,
      }),
      JSON.stringify({ ...maximum, projectId: project.id }),
      escapedJson({ ...maximum, projectId: project.id }),
    ];
    const create = (payload: string, account: Account | null, key: string = randomUUID()) =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${alice.spaceId}/tasks`,
        headers: {
          ...headers(key),
          origin: ORIGIN,
          ...(account ? { cookie: account.cookie, 'x-hexu-space': account.spaceId } : {}),
        },
        payload,
      });
    let before = snapshot(f.store);
    for (const body of bodies) {
      for (const [account, status] of [
        [null, 401],
        [bob, 404],
        [{ ...bob, spaceId: `personal-${bob.user.id}` }, 404],
      ] as const) {
        const response = await create(body, account);
        assert.equal(response.statusCode, status, response.body);
        assert.deepEqual(snapshot(f.store), before);
      }
      const hidden = await create(
        JSON.stringify({ ...JSON.parse(body), projectId: hiddenProject.id }),
        alice,
      );
      assert.equal(hidden.statusCode, 404, hidden.body);
      assert.deepEqual(snapshot(f.store), before);
    }
    const granted = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    assert.equal(granted.statusCode, 200, granted.body);
    const keys = bodies.map(() => randomUUID());
    for (const [index, body] of bodies.entries()) {
      const response = await create(body, bob, keys[index]);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json<Task>().ownerUserId, bob.user.id);
      assert.equal(response.json<Task>().createdByUserId, bob.user.id);
      before = snapshot(f.store);
      assert.deepEqual((await create(body, bob, keys[index])).json(), response.json());
      assert.deepEqual(snapshot(f.store), before);
    }
    for (const [role, status] of [
      ['view', 403],
      [null, 404],
    ] as const) {
      const changed = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
        role,
      });
      assert.equal(changed.statusCode, 200, changed.body);
      before = snapshot(f.store);
      for (const [index, body] of bodies.entries()) {
        for (const key of [keys[index], randomUUID()]) {
          const response = await create(body, bob, key);
          assert.equal(response.statusCode, status, response.body);
          assert.deepEqual(snapshot(f.store), before);
        }
      }
    }
    const transferred = await f.call(`projects/${hiddenProject.id}/members/${alice.user.id}`, bob, {
      role: 'manage',
    });
    assert.equal(transferred.statusCode, 200, transferred.body);
    const removed = await f.call(
      `spaces/${alice.spaceId}/members/${bob.user.id}/remove`,
      alice,
      {},
    );
    assert.equal(removed.statusCode, 200, removed.body);
    before = snapshot(f.store);
    for (const [index, body] of bodies.entries()) {
      const response = await create(body, bob, keys[index]);
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(snapshot(f.store), before);
    }
  } finally {
    await f.close();
  }
});

test('大正文创建的计数、Task、通知和回执仍原子提交，故障可原请求重试且不触发执行', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const unaffected = snapshot(store, writeTables);
    const payload = escapedJson({ ...maximum, projectId: null });
    for (const [table, operation] of [
      ['metadata', 'UPDATE'],
      ['tasks', 'INSERT'],
      ['outbox', 'INSERT'],
      ['idempotency_records', 'INSERT'],
      ['task_content_revisions', 'INSERT'],
    ]) {
      const key = randomUUID();
      const before = snapshot(store);
      store.db.exec(
        `CREATE TRIGGER break_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`,
      );
      const create = () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/spaces/${store.spaceId}/tasks`,
          headers: headers(key),
          payload,
        });
      const failed = await create();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(snapshot(store), before);
      store.db.exec('DROP TRIGGER break_write');
      const response = await create();
      assert.equal(response.statusCode, 201, response.body);
      assert.deepEqual(snapshot(store, writeTables), unaffected);
      const after = snapshot(store);
      assert.deepEqual((await create()).json(), response.json());
      assert.deepEqual(snapshot(store), after);
    }
  } finally {
    await app.close();
  }
});
