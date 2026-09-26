import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  CodexSession,
  codexArguments,
  codexSandbox,
} from '../packages/adapters/codex/src/index.js';
import { createApp } from '../apps/control/src/app.js';
import { Store } from '../packages/db/src/store.js';
import { parseNativeRunCreate, type NativeOverview } from '../packages/contracts/src/native.js';
import type { Run } from '../packages/contracts/src/index.js';
const key = 'sk-openai-protocol-fixture-not-a-real-key';
const headers = (id = randomUUID()) => ({ 'x-hexu-client': 'web', 'idempotency-key': id });
async function environment() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-codex-test-')),
    root = join(dir, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'fixture repository\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'init',
  ]);
  const executable = async (name: string, file: string) => {
    const path = join(dir, name);
    await writeFile(
      path,
      `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/' + file + '.js')).href)});\n`,
    );
    await chmod(path, 0o700);
    return path;
  };
  const store = new Store();
  const app = await createApp({
    store,
    native: {
      enabled: true,
      roots: [root],
      claudeExecutable: await executable('claude-fixture', 'native-tool'),
      apiKey: 'sk-ant-fixture-never-use-real-account',
      codexExecutable: await executable('codex-fixture', 'codex-tool'),
      codexApiKey: key,
    },
  });
  const overview = (await app.inject({ url: '/api/v1/native' })).json() as NativeOverview;
  const task = store.createTask(
    { title: 'Codex integration fixture', description: '', projectId: null },
    randomUUID(),
  );
  const body = (tool = 'codex', prompt = 'analyze', taskId = task.id) => ({
    provider: 'native',
    requestedTool: tool,
    prompt,
    workingCopyId: overview.workspaces[0]!.id,
    mode: 'edit',
    confirmExecution: true,
    expectedRevision: store.getTask(taskId).revision,
  });
  const post = (route: string, data: Record<string, unknown>, id = randomUUID()) =>
    app.inject({ method: 'POST', url: '/api/v1/' + route, headers: headers(id), payload: data });
  const wait = async (run: Run) => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const r = store.run(run.id);
      if (['succeeded', 'failed', 'cancelled'].includes(r.state)) return r;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('fixture run timeout');
  };
  return {
    dir,
    root,
    store,
    app,
    task,
    overview,
    body,
    post,
    wait,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('Codex 只接受显式原生请求，不伪造美元上限', () => {
  const input = parseNativeRunCreate({
    provider: 'native',
    requestedTool: 'codex',
    prompt: 'hello',
    workingCopyId: 'w',
    expectedRevision: 1,
    confirmExecution: true,
    maxBudgetUsd: 1,
  });
  assert.equal(input.maxBudgetUsd, null);
  const args = codexArguments('/test/repo').join(' ');
  for (const expected of [
    'ephemeral',
    'shell_tool=false',
    'unified_exec=false',
    'web_search="disabled"',
    'trust_level="untrusted"',
  ])
    assert.ok(args.includes(expected));
  assert.ok(!args.includes('danger-full-access'));
  assert.deepEqual(codexSandbox('/test/repo', 'read-only'), {
    type: 'readOnly',
    access: { type: 'restricted', includePlatformDefaults: true, readableRoots: ['/test/repo'] },
  });
});
test('RPC 超时和销毁拒绝等待请求，不重发', async () => {
  const sent: string[] = [];
  const session = new CodexSession(
    (line) => sent.push(line),
    () => {},
    () => {},
    () => {},
    15,
  );
  await assert.rejects(session.request('initialize', {}), /超时/);
  assert.equal(sent.length, 1);
  const pending = session.request('other', {});
  session.dispose();
  await assert.rejects(pending, /已结束/);
});
test('未知来源的反向授权被拒绝，不展示数据', () => {
  const sent: string[] = [];
  const events: string[] = [];
  const session = new CodexSession(
    (l) => sent.push(l),
    (_, t) => events.push(t),
    () => {},
    () => {},
  );
  session.line(
    JSON.stringify({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'other', turnId: 'other' },
    }),
  );
  assert.ok(JSON.parse(sent[0]!).error);
  assert.deepEqual(events, []);
  session.dispose();
});
test('真实 Codex fixture JSONL 进程：能力、分页目录、引用与费用来源', async () => {
  const f = await environment();
  try {
    assert.equal(f.overview.codex.available, true);
    const catalog = await f.post('native/codex/models', {});
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().items[0].id, 'fixture-model');
    const response = await f.post(`tasks/${f.task.id}/runs`, f.body());
    assert.equal(response.statusCode, 201);
    const run = await f.wait(response.json());
    assert.equal(run.state, 'succeeded');
    assert.equal(run.native?.sessionId, 'fixture-thread');
    assert.equal(run.native?.turnId, 'fixture-turn');
    assert.equal(f.store.getTask(f.task.id).status, 'in_progress');
    assert.equal(f.store.nativeLock(run.native!.workingCopyId), null);
    const events = f.store
      .nativeEvents(run.id)
      .map((e) => e.body)
      .join('\n');
    assert.ok(events.includes('42'));
    assert.ok(!events.includes(key));
    assert.ok(!events.includes('private-chain'));
    assert.ok(!events.includes('foreign-secret'));
    assert.ok(!events.includes('duplicate-item'));
    const messages = f.store.messages(f.task.id);
    assert.equal(messages.at(-1)?.actorName, 'Codex · 原生');
  } finally {
    await f.close();
  }
});
test('Claude → Codex → Claude 沿用未提交代码、上下文与同一任务，重复点击不重跑', async () => {
  const f = await environment();
  try {
    const first = await f.wait(
      (await f.post(`tasks/${f.task.id}/runs`, f.body('claude-code', 'FIXTURE_WRITE'))).json(),
    );
    assert.equal(first.state, 'succeeded');
    const preview = await f.app.inject({
      url: `/api/v1/tasks/${f.task.id}/continuation-preview?sourceRunId=${first.id}`,
    });
    assert.equal(preview.json().canContinue, true);
    assert.ok(preview.json().contextText.includes('native-output.txt'));
    const data = { ...f.body('codex', 'CODEX_WRITE'), sourceRunId: first.id };
    const operationKey = randomUUID();
    const response = await f.post(`tasks/${f.task.id}/runs`, data, operationKey);
    assert.equal(response.statusCode, 201);
    const second = await f.wait(response.json());
    assert.equal(second.state, 'succeeded');
    assert.equal(second.previousRunId, first.id);
    assert.equal(second.native?.continuationSourceId, first.id);
    assert.ok(second.native?.contextText.includes('fixture edit'));
    assert.equal(
      await readFile(join(f.root, 'codex-output.txt'), 'utf8'),
      'fixture continued\nfixture edit\n',
    );
    const replay = await f.post(`tasks/${f.task.id}/runs`, data, operationKey);
    assert.equal(replay.json().id, second.id);
    assert.equal(await readFile(join(f.root, 'codex-count.txt'), 'utf8'), 'one invocation\n');
    const third = await f.wait(
      (
        await f.post(`tasks/${f.task.id}/runs`, {
          ...f.body('claude-code', 'Summarize the continuation'),
          sourceRunId: second.id,
        })
      ).json(),
    );
    assert.equal(third.state, 'succeeded');
    assert.equal(third.previousRunId, second.id);
    assert.equal(third.taskId, first.taskId);
    const stale = await f.post(`tasks/${f.task.id}/runs`, {
      ...f.body(),
      sourceRunId: first.id,
    });
    assert.equal(stale.statusCode, 409);
    const changed = await f.post(
      `tasks/${f.task.id}/runs`,
      { ...data, prompt: 'different' },
      operationKey,
    );
    assert.equal(changed.statusCode, 409);
  } finally {
    await f.close();
  }
});
test('运行中不能跨工具覆盖；interrupt 后再继续', async () => {
  const f = await environment();
  try {
    const r = (
      await f.post(`tasks/${f.task.id}/runs`, f.body('codex', 'CODEX_HANG'))
    ).json() as Run;
    const until = Date.now() + 4000;
    while (!f.store.run(r.id).native?.turnId && Date.now() < until)
      await new Promise((r) => setTimeout(r, 15));
    const conflict = await f.post(`tasks/${f.task.id}/runs`, {
      ...f.body('claude-code'),
      sourceRunId: r.id,
    });
    assert.equal(conflict.statusCode, 409);
    await f.post(`runs/${r.id}/stop`, {});
    const stopped = await f.wait(r);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.native?.terminationConfirmed, true);
    // Old context intentionally includes CODEX_HANG; Claude fixture does not interpret it.
    const next = await f.wait(
      (
        await f.post(`tasks/${f.task.id}/runs`, {
          ...f.body('claude-code', 'continue'),
          sourceRunId: r.id,
        })
      ).json(),
    );
    assert.equal(next.state, 'succeeded');
  } finally {
    await f.close();
  }
});
for (const prompt of ['CODEX_NO_RESULT', 'CODEX_BAD_JSON', 'CODEX_FAILURE'])
  test(`${prompt} 不会成为成功`, async () => {
    const f = await environment();
    try {
      const run = await f.wait(
        (await f.post(`tasks/${f.task.id}/runs`, f.body('codex', prompt))).json(),
      );
      assert.equal(run.state, 'failed');
      assert.equal(f.store.getTask(f.task.id).status, 'in_progress');
    } finally {
      await f.close();
    }
  });
