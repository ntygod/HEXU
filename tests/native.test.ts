import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/control/src/app.js';
import { Store } from '../packages/db/src/store.js';
import {
  parseNativeRunCreate,
  type NativeRunConfig,
  type NativeOverview,
} from '../packages/contracts/src/native.js';
import {
  claudeCapabilities,
  requiredFlags,
  requiredSessionFlags,
  ClaudeStream,
  claudeArguments,
  redact,
} from '../packages/adapters/claude-code/src/index.js';
import { LocalWorkspaces, safePath } from '../apps/runner/src/workspaces.js';
import { runProcess } from '../apps/runner/src/process-host.js';
import { NativeRuntime } from '../apps/runner/src/runtime.js';
const headers = (key = randomUUID()) => ({ 'x-hexu-client': 'web', 'idempotency-key': key });
const fakeKey = 'sk-ant-test-fixture-never-a-real-credential';
const input = (id = 'wc-test') => ({
  provider: 'native',
  requestedTool: 'claude-code',
  confirmExecution: true,
  workingCopyId: id,
  prompt: 'inspect files',
  expectedRevision: 1,
});
const config: NativeRunConfig = {
  workingCopyId: 'wc-test',
  mode: 'read-only',
  model: null,
  maxTurns: 8,
  maxBudgetUsd: 1,
  timeoutSeconds: 10,
  toolVersion: 'fixture',
  contextText: 'inspect files',
  contextHash: 'test',
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-native-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'fixture repository\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const executable = join(dir, 'claude-fixture');
  // Executed as an actual child process, with the fixture protocol script explicitly identified.
  await writeFile(
    executable,
    `#!${process.execPath}\nimport(${JSON.stringify('file://' + resolve('dist/tests/fixtures/native-tool.js'))});\n`,
  );
  await chmod(executable, 0o700);
  return { dir, repo, executable, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function waitUntil<T>(read: () => T | Promise<T>, check: (v: T) => boolean) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for fixture');
}

test('原生创建需要显式费用与目录授权，不接受未知工具', () => {
  assert.equal(parseNativeRunCreate(input()).mode, 'read-only');
  for (const change of [
    { confirmExecution: false },
    { requestedTool: 'unknown-tool' },
    { maxBudgetUsd: 0 },
    { maxTurns: 1.5 },
    { mode: 'bypass' },
    { model: '--danger' },
    { timeoutSeconds: Infinity },
  ])
    assert.throws(() => parseNativeRunCreate({ ...input(), ...change }));
});
test('Claude 使用 bare/restricted；不提供 Bash、MCP 或 bypass', () => {
  const args = claudeArguments(config);
  assert.ok(args.includes('--bare'));
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!args.join(' ').includes('bypassPermissions'));
  assert.equal(
    claudeArguments({ ...config, mode: 'edit' })[args.indexOf('--tools') + 1],
    'Read,Glob,Grep,Edit,Write',
  );
});
test('结构化流只保存可显示结果，忽略 thinking 与工具参数', () => {
  const messages: string[] = [];
  const parser = new ClaudeStream((_, body) => messages.push(body));
  parser.line(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'tool_use', name: 'Read', input: 'secret' },
          { type: 'text', text: 'hello' },
        ],
      },
    }),
  );
  parser.line(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      permission_denials: [{}],
    }),
  );
  assert.equal(parser.summary.success, true);
  assert.equal(parser.summary.denials, 1);
  assert.equal(messages.join('').includes('secret'), false);
  assert.throws(() => parser.line('{bad'));
  assert.throws(() => parser.line(JSON.stringify({ type: 'result', subtype: 'success' })));
});
test('错误结果不能由自然语言改写为成功，密钥从显示输出中脱敏', () => {
  const parser = new ClaudeStream(() => {});
  parser.line(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: '全部完成',
    }),
  );
  assert.equal(parser.summary.success, false);
  assert.equal(
    redact(`key ${fakeKey} and opaque-secret-value`, ['opaque-secret-value']).includes(
      'secret-value',
    ),
    false,
  );
  assert.ok(!redact(fakeKey).includes(fakeKey));
});
test('文件路径边界拒绝敏感文件和逃逸', () => {
  for (const name of [
    '../outside',
    '/etc/passwd',
    '.env',
    '.env.local',
    'x/.env.production',
    '.git/config',
    'x/.ssh/id_rsa',
    'a\\b',
    'secret.pem',
    '.hexu/preview.sqlite',
  ])
    assert.equal(safePath(name), false, name);
  assert.equal(safePath('src/orders.ts'), true);
});
test('真实 Git 状态/diff；过滤敏感文件、符号链接、未追踪目录', async () => {
  const f = await fixture();
  const store = new Store();
  try {
    const workspaces = new LocalWorkspaces(store, [f.repo]);
    await workspaces.initialize();
    const id = workspaces.list()[0]!.id;
    await writeFile(join(f.repo, 'README.md'), 'changed\n');
    await writeFile(join(f.repo, '.env'), fakeKey);
    await writeFile(join(f.repo, 'new.txt'), 'new text');
    await symlink(join(f.repo, '.env'), join(f.repo, 'linked.txt'));
    const snap = await workspaces.snapshot(id);
    assert.deepEqual(snap.changes.map((c) => c.path).sort(), ['README.md', 'new.txt']);
    assert.equal(snap.omitted, 2);
    assert.match((await workspaces.diff(id, 'README.md')).text, /\+changed/);
    assert.equal((await workspaces.diff(id, 'new.txt')).text, 'new text');
    await assert.rejects(workspaces.read(id, '../outside'));
    await assert.rejects(workspaces.read(id, '.env'));
    await assert.rejects(workspaces.read(id, 'linked.txt'));
    await assert.rejects(workspaces.get('unconfigured'));
  } finally {
    store.close();
    await f.cleanup();
  }
});
test('拒绝重叠授权目录与子目录冒充仓库根', async () => {
  const f = await fixture();
  const store = new Store();
  try {
    await assert.rejects(new LocalWorkspaces(store, [f.repo, f.repo]).initialize(), /重叠/);
    await mkdir(join(f.repo, 'child'));
    await assert.rejects(
      new LocalWorkspaces(store, [join(f.repo, 'child')]).initialize(),
      /根目录/,
    );
  } finally {
    store.close();
    await f.cleanup();
  }
});
test('真实子进程接收 stdin 而非 Shell 拼接；超时与停止可确认', async () => {
  const lines: string[] = [];
  const handle = runProcess({
    executable: process.execPath,
    args: ['-e', "process.stdin.on('data', b => console.log(b.toString()))"],
    cwd: tmpdir(),
    env: {},
    input: '$(touch never-run)',
    timeoutMs: 2000,
    onLine: (l) => lines.push(l),
  });
  const result = await handle.done;
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['$(touch never-run)']);
  assert.equal(result.terminationConfirmed, true);
  const hang = runProcess({
    executable: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 150,
    onLine: () => {},
  });
  const stopped = await hang.done;
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.terminationConfirmed, true);
  assert.match(stopped.error!, /时间上限/);
});
test('缺失可执行程序和畸形输出不会成为成功', async () => {
  const absent = runProcess({
    executable: '/hexu-no-such-tool',
    args: [],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 1000,
    onLine: () => {},
  });
  const out = await absent.done;
  assert.ok(out.error);
  assert.equal(out.terminationConfirmed, true);
  const malformed = runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log("bad");setInterval(()=>{},1000)'],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 2000,
    onLine: () => {
      throw new Error('invalid');
    },
  });
  assert.match((await malformed.done).error!, /协议/);
});
test('原生能力缺凭证或 CLI 不可用时明确拒绝，不影响模拟', async () => {
  const f = await fixture();
  const store = new Store();
  try {
    const runtime = new NativeRuntime(store, {
      enabled: true,
      roots: [f.repo],
      claudeExecutable: f.executable,
    });
    await runtime.initialize();
    assert.equal(runtime.overview().claude.available, false);
    assert.match(runtime.overview().claude.reason, /API_KEY/);
    const missing = new NativeRuntime(store, {
      enabled: true,
      roots: [f.repo],
      claudeExecutable: '/missing-tool',
    });
    await missing.initialize();
    assert.equal(missing.overview().claude.available, false);
  } finally {
    store.close();
    await f.cleanup();
  }
});
test('原生 HTTP 流程由协议 fixture 驱动，真实写文件但不调用模型', async () => {
  const f = await fixture();
  const app = await createApp({
    native: { enabled: true, roots: [f.repo], claudeExecutable: f.executable, apiKey: fakeKey },
  });
  try {
    const caps = (await app.inject('/api/v1/native')).json<NativeOverview>();
    assert.equal(caps.claude.available, true);
    const wc = caps.workspaces[0]!.id;
    const body = { ...input(wc), mode: 'edit', prompt: 'FIXTURE_WRITE' };
    const key = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-24/runs',
      headers: headers(key),
      payload: body,
    });
    assert.equal(response.statusCode, 201);
    const id = response.json().id;
    await waitUntil(
      async () => (await app.inject(`/api/v1/runs/${id}`)).json(),
      (r) => r.state === 'succeeded',
    );
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-24/runs',
      headers: headers(key),
      payload: body,
    });
    assert.equal(replay.json().id, id);
    const task = (await app.inject('/api/v1/tasks/task-24')).json();
    assert.equal(task.task.status, 'in_progress');
    assert.equal(task.runs.length, 1);
    assert.ok(!JSON.stringify(task.messages).includes(fakeKey));
    assert.ok(JSON.stringify(task.messages).includes('[REDACTED]'));
    const diff = await app.inject(`/api/v1/native/workspaces/${wc}/diff?path=native-output.txt`);
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().text, 'fixture edit\n');
    const events = (await app.inject(`/api/v1/runs/${id}/native-events`)).json();
    assert.ok(events.items.length >= 3);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/runs/${id}/authorization`,
          headers: headers(),
          payload: { decision: 'allow' },
        })
      ).statusCode,
      422,
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});
test('相同工作目录跨任务互斥，停止释放后可继续', async () => {
  const f = await fixture();
  const store = new Store();
  const app = await createApp({
    store,
    native: { enabled: true, roots: [f.repo], claudeExecutable: f.executable, apiKey: fakeKey },
  });
  try {
    const wc = (await app.inject('/api/v1/native')).json().workspaces[0].id;
    const started = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/task-24/runs',
        headers: headers(),
        payload: { ...input(wc), prompt: 'FIXTURE_HANG' },
      })
    ).json();
    await waitUntil(
      () => store.run(started.id),
      (r) => r.state === 'running',
    );
    const task = store.createTask({ title: 'other', description: '', projectId: null }, 'other');
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/runs`,
      headers: headers(),
      payload: input(wc),
    });
    assert.equal(blocked.statusCode, 409);
    const stopped = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${started.id}/stop`,
      headers: headers(),
    });
    assert.equal(stopped.json().state, 'stopping');
    await waitUntil(
      () => store.run(started.id),
      (r) => r.state === 'cancelled',
    );
    assert.equal(store.nativeLock(wc), null);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/runs`,
          headers: headers(),
          payload: input(wc),
        })
      ).statusCode,
      201,
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});
test('标记完成会停止原生进程而非被模拟器假确认', async () => {
  const f = await fixture();
  const store = new Store();
  const app = await createApp({
    store,
    native: { enabled: true, roots: [f.repo], claudeExecutable: f.executable, apiKey: fakeKey },
  });
  try {
    const wc = (await app.inject('/api/v1/native')).json().workspaces[0].id;
    const run = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/task-24/runs',
        headers: headers(),
        payload: { ...input(wc), prompt: 'FIXTURE_HANG' },
      })
    ).json();
    await waitUntil(
      () => store.run(run.id),
      (r) => r.state === 'running',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-24/complete',
      headers: headers(),
      payload: { expectedRevision: store.getTask('task-24').revision },
    });
    assert.equal(response.json().status, 'done');
    await waitUntil(
      () => store.run(run.id),
      (r) => r.state === 'cancelled',
    );
    assert.equal(store.run(run.id).provider, 'native');
    assert.ok(!store.messages('task-24').at(-1)!.body.includes('模拟执行已停止'));
  } finally {
    await app.close();
    await f.cleanup();
  }
});
test('零退出但缺少原生结束事件应失败；权限拒绝保持可见', async () => {
  const f = await fixture();
  const store = new Store();
  const runtime = new NativeRuntime(store, {
    enabled: true,
    roots: [f.repo],
    claudeExecutable: f.executable,
    apiKey: fakeKey,
  });
  try {
    await runtime.initialize();
    const run = await runtime.create(
      'task-24',
      parseNativeRunCreate({
        ...input(runtime.overview().workspaces[0]!.id),
        prompt: 'FIXTURE_NO_RESULT',
      }),
      'missing-result',
    );
    await waitUntil(
      () => store.run(run.id),
      (r) => r.state === 'failed',
    );
    assert.match(store.messages('task-24').at(-1)!.body, /result/);
  } finally {
    await runtime.close();
    store.close();
    await f.cleanup();
  }
});
test('服务重启保留原生未知状态和目录锁，不重复派发', () => {
  const store = new Store();
  try {
    store.registerWorkingCopy({
      id: 'wc-test',
      name: 'test',
      root: '/test',
      createdAt: new Date().toISOString(),
    });
    const run = store.createNativeRun('task-24', parseNativeRunCreate(input()), config, 'native');
    store.stepRun(run.id, 'preparing');
    store.stepRun(run.id, 'running');
    assert.equal(store.recoverMockRuns(), 0);
    store.recoverNativeRuns();
    assert.equal(store.run(run.id).observation, 'unknown');
    assert.equal(store.nativeLock('wc-test'), run.id);
    store.stopRun(run.id, 'stop');
    assert.equal(store.nativeLock('wc-test'), run.id);
    store.confirmNativeStopped(run.id);
    assert.equal(store.nativeLock('wc-test'), null);
    assert.equal(store.run(run.id).state, 'failed');
  } finally {
    store.close();
  }
});

