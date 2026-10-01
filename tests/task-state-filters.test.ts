import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError, taskStatuses, type Task } from '../packages/contracts/src/index.js';
import {
  parseTaskPeopleFilters,
  type TaskPeopleFilters,
} from '../packages/contracts/src/task-participants.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { demoMembers } from '../packages/db/src/seed.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
const second = demoMembers[1]!.id;
const ids = (tasks: Task[]) => tasks.map(({ id }) => id).sort();
function snapshot(store: Store) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}
function configure(store: Store, task: Task, status: Task['status'], attention: string | null) {
  const current =
    task.status === status
      ? task
      : store.changeTask(task.id, status, task.revision, 'keep', randomUUID());
  return store.patchTask(task.id, { expectedRevision: current.revision, attention }, randomUUID());
}
function participate(store: Store, task: Task, userId = second, action: 'add' | 'remove' = 'add') {
  return store.taskParticipants.change(
    task.id,
    { expectedRevision: store.taskParticipants.view(task.id).revision, userId, action },
    randomUUID(),
  );
}
function makeTask(
  store: Store,
  projectId: string,
  title: string,
  status: Task['status'] = 'todo',
  attention: string | null = '需要确认',
) {
  return configure(
    store,
    store.createTask({ title, description: '共同说明', projectId }, randomUUID()),
    status,
    attention,
  );
}

test('状态/关注筛选契约保留旧默认形状，严格校验枚举、单值和已知路由参数', () => {
  assert.deepEqual(parseTaskPeopleFilters({}), {
    q: undefined,
    ownerUserId: undefined,
    participantUserId: undefined,
  });
  assert.deepEqual(
    parseTaskPeopleFilters({
      q: '  Alpha ',
      ownerUserId: ' owner ',
      participantUserId: ' member ',
      projectId: 'project',
      cursor: 'task',
      limit: '1',
    }),
    { q: 'Alpha', ownerUserId: 'owner', participantUserId: 'member' },
  );
  for (const status of taskStatuses)
    for (const attention of ['present', 'absent'] as const)
      assert.deepEqual(parseTaskPeopleFilters({ status, attention }), {
        q: undefined,
        ownerUserId: undefined,
        participantUserId: undefined,
        status,
        attention,
      });
  for (const key of [
    'q',
    'ownerUserId',
    'participantUserId',
    'status',
    'attention',
    'projectId',
    'cursor',
    'limit',
  ])
    for (const value of [null, false, 1, {}, [], ['todo'], ['todo', 'todo']])
      assert.throws(() => parseTaskPeopleFilters({ [key]: value }), code('INVALID_INPUT'));
  for (const query of [
    null,
    [],
    { status: '' },
    { status: ' todo ' },
    { status: 'blocked' },
    { status: 'running' },
    { attention: '' },
    { attention: ' present ' },
    { attention: 'waiting_feedback' },
    { attention: 'paused' },
    { attention: 'true' },
    { state: 'todo' },
    { view: 'board' },
    { ownerId: 'owner' },
    { status: 'todo', unknown: undefined },
    { q: 'x'.repeat(161) },
    { q: ' '.repeat(161) },
    { ownerUserId: 'x'.repeat(101) },
    { ownerUserId: ' '.repeat(101) },
    { participantUserId: 'x'.repeat(101) },
    { participantUserId: ' '.repeat(101) },
  ])
    assert.throws(() => parseTaskPeopleFilters(query), code('INVALID_INPUT'));
});

