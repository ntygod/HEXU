import { NextInputs } from '../packages/db/src/next-inputs.js';
import { parseNextInput, nodeContinuationContext } from '../packages/contracts/src/next-input.js';
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

// E2b3: actual source/selection/queue semantics, never live provider input.
function continued(f: ReturnType<typeof fixture>, source: Run, ids: string[] = []) {
  const queue = new NextInputs(f.store);
  const preview = f.as(() => f.execution.continuationPreview(f.task.id, source.id));
  const notes = f.as(() => queue.list(f.task.id));
  return parseNodeRun({
    ...f.body(),
    prompt: '后续修改',
    continuation: {
      sourceRunId: source.id,
      expectedContextHash: preview.contextHash,
      inputs: ids.map((id) => ({ id, revision: notes.find((i) => i.id === id)!.revision })),
    },
  });
}
test('下一轮要求严格拒绝即时发送、额外参数及重复/过量选择', () => {
  const f = fixture();
  try {
    assert.throws(() => parseNextInput({ body: '要求', delivery: 'immediate' }), DomainError);
    assert.throws(() => parseNextInput({ body: ' '.repeat(4) }), DomainError);
    assert.throws(() => parseNextInput({ body: 'x'.repeat(2001) }), DomainError);
    const selection = { sourceRunId: key(), expectedContextHash: 'a'.repeat(64), inputs: [] };
    assert.throws(
      () => parseNodeRun({ ...f.body(), continuation: { ...selection, resume: true } }),
      DomainError,
    );
    const id = key();
    assert.throws(
      () =>
        parseNodeRun({
          ...f.body(),
          continuation: {
            ...selection,
            inputs: [
              { id, revision: 1 },
              { id, revision: 1 },
            ],
          },
        }),
      DomainError,
    );
    assert.throws(
      () => nodeContinuationContext('x'.repeat(18000), 'y'.repeat(3000), []),
      code('MATERIAL_LIMIT'),
    );
  } finally {
    f.close();
  }
});
test('保存下一轮要求不改变当前派发、上下文或状态；本人可编辑撤回，重放不重复', () => {
  const f = fixture();
  try {
    f.publish();
    const run = f.create(),
      command = f.command(),
      q = new NextInputs(f.store);
    const op = key();
    const note = f.as(() => q.create(run.id, '下一轮加入空状态', op));
    assert.equal(f.as(() => q.create(run.id, note.body, op)).id, note.id);
    assert.equal(f.command().context, command.context);
    assert.equal(f.as(() => f.store.run(run.id)).state, 'queued');
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    const edited = f.as(() => q.edit(note.id, note.revision, '修改下一轮要求', key()));
    assert.equal(edited.revision, 2);
    assert.throws(() => f.as(() => q.edit(note.id, 1, '过期编辑', key())), DomainError);
    assert.throws(
      () => f.as(() => q.edit(note.id, 2, '修改他人要求', key()), f.bob),
      code('INPUT_AUTHOR_REQUIRED'),
    );
    assert.equal(f.as(() => q.edit(note.id, 2, null, key())).state, 'cancelled');
    // Queueing next-round input doesn't invalidate existing material/permit.
    f.send(command, 1, 'accepted');
    assert.equal(
      f.execution.permit(f.token, f.connection, command.id, command.generation).allowed,
      true,
    );
  } finally {
    f.close();
  }
});
test('接续必须确认来源结束，同一任务/节点/目录，旧来源和未知进程不能继续', () => {
  const f = fixture();
  try {
    const { run, c } = f.running();
    const pending = continued(f, run);
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, pending, key())),
      code('SOURCE_NOT_STOPPED'),
    );
    f.send(c, 3, 'unknown');
    assert.equal(f.as(() => f.execution.continuationPreview(f.task.id, run.id)).ready, false);
    f.send(c, 4, 'terminal', 'cancelled');
    const ready = continued(f, run);
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, { ...ready, workingCopyId: key() }, key())),
      code('CONTINUATION_SCOPE_CHANGED'),
    );
    const next = f.as(() => f.execution.create(f.task.id, ready, key()));
    assert.equal(next.previousRunId, run.id);
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, ready, key())),
      code('SOURCE_CHANGED'),
    );
    assert.throws(
      () => f.as(() => f.execution.continuationPreview(f.task.id, run.id), f.bob),
      code('NODE_OWNER_REQUIRED'),
    );
    const other = f.as(() =>
      f.store.createTask({ title: '其他任务', description: '', projectId: f.project.id }, key()),
    );
    assert.throws(
      () => f.as(() => f.execution.continuationPreview(other.id, run.id)),
      code('INVALID_CONTINUATION'),
    );
  } finally {
    f.close();
  }
});
test('只采用明确选择的要求和本次来源输出，不采用其他执行或终态后的迟到输出', () => {
  const f = fixture();
  try {
    const { run, c } = f.running(),
      q = new NextInputs(f.store);
    const note = f.as(() => q.create(run.id, '明确采用的要求', key()), f.bob);
    f.as(() => q.create(run.id, '不得自动带入的要求', key()));
    f.send(c, 3, 'output', null, '本次来源输出');
    f.send(c, 4, 'terminal', 'succeeded');
    f.send(c, 5, 'output', null, '终态后迟到不公开输出');
    const input = continued(f, run, [note.id]),
      idempotency = key();
    const next = f.as(() => f.execution.create(f.task.id, input, idempotency));
    const target = f.command();
    assert.match(target.context, /本次来源输出/);
    assert.match(target.context, /明确采用的要求/);
    assert.ok(!target.context.includes('不得自动带入的要求'));
    assert.ok(!target.context.includes('终态后迟到不公开输出'));
    assert.equal(f.as(() => q.list(f.task.id)).find((i) => i.id === note.id)!.state, 'attached');
    assert.equal(f.as(() => f.execution.create(f.task.id, input, idempotency)).id, next.id);
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 2);
    assert.throws(
      () => f.as(() => q.edit(note.id, 2, '修改派发材料', key()), f.bob),
      code('INPUT_BOUND'),
    );
    f.send(target, 1, 'accepted');
    assert.equal(
      f.execution.permit(f.token, f.connection, target.id, target.generation).allowed,
      true,
    );
    assert.equal(f.as(() => q.list(f.task.id)).find((i) => i.id === note.id)!.state, 'attached');
    f.send(target, 2, 'running');
    assert.equal(f.as(() => q.list(f.task.id)).find((i) => i.id === note.id)!.state, 'started');
    f.send(target, 3, 'terminal', 'succeeded');
    assert.equal(f.as(() => f.store.getTask(f.task.id)).status, 'in_progress');
  } finally {
    f.close();
  }
});
test('旧材料预览、旧要求修订、跨任务选择和撤回要求都在事务内拒绝', () => {
  const f = fixture();
  try {
    const { run, c } = f.running(),
      q = new NextInputs(f.store);
    const note = f.as(() => q.create(run.id, '原要求', key()));
    f.send(c, 3, 'terminal', 'succeeded');
    const stale = continued(f, run, [note.id]);
    f.as(() => q.edit(note.id, 1, '新要求', key()));
    assert.throws(() => f.as(() => f.execution.create(f.task.id, stale, key())), DomainError);
    const current = continued(f, run, [note.id]);
    f.as(() => f.store.addMessage(f.task.id, '新的人工讨论', null, key()));
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, current, key())),
      code('CONTEXT_CHANGED'),
    );
    const cancelled = continued(f, run, [note.id]);
    f.as(() => q.edit(note.id, 2, null, key()));
    assert.throws(() => f.as(() => f.execution.create(f.task.id, cancelled, key())), DomainError);
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
  } finally {
    f.close();
  }
});
test('接续关联和选中要求随派发事务共同回滚；取消未启动的派发可重新选择', () => {
  const f = fixture();
  try {
    const { run, c } = f.running(),
      q = new NextInputs(f.store);
    const note = f.as(() => q.create(run.id, '保留待使用要求', key()));
    f.send(c, 3, 'terminal', 'succeeded');
    const input = continued(f, run, [note.id]),
      operation = key();
    f.store.db.exec(
      "CREATE TRIGGER fail_link BEFORE INSERT ON node_continuation_links BEGIN SELECT RAISE(ABORT,'link fixture failure'); END;",
    );
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, input, operation)),
      /link fixture failure/,
    );
    assert.equal(f.as(() => q.list(f.task.id))[0]!.state, 'queued');
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    f.store.db.exec('DROP TRIGGER fail_link');
    const next = f.as(() => f.execution.create(f.task.id, input, operation));
    f.as(() => f.store.stopRun(next.id, key()));
    f.execution.reconcile();
    assert.equal(f.as(() => q.list(f.task.id))[0]!.state, 'queued');
    assert.equal(f.as(() => q.list(f.task.id))[0]!.targetRunId, null);
    // Explicitly select returned note in a new continuation, never silently retry.
    assert.equal(
      f.as(() => f.execution.create(f.task.id, continued(f, next, [note.id]), key())).previousRunId,
      next.id,
    );
  } finally {
    f.close();
  }
});
test('已获启动许可但状态未知的接续不自动重排要求或启动；控制服务重启保留关联', () => {
  const f = fixture();
  try {
    const { run, c } = f.running(),
      q = new NextInputs(f.store);
    const note = f.as(() => q.create(run.id, '不能重复执行的要求', key()));
    f.send(c, 3, 'terminal', 'succeeded');
    const next = f.as(() => f.execution.create(f.task.id, continued(f, run, [note.id]), key()));
    const command = f.command();
    f.send(command, 1, 'accepted');
    assert.equal(
      f.execution.permit(f.token, f.connection, command.id, command.generation).allowed,
      true,
    );
    new NodeExecution(f.store, f.nodes);
    const retained = f.as(() => q.list(f.task.id))[0]!;
    assert.equal(retained.state, 'attached');
    assert.equal(retained.targetRunId, next.id);
    assert.equal(f.as(() => f.execution.continuationPreview(f.task.id, next.id)).ready, false);
    f.send(command, 2, 'terminal', 'cancelled', '本机已核对停止，启动历史不明');
    assert.equal(f.as(() => q.list(f.task.id))[0]!.state, 'attached');
  } finally {
    f.close();
  }
});
test('下一轮要求沿用项目权限；撤权后的列表与幂等重放均不能泄露，队列有界', () => {
  const f = fixture();
  try {
    const { run } = f.running(),
      q = new NextInputs(f.store),
      op = key();
    const note = f.as(() => q.create(run.id, '成员原要求', op), f.bob);
    for (let i = 0; i < 19; i++) f.as(() => q.create(run.id, `待使用 ${i}`, key()));
    assert.throws(() => f.as(() => q.create(run.id, '超限', key())), code('INPUT_QUEUE_FULL'));
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(f.project.id, f.bob.id);
    assert.throws(() => f.as(() => q.list(f.task.id), f.bob), DomainError);
    assert.throws(() => f.as(() => q.create(run.id, note.body, op), f.bob), DomainError);
    assert.throws(() => f.as(() => q.edit(note.id, 1, null, key()), f.bob), DomainError);
  } finally {
    f.close();
  }
});

