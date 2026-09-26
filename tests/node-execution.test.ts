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