test('纯筛选覆盖全部状态和实际关注文本，并与关键词/负责人/当前参与者取交集', () => {
  const base: Task = {
    id: 'task-a',
    shortId: 'HX-123',
    spaceId: 'space',
    projectId: 'project',
    visibility: 'project',
    title: 'Alpha 订单',
    description: '订单导出 Beta',
    ownerUserId: 'owner',
    participantUserIds: ['member'],
    status: 'todo',
    attention: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const attentionCases: [string | null, boolean][] = [
    [null, false],
    ['', false],
    [' \t\n\u3000 ', false],
    ['  需要确认  ', true],
    ['waiting_feedback', true],
    ['blocked', true],
    ['paused', true],
  ];
  for (const status of taskStatuses)
    for (const [attention, present] of attentionCases) {
      const task = { ...base, status, attention };
      for (const requested of [undefined, ...taskStatuses])
        for (const attentionFilter of [undefined, 'present', 'absent'] as const) {
          const filters = { status: requested, attention: attentionFilter };
          assert.equal(
            matchesTaskPeopleFilters(task, filters),
            (requested === undefined || requested === status) &&
              (attentionFilter === undefined || (attentionFilter === 'present') === present),
            JSON.stringify({ status, attention, filters }),
          );
        }
    }
  const task = { ...base, attention: '任意关注内容' };
  const all: TaskPeopleFilters = {
    status: 'todo',
    attention: 'present',
    q: ' ALPHA ',
    ownerUserId: 'owner',
    participantUserId: 'member',
  };
  assert.equal(matchesTaskPeopleFilters(task, all), true);
  for (const q of ['alpha', 'hx-123', 'BETA', '订单'])
    assert.equal(matchesTaskPeopleFilters(task, { ...all, q }), true);
  for (const mismatch of [
    { status: 'done' as const },
    { attention: 'absent' as const },
    { q: '任意关注内容' },
    { ownerUserId: 'other' },
    { participantUserId: 'other' },
  ])
    assert.equal(matchesTaskPeopleFilters(task, { ...all, ...mismatch }), false);
  assert.equal(matchesTaskPeopleFilters({ ...task, participantUserIds: [] }, all), false);
  assert.equal(matchesTaskPeopleFilters({ ...task, participantUserIds: undefined }, all), false);
  assert.equal(
    matchesTaskPeopleFilters(
      { ...base, title: 'blocked waiting_feedback paused' },
      { attention: 'present' },
    ),
    false,
  );
});

test('API 默认保留取消任务，关注只读取文本而不推断执行等待状态，所有筛选读取不写业务数据', async () => {
  const store = new Store(),
    app = await createApp({ store });
  try {
    const project = store.createProject({ name: '状态矩阵', description: '' }, randomUUID());
    const tasks = taskStatuses.flatMap((status) =>
      [null, ' \t\n\u3000 ', '待核对'].map((attention, index) =>
        makeTask(store, project.id, `${status}-${index}`, status, attention),
      ),
    );
    const waiting = makeTask(store, project.id, '执行等待不能替代关注', 'in_progress', null);
    const run = store.createRun(
      waiting.id,
      {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'waiting_input',
        prompt: '',
        expectedRevision: waiting.revision,
        reopenTask: false,
      },
      randomUUID(),
    );
    store.stepRun(run.id, 'preparing');
    store.stepRun(run.id, 'running');
    store.stepRun(run.id, 'waiting_input');
    const before = snapshot(store),
      writes = store.db.prepare('SELECT total_changes() AS count').get();
    const list = async (filters: Record<string, string> = {}) => {
      const query = new URLSearchParams({ projectId: project.id, ...filters });
      const response = await app.inject({ url: `/api/v1/spaces/${store.spaceId}/tasks?${query}` });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { items: Task[]; nextCursor: string | null };
    };
    assert.deepEqual(ids((await list()).items), ids([...tasks, waiting]));
    assert.deepEqual(
      ids((await list({ status: 'cancelled' })).items),
      ids(tasks.filter((task) => task.status === 'cancelled')),
    );
    for (const status of taskStatuses)
      for (const attention of ['present', 'absent']) {
        const result = await list({ status, attention });
        assert.deepEqual(
          ids(result.items),
          ids(
            [...tasks, waiting].filter(
              (task) =>
                task.status === status &&
                (attention === 'present'
                  ? task.attention === '待核对'
                  : task.attention !== '待核对'),
            ),
          ),
        );
        assert.equal(result.nextCursor, null);
      }
    assert.equal(
      (await list({ attention: 'present' })).items.some((task) => task.id === waiting.id),
      false,
    );
    assert.equal(
      (await list({ attention: 'absent' })).items.some((task) => task.id === waiting.id),
      true,
    );
    assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), writes);
    assert.deepEqual(snapshot(store), before);
  } finally {
    await app.close();
  }
});