// E2b4 uses the same task/dispatch fixtures. No model or real account credentials.
import { NodeContinuations } from '../packages/db/src/node-continuations.js';
import { parseNodeContinuationOperation } from '../packages/contracts/src/node-continuation.js';
function operationFixture(start = true) {
  const f = fixture();
  f.publish();
  const source = start ? f.running() : { run: f.create(), c: f.command() };
  const operations = new NodeContinuations(f.store, f.execution);
  const body = (
    onActiveRun: 'wait' | 'request_stop' = 'wait',
    inputs: { id: string; revision: number }[] = [],
  ) => ({
    ...f.body(),
    prompt: '冻结的下一次要求',
    onActiveRun,
    continuation: {
      sourceRunId: source.run.id,
      expectedContextHash: f.as(
        () => f.execution.continuationPreview(f.task.id, source.run.id, true).contextHash,
      ),
      inputs,
    },
  });
  const schedule = (
    mode: 'wait' | 'request_stop' = 'wait',
    inputs: { id: string; revision: number }[] = [],
    id = key(),
  ) =>
    f.as(() =>
      operations.create(f.task.id, parseNodeContinuationOperation(body(mode, inputs)), id),
    );
  const read = (id: string) => f.as(() => operations.get(id));
  return { ...f, source, operations, body, schedule, read };
}

