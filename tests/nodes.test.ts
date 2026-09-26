import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../packages/db/src/store.js';
import { NodeRegistry } from '../packages/db/src/nodes.js';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  controlOrigin,
  parsePair,
  parseSnapshot,
  type NodeSnapshot,
} from '../packages/contracts/src/nodes.js';
import type { IdentityUser } from '../packages/contracts/src/identity.js';
import { teamFixture, ORIGIN } from './helpers/team.js';
const key = () => randomUUID();
const secret = () => randomBytes(32).toString('base64url');
const codeIs = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
function fixture() {
  const store = new Store(':memory:', undefined, { team: true });
  const alice: IdentityUser = {
    id: key(),
    name: '节点所有者',
    email: 'node-owner@example.invalid',
  };
  const bob: IdentityUser = { id: key(), name: '项目成员', email: 'node-member@example.invalid' };
  store.collaboration.ensurePerson(alice);
  store.collaboration.ensurePerson(bob);
  const space = store.as({ user: alice, spaceId: `personal-${alice.id}` }, () =>
    store.collaboration.createSpace('节点测试空间', key()),
  );
  store.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(space.id, bob.id, 'member');
  const as = <T>(user: IdentityUser, fn: () => T) => store.as({ user, spaceId: space.id }, fn);
  const project = as(alice, () =>
    store.createProject({ name: '显式授权项目', description: '' }, key()),
  );
  let now = Date.now();
  const registry = new NodeRegistry(store, () => now);
  const pair = () => {
    const pairing = as(alice, () => registry.createPairing(project.id, key()));
    const input = parsePair({
      code: pairing.code,
      nodeToken: secret(),
      clientId: key(),
      projectId: project.id,
      name: '研发电脑',
      platform: 'linux',
      arch: 'x64',
      protocol: 1,
      workspaces: [{ id: key(), name: '开发工作副本' }],
    });
    const node = registry.pair(input);
    return { pairing, input, node, connection: key() };
  };
  const snapshot = (id: string): NodeSnapshot => ({
    capturedAt: new Date(now).toISOString(),
    workspaces: [
      {
        id,
        state: 'available',
        capturedAt: new Date(now).toISOString(),
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicts: 0,
      },
    ],
  });
  return {
    store,
    alice,
    bob,
    as,
    space,
    project,
    registry,
    pair,
    snapshot,
    advance(ms: number) {
      now += ms;
    },
    clock: () => now,
  };
}

test('节点协议拒绝路径扩权、未知字段、伪造版本和外部控制地址', () => {
  for (const url of [
    'https://example.com',
    'http://localhost:4310',
    'http://127.0.0.1.evil.test:4310',
    'http://127.0.0.1:4310/a',
    'http://user:secret@127.0.0.1:4310',
    'http://127.0.0.1:4310/?token=x',
    'http://127.1:4310',
    'file:///tmp/test',
  ])
    assert.throws(() => controlOrigin(url), DomainError);
  assert.equal(controlOrigin('http://127.0.0.1:4310/'), 'http://127.0.0.1:4310');
  assert.equal(controlOrigin('http://[::1]:4310'), 'http://[::1]:4310');
  const f = fixture();
  try {
    const p = f.pair();
    assert.throws(() => parsePair({ ...p.input, protocol: 2 }), codeIs('PROTOCOL_UNSUPPORTED'));
    assert.throws(
      () => parsePair({ ...p.input, protocol: 1, roots: ['/etc'] }),
      codeIs('INVALID_INPUT'),
    );
    assert.throws(
      () => parsePair({ ...p.input, protocol: 1, name: '/home/user/repo' }),
      codeIs('INVALID_INPUT'),
    );
    assert.throws(
      () => parseSnapshot({ ...f.snapshot(p.input.workspaces[0]!.id), shell: 'touch secret' }),
      codeIs('INVALID_INPUT'),
    );
  } finally {
    f.store.close();
  }
});

test('配对码仅返回一次，凭证及配对明文不进入数据库或幂等记录', () => {
  const f = fixture();
  try {
    const replayKey = key(),
      p = f.as(f.alice, () => f.registry.createPairing(f.project.id, replayKey));
    assert.ok(p.code);
    assert.equal(f.as(f.alice, () => f.registry.createPairing(f.project.id, replayKey)).code, null);
    const raw =
      JSON.stringify(f.store.db.prepare('SELECT * FROM runner_pairings').all()) +
      JSON.stringify(f.store.db.prepare('SELECT * FROM idempotency_records').all());
    assert.ok(!raw.includes(p.code));
    const paired = f.pair();
    const nodes = JSON.stringify(f.store.db.prepare('SELECT * FROM runner_nodes').all());
    assert.ok(!nodes.includes(paired.input.nodeToken));
    assert.ok(!nodes.includes(paired.input.code));
    const view = f.as(f.alice, () => f.registry.get(paired.node.nodeId));
    assert.equal(view.executionEnabled, false);
    assert.deepEqual(view.capabilities, ['git-summary']);
    assert.equal(view.presence, 'paired');
    assert.equal(view.snapshot, null);
  } finally {
    f.store.close();
  }
});

