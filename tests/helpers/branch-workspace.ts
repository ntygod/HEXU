import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Run } from '../../packages/contracts/src/index.js';
import type { WorkBranchView } from '../../packages/contracts/src/work-branches.js';
import type { BranchWorkspaceOperation } from '../../packages/contracts/src/work-branch-workspaces.js';
import { retentionFixture } from './checkpoint-retention.js';
import { localRetentionOperation } from '../../apps/runner/src/agent/checkpoint-retention.js';
import {
  prepareBranchWorkspace,
  bindBranchWorkspace,
} from '../../apps/runner/src/agent/branch-workspace.js';
import { AgentStorage, readCredentials } from '../../apps/runner/src/agent/storage.js';
import { AgentConnection } from '../../apps/runner/src/agent/connection.js';
import { NodeExecutor } from '../../apps/runner/src/agent/executor.js';
import {
  configureExecution,
  writeExecutionPolicy,
} from '../../apps/runner/src/agent/execution-policy.js';

export const branchYes = async (prompt: string) =>
  /(?:CLOSE_BRANCH|CLEAN_GIT|BRANCH|RESTORE|PUBLISH|GIT|BIND|CLEAN) [0-9a-f-]{36}/.exec(prompt)![0];
export async function branchCli(entry: string, args: string[], input: string) {
  const child = spawn(process.execPath, [resolve('dist/apps/runner/src/' + entry), ...args], {
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
export async function branchWorkspaceFixture(
  format: 'sha1' | 'sha256' = 'sha1',
  largeContext = false,
) {
  const f = await retentionFixture(format);
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousOpenai = process.env.OPENAI_API_KEY;
  const active: { storage: AgentStorage; connection: AgentConnection; executor: NodeExecutor }[] =
    [];
  try {
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'retain',
      async () => `RETAIN ${f.oid} 7`,
      () => {},
    );
    const patch = await f.api.call(
      `tasks/${f.task.id}`,
      f.alice,
      {
        expectedRevision: 1,
        description: largeContext ? 'D'.repeat(12000) : 'COMMON_BRANCH_INPUT',
      },
      randomUUID(),
      'PATCH',
    );
    assert.equal(patch.statusCode, 200, patch.body);
    const groupReply = await f.api.call(`tasks/${f.task.id}/work-branches`, f.alice, {
      expectedTaskRevision: 2,
      checkpointId: f.first.request.checkpointId,
      branches: [
        { name: '方案 A', goal: largeContext ? 'G'.repeat(3000) : '独立目标 ALPHA_ONLY' },
        { name: '方案 B', goal: '独立目标 BETA_ONLY' },
      ],
    });
    assert.equal(groupReply.statusCode, 201, groupReply.body);
    const view = groupReply.json() as WorkBranchView;
    const groupPath = `tasks/${f.task.id}/work-branches/groups/${view.group.id}`;
    const read = async () => (await f.api.call(groupPath, f.alice)).json() as WorkBranchView;
    const create = async (index = 0, key = randomUUID()) => {
      const branch = (await read()).branches[index]!,
        path = `tasks/${f.task.id}/work-branches/${branch.id}`;
      const source = (await f.api.call(path + '/workspace-options', f.alice)).json().items[0];
      const body = {
        expectedRevision: branch.revision,
        retentionId: source.request.id,
        snapshotHash: source.manifest.snapshotHash,
      };
      const r = await f.api.call(path + '/workspaces', f.alice, body, key);
      assert.equal(r.statusCode, 201, r.body);
      return { op: r.json() as BranchWorkspaceOperation, path, body, key, branch };
    };
    const prepare = async (index = 0) => {
      const c = await create(index),
        target = join(f.dir, 'branch-' + index);
      const p = await prepareBranchWorkspace(f.home, c.op.ticket.id, target, branchYes, () => {});
      assert.equal(p.result?.state, 'prepared');
      assert.equal(p.git?.state, 'ready');
      return { ...c, p, target };
    };
    const pair = async (p: Awaited<ReturnType<typeof prepare>>['p']) => {
      const code = (await f.api.call('nodes/pairings', f.alice, { projectId: f.project.id })).json()
        .code;
      const r = await branchCli(
        'cli.js',
        ['connect', '--state', p.git!.nodeState!, '--config', p.git!.configPath!],
        `${code}\nCONNECT\n`,
      );
      assert.equal(r.status, 0, r.output);
      return readCredentials(p.git!.nodeState!);
    };
    const bind = async (p: Awaited<ReturnType<typeof prepare>>['p']) =>
      bindBranchWorkspace(p.git!.nodeState!, branchYes);
    const enable = async (
      p: Awaited<ReturnType<typeof prepare>>['p'],
      tool: 'claude-code' | 'codex' = 'claude-code',
    ) => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-branch-protocol-fixture-not-a-real-key';
      process.env.OPENAI_API_KEY = 'sk-openai-branch-protocol-fixture-not-a-real-key';
      const home = p.git!.nodeState!,
        executable = join(home, `${tool}-branch-protocol-fixture.mjs`);
      await writeFile(
        executable,
        `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (!process.argv.includes('--version') && !process.argv.includes('--help')) appendFileSync(${JSON.stringify(join(home, 'fixture-starts.txt'))}, 'start\\n');\nawait import(${JSON.stringify(pathToFileURL(resolve(`dist/tests/fixtures/${tool === 'codex' ? 'codex-tool' : 'native-tool'}.js`)).href)});\n`,
      );
      await chmod(executable, 0o700);
      const config = join(home, 'execution-config.json');
      await writeFile(
        config,
        JSON.stringify({
          tool,
          executable,
          mode: 'edit',
          workspaces: ['方案代码'],
          timeoutSeconds: 30,
          maxBudgetUsd: tool === 'codex' ? null : 1,
        }),
      );
      const c = readCredentials(home),
        policy = await configureExecution(config, c);
      writeExecutionPolicy(home, policy);
      const storage = new AgentStorage(home),
        connection = new AgentConnection(storage),
        executor = new NodeExecutor(connection);
      const node = { storage, connection, executor };
      active.push(node);
      await connection.cycle();
      await executor.tick();
      return { ...node, c };
    };
    const run = async (
      index: number,
      node: Awaited<ReturnType<typeof enable>>,
      prompt = 'FIXTURE_CAPTURE_INPUT FIXTURE_WRITE',
      key = randomUUID(),
    ) => {
      const branch = (await read()).branches[index]!;
      const options = (
        await f.api.call(`tasks/${f.task.id}/node-options?workBranchId=${branch.id}`, f.alice)
      ).json();
      const option = options.items.find((n: { nodeId: string }) => n.nodeId === node.c.nodeId);
      assert(option);
      const body = {
        provider: 'node',
        nodeId: node.c.nodeId,
        workingCopyId: node.c.directories[0]!.id,
        policyHash: option.policyHash,
        mode: 'edit',
        prompt,
        expectedRevision: options.taskRevision,
        expectedTaskContextHash: options.taskContextHash,
        confirmExecution: true,
        workBranch: {
          branchId: branch.id,
          expectedRevision: branch.revision,
          startHash: view.group.startHash,
        },
      };
      const reply = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
      return { reply, body, key, run: reply.json() as Run };
    };
    const tick = async () => {
      for (const n of active) {
        await n.connection.cycle();
        await n.executor.tick();
      }
    };
    return {
      ...f,
      view,
      read,
      createPreparation: create,
      prepare,
      pairBranch: pair,
      bindBranch: bind,
      enableBranch: enable,
      runBranch: run,
      tick,
      active,
      close: async () => {
        for (const n of active) {
          await n.executor.close();
          await n.connection.goodbye().catch(() => {});
          n.storage.close();
        }
        if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousKey;
        if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousOpenai;
        await f.close();
      },
    };
  } catch (e) {
    await f.close();
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenai;
    throw e;
  }
}