test('节点接续契约必须明确来源、停止策略与费用确认，拒绝执行参数扩权', () => {
  const f = operationFixture();
  try {
    for (const patch of [
      { onActiveRun: undefined },
      { continuation: undefined },
      { confirmExecution: false },
      { executable: '/bin/sh' },
      { contextText: 'injected' },
    ])
      assert.throws(() => parseNodeContinuationOperation({ ...f.body(), ...patch }), DomainError);
  } finally {
    f.close();
  }
});

test('节点等待安排冻结材料；自然结束后原子创建 Run，不补入后来的模型输出或新要求', () => {
  const f = operationFixture();
  try {
    f.send(f.source.c, 3, 'output', null, '授权时可见的来源文本');
    const note = f.as(() =>
      new NextInputs(f.store).create(f.source.run.id, '明确选择的要求', key()),
    );
    const input = parseNodeContinuationOperation(
      f.body('wait', [{ id: note.id, revision: note.revision }]),
    );
    const idem = key(),
      op = f.as(() => f.operations.create(f.task.id, input, idem));
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'waiting_for_stop');
    assert.equal(f.as(() => f.store.run(f.source.run.id)).state, 'running');
    f.as(() => new NextInputs(f.store).create(f.source.run.id, '后来新增不选的要求', key()));
    f.send(f.source.c, 4, 'output', null, '后来的模型文本不自动采用');
    f.send(f.source.c, 5, 'terminal', 'succeeded', '后来的最终结果也不自动采用');
    f.operations.tick();
    const done = f.read(op.id),
      target = f.as(() => f.store.run(done.runId!));
    assert.equal(done.state, 'succeeded', JSON.stringify(done.blockers));
    assert.equal(target.state, 'queued');
    assert.equal(target.previousRunId, f.source.run.id);
    assert.equal(f.command().context, op.contextText);
    assert.match(f.command().context, /授权时可见的来源文本/);
    assert.match(f.command().context, /明确选择的要求/);
    assert.doesNotMatch(f.command().context, /后来的模型文本|后来新增不选|后来的最终结果/);
    const replay = f.as(() => f.operations.create(f.task.id, input, idem));
    assert.equal(replay.runId, done.runId);
    f.operations.tick();
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 2);
    assert.equal(
      f.as(() => new NextInputs(f.store).list(f.task.id)).find((n) => n.id === note.id)?.state,
      'attached',
    );
  } finally {
    f.close();
  }
});