test('服务端反向命令授权默认拒绝并留记录', async () => {
  const f = await environment();
  try {
    const run = await f.wait(
      (await f.post(`tasks/${f.task.id}/runs`, f.body('codex', 'CODEX_DENIAL'))).json(),
    );
    assert.equal(run.state, 'succeeded');
    assert.ok(f.store.nativeEvents(run.id).some((e) => e.kind === 'warning'));
  } finally {
    await f.close();
  }
});
test('拒绝跨任务来源，且不会自动重开已完成任务', async () => {
  const f = await environment();
  try {
    const r = await f.wait((await f.post(`tasks/${f.task.id}/runs`, f.body())).json());
    const other = f.store.createTask(
      { title: 'other', description: '', projectId: null },
      randomUUID(),
    );
    const wrong = await f.post(`tasks/${other.id}/runs`, {
      ...f.body('codex', 'continue', other.id),
      sourceRunId: r.id,
    });
    assert.equal(wrong.statusCode, 409);
    await f.post(`tasks/${f.task.id}/complete`, {
      expectedRevision: f.store.getTask(f.task.id).revision,
    });
    const closed = await f.post(`tasks/${f.task.id}/runs`, {
      ...f.body(),
      sourceRunId: r.id,
    });
    assert.equal(closed.statusCode, 409);
    const reopened = await f.post(`tasks/${f.task.id}/runs`, {
      ...f.body(),
      sourceRunId: r.id,
      reopenTask: true,
    });
    assert.equal(reopened.statusCode, 201);
    await f.wait(reopened.json());
  } finally {
    await f.close();
  }
});

