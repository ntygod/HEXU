import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { teamFixture } from './helpers/team.js';
import { AgentStorage, writeCredentials } from '../apps/runner/src/agent/storage.js';
import { authorizeDirectories } from '../apps/runner/src/agent/workspaces.js';
import { AgentConnection, nodeRequest } from '../apps/runner/src/agent/connection.js';
import { NodeExecutor } from '../apps/runner/src/agent/executor.js';
import {
  configureExecution,
  writeExecutionPolicy,
} from '../apps/runner/src/agent/execution-policy.js';
import { ExecutionJournal } from '../apps/runner/src/agent/execution-journal.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { NodeExecutionOption } from '../packages/contracts/src/node-execution.js';
import type { Run } from '../packages/contracts/src/index.js';
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fakeKey = 'sk-ant-node-protocol-fixture-not-a-real-key';
async function fixture(tool: 'claude-code' | 'codex' = 'claude-code') {
  const f = await teamFixture(),
    { alice, bob } = await f.pair(),
    project = await f.project(alice),
    task = await f.task(alice, project.id);
  await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
  const dir = await mkdtemp(join(tmpdir(), 'hexu-executor-test-')),
    root = join(dir, 'repo'),
    home = join(dir, 'node');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional isolated node checkout\n');
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
    'fixture',
  ]);
  const executable = join(dir, 'tool-fixture.mjs');
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nif (!process.argv.includes('--help') && !process.argv.includes('--version')) appendFileSync(${JSON.stringify(join(root, 'actual-starts.txt'))}, 'one\\n');\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/' + (tool === 'codex' ? 'codex-tool' : 'native-tool') + '.js')).href)});\n`,
  );
  await chmod(executable, 0o700);
  const directories = await authorizeDirectories([{ name: '测试工作副本', path: root }], home);
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const token = randomBytes(32).toString('base64url');
  const code = (await f.call('nodes/pairings', alice, { projectId: project.id })).json().code;
  const identity = {
    protocol: 1,
    code,
    nodeToken: token,
    clientId: randomUUID(),
    projectId: project.id,
    name: '本人执行节点',
    platform: 'linux',
    arch: 'x64',
    workspaces: directories.map(({ id, name }) => ({ id, name })),
  };
  const pair = await nodeRequest<{ nodeId: string }>(origin, 'pair', identity);
  let storage = new AgentStorage(home);
  writeCredentials(home, {
    version: 1,
    controlUrl: origin,
    clientId: identity.clientId,
    nodeToken: token,
    name: identity.name,
    projectId: project.id,
    spaceId: alice.spaceId,
    nodeId: pair.nodeId,
    directories,
  });
  const environmentName = tool === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
    previous = process.env[environmentName];
  process.env[environmentName] = fakeKey;
  const config = join(dir, 'execution.json');
  await writeFile(
    config,
    JSON.stringify({
      tool,
      executable,
      mode: 'edit',
      workspaces: ['测试工作副本'],
      timeoutSeconds: 30,
      maxBudgetUsd: tool === 'codex' ? null : 1,
    }),
  );
  const policy = await configureExecution(
    config,
    (await import('../apps/runner/src/agent/storage.js')).readCredentials(home),
  );
  writeExecutionPolicy(home, policy);
  let connection = new AgentConnection(storage),
    executor = new NodeExecutor(connection);
  await connection.cycle();
  await executor.tick();
  const option = (await f.call(`tasks/${task.id}/node-options`, alice)).json()
    .items[0] as NodeExecutionOption;
  assert.equal(option.available, true);
  const create = async (prompt = 'FIXTURE_WRITE') => {
    const revision = (await f.call(`tasks/${task.id}`, alice)).json().task.revision;
    const body = {
      provider: 'node',
      nodeId: pair.nodeId,
      workingCopyId: directories[0]!.id,
      policyHash: option.policyHash,
      mode: 'edit',
      prompt,
      expectedRevision: revision,
      confirmExecution: true,
    };
    const key = randomUUID(),
      response = await f.call(`tasks/${task.id}/runs`, alice, body, key);
    assert.equal(response.statusCode, 201, response.body);
    return { run: response.json() as Run, body, key };
  };
  const getRun = async (id: string) => (await f.call(`runs/${id}`, alice)).json() as Run;
  const until = async (read: () => Promise<Run>, state: (r: Run) => boolean) => {
    for (let i = 0; i < 60; i++) {
      await connection.cycle();
      await executor.tick();
      const r = await read();
      if (state(r)) return r;
      await pause();
    }
    throw new Error('Node execution fixture did not settle');
  };
  return {
    ...f,
    alice,
    bob,
    project,
    task,
    dir,
    root,
    home,
    origin,
    token,
    policy,
    option,
    pair,
    directories,
    create,
    getRun,
    until,
    get storage() {
      return storage;
    },
    get executor() {
      return executor;
    },
    get connection() {
      return connection;
    },
    async restart() {
      await executor.close();
      await connection.goodbye();
      storage.close();
      storage = new AgentStorage(home);
      connection = new AgentConnection(storage);
      executor = new NodeExecutor(connection);
      await connection.cycle();
      await executor.tick();
    },
    async close() {
      await executor.close();
      await connection.goodbye();
      storage.close();
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
      await f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('实际 HTTP 派发到独立适配器进程，写入 Git 目录、回传输出且重复请求不重复启动', async () => {
  const f = await fixture();
  try {
    const { run, body, key } = await f.create();
    const done = await f.until(
      () => f.getRun(run.id),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state),
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.node?.terminationConfirmed, true);
    assert.equal(await readFile(join(f.root, 'native-output.txt'), 'utf8'), 'fixture edit\n');
    const duplicate = await f.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(duplicate.json().id, run.id);
    await f.restart();
    assert.equal(await readFile(join(f.root, 'actual-starts.txt'), 'utf8'), 'one\n');
    const detail = (await f.call(`tasks/${f.task.id}`, f.bob)).json();
    assert.equal(detail.task.status, 'in_progress');
    assert.ok(
      detail.messages.some((m: { body: string }) => m.body.includes('fixture response [REDACTED]')),
    );
    assert.ok(!JSON.stringify(detail).includes(fakeKey));
    assert.ok(!JSON.stringify(detail).includes(f.token));
    assert.ok(!JSON.stringify(detail).includes('private thought'));
  } finally {
    await f.close();
  }
});
test('独立 Codex App Server 适配走实际进程，不借用控制服务账户', async () => {
  const f = await fixture('codex');
  try {
    const { run } = await f.create('CODEX_WRITE');
    const done = await f.until(
      () => f.getRun(run.id),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state),
    );
    assert.equal(done.state, 'succeeded');
    assert.equal(done.requestedTool, 'codex');
    assert.equal(await readFile(join(f.root, 'codex-count.txt'), 'utf8'), 'one invocation\n');
    assert.equal(await readFile(join(f.root, 'actual-starts.txt'), 'utf8'), 'one\n');
  } finally {
    await f.close();
  }
});
test('运行中的节点接到停止后确认进程退出，项目只读不能停止', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('FIXTURE_HANG');
    await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'running',
    );
    await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: 'view' });
    assert.equal((await f.call(`runs/${run.id}/stop`, f.bob, {})).statusCode, 403);
    assert.equal((await f.call(`runs/${run.id}/stop`, f.alice, {})).json().state, 'stopping');
    const stopped = await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'cancelled',
    );
    assert.equal(stopped.node?.terminationConfirmed, true);
  } finally {
    await f.close();
  }
});
test('通信故障请求本机停止，恢复只重放已保存的结果，不重启模型', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('FIXTURE_HANG');
    await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'running',
    );
    f.executor.transportLost();
    const done = await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'cancelled',
    );
    assert.equal(done.node?.terminationConfirmed, true);
    await f.restart();
    assert.equal(await readFile(join(f.root, 'actual-starts.txt'), 'utf8'), 'one\n');
  } finally {
    await f.close();
  }
});
test('运行中撤销节点仍能提交停止证据，但不能继续接任务或发布输出', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('FIXTURE_HANG');
    await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'running',
    );
    const node = (await f.call(`nodes/${f.pair.nodeId}`, f.alice)).json();
    await f.call(`nodes/${node.id}/revoke`, f.alice, { expectedRevision: node.revision });
    await assert.rejects(f.executor.tick());
    await f.executor.close();
    assert.equal((await f.getRun(run.id)).state, 'cancelled');
    assert.equal((await f.getRun(run.id)).node?.terminationConfirmed, true);
    assert.equal(await readFile(join(f.root, 'actual-starts.txt'), 'utf8'), 'one\n');
  } finally {
    await f.close();
  }
});
test('两个独立状态目录和 preview 共用持久化目录占用，未知旧进程不能被租约超时抢占', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-shared-lease-')),
    dispatch = randomUUID();
  const first = new WorkspaceLease(dir, dispatch);
  try {
    assert.throws(() => new WorkspaceLease(dir, randomUUID()), /第二个写入者/);
    first.close(); // Crash-like close: persistent claim remains.
    assert.throws(() => new WorkspaceLease(dir, randomUUID()), /第二个写入者/);
    new WorkspaceLease(dir, dispatch, true).release();
    const second = new WorkspaceLease(dir, randomUUID());
    second.release();
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('已接单日志重启转未知并保留原事件；收到相同命令不得再次接单', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create();
    const next = await nodeRequest<{
      command: import('../packages/contracts/src/node-execution.js').DispatchCommand;
    }>(f.origin, 'execution-poll', { connectionId: f.connection.connectionId }, f.token);
    const journal = new ExecutionJournal(f.storage);
    assert.equal(journal.accept(next.command), true);
    assert.equal(journal.accept(next.command), false);
    journal.recover();
    assert.equal(journal.get(next.command.id)?.phase, 'unknown');
    assert.equal(journal.pending()?.event.kind, 'accepted');
    await f.executor.flush();
    await f.executor.tick();
    assert.equal((await f.getRun(run.id)).observation, 'unknown');
    await assert.rejects(readFile(join(f.root, 'actual-starts.txt')), /ENOENT/);
    assert.throws(() => journal.accept({ ...next.command, context: 'changed' }), /内容发生变化/);
    journal.settle(next.command.id, 'cancelled', '测试操作者确认没有启动');
    await f.executor.flush();
  } finally {
    await f.close();
  }
});
test('零退出但没有模型协议完成事件不标成功，失败释放已确认目录', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('FIXTURE_NO_RESULT');
    const done = await f.until(
      () => f.getRun(run.id),
      (r) => r.state === 'failed',
    );
    assert.equal(done.node?.terminationConfirmed, true);
    const options = (await f.call(`tasks/${f.task.id}/node-options`, f.alice)).json();
    assert.equal(options.items[0].available, true);
  } finally {
    await f.close();
  }
});