test('停止后接续不把 stopping 当终态，取消安排不会撤销已发的停止请求', () => {
  const f = operationFixture();
  try {
    const op = f.schedule('request_stop');
    f.operations.tick();
    assert.equal(f.as(() => f.store.run(f.source.run.id)).state, 'stopping');
    assert.equal(f.read(op.id).state, 'waiting_for_stop');
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    f.as(() => f.operations.cancel(op.id, op.revision, 'cancel-operation'));
    const replay = f.as(() => f.operations.cancel(op.id, op.revision, 'cancel-operation'));
    assert.equal(replay.state, 'cancelled');
    f.send(f.source.c, 3, 'terminal', 'cancelled');
    f.operations.tick();
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
  } finally {
    f.close();
  }
});

test('节点预约拦截同任务重复安排、直接 Run 入口及另一任务抢占节点', () => {
  const f = operationFixture();
  try {
    const op = f.schedule();
    assert.throws(() => f.schedule(), code('CONTINUATION_PENDING'));
    assert.throws(() => f.create(), code('CONTINUATION_PENDING'));
    const other = f.as(() =>
      f.store.createTask({ title: '其他任务', description: '', projectId: f.project.id }, key()),
    );
    assert.throws(
      () =>
        f.as(() =>
          f.execution.create(
            other.id,
            { ...parseNodeContinuationOperation(f.body()).run, expectedRevision: other.revision },
            key(),
          ),
        ),
      code('CONTINUATION_PENDING'),
    );
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items[0]?.available),
      false,
    );
    f.as(() => f.operations.cancel(op.id, op.revision, key()));
    f.send(f.source.c, 3, 'terminal', 'succeeded');
    assert.equal(f.create().state, 'queued');
  } finally {
    f.close();
  }
});