test('Codex 配置兼容空 Hooks，但拒绝活动 Hooks、Shell 或错误的目录键', async () => {
  const valid = {
    features: { shell_tool: false, unified_exec: false },
    approval_policy: 'never',
    web_search: 'disabled',
    cli_auth_credentials_store: 'ephemeral',
    mcp_servers: {},
    plugins: {},
    hooks: { PreToolUse: [], SessionStart: [] },
    projects: { '/repo.with.dot': { trust_level: 'untrusted' } },
  };
  for (const [configuration, allowed] of [
    [valid, true],
    [{ ...valid, hooks: { PreToolUse: [{ command: 'never execute' }] } }, false],
    [{ ...valid, features: { shell_tool: true, unified_exec: false } }, false],
    [{ ...valid, projects: { '"/repo.with.dot"': { trust_level: 'untrusted' } } }, false],
    [{ ...valid, cli_auth_credentials_store: 'file' }, false],
  ] as const) {
    let session: CodexSession;
    session = new CodexSession(
      (line) => {
        const request = JSON.parse(line);
        queueMicrotask(() =>
          session.line(JSON.stringify({ id: request.id, result: { config: configuration } })),
        );
      },
      () => {},
      () => {},
      () => {},
    );
    try {
      if (allowed) await session.checkConfiguration('/repo.with.dot');
      else await assert.rejects(session.checkConfiguration('/repo.with.dot'));
    } finally {
      session.dispose();
    }
  }
});