test('父子目录跨节点也互斥，只有原派发的确认恢复能释放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-nested-lease-')),
    nested = join(dir, 'nested'),
    id = randomUUID();
  await mkdir(nested);
  const first = new WorkspaceLease(dir, id);
  try {
    assert.throws(() => new WorkspaceLease(nested, randomUUID()), /重叠目录/);
    first.close();
    assert.throws(() => new WorkspaceLease(nested, randomUUID(), true), /重叠目录/);
    new WorkspaceLease(dir, id, true).release();
    const second = new WorkspaceLease(nested, randomUUID());
    assert.throws(() => new WorkspaceLease(dir, randomUUID()), /重叠目录/);
    second.release();
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('未确认执行和未送达的终态证据阻止删除凭证重新配对', async () => {
  const f = await fixture();
  try {
    await f.create();
    const next = await nodeRequest<{
      command: import('../packages/contracts/src/node-execution.js').DispatchCommand;
    }>(f.origin, 'execution-poll', { connectionId: f.connection.connectionId }, f.token);
    const journal = f.executor.journal;
    journal.accept(next.command);
    assert.throws(() => journal.assertCanDisconnect(), /未确认执行/);
    journal.settle(next.command.id, 'cancelled', '测试确认没有创建进程');
    assert.throws(() => journal.assertCanDisconnect(), /未送达证据/);
    await f.executor.flush();
    journal.assertCanDisconnect();
  } finally {
    await f.close();
  }
});

test('授权根不能包含执行锁目录，正常的个人仓库仍可占用', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexu-private-lease-home-'));
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.throws(() => new WorkspaceLease(home, randomUUID()), /不能包含受管工作区锁目录/);
    const repository = join(home, 'repo');
    await mkdir(repository);
    new WorkspaceLease(repository, randomUUID()).release();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('真实 HTTP 下一轮队列与同目录新会话接续：明确选择、实际启动、脏文件保留及重放去重', async () => {
  const f = await fixture();
  try {
    const first = await f.create('FIXTURE_WRITE');
    const done = await f.until(
      () => f.getRun(first.run.id),
      (r) => r.state === 'succeeded',
    );
    await writeFile(join(f.root, 'keep-dirty.txt'), 'Uncommitted user edits stay here\n');
    const saved = await f.call(`runs/${done.id}/inputs`, f.bob, { body: '选择此条：处理空数据' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().delivery, 'queued_for_next_turn');
    const note = saved.json().input;
    const omitted = await f.call(`runs/${done.id}/inputs`, f.alice, {
      body: '此条不选择，不能偷偷带入',
    });
    assert.equal(omitted.statusCode, 200);
    const preview = (
      await f.call(`tasks/${f.task.id}/node-continuation-preview?sourceRunId=${done.id}`, f.alice)
    ).json();
    assert.equal(preview.ready, true);
    assert.equal(
      (await f.call(`tasks/${f.task.id}/node-continuation-preview?sourceRunId=${done.id}`, f.bob))
        .statusCode,
      403,
    );
    const body = {
      ...first.body,
      prompt: 'FIXTURE_CAPTURE_INPUT',
      expectedRevision: (await f.call(`tasks/${f.task.id}`, f.alice)).json().task.revision,
      continuation: {
        sourceRunId: done.id,
        expectedContextHash: preview.contextHash,
        inputs: [{ id: note.id, revision: note.revision }],
      },
    };
    const idempotency = randomUUID();
    const created = await f.call(`tasks/${f.task.id}/runs`, f.alice, body, idempotency);
    assert.equal(created.statusCode, 201, created.body);
    const second = await f.until(
      () => f.getRun(created.json().id),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state),
    );
    assert.equal(second.state, 'succeeded');
    assert.equal(second.previousRunId, done.id);
    assert.equal(second.node?.workingCopyId, done.node?.workingCopyId);
    const context = await readFile(join(f.root, 'received-context.txt'), 'utf8');
    assert.match(context, /选择此条：处理空数据/);
    assert.ok(!context.includes('此条不选择'));
    assert.match(context, /fixture response \[REDACTED\]/);
    assert.equal(
      await readFile(join(f.root, 'keep-dirty.txt'), 'utf8'),
      'Uncommitted user edits stay here\n',
    );
    assert.equal(
      (await f.call(`tasks/${f.task.id}/runs`, f.alice, body, idempotency)).json().id,
      second.id,
    );
    await f.restart();
    assert.equal(await readFile(join(f.root, 'actual-starts.txt'), 'utf8'), 'one\none\n');
    const queue = (await f.call(`tasks/${f.task.id}/next-inputs`, f.alice)).json().items;
    assert.equal(queue.find((i: { id: string }) => i.id === note.id).state, 'started');
    assert.equal(
      queue.find((i: { id: string }) => i.id === omitted.json().input.id).state,
      'queued',
    );
  } finally {
    await f.close();
  }
});
test('下一轮要求的 HTTP 编辑/撤回与只读访问边界，不取消当前已排队执行', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('FIXTURE_WRITE');
    const note = (await f.call(`runs/${run.id}/inputs`, f.bob, { body: '可编辑草稿' })).json()
      .input;
    const edited = await f.call(
      `next-inputs/${note.id}`,
      f.bob,
      { body: '新草稿', expectedRevision: 1 },
      randomUUID(),
      'PATCH',
    );
    assert.equal(edited.statusCode, 200, edited.body);
    const no = await f.call(`next-inputs/${note.id}/cancel`, f.alice, { expectedRevision: 2 });
    assert.equal(no.statusCode, 403);
    const cancel = await f.call(`next-inputs/${note.id}/cancel`, f.bob, { expectedRevision: 2 });
    assert.equal(cancel.json().state, 'cancelled');
    await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: 'view' });
    assert.equal((await f.call(`tasks/${f.task.id}/next-inputs`, f.bob)).statusCode, 200);
    assert.equal(
      (await f.call(`runs/${run.id}/inputs`, f.bob, { body: '只读不能添加' })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.until(
          () => f.getRun(run.id),
          (r) => r.state === 'succeeded',
        )
      ).state,
      'succeeded',
    );
  } finally {
    await f.close();
  }
});
test('本机待处理摘要不包含任务文本/密钥，不改变未知状态或释放目录', async () => {
  const f = await fixture();
  try {
    const { run } = await f.create('sensitive fixture prompt');
    const c = (
      await nodeRequest<{ command: any }>(
        f.origin,
        'execution-poll',
        { connectionId: f.connection.connectionId },
        f.token,
      )
    ).command;
    f.executor.journal.accept(c);
    const list = f.executor.journal.pendingSummaries();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.runId, run.id);
    assert.equal(list[0]!.requiresLocalReview, true);
    assert.ok(!JSON.stringify(list).includes('sensitive fixture prompt'));
    assert.ok(!JSON.stringify(list).includes(f.token));
    assert.equal(f.executor.journal.get(c.id)!.phase, 'accepted');
    // Fixture cleanup explicitly settles a never-started command, not product recovery.
    f.executor.journal.settle(c.id, 'cancelled', 'fixture no spawn');
    await f.executor.flush();
    assert.equal(f.executor.journal.pendingSummaries().length, 0);
  } finally {
    await f.close();
  }
});