test('保存于源执行开始前的安排接受唯一自动 todo→in_progress 修订，不误报人工变更', () => {
  const f = operationFixture(false);
  try {
    const op = f.schedule();
    f.send(f.source.c, 1, 'accepted');
    assert.equal(
      f.execution.permit(f.token, f.connection, f.source.c.id, f.source.c.generation).allowed,
      true,
    );
    f.send(f.source.c, 2, 'running');
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'waiting_for_stop');
    f.send(f.source.c, 3, 'terminal', 'succeeded');
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'succeeded', JSON.stringify(f.read(op.id).blockers));
  } finally {
    f.close();
  }
});

test('所选要求被编辑或撤回、人工讨论/任务变化时暂停，保留授权时材料并不停止源进程', () => {
  for (const kind of ['edit-note', 'retract-note', 'message', 'task', 'complete'] as const) {
    const f = operationFixture();
    try {
      const notes = new NextInputs(f.store);
      const note = f.as(() => notes.create(f.source.run.id, '原选择要求', key()));
      const op = f.schedule('request_stop', [{ id: note.id, revision: note.revision }]);
      f.as(() => {
        if (kind === 'edit-note' || kind === 'retract-note')
          notes.edit(note.id, note.revision, kind === 'edit-note' ? '新要求' : null, key());
        else if (kind === 'message') f.store.addMessage(f.task.id, '新的人工讨论', null, key());
        else if (kind === 'task')
          f.store.patchTask(
            f.task.id,
            { expectedRevision: f.store.getTask(f.task.id).revision, description: '变更说明' },
            key(),
          );
        else
          f.store.changeTask(f.task.id, 'done', f.store.getTask(f.task.id).revision, 'keep', key());
      });
      f.operations.tick();
      assert.equal(f.read(op.id).state, 'needs_attention', kind);
      assert.match(f.read(op.id).contextText, /原选择要求/);
      assert.equal(f.as(() => f.store.run(f.source.run.id)).state, 'running');
      assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    } finally {
      f.close();
    }
  }
});

test('节点撤权、本机策略变更与连接失效不会让待接续重新取得执行权', () => {
  for (const kind of ['revoke', 'policy', 'offline'] as const) {
    const f = operationFixture();
    try {
      const op = f.schedule();
      if (kind === 'revoke')
        f.as(() =>
          f.nodes.revoke(
            f.source.run.node!.nodeId,
            f.nodes.get(f.source.run.node!.nodeId).revision,
            key(),
          ),
        );
      else if (kind === 'policy')
        f.execution.publish(f.token, f.connection, { ...f.policy, grantId: key() });
      else f.nodes.goodbye(f.token, f.connection);
      f.operations.tick();
      assert.equal(f.read(op.id).state, 'needs_attention', kind);
      assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    } finally {
      f.close();
    }
  }
});

test('重启与等待超时保留材料，释放接续预约但不释放未知源执行占用', () => {
  for (const mode of ['restart', 'expired', 'unknown'] as const) {
    const f = operationFixture();
    try {
      const op = f.schedule();
      if (mode === 'restart') new NodeContinuations(f.store, f.execution);
      else if (mode === 'expired') {
        f.store.db
          .prepare('UPDATE node_continuation_operations SET body=? WHERE id=?')
          .run(JSON.stringify({ ...op, expiresAt: '2000-01-01T00:00:00.000Z' }), op.id);
        f.operations.tick();
      } else {
        f.send(f.source.c, 3, 'unknown');
        f.operations.tick();
      }
      assert.equal(f.read(op.id).state, 'needs_attention');
      assert.equal(f.read(op.id).contextText, op.contextText);
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM node_dispatches WHERE stage!='terminal'")
          .get()!.n,
        1,
      );
      assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    } finally {
      f.close();
    }
  }
});

