import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseAiAssistanceCreate,
  renderAiAssistance,
} from '../packages/contracts/src/ai-assistance.js';
import { parsePolicy, parseNodeRun } from '../packages/contracts/src/node-execution.js';
import { executionHash } from '../packages/db/src/node-execution.js';
import { aiStoreFixture } from './helpers/ai-store.js';
import { TextClaudeStream, textClaudeArguments } from '../apps/runner/src/text-claude.js';
function fixture() {
  const f = aiStoreFixture();
  f.publish();
  const message = f.as(() =>
    f.store.addMessage(f.task.id, 'SELECTED_ERROR\r\nUNSELECTED_SECRET', null, randomUUID()),
  );
  const preview = f.as(() => f.store.assistance.preview(f.task.id, message.id));
  const input = {
    sourceMessageId: message.id,
    expectedSourceHash: preview.sourceHash,
    expectedTaskRevision: preview.taskRevision,
    range: { start: 0, end: 14 },
    question: '分析这个错误',
    nodeId: f.n.nodeId,
    policyHash: executionHash(f.policy),
    confirmMaterial: true,
    confirmExecution: true,
  };
  const create = (body: unknown = input, key: string = randomUUID()) =>
    f.as(() => f.execution.createAssistance(f.task.id, body, key));
  return { ...f, message, input, createAi: create };
}
test('AI 协助严格限定片段与两项授权，不借用真人同意或目录/会话参数', () => {
  const f = fixture();
  try {
    for (const extra of [
      { confirmMaterial: false },
      { confirmExecution: false },
      { recipientId: f.bob.id },
      { shareConfirmed: true },
      { workingCopyId: f.workspace },
      { sessionMode: 'resume' },
      { apiKey: 'fake' },
      { tool: 'codex' },
    ])
      assert.throws(() => parseAiAssistanceCreate({ ...f.input, ...extra }), DomainError);
    assert.throws(() => parsePolicy({ ...f.policy, textAssistance: false }), DomainError);
    assert.throws(
      () => parsePolicy({ ...f.policy, tool: 'codex', maxBudgetUsd: null }),
      DomainError,
    );
    assert.throws(() => parseNodeRun({ ...f.body(), purpose: 'assist' }), DomainError);
    delete f.policy.textAssistance;
    f.publish();
    assert.throws(
      () => f.createAi({ ...f.input, policyHash: executionHash(f.policy) }),
      DomainError,
    );
    assert.equal(f.as(() => f.store.runs(f.task.id)).length, 0);
  } finally {
    f.close();
  }
});
test('AI 协助原子关联固定材料、Run 与派发，保留 Task/主运行/未知目录锁并重复去重', () => {
  const f = fixture();
  try {
    const taskBefore = f.as(() => f.store.getTask(f.task.id));
    f.store.db
      .prepare('INSERT INTO native_workspaces VALUES(?,?,?)')
      .run('another-working-copy', '/fictional-root', '{}');
    f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(
      'unknown-main',
      f.task.id,
      JSON.stringify({
        id: 'unknown-main',
        taskId: f.task.id,
        provider: 'native',
        state: 'running',
        observation: 'unknown',
      }),
    );
    f.store.db
      .prepare('INSERT INTO native_workspace_locks VALUES(?,?)')
      .run('another-working-copy', 'unknown-main');
    const d = f.createAi(f.input, 'same-ai'),
      id = d.assistance.id,
      run = d.assistance.ai!.run;
    assert.equal(run.purpose, 'assist');
    assert.equal(run.assistanceId, id);
    assert.equal(run.node!.phase, 'queued');
    assert.equal(d.assistance.canReply, false);
    assert.equal(d.assistance.recipientKind, 'ai');
    const c = f.command();
    assert.equal(c.context, renderAiAssistance(f.input.question, 'SELECTED_ERROR'));
    for (const text of ['UNSELECTED_SECRET', f.task.title, f.task.description, f.workspace])
      assert.ok(!c.context.includes(text));
    assert.notEqual(c.workspaceId, f.workspace);
    assert.equal(c.session, undefined);
    assert.deepEqual(
      f.as(() => f.store.getTask(f.task.id)),
      taskBefore,
    );
    assert.equal(f.createAi(f.input, 'same-ai').assistance.id, id);
    assert.equal(f.as(() => f.store.codingRuns(f.task.id)).length, 1);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS n FROM native_workspace_locks').get()!.n,
      1,
    );
    assert.throws(
      () => f.as(() => f.execution.continuationPreview(f.task.id, run.id)),
      DomainError,
    );
    assert.throws(
      () =>
        f.as(() =>
          f.store.assistance.reply(
            id,
            { body: 'no implicit model followup', expectedRevision: 1 },
            randomUUID(),
          ),
        ),
      DomainError,
    );
  } finally {
    f.close();
  }
});
test('模型节点只在真实 running 后产生一次成功建议，ACK/许可不充当完成或模型收件', () => {
  const f = fixture();
  try {
    const d = f.createAi(),
      c = f.command();
    f.send(c, 1, 'accepted');
    assert.equal(f.as(() => f.store.assistance.get(d.assistance.id)).replies.length, 0);
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, true);
    assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
    f.send(c, 2, 'running');
    assert.equal(f.as(() => f.store.getTask(f.task.id)).status, 'todo');
    f.send(c, 3, 'terminal', 'succeeded', 'bounded suggestion');
    const done = f.as(() => f.store.assistance.get(d.assistance.id));
    assert.equal(done.assistance.state, 'responded');
    assert.equal(done.replies[0]!.actorType, 'agent');
    assert.equal(done.replies[0]!.runId, c.runId);
    assert.equal(done.replies[0]!.body, 'bounded suggestion');
    f.send(c, 3, 'terminal', 'succeeded', 'bounded suggestion');
    f.send(c, 4, 'terminal', 'succeeded', 'late');
    assert.equal(f.as(() => f.store.assistance.get(d.assistance.id)).replies.length, 1);
    assert.equal(f.as(() => f.store.detail(f.task.id)).messages.length, 1);
  } finally {
    f.close();
  }
});
test('AI 选材来源冲突和外人节点授权拒绝，普通项目阅读权不授予模型费用权', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.as(() => f.execution.createAssistance(f.task.id, f.input, 'foreign'), f.bob),
      DomainError,
    );
    assert.throws(
      () => f.createAi({ ...f.input, expectedSourceHash: 'f'.repeat(64) }),
      DomainError,
    );
    assert.throws(() => f.createAi({ ...f.input, expectedTaskRevision: 999 }), DomainError);
    const done = f.createAi();
    assert.equal(
      f.as(() => f.store.assistance.get(done.assistance.id), f.bob).assistance.canManage,
      false,
    );
    f.store.db.prepare('DELETE FROM collab_project_members WHERE user_id=?').run(f.bob.id);
    assert.throws(() => f.as(() => f.store.assistance.get(done.assistance.id), f.bob), DomainError);
  } finally {
    f.close();
  }
});
test('AI 取消只停止自身，启动前取消不获许可，运行中取消丢弃迟到输出', () => {
  const f = fixture();
  try {
    const d = f.createAi(),
      c = f.command();
    f.send(c, 1, 'accepted');
    f.execution.permit(f.token, f.connection, c.id, c.generation);
    f.send(c, 2, 'running');
    assert.throws(
      () =>
        f.as(() =>
          f.store.assistance.change(
            d.assistance.id,
            { action: 'close', expectedRevision: 1 },
            randomUUID(),
          ),
        ),
      DomainError,
    );
    const cancelled = f.as(() =>
      f.store.assistance.change(
        d.assistance.id,
        { action: 'cancel', expectedRevision: 1 },
        'cancel',
      ),
    );
    assert.equal(cancelled.assistance.ai!.run.state, 'stopping');
    assert.equal(cancelled.assistance.ai!.run.node!.terminationConfirmed, false);
    f.send(c, 3, 'output', null, 'NEVER_SHARE');
    f.send(c, 4, 'terminal', 'cancelled', 'NEVER_SHARE');
    const end = f.as(() => f.store.assistance.get(d.assistance.id));
    assert.equal(end.replies.length, 0);
    assert.equal(end.assistance.ai!.run.node!.terminationConfirmed, true);
    assert.ok(
      !JSON.stringify(f.store.db.prepare('SELECT * FROM node_run_events').all()).includes(
        'NEVER_SHARE',
      ),
    );
    assert.equal(f.as(() => f.store.getTask(f.task.id)).status, 'todo');
    const second = f.createAi(),
      c2 = f.command();
    f.as(() =>
      f.store.assistance.change(
        second.assistance.id,
        { action: 'cancel', expectedRevision: 1 },
        randomUUID(),
      ),
    );
    assert.equal(f.execution.permit(f.token, f.connection, c2.id, c2.generation).allowed, false);
  } finally {
    f.close();
  }
});
test('撤权或本机策略漂移阻止 AI 许可，既有材料不随新讨论悄悄改变', () => {
  for (const revoke of [false, true]) {
    const f = fixture();
    try {
      const d = f.createAi(),
        c = f.command();
      f.send(c, 1, 'accepted');
      f.as(() => f.store.addMessage(f.task.id, 'LATER_PRIVATE_CONTENT', null, randomUUID()));
      assert.equal(f.command().context, c.context);
      if (revoke) {
        f.store.db
          .prepare("UPDATE collab_project_members SET role='view' WHERE user_id=?")
          .run(f.alice.id);
        assert.throws(
          () => f.execution.permit(f.token, f.connection, c.id, c.generation),
          DomainError,
        );
        assert.equal(f.store.assistance.aiAuthorized(c.runId), false);
      } else {
        f.policy.maxTurns = 2;
        f.publish();
        assert.equal(f.execution.permit(f.token, f.connection, c.id, c.generation).allowed, false);
      }
      assert.equal(f.as(() => f.store.assistance.get(d.assistance.id)).replies.length, 0);
    } finally {
      f.close();
    }
  }
});
test('AI 协助、授权、Run、派发、事件和回执写入任一步失败均完整回滚', () => {
  for (const table of [
    'assistances',
    'assistance_grants',
    'runs',
    'node_dispatches',
    'assistance_events',
    'idempotency_records',
  ]) {
    const f = fixture();
    try {
      const before = f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n;
      f.store.db.exec(
        `CREATE TRIGGER fail_ai BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END;`,
      );
      assert.throws(() => f.createAi(f.input, 'rollback'));
      for (const target of [
        'assistances',
        'assistance_grants',
        'runs',
        'node_dispatches',
        'assistance_events',
      ])
        assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${target}`).get()!.n, 0, target);
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, before);
      f.store.db.exec('DROP TRIGGER fail_ai');
      assert.ok(f.createAi(f.input, 'rollback').assistance.ai);
    } finally {
      f.close();
    }
  }
});
test('纯文本 CLI 明确关闭全部工具与历史，初始化不符/工具请求/缺失结果不能成为成功', () => {
  const f = fixture();
  try {
    const args = textClaudeArguments(f.policy);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--no-session-persistence'));
    for (const flags of ['--resume', '--continue', '--allowedTools', '--add-dir'])
      assert.ok(!args.includes(flags));
    const init = {
      type: 'system',
      subtype: 'init',
      cwd: '/temporary',
      session_id: 'fixture',
      model: 'fixture',
      permissionMode: 'dontAsk',
      tools: [],
      mcp_servers: [],
    };
    for (const patch of [
      { tools: ['Read'] },
      { mcp_servers: [{}] },
      { cwd: '/project' },
      { permissionMode: 'bypassPermissions' },
    ])
      assert.throws(() =>
        new TextClaudeStream('/temporary').line(JSON.stringify({ ...init, ...patch })),
      );
    const stream = new TextClaudeStream('/temporary');
    stream.line(JSON.stringify(init));
    assert.equal(stream.summary.resultReceived, false);
    assert.throws(() =>
      stream.line(
        JSON.stringify({
          type: 'assistant',
          session_id: 'fixture',
          message: { content: [{ type: 'tool_use', name: 'Read' }] },
        }),
      ),
    );
    assert.throws(() =>
      new TextClaudeStream('/temporary').line(
        JSON.stringify({ type: 'result', session_id: 'fixture', subtype: 'success', result: 'x' }),
      ),
    );
  } finally {
    f.close();
  }
});