test('API 拒绝未知、重复和非法查询，不丢弃错误值后扩大结果', async () => {
  const store = new Store(),
    app = await createApp({ store });
  try {
    const path = `/api/v1/spaces/${store.spaceId}/tasks?`;
    const before = snapshot(store);
    const invalid = [
      'status=running',
      'status=blocked',
      'status=',
      'status=%20todo%20',
      'attention=waiting_feedback',
      'attention=paused',
      'attention=',
      'attention=%20present%20',
      'unknown=present',
      'view=board',
      'status%5B%5D=todo',
      'status=todo&ownerId=someone',
      'projectId=',
      'projectId=%20%20',
      'cursor=',
      'cursor=%20%20',
      'limit=',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=NaN',
      `q=${'x'.repeat(161)}`,
      `ownerUserId=${'x'.repeat(101)}`,
      `participantUserId=${'x'.repeat(101)}`,
      ...[
        'q',
        'ownerUserId',
        'participantUserId',
        'status',
        'attention',
        'projectId',
        'cursor',
        'limit',
      ].map((key) => `${key}=1&${key}=1`),
    ];
    for (const query of invalid) {
      const response = await app.inject({ url: path + query });
      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json().error.code, 'INVALID_INPUT', query);
    }
    assert.equal(
      (await app.inject({ url: path + 'q=%20&ownerUserId=%20&participantUserId=%20' })).statusCode,
      200,
    );
    assert.deepEqual(snapshot(store), before);
  } finally {
    await app.close();
  }
});

test('状态/关注与项目、人员、搜索全部相交后再分页，游标必须属于当前结果', async () => {
  const store = new Store(),
    app = await createApp({ store });
  try {
    const project = store.createProject({ name: '交集分页', description: '' }, randomUUID());
    const first = makeTask(store, project.id, 'Alpha 最早匹配');
    participate(store, first);
    const noAttention = makeTask(store, project.id, 'Alpha 空关注', 'todo', '  ');
    const wrongStatus = makeTask(store, project.id, 'Alpha 已取消', 'cancelled');
    const secondMatch = makeTask(store, project.id, 'Alpha 后续匹配');
    participate(store, secondMatch);
    const wrongOwner = makeTask(store, project.id, 'Alpha 其他负责人');
    store.taskAssignment.assign(
      wrongOwner.id,
      { expectedRevision: wrongOwner.revision, ownerUserId: second },
      randomUUID(),
    );
    const wrongSearch = makeTask(store, project.id, '不同标题');
    for (const task of [noAttention, wrongStatus, wrongOwner, wrongSearch])
      participate(store, task);
    makeTask(store, project.id, 'Alpha 未参与');
    const otherProject = makeTask(store, store.projects()[0]!.id, 'Alpha 其他项目');
    participate(store, otherProject);
    const query = new URLSearchParams({
      projectId: project.id,
      q: 'ALPHA',
      ownerUserId: store.actorId,
      participantUserId: second,
      status: 'todo',
      attention: 'present',
      limit: '1',
    });
    const path = `/api/v1/spaces/${store.spaceId}/tasks?${query}`;
    const before = snapshot(store);
    const page1 = (await app.inject({ url: path })).json();
    assert.deepEqual(ids(page1.items), [secondMatch.id]);
    assert.equal(page1.nextCursor, secondMatch.id);
    const page2 = (await app.inject({ url: `${path}&cursor=${page1.nextCursor}` })).json();
    assert.deepEqual(ids(page2.items), [first.id]);
    assert.equal(page2.nextCursor, null);
    for (const cursor of [
      noAttention.id,
      wrongStatus.id,
      wrongOwner.id,
      wrongSearch.id,
      otherProject.id,
      'missing',
    ]) {
      const response = await app.inject({ url: `${path}&cursor=${cursor}` });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'INVALID_CURSOR');
    }
    query.set('attention', 'absent');
    query.set('cursor', secondMatch.id);
    assert.equal(
      (await app.inject({ url: `/api/v1/spaces/${store.spaceId}/tasks?${query}` })).json().error
        .code,
      'INVALID_CURSOR',
    );
    assert.deepEqual(snapshot(store), before);
  } finally {
    await app.close();
  }
});

