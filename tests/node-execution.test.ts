import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from '../packages/db/src/store.js';
import { NodeRegistry } from '../packages/db/src/nodes.js';
import { NodeExecution, executionHash } from '../packages/db/src/node-execution.js';
import {
  parseNodeRun,
  parsePolicy,
  parseExecutionEvent,
  type ExecutionEvent,
  type ExecutionPolicy,
} from '../packages/contracts/src/node-execution.js';
import { parsePair } from '../packages/contracts/src/nodes.js';
import { DomainError, type Run } from '../packages/contracts/src/index.js';
import type { IdentityUser } from '../packages/contracts/src/identity.js';
const key = () => randomUUID();
const code = (value: string) => (e: unknown) => e instanceof DomainError && e.code === value;
function fixture() {
  const store = new Store(':memory:', undefined, { team: true });
  const alice: IdentityUser = {
    id: key(),
    email: 'node-owner@example.invalid',
    name: '节点所有者',
  };
  const bob: IdentityUser = {
    id: key(),
    email: 'project-editor@example.invalid',
    name: '其他项目成员',
  };
  store.collaboration.ensurePerson(alice);
  store.collaboration.ensurePerson(bob);
  const space = store.as({ user: alice, spaceId: `personal-${alice.id}` }, () =>
    store.collaboration.createSpace('执行测试', key()),
  );
  store.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(space.id, bob.id, 'member');
  const as = <T>(fn: () => T, user = alice) => store.as({ user, spaceId: space.id }, fn);
  const project = as(() =>
    store.createProject({ name: '本机明确授权项目', description: '' }, key()),
  );
  store.db
    .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
    .run(project.id, bob.id, 'edit');
  const task = as(() =>
    store.createTask({ title: '实际任务', description: '原始说明', projectId: project.id }, key()),
  );
  const nodes = new NodeRegistry(store),
    execution = new NodeExecution(store, nodes);
  const token = randomBytes(32).toString('base64url'),
    workspace = key(),
    connection = key();
  const pairing = as(() => nodes.createPairing(project.id, key()));
  const n = nodes.pair(
    parsePair({
      protocol: 1,
      code: pairing.code,
      nodeToken: token,
      clientId: key(),
      projectId: project.id,
      name: '本人电脑',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: workspace, name: '项目目录' }],
    }),
  );
  nodes.hello(token, connection);
  nodes.sync(token, connection, 1, {
    capturedAt: new Date().toISOString(),
    workspaces: [
      {
        id: workspace,
        state: 'available',
        capturedAt: new Date().toISOString(),
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
    ],
  });
  const policy: ExecutionPolicy = {
    grantId: key(),
    tool: 'claude-code',
    model: null,
    mode: 'edit',
    workspaceIds: [workspace],
    timeoutSeconds: 30,
    maxTurns: 8,
    maxBudgetUsd: 1,
    toolVersion: 'protocol fixture only',
  };
  const publish = () => execution.publish(token, connection, policy);
  const body = () => ({
    provider: 'node',
    nodeId: n.nodeId,
    workingCopyId: workspace,
    policyHash: executionHash(policy),
    mode: 'edit',
    prompt: '实现范围明确的修改',
    expectedRevision: as(() => store.getTask(task.id).revision),
    confirmExecution: true,
  });
  const create = (idempotency: string = key()) =>
    as(() => execution.create(task.id, parseNodeRun(body()), idempotency));
  const command = () => execution.poll(token, connection).command!;
  const send = (
    c: ReturnType<typeof command>,
    sequence: number,
    kind: ExecutionEvent['kind'],
    result: ExecutionEvent['result'] = null,
    text = '',
  ) =>
    execution.acceptEvent(token, c.id, c.generation, {
      sequence,
      kind,
      result,
      text,
      terminationConfirmed: kind === 'terminal',
    });
  const running = () => {
    publish();
    const run = create(),
      c = command();
    send(c, 1, 'accepted');
    assert.equal(execution.permit(token, connection, c.id, c.generation).allowed, true);
    send(c, 2, 'running');
    return { run, c };
  };
  return {
    store,
    nodes,
    execution,
    alice,
    bob,
    space,
    project,
    task,
    token,
    workspace,
    connection,
    n,
    policy,
    publish,
    body,
    create,
    command,
    send,
    running,
    as,
    close: () => store.close(),
  };
}