test('派发最后检查时取消仍生效；Operation→Run 关联故障与 Run/要求绑定共同回滚', () => {
  for (const mode of ['cancel', 'rollback'] as const) {
    const f = operationFixture();
    try {
      const note = f.as(() =>
        new NextInputs(f.store).create(f.source.run.id, '事务绑定要求', key()),
      );
      const op = f.schedule('wait', [{ id: note.id, revision: note.revision }]);
      f.send(f.source.c, 3, 'terminal', 'succeeded');
      if (mode === 'cancel') {
        const create = f.execution.create.bind(f.execution);
        f.execution.create = (...args) => {
          const current = f.read(op.id);
          f.as(() => f.operations.cancel(op.id, current.revision, key()));
          return create(...args);
        };
      } else
        f.store.db.exec(
          "CREATE TRIGGER fail_operation_link BEFORE UPDATE ON node_continuation_operations WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'fixture operation failure'); END;",
        );
      f.operations.tick();
      assert.equal(f.read(op.id).state, mode === 'cancel' ? 'cancelled' : 'failed');
      assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
      assert.equal(f.as(() => new NextInputs(f.store).list(f.task.id))[0]?.state, 'queued');
      assert.equal(
        f.store.db.prepare('SELECT COUNT(*) AS n FROM node_continuation_links').get()!.n,
        0,
      );
    } finally {
      f.close();
    }
  }
});

test('接续新 Run 已创建后取消必须使用 Run 停止，不误报安排取消', () => {
  const f = operationFixture();
  try {
    const op = f.schedule();
    f.send(f.source.c, 3, 'terminal', 'succeeded');
    f.operations.tick();
    const done = f.read(op.id);
    assert.throws(
      () => f.as(() => f.operations.cancel(op.id, done.revision, key())),
      code('RUN_ALREADY_STARTED'),
    );
    assert.equal(f.read(op.id).state, 'succeeded');
  } finally {
    f.close();
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SQLite 真实重开保留节点接续快照，重启恢复不新增派发或清除旧运行', () => {
  const f = operationFixture(),
    directory = mkdtempSync(join(tmpdir(), 'hexu-operation-reopen-'));
  let reopened: Store | undefined;
  try {
    const op = f.schedule(),
      path = join(directory, 'team.sqlite');
    f.store.db.prepare('VACUUM INTO ?').run(path);
    f.close();
    reopened = new Store(path, undefined, { team: true });
    const nodes = new NodeRegistry(reopened),
      execution = new NodeExecution(reopened, nodes);
    const operations = new NodeContinuations(reopened, execution);
    const after = reopened.as({ user: f.alice, spaceId: f.space.id }, () => operations.get(op.id));
    assert.equal(after.state, 'needs_attention');
    assert.equal(after.blockers[0]?.code, 'SERVICE_RESTARTED');
    assert.equal(after.contextText, op.contextText);
    operations.tick();
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM node_dispatches WHERE stage='unknown'").get()!
        .n,
      1,
    );
  } finally {
    f.close();
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('大量来源模型输出不会把已有人工讨论挤出校验集合并误暂停接续', () => {
  const f = operationFixture();
  try {
    f.as(() => f.store.addMessage(f.task.id, '需要保留的人工工作说明', null, key()));
    const op = f.schedule();
    for (let n = 3; n <= 104; n++) f.send(f.source.c, n, 'output', null, `来源增量 ${n}`);
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'waiting_for_stop');
    f.send(f.source.c, 105, 'terminal', 'succeeded');
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'succeeded');
    assert.match(f.command().context, /需要保留的人工工作说明/);
  } finally {
    f.close();
  }
});

test('项目归档取消未许可派发，保留已许可/未知执行或明确请求停止；快速恢复不能复活旧许可', () => {
  for (const stage of ['queued', 'accepted', 'preparing', 'running', 'unknown'] as const) {
    for (const action of ['keep', 'stop'] as const) {
      const f = fixture();
      try {
        f.publish();
        const run = f.create(),
          c = f.command();
        if (stage !== 'queued') f.send(c, 1, 'accepted');
        if (['preparing', 'running', 'unknown'].includes(stage)) {
          assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, true);
          if (stage !== 'preparing') f.send(c, 2, stage === 'running' ? 'running' : 'unknown');
        }
        const before = f.as(() => f.store.run(run.id));
        const saved = f.as(() =>
          f.store.projectLifecycle.change(
            f.project.id,
            { action: 'archive', expectedRevision: 1, activeRunAction: action },
            key(),
          ),
        );
        const after = f.as(() => f.store.run(run.id));
        const neverPermitted = ['queued', 'accepted'].includes(stage);
        assert.equal(
          after.state,
          neverPermitted ? 'cancelled' : action === 'stop' ? 'stopping' : before.state,
          `${stage}/${action}`,
        );
        assert.equal(after.node?.terminationConfirmed, neverPermitted);
        if (!neverPermitted) assert.equal(after.observation, before.observation);
        assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
        assert.throws(() => f.create(), code('PROJECT_ARCHIVED'));
        const option = f.as(() => f.execution.options(f.task.id).items[0]!);
        assert.equal(option.available, false);
        assert.match(option.reason, /归档/);
        f.as(() =>
          f.store.projectLifecycle.change(
            f.project.id,
            { action: 'restore', expectedRevision: saved.project.revision },
            key(),
          ),
        );
        assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
        assert.equal(
          f.as(() => f.store.runs(f.task.id).length),
          1,
        );
        if (!neverPermitted) assert.equal(f.command().id, c.id);
      } finally {
        f.close();
      }
    }
  }
});