test('团队状态筛选保留认证、私有/项目/空间权限和当前参与关系，撤权不靠筛选恢复', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      hiddenProject = await f.project(bob),
      personalBob = { ...bob, spaceId: `personal-${bob.user.id}` },
      otherSpaceProject = await f.project(personalBob);
    const shared = await f.task(alice, project.id, '状态筛选 共享'),
      alicePrivate = await f.task(alice, null, '状态筛选 私有甲'),
      bobPrivate = await f.task(bob, null, '状态筛选 私有乙'),
      hidden = await f.task(bob, hiddenProject.id, '状态筛选 隐藏项目'),
      otherSpace = await f.task(personalBob, otherSpaceProject.id, '状态筛选 其他空间');
    for (const [account, tasks] of [
      [alice, [shared, alicePrivate]],
      [bob, [bobPrivate, hidden]],
      [personalBob, [otherSpace]],
    ] as const)
      for (const task of tasks)
        f.store.as(account, () => configure(f.store, task, 'todo', '需要确认'));
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
      200,
    );
    f.store.as(bob, () => participate(f.store, shared, bob.user.id));
    const query = new URLSearchParams({ q: '状态筛选', status: 'todo', attention: 'present' });
    const path = `spaces/${alice.spaceId}/tasks?${query}`;
    let before = snapshot(f.store);
    assert.equal((await f.call(path)).statusCode, 401);
    assert.deepEqual(ids((await f.call(path, alice)).json().items), ids([shared, alicePrivate]));
    assert.deepEqual(
      ids((await f.call(path, bob)).json().items),
      ids([shared, bobPrivate, hidden]),
    );
    assert.deepEqual(
      ids((await f.call(`${path}&ownerUserId=${alice.user.id}`, bob)).json().items),
      [shared.id],
    );
    assert.deepEqual(
      ids((await f.call(`${path}&participantUserId=${bob.user.id}`, alice)).json().items),
      [shared.id],
    );
    assert.equal((await f.call(`${path}&projectId=${hiddenProject.id}`, alice)).statusCode, 404);
    assert.equal((await f.call(`${path}&projectId=${otherSpaceProject.id}`, bob)).statusCode, 404);
    assert.equal(
      (await f.call(`spaces/${personalBob.spaceId}/tasks?${query}`, bob)).statusCode,
      404,
    );
    assert.equal(
      (await f.call(`${path}&cursor=${bobPrivate.id}`, alice)).json().error.code,
      'INVALID_CURSOR',
    );
    assert.deepEqual(snapshot(f.store), before);

    f.store.as(bob, () => participate(f.store, shared, bob.user.id, 'remove'));
    assert.deepEqual(
      (await f.call(`${path}&participantUserId=${bob.user.id}`, alice)).json().items,
      [],
    );
    assert.ok((await f.call(path, bob)).json().items.some((task: Task) => task.id === shared.id));
    f.store.as(bob, () => participate(f.store, shared, bob.user.id));
    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
      200,
    );
    before = snapshot(f.store);
    assert.equal((await f.call(`${path}&projectId=${project.id}`, bob)).statusCode, 404);
    assert.deepEqual(
      (await f.call(`${path}&participantUserId=${bob.user.id}`, alice)).json().items,
      [],
    );
    assert.equal(
      (await f.call(path, bob)).json().items.some((task: Task) => task.id === shared.id),
      false,
    );
    assert.equal(
      (await f.call(`${path}&cursor=${shared.id}`, bob)).json().error.code,
      'INVALID_CURSOR',
    );
    assert.deepEqual(snapshot(f.store), before);

    assert.equal(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
      200,
    );
    assert.deepEqual(
      (await f.call(`${path}&participantUserId=${bob.user.id}`, alice)).json().items,
      [],
    );
    f.store.as(bob, () => participate(f.store, shared, bob.user.id));
    assert.equal(
      (
        await f.call(`projects/${hiddenProject.id}/members/${alice.user.id}`, bob, {
          role: 'manage',
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    before = snapshot(f.store);
    assert.equal((await f.call(path, bob)).statusCode, 403);
    assert.deepEqual(
      (await f.call(`${path}&participantUserId=${bob.user.id}`, alice)).json().items,
      [],
    );
    assert.deepEqual(snapshot(f.store), before);
  } finally {
    await f.close();
  }
});
