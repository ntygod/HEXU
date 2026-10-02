import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../packages/contracts/src/index.js';
import type { IdentityUser } from '../packages/contracts/src/identity.js';
import {
  parseIncomingHandoffListQuery,
  parseIncomingHandoffTarget,
  type IncomingHandoffPage,
  type IncomingHandoffSummary,
} from '../packages/contracts/src/incoming-handoffs.js';
import { IncomingHandoffQueries } from '../packages/db/src/incoming-handoffs.js';
import { HandoffStore } from '../packages/db/src/handoffs.js';
import { HandoffAcceptanceStore } from '../packages/db/src/handoff-acceptance.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';
import { Store } from '../packages/db/src/store.js';
import { ORIGIN, teamFixture } from './helpers/team.js';

const AT = Date.parse('2030-01-01T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const snapshots = (store: Store) =>
  (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [name, JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all())]);

function fixture(path = ':memory:') {
  const store = new Store(path, undefined, { team: true });
  const alice: IdentityUser = { id: 'alice', name: '甲当前名字', email: 'alice@example.invalid' };
  const bob: IdentityUser = { id: 'bob', name: '乙', email: 'bob@example.invalid' };
  store.collaboration.ensurePerson(alice);
  store.collaboration.ensurePerson(bob);
  const space = store.as({ user: alice, spaceId: 'personal-alice' }, () =>
    store.collaboration.createSpace('测试团队', randomUUID()),
  );
  store.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(space.id, bob.id, 'member');
  const as = <T>(action: () => T, user = bob, spaceId: string = space.id) =>
    store.as({ user, spaceId }, action);
  const project = as(
    () => store.createProject({ name: '项目', description: '' }, randomUUID()),
    alice,
  );
  store.db
    .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
    .run(project.id, bob.id, 'view');
  const task = as(
    () =>
      store.createTask(
        { title: '当前任务', description: '不能投影的Task正文', projectId: project.id },
        randomUUID(),
      ),
    alice,
  );
  const queries = new IncomingHandoffQueries(store, () => AT);
  return { store, alice, bob, space, project, task, as, queries };
}