test('归档在同一事务暂停节点等待安排并保留固定材料；恢复和协调 tick 不自动创建 Run', () => {
  const f = operationFixture();
  try {
    const op = f.schedule();
    const frozen = f.read(op.id).contextText;
    const saved = f.as(() =>
      f.store.projectLifecycle.change(
        f.project.id,
        { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
        key(),
      ),
    );
    assert.equal(f.read(op.id).state, 'needs_attention');
    assert.equal(f.read(op.id).blockers[0]!.code, 'PROJECT_ARCHIVED');
    assert.equal(f.read(op.id).contextText, frozen);
    assert.throws(() => f.schedule(), code('PROJECT_ARCHIVED'));
    f.as(() =>
      f.store.projectLifecycle.change(
        f.project.id,
        { action: 'restore', expectedRevision: saved.project.revision },
        key(),
      ),
    );
    f.send(f.source.c, 3, 'terminal', 'succeeded');
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'needs_attention');
    assert.equal(f.read(op.id).contextText, frozen);
    assert.equal(
      f.as(() => f.store.runs(f.task.id).length),
      1,
    );
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items[0]!.available),
      true,
    );
  } finally {
    f.close();
  }
});

test('归档事务的节点派发更新故障不留下半归档，恢复项目也不恢复已撤销凭证', () => {
  const f = fixture();
  try {
    f.publish();
    const run = f.create(),
      c = f.command();
    f.send(c, 1, 'accepted');
    f.store.db.exec(
      "CREATE TRIGGER fail_archived_dispatch BEFORE UPDATE ON node_dispatches BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
    );
    assert.throws(
      () =>
        f.as(() =>
          f.store.projectLifecycle.change(
            f.project.id,
            { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
            key(),
          ),
        ),
      /fixture rollback/,
    );
    assert.equal(
      f.as(() => f.store.project(f.project.id).revision),
      1,
    );
    assert.equal(
      f.as(() => f.store.run(run.id).node!.phase),
      'accepted',
    );
    f.store.db.exec('DROP TRIGGER fail_archived_dispatch');
    f.as(() =>
      f.store.projectLifecycle.change(
        f.project.id,
        { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
        key(),
      ),
    );
    f.as(() => f.nodes.revoke(f.n.nodeId, f.nodes.get(f.n.nodeId).revision, key()));
    f.as(() =>
      f.store.projectLifecycle.change(
        f.project.id,
        { action: 'restore', expectedRevision: 2 },
        key(),
      ),
    );
    assert.throws(() => f.nodes.hello(f.token, key()), DomainError);
    assert.equal(
      f.as(() => f.execution.options(f.task.id).items.length),
      0,
    );
  } finally {
    f.close();
  }
});

test('改派保留节点所有者、运行发起者和活动派发，接任者不能借负责人身份启动他人节点', () => {
  const f = fixture();
  try {
    const { run, c } = f.running();
    const before = f.as(() => f.store.run(run.id));
    const dispatch = f.store.db.prepare('SELECT * FROM node_dispatches WHERE id=?').get(c.id);
    const beforeNode = f.as(() => f.nodes.get(f.n.nodeId));
    assert.equal(before.createdByUserId, f.alice.id);
    const next = f.as(
      () =>
        f.store.taskAssignment.assign(
          f.task.id,
          { expectedRevision: f.store.getTask(f.task.id).revision, ownerUserId: f.bob.id },
          key(),
        ),
      f.bob,
    );
    assert.equal(next.createdByUserId, f.alice.id);
    assert.equal(next.ownerUserId, f.bob.id);
    assert.deepEqual(
      f.as(() => f.store.run(run.id)),
      before,
    );
    assert.deepEqual(
      f.store.db.prepare('SELECT * FROM node_dispatches WHERE id=?').get(c.id),
      dispatch,
    );
    assert.deepEqual(
      f.as(() => f.nodes.get(f.n.nodeId)),
      beforeNode,
    );
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, parseNodeRun(f.body()), key()), f.bob),
      code('NODE_OWNER_REQUIRED'),
    );
    f.send(c, 3, 'terminal', 'succeeded');
    assert.throws(
      () => f.as(() => f.execution.create(f.task.id, parseNodeRun(f.body()), key()), f.bob),
      code('NODE_OWNER_REQUIRED'),
    );
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
  } finally {
    f.close();
  }
});

