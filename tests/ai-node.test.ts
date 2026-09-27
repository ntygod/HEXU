import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { aiNodeFixture } from './helpers/ai-node.js';
import type { AssistanceDetail } from '../packages/contracts/src/assistance.js';
import { writeExecutionPolicy } from '../apps/runner/src/agent/execution-policy.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
type Fixture = Awaited<ReturnType<typeof aiNodeFixture>>;
async function create(f: Fixture, question = '检查文本') {
  const m = (
    await f.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: 'SELECTED_ERROR\nSECRET_OTHER_MATERIAL',
    })
  ).json();
  const preview = (
    await f.call(`tasks/${f.task.id}/messages/${m.id}/assistance-preview`, f.alice)
  ).json();
  const body = {
    sourceMessageId: m.id,
    expectedSourceHash: preview.sourceHash,
    expectedTaskRevision: preview.taskRevision,
    range: { start: 0, end: 14 },
    question,
    nodeId: f.pair.nodeId,
    policyHash: f.option.policyHash,
    confirmMaterial: true,
    confirmExecution: true,
  };
  const key = randomUUID(),
    r = await f.call(`tasks/${f.task.id}/ai-assistances`, f.alice, body, key);
  assert.equal(r.statusCode, 201, r.body);
  return { detail: r.json() as AssistanceDetail, body, key };
}
const terminal = (r: { state: string }) => ['succeeded', 'failed', 'cancelled'].includes(r.state);
const captures = async (f: Fixture) =>
  (await readFile(join(f.dir, 'captures.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
test('真实 HTTP/独立子进程纯文本协助，只收到固定片段，空目录与独立环境，无主任务副作用', async () => {
  const f = await aiNodeFixture();
  const lease = new WorkspaceLease(f.root, 'unrelated-active-writer');
  try {
    const before = (await f.call(`tasks/${f.task.id}`, f.alice)).json().task;
    const d = await create(f);
    const run = await f.until(() => f.getRun(d.detail.assistance.ai!.run.id), terminal);
    assert.equal(run.state, 'succeeded');
    assert.equal(run.node!.terminationConfirmed, true);
    const all = await captures(f);
    assert.equal(all.length, 1);
    const actual = all[0];
    assert.equal(actual.input, d.detail.assistance.ai!.inputText);
    assert.ok(!actual.input.includes('SECRET_OTHER_MATERIAL'));
    assert.notEqual(actual.cwd, f.root);
    assert.deepEqual(actual.files, []);
    for (const name of [
      'OPENAI_API_KEY',
      'HEXU_NATIVE_ROOTS',
      'NODE_OPTIONS',
      'ANTHROPIC_BASE_URL',
    ])
      assert.ok(!actual.envNames.includes(name));
    assert.ok(actual.args.includes('--no-session-persistence'));
    await assert.rejects(access(actual.home));
    assert.equal(
      await readFile(join(f.root, 'README.md'), 'utf8'),
      'Fictional isolated node checkout\n',
    );
    const after = (await f.call(`tasks/${f.task.id}`, f.alice)).json();
    assert.deepEqual(after.task, before);
    assert.equal(after.messages.length, 1);
    const result = (await f.call(`assistances/${d.detail.assistance.id}`, f.alice)).json();
    assert.equal(result.replies.length, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_THINKING_NOT_SHARED'));
    const repeat = await f.call(`tasks/${f.task.id}/ai-assistances`, f.alice, d.body, d.key);
    assert.equal(repeat.statusCode, 201, repeat.body);
    await f.restart();
    await f.executor.tick();
    assert.equal((await captures(f)).length, 1);
    assert.equal(f.executor.claudeSessions.list().length, 0);
    assert.throws(() => new WorkspaceLease(f.root, 'another-writer'));
  } finally {
    lease.release();
    await f.close();
  }
});
test('实际文本进程拒绝工具启用、工具调用、错会话、无结果和失败，不发布伪成功建议', async () => {
  const f = await aiNodeFixture();
  try {
    for (const scenario of [
      'TOOLS_ENABLED',
      'TOOL_USE',
      'WRONG_SESSION',
      'NO_RESULT',
      'FAIL_TEXT',
    ]) {
      const d = await create(f, scenario),
        run = await f.until(() => f.getRun(d.detail.assistance.ai!.run.id), terminal);
      assert.equal(run.state, 'failed', scenario);
      assert.equal(run.node!.terminationConfirmed, true);
      assert.equal(
        (await f.call(`assistances/${d.detail.assistance.id}`, f.alice)).json().replies.length,
        0,
      );
    }
    assert.equal((await captures(f)).length, 5);
  } finally {
    await f.close();
  }
});
test('AI 运行取消确认真实进程停止，启动前本机撤销不生成子进程，已知密钥和临时目录不外泄', async () => {
  const f = await aiNodeFixture();
  try {
    const d = await create(f, 'HANG_TEXT');
    await f.until(
      () => f.getRun(d.detail.assistance.ai!.run.id),
      (r) => r.state === 'running',
    );
    const cancel = await f.call(`assistances/${d.detail.assistance.id}/state`, f.alice, {
      action: 'cancel',
      expectedRevision: 1,
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const stopped = await f.until(() => f.getRun(d.detail.assistance.ai!.run.id), terminal);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.node!.terminationConfirmed, true);
    assert.equal(
      (await f.call(`assistances/${d.detail.assistance.id}`, f.alice)).json().replies.length,
      0,
    );
    const leak = await create(f, 'LEAK_KEY');
    await f.until(() => f.getRun(leak.detail.assistance.ai!.run.id), terminal);
    const out = (await f.call(`assistances/${leak.detail.assistance.id}`, f.alice)).body;
    assert.ok(!out.includes('sk-ant-node-protocol-fixture-not-a-real-key'));
    assert.ok(!out.includes('hexu-text-assist-'));
    const unstarted = await create(f);
    writeExecutionPolicy(f.home, null);
    await f.until(() => f.getRun(unstarted.detail.assistance.ai!.run.id), terminal);
    assert.equal((await captures(f)).length, 2);
  } finally {
    await f.close();
  }
});
test('文本派发接受后重启保留未知证据，不重复启动；本机明确 STOPPED 恢复不触碰其他目录锁', async () => {
  const f = await aiNodeFixture();
  const lease = new WorkspaceLease(f.root, 'retained-other-writer');
  try {
    const d = await create(f),
      r = d.detail.assistance.ai!.run;
    // Journal a received command without requesting its launch permit, then restart.
    const row = f.store.db
      .prepare('SELECT command FROM node_dispatches WHERE run_id=?')
      .get(r.id) as { command: string };
    const command = JSON.parse(row.command);
    f.executor.journal.accept(command);
    await f.restart();
    assert.equal(f.executor.journal.get(command.id)!.phase, 'unknown');
    await assert.rejects(access(join(f.dir, 'captures.jsonl')));
    await f.suspend();
    const child = spawn(
      process.execPath,
      [
        resolve('dist/apps/runner/src/cli.js'),
        'recover-execution',
        '--state',
        f.home,
        '--dispatch',
        command.id,
      ],
      { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (s) => (out += s));
    child.stderr.on('data', (s) => (out += s));
    child.stdin.end(`STOPPED ${command.id}\n`);
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 0, out);
    assert.throws(() => new WorkspaceLease(f.root, 'must-not-release'));
  } finally {
    lease.release();
    await f.close();
  }
});