test('执行契约拒绝伪造路径/账户/工具参数、未确认费用与非法终态', () => {
  const f = fixture();
  try {
    for (const change of [
      { root: '/etc' },
      { apiKey: 'fake' },
      { args: [] },
      { requestedTool: 'other' },
      { confirmExecution: false },
    ])
      assert.throws(() => parseNodeRun({ ...f.body(), ...change }), DomainError);
    assert.throws(() => parsePolicy({ ...f.policy, timeoutSeconds: 9999 }), DomainError);
    assert.throws(() => parsePolicy({ ...f.policy, tool: 'codex', maxBudgetUsd: 1 }), DomainError);
    assert.throws(
      () =>
        parseExecutionEvent({
          sequence: 1,
          kind: 'terminal',
          text: '',
          result: 'cancelled',
          terminationConfirmed: false,
        }),
      DomainError,
    );
  } finally {
    f.close();
  }
});
test('摘要配对不授予执行，且项目编辑权不能替代节点所有权', () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.as(() => f.execution.options(f.task.id).items),
      [],
    );
    assert.throws(() => f.create(), code('EXECUTION_UNAVAILABLE'));
    f.publish();
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items.length),
      1,
    );
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items.length, f.bob),
      0,
    );
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, parseNodeRun(f.body()), key()), f.bob),
      code('NODE_OWNER_REQUIRED'),
    );
    assert.throws(
      () => f.execution.publish(f.token, f.connection, { ...f.policy, workspaceIds: [key()] }),
      code('WORKSPACE_SCOPE_MISMATCH'),
    );
  } finally {
    f.close();
  }
});
test('事务故障共同回滚 Run、派发、消息与幂等结果', () => {
  const f = fixture();
  try {
    f.publish();
    f.store.db.exec(
      "CREATE TRIGGER fail_dispatch BEFORE INSERT ON node_dispatches BEGIN SELECT RAISE(ABORT,'fixture dispatch failure'); END;",
    );
    assert.throws(() => f.create('atomic-key'), /fixture dispatch failure/);
    assert.equal(
      f.as(() => f.store.runs(f.task.id).length),
      0,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM node_dispatches').get()?.n, 0);
    f.store.db.exec('DROP TRIGGER fail_dispatch;');
    assert.ok(f.create('atomic-key').id);
  } finally {
    f.close();
  }
});
test('重复提交只有一个 Run，接单不等于进程启动，启动许可只发一次', () => {
  const f = fixture();
  try {
    f.publish();
    const id = key(),
      run = f.create(id),
      c = f.command();
    assert.equal(f.create(id).id, run.id);
    assert.equal(
      f.as(() => f.store.getTask(f.task.id).status),
      'todo',
    );
    f.send(c, 1, 'accepted');
    assert.equal(
      f.as(() => f.store.run(run.id).node?.phase),
      'accepted',
    );
    assert.equal(
      f.as(() => f.store.getTask(f.task.id).status),
      'todo',
    );
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, true);
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    f.send(c, 2, 'running');
    assert.equal(
      f.as(() => f.store.getTask(f.task.id).status),
      'in_progress',
    );
    f.send(c, 3, 'terminal', 'succeeded', '可信协议结果');
    assert.equal(
      f.as(() => f.store.run(run.id).state),
      'succeeded',
    );
    assert.equal(
      f.as(() => f.store.getTask(f.task.id).status),
      'in_progress',
    );
  } finally {
    f.close();
  }
});
test('ACK 丢失重放去重，乱序、异内容和另一派发代次不能修改执行', () => {
  const f = fixture();
  try {
    const { c } = f.running();
    f.send(c, 3, 'output', null, '一次输出');
    assert.equal(f.send(c, 3, 'output', null, '一次输出').acknowledgedSequence, 3);
    assert.equal(
      f.as(() => f.store.messages(f.task.id).filter((m) => m.body === '一次输出').length),
      1,
    );
    assert.throws(() => f.send(c, 3, 'output', null, 'different'), code('SEQUENCE_CONFLICT'));
    assert.throws(() => f.send(c, 5, 'output'), code('SEQUENCE_GAP'));
    assert.throws(
      () => f.send({ ...c, generation: key() }, 4, 'terminal', 'succeeded'),
      code('DISPATCH_NOT_FOUND'),
    );
  } finally {
    f.close();
  }
});
test('接单后新增人工要求会阻止启动，保留请求与取消原因', () => {
  const f = fixture();
  try {
    f.publish();
    const run = f.create(),
      c = f.command();
    f.send(c, 1, 'accepted');
    f.as(() => f.store.addMessage(f.task.id, '新的人工范围', null, key()));
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    assert.equal(
      f.as(() => f.store.run(run.id).state),
      'cancelled',
    );
    assert.match(
      f.as(() => f.store.messages(f.task.id).at(-1)!.body),
      /上下文/,
    );
  } finally {
    f.close();
  }
});
test('排队取消不发启动许可，运行中停止必须等待真正终态后解锁', () => {
  const f = fixture();
  try {
    f.publish();
    const queued = f.create(),
      c = f.command();
    f.as(() => f.store.stopRun(queued.id, key()));
    f.execution.reconcile();
    assert.equal(
      f.as(() => f.store.run(queued.id).state),
      'cancelled',
    );
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    const { run, c: second } = f.running();
    f.as(() => f.store.stopRun(run.id, key()));
    f.execution.reconcile();
    assert.equal(f.execution.poll(f.token, f.connection).stopRequested, true);
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items[0]!.available),
      false,
    );
    f.send(second, 3, 'terminal', 'cancelled');
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items[0]!.available),
      true,
    );
  } finally {
    f.close();
  }
});
test('未知旧进程保留节点占用，控制服务重启不重发启动许可', () => {
  const f = fixture();
  try {
    const { run, c } = f.running();
    const restarted = new NodeExecution(f.store, f.nodes);
    assert.equal(
      f.as(() => f.store.run(run.id).observation),
      'unknown',
    );
    assert.equal(
      f.as(() => restarted.options(f.task.id).items[0]!.available),
      false,
    );
    assert.equal(restarted.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    f.send(c, 3, 'terminal', 'cancelled', '本机操作者确认停止');
    assert.equal(
      f.as(() => f.store.run(run.id).node?.terminationConfirmed),
      true,
    );
  } finally {
    f.close();
  }
});
test('运行中撤权只允许收尾证据，输出不再公开，旧凭证不能获取命令', () => {
  const f = fixture();
  try {
    const { c, run } = f.running();
    f.as(() => f.nodes.revoke(f.n.nodeId, 1, key()));
    f.execution.reconcile();
    assert.throws(() => f.execution.poll(f.token, f.connection), code('NODE_REVOKED'));
    f.send(c, 3, 'output', null, '撤权后的内容不应分享');
    f.send(c, 4, 'terminal', 'cancelled', '撤权后的终态原文也不分享');
    assert.equal(
      f.as(() => f.store.run(run.id).state),
      'cancelled',
    );
    const data = f.as(() => JSON.stringify(f.store.messages(f.task.id)));
    assert.ok(!data.includes('撤权后的内容不应分享'));
    assert.ok(!data.includes('撤权后的终态原文也不分享'));
  } finally {
    f.close();
  }
});
test('已结束记录不被迟到事件改回运行；完成任务也不吞掉执行终态', () => {
  const f = fixture();
  try {
    const { c, run } = f.running();
    f.as(() =>
      f.store.changeTask(f.task.id, 'done', f.store.getTask(f.task.id).revision, 'keep', key()),
    );
    f.send(c, 3, 'terminal', 'succeeded');
    f.send(c, 4, 'running');
    assert.equal(
      f.as(() => f.store.run(run.id).state),
      'succeeded',
    );
    assert.equal(
      f.as(() => f.store.getTask(f.task.id).status),
      'done',
    );
  } finally {
    f.close();
  }
});