test('Claude 默认不保存会话；只有节点 UUID 能选择新建或恢复，恢复不携带 fork/continue', () => {
  assert.ok(claudeArguments(config).includes('--no-session-persistence'));
  const sessionId = randomUUID();
  for (const action of ['created', 'resumed'] as const) {
    const args = claudeArguments(config, { sessionId, action });
    assert.ok(args.includes(action === 'resumed' ? '--resume' : '--session-id'));
    assert.ok(args.includes(sessionId));
    assert.ok(!args.includes('--no-session-persistence'));
    assert.ok(!args.includes('--continue') && !args.includes('--fork-session'));
    assert.ok(args.includes('--bare') && args.includes('--restricted'));
  }
  for (const sessionId of [
    'latest',
    '../foreign.jsonl',
    '--dangerously-skip-permissions',
    'x'.repeat(300),
  ])
    assert.throws(() => claudeArguments(config, { sessionId, action: 'resumed' }));
});

test('Claude 保留模式核对 init、会话、目录、模型及受限工具，输出错误身份前即拒绝', () => {
  const sessionId = randomUUID();
  const guard = {
    sessionId,
    cwd: '/fictional/repo',
    mode: 'read-only' as const,
    resolvedModel: 'fixture-model',
  };
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: guard.cwd,
    model: guard.resolvedModel,
    permissionMode: 'dontAsk',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
  };
  const result = {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    result: 'valid answer',
  };
  for (const changed of [
    { session_id: randomUUID() },
    { cwd: '/foreign' },
    { model: 'foreign-model' },
    { permissionMode: 'bypassPermissions' },
    { tools: ['Read', 'Bash'] },
    { mcp_servers: [{ name: 'foreign' }] },
  ]) {
    const events: string[] = [],
      stream = new ClaudeStream((_k, text) => events.push(text), guard);
    assert.throws(() => stream.line(JSON.stringify({ ...init, ...changed })));
    assert.equal(events.length, 0);
    assert.equal(stream.summary.success, false);
  }
  for (const changed of [{ session_id: randomUUID() }, { session_id: undefined }]) {
    const stream = new ClaudeStream(() => {}, guard);
    stream.line(JSON.stringify(init));
    assert.throws(() => stream.line(JSON.stringify({ ...result, ...changed })));
    assert.equal(stream.summary.success, false);
  }
  const stream = new ClaudeStream(() => {}, guard);
  assert.throws(() => stream.line(JSON.stringify(result)));
  stream.line(JSON.stringify(init));
  assert.throws(() => stream.line(JSON.stringify(init)));
  stream.line(JSON.stringify(result));
  assert.equal(stream.summary.sessionId, sessionId);
  assert.equal(stream.summary.resolvedModel, guard.resolvedModel);
  assert.equal(stream.summary.success, true);
  assert.throws(() =>
    stream.line(
      JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [] } }),
    ),
  );
});