test('配对消费幂等绑定同一节点身份和目录，不允许另一客户端接管', () => {
  const f = fixture();
  try {
    const p = f.pair();
    assert.equal(f.registry.pair(p.input).nodeId, p.node.nodeId);
    assert.throws(
      () => f.registry.pair({ ...p.input, nodeToken: secret() }),
      codeIs('PAIRING_USED'),
    );
    assert.throws(() => f.registry.pair({ ...p.input, clientId: key() }), codeIs('PAIRING_USED'));
    assert.throws(
      () => f.registry.pair({ ...p.input, workspaces: [{ id: key(), name: '另一个目录' }] }),
      codeIs('PAIRING_USED'),
    );
    assert.throws(() => f.registry.preview(p.input.code), codeIs('PAIRING_USED'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runner_nodes').get()?.n, 1);
  } finally {
    f.store.close();
  }
});

test('未消费配对码可以取消、过期，并与项目确认范围绑定', () => {
  const f = fixture();
  try {
    const p = f.as(f.alice, () => f.registry.createPairing(f.project.id, key()));
    assert.equal(f.registry.preview(p.code!).projectId, f.project.id);
    f.as(f.alice, () => f.registry.cancelPairing(p.id, key()));
    assert.throws(() => f.registry.preview(p.code!), codeIs('PAIRING_INVALID'));
    const second = f.as(f.alice, () => f.registry.createPairing(f.project.id, key()));
    f.advance(10 * 60000);
    assert.throws(() => f.registry.preview(second.code!), codeIs('PAIRING_INVALID'));
  } finally {
    f.store.close();
  }
});

test('配对注册与消费必须同时提交，故障不会留下半个节点', () => {
  const f = fixture();
  try {
    const p = f.as(f.alice, () => f.registry.createPairing(f.project.id, key()));
    const input = parsePair({
      code: p.code,
      nodeToken: secret(),
      clientId: key(),
      projectId: f.project.id,
      name: '事务测试',
      platform: 'linux',
      arch: 'x64',
      protocol: 1,
      workspaces: [{ id: key(), name: '工作副本' }],
    });
    f.store.db.exec(
      "CREATE TRIGGER fixture_pair_failure BEFORE UPDATE ON runner_pairings BEGIN SELECT RAISE(ABORT,'fixture pair failure'); END;",
    );
    assert.throws(() => f.registry.pair(input), /fixture pair failure/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runner_nodes').get()?.n, 0);
    f.store.db.exec('DROP TRIGGER fixture_pair_failure;');
    assert.ok(f.registry.pair(input).nodeId);
  } finally {
    f.store.close();
  }
});

test('目录摘要只接受已授权 ID，ACK 去重且拒绝跳号或同序号不同内容', () => {
  const f = fixture();
  try {
    const p = f.pair(),
      snapshot = f.snapshot(p.input.workspaces[0]!.id);
    f.registry.hello(p.input.nodeToken, p.connection);
    assert.throws(
      () => f.registry.sync(p.input.nodeToken, p.connection, 1, f.snapshot(key())),
      codeIs('WORKSPACE_SCOPE_MISMATCH'),
    );
    assert.equal(
      f.registry.sync(p.input.nodeToken, p.connection, 1, snapshot).acknowledgedSequence,
      1,
    );
    assert.equal(
      f.registry.sync(p.input.nodeToken, p.connection, 1, snapshot).acknowledgedSequence,
      1,
    );
    assert.throws(
      () => f.registry.sync(p.input.nodeToken, p.connection, 3, snapshot),
      codeIs('SEQUENCE_GAP'),
    );
    assert.throws(
      () =>
        f.registry.sync(p.input.nodeToken, p.connection, 1, {
          ...snapshot,
          workspaces: [{ ...snapshot.workspaces[0]!, modified: 9 }],
        }),
      codeIs('SEQUENCE_CONFLICT'),
    );
    assert.equal(f.as(f.alice, () => f.registry.get(p.node.nodeId)).acknowledgedSequence, 1);
  } finally {
    f.store.close();
  }
});

test('心跳陈旧、离线和未知与任务运行分开，重启后必须重新握手', () => {
  const f = fixture();
  try {
    const p = f.pair();
    f.registry.hello(p.input.nodeToken, p.connection);
    f.registry.sync(p.input.nodeToken, p.connection, 1, f.snapshot(p.input.workspaces[0]!.id));
    const view = () => f.as(f.alice, () => f.registry.get(p.node.nodeId));
    assert.equal(view().presence, 'online');
    f.advance(20001);
    assert.equal(view().presence, 'stale');
    f.advance(40000);
    assert.equal(view().presence, 'offline');
    const restarted = new NodeRegistry(f.store, f.clock);
    assert.equal(f.as(f.alice, () => restarted.get(p.node.nodeId)).presence, 'unknown');
    assert.throws(
      () =>
        restarted.sync(p.input.nodeToken, p.connection, 2, f.snapshot(p.input.workspaces[0]!.id)),
      codeIs('RECONNECT_REQUIRED'),
    );
    restarted.hello(p.input.nodeToken, p.connection);
    restarted.sync(p.input.nodeToken, p.connection, 2, f.snapshot(p.input.workspaces[0]!.id));
    assert.equal(f.as(f.alice, () => restarted.get(p.node.nodeId)).presence, 'online');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 0);
  } finally {
    f.store.close();
  }
});

test('连接代次阻止双进程和旧连接迟到续租，主动退出立即显示离线', () => {
  const f = fixture();
  try {
    const p = f.pair(),
      other = key();
    f.registry.hello(p.input.nodeToken, p.connection);
    assert.throws(
      () => f.registry.hello(p.input.nodeToken, other),
      codeIs('NODE_ALREADY_CONNECTED'),
    );
    f.registry.sync(p.input.nodeToken, p.connection, 1, f.snapshot(p.input.workspaces[0]!.id));
    f.advance(20001);
    f.registry.hello(p.input.nodeToken, other);
    assert.throws(
      () =>
        f.registry.sync(p.input.nodeToken, p.connection, 2, f.snapshot(p.input.workspaces[0]!.id)),
      codeIs('RECONNECT_REQUIRED'),
    );
    f.registry.sync(p.input.nodeToken, other, 2, f.snapshot(p.input.workspaces[0]!.id));
    f.registry.goodbye(p.input.nodeToken, other);
    assert.equal(f.as(f.alice, () => f.registry.get(p.node.nodeId)).presence, 'offline');
  } finally {
    f.store.close();
  }
});

test('空间成员不自动看到节点；项目只读可看摘要但无配对或节点撤销权', () => {
  const f = fixture();
  try {
    const p = f.pair();
    assert.deepEqual(
      f.as(f.bob, () => f.registry.list()),
      [],
    );
    assert.throws(() => f.as(f.bob, () => f.registry.get(p.node.nodeId)), codeIs('NOT_FOUND'));
    f.as(f.alice, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.bob.id, 'view', key()),
    );
    assert.equal(f.as(f.bob, () => f.registry.list()).length, 1);
    assert.equal(f.as(f.bob, () => f.registry.get(p.node.nodeId)).canRevoke, false);
    assert.throws(
      () => f.as(f.bob, () => f.registry.createPairing(f.project.id, key())),
      codeIs('FORBIDDEN'),
    );
    assert.throws(
      () => f.as(f.bob, () => f.registry.revoke(p.node.nodeId, 1, key())),
      codeIs('FORBIDDEN'),
    );
    f.as(f.alice, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.bob.id, null, key()),
    );
    assert.deepEqual(
      f.as(f.bob, () => f.registry.list()),
      [],
    );
  } finally {
    f.store.close();
  }
});

