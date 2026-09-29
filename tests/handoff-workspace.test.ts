import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Run } from '../packages/contracts/src/index.js';
import { handoffAcceptanceFixture } from './helpers/handoff-acceptance.js';
import { silent, noAsk } from './helpers/checkpoint-transfer.js';
import {
  prepareHandoffWorkspace,
  readGitWorkspaceProgress,
  cleanupHandoffWorkspace,
  assertGitWorkspaceSettled,
} from '../apps/runner/src/agent/handoff-workspace.js';
import { readCredentials, AgentStorage } from '../apps/runner/src/agent/storage.js';
import { AgentConnection } from '../apps/runner/src/agent/connection.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { NodeExecutor } from '../apps/runner/src/agent/executor.js';
import {
  configureExecution,
  writeExecutionPolicy,
} from '../apps/runner/src/agent/execution-policy.js';

const code = (name: string) => (e: unknown) => e instanceof DomainError && e.code === name;
const yes = async (prompt: string) => /(?:GIT|CLEAN_GIT) [0-9a-f-]{36}/.exec(prompt)![0];
async function fixture() {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    await f.confirm(op);
    return { ...f, op };
  } catch (e) {
    await f.close();
    throw e;
  }
}
async function cli(args: string[], input: string) {
  const child = spawn(process.execPath, [resolve('dist/apps/runner/src/cli.js'), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let output = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (output += v));
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return { status, output };
}

test('原接手目录明确准备浅Git，不修改用户代码/旧凭证，重复调用不覆盖后续修改', async () => {
  const f = await fixture();
  try {
    const credentials = await readFile(join(f.receiverHome, 'credentials.json'));
    const file = await readFile(join(f.target, 'README.md'));
    const p = await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent);
    assert.equal(p.state, 'ready');
    assert.equal(
      execFileSync('git', ['-C', f.target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      f.oid,
    );
    assert.equal(
      execFileSync('git', ['-C', f.target, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      '1',
    );
    assert.equal(
      execFileSync('git', ['-C', f.target, 'status', '--porcelain=v1'], {
        encoding: 'utf8',
      }).trim(),
      '',
    );
    assert.deepEqual(await readFile(join(f.target, 'README.md')), file);
    assert.deepEqual(await readFile(join(f.receiverHome, 'credentials.json')), credentials);
    const config = JSON.parse(await readFile(p.configPath!, 'utf8'));
    assert.deepEqual(config.expectedScope, {
      ownerId: f.bob.user.id,
      projectId: f.project.id,
      spaceId: f.bob.spaceId,
    });
    await writeFile(join(f.target, 'README.md'), 'user change after prepare');
    assert.equal(
      (await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, noAsk, silent)).id,
      p.id,
    );
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'user change after prepare');
    await assert.rejects(
      () => cleanupHandoffWorkspace(f.receiverHome, f.op.ticket.id, noAsk),
      code('WORKSPACE_READY'),
    );
    assert.equal(readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id)?.state, 'ready');
    assertGitWorkspaceSettled(f.receiverHome);
  } finally {
    await f.close();
  }
});

test('拒绝同意和确认期间新增.git都不会被覆盖或自动准备', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() =>
      prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, async () => 'NO', silent),
    );
    assert(!existsSync(join(f.target, '.git')));
    await assert.rejects(() =>
      prepareHandoffWorkspace(
        f.receiverHome,
        f.op.ticket.id,
        f.target,
        async (q) => {
          await mkdir(join(f.target, '.git'));
          await writeFile(join(f.target, '.git', 'user-note'), 'keep');
          return yes(q);
        },
        silent,
      ),
    );
    assert.equal(await readFile(join(f.target, '.git', 'user-note'), 'utf8'), 'keep');
  } finally {
    await f.close();
  }
});