test('恢复引导中取消：不发送 thread/resume 或 turn/start，也不回退新会话', async () => {
  for (const phase of ['thread/read', 'thread/resume']) {
    let stopped = false;
    const calls: string[] = [];
    let session: CodexSession;
    session = new CodexSession(
      (line) => {
        const q = JSON.parse(line);
        calls.push(q.method);
        if (q.method === phase) stopped = true;
        const reply =
          q.method === 'thread/read'
            ? {
                thread: {
                  id: 'stored-thread',
                  cwd: '/fixture',
                  ephemeral: false,
                  status: { type: 'notLoaded' },
                },
              }
            : {
                thread: { id: 'stored-thread', ephemeral: false },
                cwd: '/fixture',
                approvalPolicy: 'never',
                sandbox: { type: 'readOnly' },
                model: 'fixture-model',
              };
        queueMicrotask(() => session.line(JSON.stringify({ id: q.id, result: reply })));
      },
      () => {},
      () => {},
      () => {},
    );
    try {
      await assert.rejects(
        session.start(
          '/fixture',
          'edit',
          'new material',
          'fixture-model',
          { threadId: 'stored-thread', resolvedModel: 'fixture-model' },
          () => stopped,
        ),
        /启动已取消/,
      );
      assert.ok(!calls.includes('turn/start') && !calls.includes('thread/start'));
      assert.deepEqual(
        calls,
        phase === 'thread/read' ? ['thread/read'] : ['thread/read', 'thread/resume'],
      );
    } finally {
      session.dispose();
    }
  }
});

test('持久会话拒绝缺失自动行为配置和恢复后的模型或权限漂移', async () => {
  for (const fault of ['config', 'model', 'sandbox'] as const) {
    const calls: string[] = [];
    let session: CodexSession;
    session = new CodexSession(
      (line) => {
        const q = JSON.parse(line);
        calls.push(q.method);
        let result: unknown;
        if (q.method === 'config/read')
          result = {
            config: {
              features: { shell_tool: false, unified_exec: false },
              web_search: 'disabled',
              approval_policy: 'never',
              cli_auth_credentials_store: 'ephemeral',
              projects: { '/fixture': { trust_level: 'untrusted' } },
              hooks: {},
              plugins: {},
              mcp_servers: {},
            },
          };
        else if (q.method === 'thread/read')
          result = {
            thread: {
              id: 'stored-thread',
              cwd: '/fixture',
              ephemeral: false,
              status: { type: 'notLoaded' },
            },
          };
        else
          result = {
            thread: { id: 'stored-thread', ephemeral: false },
            cwd: '/fixture',
            approvalPolicy: 'never',
            sandbox: { type: fault === 'sandbox' ? 'dangerFullAccess' : 'readOnly' },
            model: fault === 'model' ? 'different-model' : 'fixture-model',
          };
        queueMicrotask(() => session.line(JSON.stringify({ id: q.id, result })));
      },
      () => {},
      () => {},
      () => {},
    );
    try {
      if (fault === 'config')
        await assert.rejects(session.checkConfiguration('/fixture', true), /自动行为/);
      else
        await assert.rejects(
          session.start('/fixture', 'edit', 'new material', null, {
            threadId: 'stored-thread',
            resolvedModel: 'fixture-model',
          }),
          /不会回退新会话/,
        );
      assert.ok(!calls.includes('turn/start') && !calls.includes('thread/start'));
    } finally {
      session.dispose();
    }
  }
});