test('节点所有者主动撤销后，旧节点凭证与原配对码均不能复活', () => {
  const f = fixture();
  try {
    const p = f.pair(),
      replay = key();
    f.as(f.alice, () => f.registry.revoke(p.node.nodeId, 1, replay));
    assert.equal(
      f.as(f.alice, () => f.registry.revoke(p.node.nodeId, 1, replay)).presence,
      'revoked',
    );
    assert.throws(() => f.registry.hello(p.input.nodeToken, p.connection), codeIs('NODE_REVOKED'));
    assert.throws(() => f.registry.pair(p.input), codeIs('PAIRING_USED'));
  } finally {
    f.store.close();
  }
});

test('项目撤权即使随后恢复，也永久撤销旧节点和待配对码', () => {
  const f = fixture();
  try {
    f.as(f.alice, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.bob.id, 'manage', key()),
    );
    const p = f.pair();
    const pending = f.as(f.alice, () => f.registry.createPairing(f.project.id, key()));
    f.as(f.bob, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.alice.id, 'view', key()),
    );
    f.as(f.bob, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.alice.id, 'edit', key()),
    );
    assert.throws(() => f.registry.hello(p.input.nodeToken, p.connection), codeIs('NODE_REVOKED'));
    assert.throws(() => f.registry.preview(pending.code!), codeIs('PAIRING_INVALID'));
  } finally {
    f.store.close();
  }
});