test('准备失败保留元数据，只清理完整归属的本次.git，允许明确清理后重新准备', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() =>
      prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, async () => 'NO', silent),
    );
    const db = new DatabaseSync(join(f.receiverHome, 'handoff-workspaces/journal.sqlite'));
    db.exec(
      "CREATE TRIGGER fail_ready BEFORE UPDATE ON preparations WHEN json_extract(NEW.body,'$.state')='ready' BEGIN SELECT RAISE(ABORT,'fixture persist failure'); END;",
    );
    db.close();
    await assert.rejects(() =>
      prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent),
    );
    assert.equal(
      readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id)?.state,
      'needs_attention',
    );
    assert.throws(() => assertGitWorkspaceSettled(f.receiverHome), code('WORKSPACE_UNSETTLED'));
    const before = await readFile(join(f.target, 'README.md'));
    await writeFile(join(f.target, '.git', 'user-note'), 'keep');
    await assert.rejects(() => cleanupHandoffWorkspace(f.receiverHome, f.op.ticket.id, yes));
    assert.equal(await readFile(join(f.target, '.git', 'user-note'), 'utf8'), 'keep');
    assert(existsSync(join(f.target, '.git', 'HEAD')));
    await unlink(join(f.target, '.git', 'user-note')); // only the fixture's own added file
    const interrupted = readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id)!;
    const restart = new DatabaseSync(join(f.receiverHome, 'handoff-workspaces/journal.sqlite'));
    restart
      .prepare('UPDATE preparations SET body=? WHERE id=?')
      .run(JSON.stringify({ ...interrupted, state: 'preparing' }), interrupted.id);
    restart.close();
    const crashedLease = new WorkspaceLease(f.target, `handoff-git:${interrupted.id}`);
    crashedLease.close(); // simulate a dead writer without clearing its persistent claim
    assert.equal(readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id)?.state, 'preparing');
    assert.equal(
      (await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, noAsk, silent))
        .state,
      'needs_attention',
    );
    const clean = await cleanupHandoffWorkspace(f.receiverHome, f.op.ticket.id, yes);
    assert.equal(clean.state, 'cleaned');
    assert(!existsSync(join(f.target, '.git')));
    assert.deepEqual(await readFile(join(f.target, 'README.md')), before);
    const reset = new DatabaseSync(join(f.receiverHome, 'handoff-workspaces/journal.sqlite'));
    reset.exec('DROP TRIGGER fail_ready;');
    reset.close();
    const p = await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent);
    assert.equal(p.state, 'ready');
    assert.notEqual(p.id, clean.id);
  } finally {
    await f.close();
  }
});

test('Git准备拒绝不同目录与用户改动，不从历史接受回执覆盖当前文件', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.receiverRoot, noAsk, silent),
      code('WORKSPACE_SOURCE_MISMATCH'),
    );
    await writeFile(join(f.target, 'README.md'), 'my current edits');
    await assert.rejects(() =>
      prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent),
    );
    assert(!existsSync(join(f.target, '.git')));
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'my current edits');
  } finally {
    await f.close();
  }
});

test('Git准备在本机确认后重新核对当前权限，降权后不生成元数据或节点', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() =>
      prepareHandoffWorkspace(
        f.receiverHome,
        f.op.ticket.id,
        f.target,
        async (prompt) => {
          const changed = await f.api.call(
            `projects/${f.project.id}/members/${f.bob.user.id}`,
            f.alice,
            { role: 'view' },
          );
          assert.equal(changed.statusCode, 200, changed.body);
          return yes(prompt);
        },
        silent,
      ),
    );
    assert(!existsSync(join(f.target, '.git')));
    assert.equal(readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id), null);
    assert.equal(readCredentials(f.receiverHome).nodeId, f.receiver.nodeId);
  } finally {
    await f.close();
  }
});

test('Git准备不会清理未知模型预约，任务未知Run与操作者变化都阻止新准备', async () => {
  const f = await fixture();
  const lease = new WorkspaceLease(f.target, 'fixture-unknown-writer');
  try {
    await assert.rejects(
      () => prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent),
      code('LOCAL_WORKSPACE_BUSY'),
    );
    assert.throws(
      () => new WorkspaceLease(f.target, 'fixture-other-writer'),
      code('LOCAL_WORKSPACE_BUSY'),
    );
    lease.release();
    const id = randomUUID();
    f.api.store.db.prepare('INSERT INTO runs(id,task_id,body) VALUES(?,?,?)').run(
      id,
      f.task.id,
      JSON.stringify({
        id,
        taskId: f.task.id,
        provider: 'node',
        state: 'failed',
        observation: 'unknown',
        revision: 1,
      }),
    );
    await assert.rejects(
      () => prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, noAsk, silent),
      code('HANDOFF_WRITER_ACTIVE'),
    );
    f.api.store.db.prepare('DELETE FROM runs WHERE id=?').run(id);
    const task = (await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task;
    f.api.store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...task, operatorUserId: f.alice.user.id }), task.id);
    await assert.rejects(
      () => prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, noAsk, silent),
      code('HANDOFF_CONTEXT_CHANGED'),
    );
    assert(!existsSync(join(f.target, '.git')));
  } finally {
    lease.release();
    await f.close();
  }
});