interface Invitation {
  id: string;
  taskId: string;
  spaceId: string;
  projectId: string;
  revision: number;
  state: 'offered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';
  sender: { id: string; name: string };
  material: { recipient: { id: string; name: string }; privateMarker: string };
  summary: string;
  remainingWork: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

// Isolated fixture metadata deliberately omits any material/node records. Tests
// neither offer invitations nor exercise transfers, filesystem checks or execution.
function seed(
  store: Store,
  task: Task,
  senderId: string,
  recipientId: string,
  changes: Partial<Invitation> = {},
) {
  const h: Invitation = {
    id: randomUUID(),
    taskId: task.id,
    spaceId: task.spaceId,
    projectId: task.projectId!,
    revision: 1,
    state: 'offered',
    sender: { id: senderId, name: '旧名字不可投影' },
    material: {
      recipient: { id: recipientId, name: '旧接收名字' },
      privateMarker: '绝不返回的材料身份与节点',
    },
    summary: '发起人工作说明',
    remainingWork: '发起人剩余工作说明',
    environment: '发起人环境说明',
    createdAt: iso(AT - 1000),
    updatedAt: iso(AT - 1000),
    expiresAt: iso(AT + 3600000),
    ...changes,
  };
  store.db.exec('PRAGMA foreign_keys=OFF');
  try {
    store.db
      .prepare(
        `INSERT INTO handoffs
      (id,task_id,space_id,transfer_id,sender_id,recipient_id,state,revision,expires_at,body)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        h.id,
        h.taskId,
        h.spaceId,
        randomUUID(),
        h.sender.id,
        h.material.recipient.id,
        h.state,
        h.revision,
        h.expiresAt,
        JSON.stringify(h),
      );
  } finally {
    store.db.exec('PRAGMA foreign_keys=ON');
  }
  return h;
}
function change(store: Store, h: Invitation, changes: Partial<Invitation>) {
  const next = { ...h, ...changes };
  store.db
    .prepare('UPDATE handoffs SET state=?,revision=?,expires_at=?,body=? WHERE id=?')
    .run(next.state, next.revision, next.expiresAt, JSON.stringify(next), h.id);
  return next;
}
function seedPendingAcceptance(store: Store, h: Invitation) {
  store.db.exec('PRAGMA foreign_keys=OFF');
  try {
    store.db.prepare('INSERT INTO handoff_acceptances VALUES(?,?,?,?,?,?)').run(
      'pending-acceptance',
      h.id,
      h.taskId,
      'synthetic-node',
      'waiting_local',
      JSON.stringify({
        id: 'pending-acceptance',
        state: 'waiting_local',
        expiresAt: '2000-01-01T00:00:00.000Z',
        privateMarker: 'do-not-read',
      }),
    );
  } finally {
    store.db.exec('PRAGMA foreign_keys=ON');
  }
}
function guardLegacy(t: TestContext, store: Store) {
  const fail = () => {
    throw new Error('Summary reads must not enter lifecycle, material or full-record reads');
  };
  for (const method of [
    'list',
    'get',
    'history',
    'expire',
    'view',
    'record',
    'options',
    'material',
    'transfer',
  ] as const)
    t.mock.method(HandoffStore.prototype as unknown as Record<string, () => unknown>, method, fail);
  for (const method of ['sweep', 'get', 'list', 'preview'] as const)
    t.mock.method(HandoffAcceptanceStore.prototype, method, fail);
  t.mock.method(CheckpointTransferStore.prototype, 'get', fail);
  for (const method of ['getTask', 'tasks', 'project', 'projects'] as const)
    t.mock.method(store, method, fail);
}
const list = (f: ReturnType<typeof fixture>, cursor: string | null = null, limit = 20) =>
  f.as(() => f.queries.list({ cursor, limit }));
const get = (f: ReturnType<typeof fixture>, h: Invitation) =>
  f.as(() => f.queries.get(h.taskId, h.id));
const assertUnavailable = (action: () => unknown) =>
  assert.throws(action, {
    code: 'NOT_FOUND',
    status: 404,
    message: '接手邀请不存在或不可访问',
  });

test('incoming invitation contracts accept only bounded canonical paging and exact target inputs', () => {
  assert.deepEqual(parseIncomingHandoffListQuery({}), { cursor: null, limit: 20 });
  assert.deepEqual(parseIncomingHandoffListQuery({ cursor: 'abc_123', limit: '50' }), {
    cursor: 'abc_123',
    limit: 50,
  });
  for (const value of [
    null,
    [],
    'bad',
    { limit: 1 },
    { limit: null },
    { limit: '0' },
    { limit: '01' },
    { limit: '51' },
    { limit: '1.0' },
    { limit: '1e1' },
    { limit: ' 1' },
    { limit: ['1', '2'] },
    { limit: String(Number.MAX_SAFE_INTEGER + 1) },
    { recipientId: 'alice' },
    { spaceId: 'other' },
    { state: 'accepted' },
    { includeHistory: 'true' },
    { offset: '1' },
  ])
    assert.throws(() => parseIncomingHandoffListQuery(value), { code: 'INVALID_INPUT' });
  for (const cursor of [null, '', ' a', 'a ', '../a', ['a', 'b'], 'a'.repeat(513)])
    assert.throws(() => parseIncomingHandoffListQuery({ cursor }), { code: 'INVALID_CURSOR' });
  assert.deepEqual(
    parseIncomingHandoffTarget({ targetTaskId: 'task-1', handoffId: 'handoff-1' }, {}),
    { taskId: 'task-1', handoffId: 'handoff-1' },
  );
  for (const value of [
    { targetTaskId: ' task', handoffId: 'id' },
    { targetTaskId: 'task', handoffId: '../id' },
    { taskId: 'task', handoffId: 'id' },
  ])
    assert.throws(() => parseIncomingHandoffTarget(value, {}), { code: 'INVALID_INPUT' });
  assert.throws(
    () =>
      parseIncomingHandoffTarget({ targetTaskId: 'task', handoffId: 'id' }, { history: 'true' }),
    { code: 'INVALID_INPUT' },
  );
});

test('recipient summaries project only bounded authored notes/current Task and visible current sender, with exact off-page lookup', (t) => {
  const f = fixture();
  try {
    const invitations = Array.from({ length: 55 }, (_, i) =>
      seed(f.store, f.task, f.alice.id, f.bob.id, {
        summary: '中😀'.repeat(3000) + '未投影的后半正文',
        remainingWork: '余'.repeat(5000),
        environment: '环'.repeat(3000),
        updatedAt: iso(AT - i),
      }),
    );
    guardLegacy(t, f.store);
    const prepare = f.store.db.prepare.bind(f.store.db);
    let projected = 0;
    t.mock.method(f.store.db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes(' AS summary')) {
        assert(!/SELECT\s+(?:\*|h\.body|t\.body)\b/.test(sql));
        if (sql.includes('ORDER BY h.rowid DESC')) {
          const all = statement.all.bind(statement);
          t.mock.method(statement, 'all', (...parameters: Parameters<typeof statement.all>) => {
            assert.equal(parameters.at(-1), 51);
            const rows = all(...parameters);
            assert.equal(rows.length, 51);
            assert(rows.every((row) => !('body' in row) && !('material' in row)));
            projected++;
            return rows;
          });
        }
      }
      return statement;
    });
    const before = snapshots(f.store);
    const page = list(f, null, 50);
    assert.equal(projected, 1);
    assert.equal(page.items.length, 50);
    const item = page.items[0]!;
    assert.deepEqual(
      Object.keys(item).sort(),
      [
        'id',
        'task',
        'sender',
        'summary',
        'remainingWork',
        'environment',
        'revision',
        'createdAt',
        'updatedAt',
        'expiresAt',
      ].sort(),
    );
    assert.deepEqual(item.task, {
      id: f.task.id,
      shortId: f.task.shortId,
      title: f.task.title,
      projectId: f.project.id,
    });
    assert.deepEqual(item.sender, { id: f.alice.id, name: f.alice.name });
    assert.equal([...item.summary].length, 4000);
    assert.equal(item.remainingWork.length, 4000);
    assert.equal(item.environment.length, 2000);
    for (const secret of [
      '绝不返回',
      '不能投影的Task正文',
      '旧名字不可投影',
      '未投影的后半正文',
      'canAccept',
      'transferId',
      'nodeId',
    ])
      assert(!JSON.stringify(page).includes(secret), secret);
    assert.equal(get(f, invitations[0]!).id, invitations[0]!.id);
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    f.store.close();
  }
});

test('all summary success/empty/error/terminal/overdue reads leave every persistent table unchanged, including pending acceptance', (t) => {
  const f = fixture();
  try {
    const active = seed(f.store, f.task, f.alice.id, f.bob.id);
    const hidden = ['accepted', 'rejected', 'withdrawn', 'expired'].map((state) =>
      seed(f.store, f.task, f.alice.id, f.bob.id, { state: state as Invitation['state'] }),
    );
    hidden.push(seed(f.store, f.task, f.alice.id, f.bob.id, { expiresAt: iso(AT) }));
    hidden.push(seed(f.store, f.task, f.alice.id, f.bob.id, { expiresAt: iso(AT - 1) }));
    seedPendingAcceptance(f.store, hidden.at(-1)!);
    guardLegacy(t, f.store);
    const before = snapshots(f.store);
    assert.deepEqual(
      list(f).items.map((x) => x.id),
      [active.id],
    );
    assert.equal(get(f, active).id, active.id);
    for (const h of hidden) assertUnavailable(() => get(f, h));
    assertUnavailable(() => f.as(() => f.queries.get(f.task.id, 'unknown')));
    assertUnavailable(() => f.as(() => f.queries.get('wrong-task', active.id)));
    assert.deepEqual(
      f.as(() => f.queries.list({ cursor: null, limit: 20 }), f.alice),
      { items: [], nextCursor: null },
    );
    assert.throws(() => list(f, 'not-json'), { code: 'INVALID_CURSOR' });
    assert.throws(() => parseIncomingHandoffListQuery({ limit: 'no' }), { code: 'INVALID_INPUT' });
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    f.store.close();
  }
});

test('each read checks current recipient, space, project and Task access independently of ownership and hides departed sender identity', (t) => {
  const f = fixture();
  try {
    const h = seed(f.store, f.task, f.alice.id, f.bob.id);
    guardLegacy(t, f.store);
    assert.equal(get(f, h).id, h.id); // Bob is a viewer; Alice owns the Task.
    assertUnavailable(() => f.as(() => f.queries.get(h.taskId, h.id), f.alice));
    assertUnavailable(() => f.as(() => f.queries.get(h.taskId, h.id), f.bob, 'personal-bob'));
    const body = { ...f.task, ownerUserId: f.bob.id, title: '改派后的当前任务' };
    f.store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body), f.task.id);
    let before = snapshots(f.store);
    assert.equal(get(f, h).task.title, body.title);
    assert.deepEqual(snapshots(f.store), before);
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.bob.id);
    before = snapshots(f.store);
    assert.deepEqual(list(f), { items: [], nextCursor: null });
    assertUnavailable(() => get(f, h));
    assert.deepEqual(snapshots(f.store), before);
    f.store.db
      .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
      .run(f.project.id, f.bob.id, 'view');
    f.store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...body, visibility: 'private' }), f.task.id);
    before = snapshots(f.store);
    assert.deepEqual(list(f), { items: [], nextCursor: null });
    assertUnavailable(() => get(f, h));
    assert.deepEqual(snapshots(f.store), before);
    f.store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body), f.task.id);
    f.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(f.space.id, f.alice.id);
    before = snapshots(f.store);
    assert.equal(get(f, h).sender, null);
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    f.store.close();
  }
});

test('stable scope-bound keyset pages exclude new rows and recheck current anchor and candidate permissions', () => {
  const f = fixture();
  try {
    const invitations = Array.from({ length: 23 }, () =>
      seed(f.store, f.task, f.alice.id, f.bob.id),
    );
    let before = snapshots(f.store);
    const first = list(f);
    assert.equal(first.items.length, 20);
    assert.deepEqual(snapshots(f.store), before);
    const newest = seed(f.store, f.task, f.alice.id, f.bob.id);
    change(f.store, invitations[0]!, {
      revision: 2,
      updatedAt: iso(AT + 5),
      summary: '修订后的说明',
    });
    before = snapshots(f.store);
    const second = list(f, first.nextCursor);
    assert.deepEqual(
      second.items.map((x) => x.id),
      invitations
        .slice(0, 3)
        .reverse()
        .map((x) => x.id),
    );
    assert.equal(second.items.at(-1)!.summary, '修订后的说明');
    assert.equal(second.nextCursor, null);
    assert(!second.items.some((x) => x.id === newest.id));
    assert.throws(
      () => f.as(() => f.queries.list({ cursor: first.nextCursor, limit: 20 }), f.alice),
      { code: 'INVALID_CURSOR' },
    );
    assert.throws(
      () =>
        f.as(() => f.queries.list({ cursor: first.nextCursor, limit: 20 }), f.bob, 'personal-bob'),
      { code: 'INVALID_CURSOR' },
    );
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    for (const cursor of [
      { ...decoded, v: 2 },
      { ...decoded, extra: 'unknown' },
      { ...decoded, afterId: 'missing' },
      { ...decoded, scope: 'wrong' },
    ])
      assert.throws(() => list(f, Buffer.from(JSON.stringify(cursor)).toString('base64url')), {
        code: 'INVALID_CURSOR',
      });
    assert.deepEqual(snapshots(f.store), before);
    change(f.store, invitations[3]!, { state: 'withdrawn' });
    before = snapshots(f.store);
    assert.throws(() => list(f, first.nextCursor), { code: 'INVALID_CURSOR' });
    assert.deepEqual(snapshots(f.store), before);
    const fresh = list(f, null, 1);
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.bob.id);
    before = snapshots(f.store);
    assert.throws(() => list(f, fresh.nextCursor), { code: 'INVALID_CURSOR' });
    assert.deepEqual(list(f), { items: [], nextCursor: null });
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    f.store.close();
  }
});

test('a single clock value applies to the whole read and equality is unavailable without persisting expiry', () => {
  const f = fixture();
  try {
    const h = seed(f.store, f.task, f.alice.id, f.bob.id, { expiresAt: iso(AT + 1) });
    let calls = 0;
    const queries = new IncomingHandoffQueries(f.store, () => AT + calls++);
    const before = snapshots(f.store);
    assert.equal(f.as(() => queries.list({ cursor: null, limit: 20 })).items[0]!.id, h.id);
    assert.equal(calls, 1);
    assertUnavailable(() => f.as(() => queries.get(h.taskId, h.id)));
    assert.equal(calls, 2);
    assert.deepEqual(
      f.as(() => queries.list({ cursor: null, limit: 20 })),
      { items: [], nextCursor: null },
    );
    assert.equal(calls, 3);
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    f.store.close();
  }
});

test('indexed/body identity drift cannot redirect invitations or join another current parent', () => {
  const f = fixture();
  try {
    const h = seed(f.store, f.task, f.alice.id, f.bob.id);
    const changes: Partial<Invitation>[] = [
      { id: 'wrong' },
      { taskId: 'wrong' },
      { spaceId: 'wrong' },
      { projectId: 'wrong' },
      { revision: 9 },
      { state: 'accepted' },
      { expiresAt: iso(AT + 2) },
      { sender: { id: f.bob.id, name: 'wrong' } },
      { material: { recipient: { id: f.alice.id, name: 'wrong' }, privateMarker: 'wrong' } },
    ];
    for (const patch of changes) {
      f.store.db
        .prepare('UPDATE handoffs SET body=? WHERE id=?')
        .run(JSON.stringify({ ...h, ...patch }), h.id);
      const before = snapshots(f.store);
      assert.deepEqual(list(f), { items: [], nextCursor: null });
      assertUnavailable(() => get(f, h));
      assert.deepEqual(snapshots(f.store), before);
    }
    f.store.db.prepare('UPDATE handoffs SET body=? WHERE id=?').run(JSON.stringify(h), h.id);
    for (const patch of [{ id: 'wrong' }, { spaceId: 'wrong' }, { projectId: 'wrong' }]) {
      f.store.db
        .prepare('UPDATE tasks SET body=? WHERE id=?')
        .run(JSON.stringify({ ...f.task, ...patch }), f.task.id);
      const before = snapshots(f.store);
      assertUnavailable(() => get(f, h));
      assert.deepEqual(list(f), { items: [], nextCursor: null });
      assert.deepEqual(snapshots(f.store), before);
    }
  } finally {
    f.store.close();
  }
});

test('parent authorization and summary projection share one SQLite read snapshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-incoming-read-'));
  const f = fixture(join(dir, 'workspace.sqlite'));
  const other = new DatabaseSync(join(dir, 'workspace.sqlite'));
  try {
    const h = seed(f.store, f.task, f.alice.id, f.bob.id);
    let changed = false;
    const prepare = f.store.db.prepare.bind(f.store.db);
    t.mock.method(f.store.db, 'prepare', (sql: string) => {
      if (sql.includes(' AS summary') && !changed) {
        changed = true;
        other
          .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
          .run(f.project.id, f.bob.id);
        other
          .prepare('UPDATE tasks SET body=? WHERE id=?')
          .run(JSON.stringify({ ...f.task, title: '另一个快照' }), f.task.id);
      }
      return prepare(sql);
    });
    assert.equal(get(f, h).task.title, f.task.title);
    assert(changed);
    const before = snapshots(f.store);
    assertUnavailable(() => get(f, h));
    assert.deepEqual(snapshots(f.store), before);
  } finally {
    other.close();
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('real HTTP isolates recipient/Task/space permissions and errors while keeping every application table unchanged', async (t) => {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, project.id)) as Task;
    await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    const active = seed(api.store, task, alice.user.id, bob.user.id);
    const anotherTask = (await api.task(alice, project.id)) as Task;
    const terminal = seed(api.store, task, alice.user.id, bob.user.id, { state: 'rejected' });
    const overdue = seed(api.store, task, alice.user.id, bob.user.id, {
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    seedPendingAcceptance(api.store, overdue);
    guardLegacy(t, api.store);
    const base = await api.app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (path: string, account = bob) => {
      const before = snapshots(api.store);
      const response = await fetch(`${base}/api/v1/incoming-handoffs${path}`, {
        headers: { cookie: account.cookie, origin: ORIGIN, 'x-hexu-space': account.spaceId },
      });
      const data = await response.json();
      assert.deepEqual(snapshots(api.store), before, path);
      return { status: response.status, data };
    };
    const listResponse = await request('');
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      (listResponse.data as IncomingHandoffPage).items.map((x) => x.id),
      [active.id],
    );
    const exact = await request(`/${task.id}/${active.id}`);
    assert.equal(exact.status, 200);
    assert.equal((exact.data as IncomingHandoffSummary).task.id, task.id);
    const missing = await request(`/${task.id}/missing`);
    for (const [path, account] of [
      [`/${task.id}/${active.id}`, alice],
      [`/${anotherTask.id}/${active.id}`, bob],
      [`/unknown-task/${active.id}`, bob],
      [`/${task.id}/${terminal.id}`, bob],
      [`/${task.id}/${overdue.id}`, bob],
      [`/${task.id}/${active.id}`, { ...bob, spaceId: `personal-${bob.user.id}` }],
    ] as const) {
      const response = await request(path, account);
      assert.equal(response.status, 404, path);
      assert.deepEqual(response.data.error, missing.data.error, path);
    }
    for (const query of [
      '?limit=1&limit=2',
      '?cursor=a&cursor=b',
      '?limit=51',
      '?state=accepted',
      '?limit=01',
      `/${task.id}/${active.id}?history=true`,
    ])
      assert([400, 409].includes((await request(query)).status), query);
    assert.equal((await request('?cursor=not-json')).status, 409);
    // Revoke directly: the new path itself must authorize, without generic :taskId middleware.
    api.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(project.id, bob.user.id);
    assert.deepEqual((await request('')).data, { items: [], nextCursor: null });
    const revoked = await request(`/${task.id}/${active.id}`);
    assert.equal(revoked.status, 404);
    assert.deepEqual(revoked.data.error, missing.data.error);
  } finally {
    await api.close();
  }
});