test('摘要不可夹带文件路径、凭证字段和无效数量，不可伪造不可访问目录的计数', () => {
  const f = fixture();
  try {
    const p = f.pair(),
      s = f.snapshot(p.input.workspaces[0]!.id);
    for (const change of [
      { path: '/secret' },
      { code: 'secret' },
      { modified: -1 },
      { untracked: Infinity },
      { state: 'unavailable' },
    ])
      assert.throws(
        () => parseSnapshot({ ...s, workspaces: [{ ...s.workspaces[0], ...change }] }),
        DomainError,
      );
    assert.throws(
      () => parseSnapshot({ ...s, workspaces: [s.workspaces[0], s.workspaces[0]] }),
      DomainError,
    );
    f.registry.hello(p.input.nodeToken, p.connection);
    assert.throws(
      () =>
        f.registry.sync(p.input.nodeToken, p.connection, 1, {
          ...s,
          capturedAt: new Date(f.clock() + 120000).toISOString(),
        }),
      codeIs('CLOCK_SKEW'),
    );
  } finally {
    f.store.close();
  }
});

test('真实账号和节点通道不可互相冒用，配对不解锁团队执行', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice);
    const paired = await f.call('nodes/pairings', alice, { projectId: project.id });
    assert.equal(paired.statusCode, 201, paired.body);
    const input = {
      code: paired.json().code,
      nodeToken: secret(),
      clientId: key(),
      projectId: project.id,
      name: '真实节点协议',
      platform: 'linux',
      arch: 'x64',
      protocol: 1,
      workspaces: [{ id: key(), name: '工作副本' }],
    };
    const send = (path: string, payload: unknown, extra: Record<string, string> = {}) =>
      f.app.inject({
        url: '/runner/v1/' + path,
        method: 'POST',
        payload: payload as Record<string, unknown>,
        headers: { 'x-hexu-runner': '1', ...extra },
      });
    assert.equal((await send('pair', input, { cookie: alice.cookie })).statusCode, 403);
    assert.equal((await send('pair', input, { origin: ORIGIN })).statusCode, 403);
    const response = await send('pair', input);
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().nodeId;
    assert.equal((await f.call(`nodes/${id}`, bob)).statusCode, 404);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/v1/nodes',
          headers: { authorization: `Bearer ${input.nodeToken}` },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await send('hello?token=secret', { protocol: 1, connectionId: key() })).statusCode,
      403,
    );
    assert.equal((await send('hello', { protocol: 1, connectionId: key() })).statusCode, 401);
    const hello = await send(
      'hello',
      { protocol: 1, connectionId: key() },
      { authorization: `Bearer ${input.nodeToken}` },
    );
    assert.equal(hello.statusCode, 200, hello.body);
    assert.equal(hello.json().executionEnabled, false);
    const task = await f.task(alice, project.id);
    assert.equal(
      (await f.call(`tasks/${task.id}/runs`, alice, { provider: 'native' })).statusCode,
      422,
    );
    assert.equal((await f.call('native', alice)).statusCode, 422);
  } finally {
    await f.close();
  }
});

test('配对限额与取消后的可重建行为受到约束', () => {
  const f = fixture();
  try {
    const items = Array.from({ length: 5 }, () =>
      f.as(f.alice, () => f.registry.createPairing(f.project.id, key())),
    );
    assert.throws(
      () => f.as(f.alice, () => f.registry.createPairing(f.project.id, key())),
      codeIs('PAIRING_LIMIT'),
    );
    f.as(f.alice, () => f.registry.cancelPairing(items[0]!.id, key()));
    assert.ok(f.as(f.alice, () => f.registry.createPairing(f.project.id, key())).code);
  } finally {
    f.store.close();
  }
});

test('节点原所有者被移出项目后也不能通过节点或配对记录看到项目新信息', () => {
  const f = fixture();
  try {
    f.as(f.alice, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.bob.id, 'manage', key()),
    );
    const p = f.pair();
    f.as(f.bob, () =>
      f.store.collaboration.setProjectMember(f.project.id, f.alice.id, null, key()),
    );
    assert.throws(() => f.as(f.alice, () => f.registry.get(p.node.nodeId)), codeIs('NOT_FOUND'));
    assert.deepEqual(
      f.as(f.alice, () => f.registry.list()),
      [],
    );
    assert.deepEqual(
      f.as(f.alice, () => f.registry.pairings()),
      [],
    );
    assert.throws(() => f.registry.hello(p.input.nodeToken, p.connection), codeIs('NODE_REVOKED'));
  } finally {
    f.store.close();
  }
});