test('Claude 2.1.283 的隐藏 max-turns 不误判；未知版本和缺失隔离参数仍拒绝', () => {
  const help = [...requiredFlags.filter((f) => f !== '--max-turns'), ...requiredSessionFlags].join(
    ' ',
  );
  assert.equal(claudeCapabilities('2.1.283 (Claude Code)', help, true), true);
  assert.equal(claudeCapabilities('2.1.284 (Claude Code)', help, true), false);
  assert.equal(
    claudeCapabilities('2.1.283 (Claude Code)', help.replace('--restricted', ''), true),
    false,
  );
  assert.equal(
    claudeCapabilities('2.1.283 (Claude Code)', help.replace('--resume', ''), true),
    false,
  );
  assert.equal(
    claudeCapabilities('2.1.283 (Claude Code)', help.replace('--no-session-persistence', '')),
    false,
  );
});

test('Claude 非保留执行同样拒绝 init/result 会话错配，不截断原生 ID 伪装为一致', () => {
  const stream = new ClaudeStream(() => {});
  stream.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session' }));
  for (const session_id of ['another-session', 'x'.repeat(201), '/foreign/history', 123]) {
    assert.throws(() =>
      stream.line(JSON.stringify({ type: 'result', subtype: 'success', session_id })),
    );
    assert.equal(stream.summary.success, false);
  }
});