test('改派不更新旧派发材料，未发启动许可时修订检查拒绝旧请求而不改变发起者', () => {
  const f = fixture();
  try {
    f.publish();
    const run = f.create(),
      c = f.command();
    f.send(c, 1, 'accepted');
    const before = f.store.db
      .prepare('SELECT command,owner_id,task_revision FROM node_dispatches WHERE id=?')
      .get(c.id);
    f.as(() =>
      f.store.taskAssignment.assign(
        f.task.id,
        { expectedRevision: f.store.getTask(f.task.id).revision, ownerUserId: f.bob.id },
        key(),
      ),
    );
    assert.deepEqual(
      f.store.db
        .prepare('SELECT command,owner_id,task_revision FROM node_dispatches WHERE id=?')
        .get(c.id),
      before,
    );
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    assert.equal(f.as(() => f.store.run(run.id)).createdByUserId, f.alice.id);
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
  } finally {
    f.close();
  }
});

test('改派原子暂停节点等待接续，回滚不改变原责任和材料，往返改派不自动重跑', () => {
  const f = operationFixture();
  try {
    const note = f.as(() =>
      new NextInputs(f.store).create(f.source.run.id, '保持原先选择的要求', key()),
    );
    const op = f.schedule('wait', [{ id: note.id, revision: note.revision }]);
    const before = f.as(() => f.store.getTask(f.task.id));
    const dispatch = f.store.db.prepare('SELECT * FROM node_dispatches').all();
    f.store.db.exec(
      "CREATE TRIGGER assignment_failure BEFORE UPDATE ON node_continuation_operations BEGIN SELECT RAISE(ABORT,'node assignment rollback'); END",
    );
    const body = { expectedRevision: before.revision, ownerUserId: f.bob.id };
    assert.throws(
      () => f.as(() => f.store.taskAssignment.assign(f.task.id, body, 'assignment')),
      /node assignment rollback/,
    );
    assert.deepEqual(
      f.as(() => f.store.getTask(f.task.id)),
      before,
    );
    assert.deepEqual(f.read(op.id), op);
    f.store.db.exec('DROP TRIGGER assignment_failure');
    const changed = f.as(() => f.store.taskAssignment.assign(f.task.id, body, 'assignment'));
    const paused = f.read(op.id);
    assert.equal(paused.state, 'needs_attention');
    assert.equal(paused.blockers[0]!.code, 'TASK_ASSIGNMENT_CHANGED');
    assert.equal(paused.contextText, op.contextText);
    assert.deepEqual(paused.input, op.input);
    assert.equal(paused.ownerId, f.alice.id);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM node_dispatches').all(), dispatch);
    f.as(() =>
      f.store.taskAssignment.assign(
        f.task.id,
        { expectedRevision: changed.revision, ownerUserId: f.alice.id },
        key(),
      ),
    );
    f.operations.tick();
    assert.equal(f.as(() => f.store.run(f.source.run.id)).state, 'running');
    f.send(f.source.c, 3, 'terminal', 'succeeded');
    f.operations.tick();
    assert.equal(f.read(op.id).state, 'needs_attention');
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 1);
    assert.equal(f.as(() => new NextInputs(f.store).list(f.task.id))[0]!.state, 'queued');
  } finally {
    f.close();
  }
});