test('独立配对配置绑定原接手本人和项目，不能使用其他人的配对码', async () => {
  const f = await fixture();
  try {
    const p = await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent);
    const wrong = (await f.api.call('nodes/pairings', f.alice, { projectId: f.project.id })).json()
      .code;
    const failed = await cli(
      ['connect', '--state', p.nodeState!, '--config', p.configPath!],
      `${wrong}\nCONNECT\n`,
    );
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /PAIRING_SCOPE_CHANGED/);
    assert(!existsSync(join(p.nodeState!, 'credentials.json')));
    const own = (await f.api.call('nodes/pairings', f.bob, { projectId: f.project.id })).json()
      .code;
    const connected = await cli(
      ['connect', '--state', p.nodeState!, '--config', p.configPath!],
      `${own}\nCONNECT\n`,
    );
    assert.equal(connected.status, 0, connected.output);
    const next = readCredentials(p.nodeState!);
    assert.notEqual(next.nodeId, f.receiver.nodeId);
    assert.equal(next.projectId, f.project.id);
    assert.equal(next.directories[0]!.root, f.target);
    assert.equal(readCredentials(f.receiverHome).nodeId, f.receiver.nodeId);
  } finally {
    await f.close();
  }
});

test('接手Git现场独立授权后通过实际节点进程在同一Task创建新Run，旧目录与账户绑定保留', async () => {
  const f = await fixture();
  const prior = process.env.ANTHROPIC_API_KEY;
  let storage: AgentStorage | undefined,
    connection: AgentConnection | undefined,
    executor: NodeExecutor | undefined;
  try {
    const p = await prepareHandoffWorkspace(f.receiverHome, f.op.ticket.id, f.target, yes, silent);
    const pairing = (await f.api.call('nodes/pairings', f.bob, { projectId: f.project.id })).json()
      .code;
    const paired = await cli(
      ['connect', '--state', p.nodeState!, '--config', p.configPath!],
      `${pairing}\nCONNECT\n`,
    );
    assert.equal(paired.status, 0, paired.output);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-handoff-workspace-protocol-fixture-not-a-real-key';
    const executable = join(f.dir, 'claude-workspace-protocol-fixture');
    await writeFile(
      executable,
      `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/native-tool.js')).href)});\n`,
    );
    await chmod(executable, 0o700);
    const policyFile = join(f.dir, 'workspace-policy.json');
    await writeFile(
      policyFile,
      JSON.stringify({
        tool: 'claude-code',
        executable,
        mode: 'edit',
        workspaces: ['接手代码'],
        timeoutSeconds: 30,
        maxBudgetUsd: 1,
      }),
    );
    const c = readCredentials(p.nodeState!);
    const policy = await configureExecution(policyFile, c);
    writeExecutionPolicy(p.nodeState!, policy);
    storage = new AgentStorage(p.nodeState!);
    connection = new AgentConnection(storage);
    executor = new NodeExecutor(connection);
    await connection.cycle();
    await executor.tick();
    const options = (await f.api.call(`tasks/${f.task.id}/node-options`, f.bob)).json();
    const option = options.items.find((v: { nodeId: string }) => v.nodeId === c.nodeId);
    assert.equal(option.available, true);
    const revision = (await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.revision;
    const created = await f.api.call(`tasks/${f.task.id}/runs`, f.bob, {
      provider: 'node',
      nodeId: c.nodeId,
      workingCopyId: c.directories[0]!.id,
      policyHash: option.policyHash,
      mode: 'edit',
      prompt: 'FIXTURE_WRITE',
      expectedRevision: revision,
      confirmExecution: true,
    });
    assert.equal(created.statusCode, 201, created.body);
    let run = created.json() as Run;
    for (let i = 0; i < 80 && run.state !== 'succeeded'; i++) {
      await connection.cycle();
      await executor.tick();
      await new Promise((r) => setTimeout(r, 30));
      run = (await f.api.call(`runs/${run.id}`, f.bob)).json() as Run;
    }
    assert.equal(run.state, 'succeeded');
    assert.equal(run.createdByUserId, f.bob.user.id);
    assert.equal(await readFile(join(f.target, 'native-output.txt'), 'utf8'), 'fixture edit\n');
    assert(!existsSync(join(f.root, 'native-output.txt')));
    assert(!existsSync(join(f.receiverRoot, 'native-output.txt')));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.operatorUserId,
      f.bob.user.id,
    );
    assert.equal(readCredentials(f.receiverHome).nodeId, f.receiver.nodeId);
  } finally {
    await executor?.close();
    await connection?.goodbye();
    storage?.close();
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
    await f.close();
  }
});
