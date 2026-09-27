import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, chmod, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { teamFixture } from './team.js';
import { AgentStorage, writeCredentials } from '../../apps/runner/src/agent/storage.js';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { AgentConnection, nodeRequest } from '../../apps/runner/src/agent/connection.js';
import { NodeExecutor } from '../../apps/runner/src/agent/executor.js';
import {
  configureExecution,
  writeExecutionPolicy,
} from '../../apps/runner/src/agent/execution-policy.js';
import { ExecutionJournal } from '../../apps/runner/src/agent/execution-journal.js';
import { WorkspaceLease } from '../../apps/runner/src/workspace-lease.js';
import type { NodeExecutionOption } from '../../packages/contracts/src/node-execution.js';
import type { Run } from '../../packages/contracts/src/index.js';
import { parseProjectMaterialRefs } from '../../packages/contracts/src/project-materials.js';
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fakeKey = 'sk-ant-node-protocol-fixture-not-a-real-key';
export async function aiNodeFixture() {
  const tool = 'claude-code' as const;
  const retainSessions = false;
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
    `#!${process.execPath}\nconst {textFixture} = await import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/text-tool.js')).href)}); await textFixture(${JSON.stringify(join(dir, 'captures.jsonl'))});\n`,
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
  let storageClosed = false;
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
  const environmentName = 'ANTHROPIC_API_KEY',
    previous = process.env[environmentName];
  process.env[environmentName] = fakeKey;
  const config = join(dir, 'execution.json');
  await writeFile(
    config,
    JSON.stringify({
      tool,
      textAssistance: true,
      executable,
      mode: 'edit',
      workspaces: ['测试工作副本'],
      timeoutSeconds: 30,
      maxBudgetUsd: 1,
      ...(retainSessions ? { retainSessions: true } : {}),
    }),
  );
  const policy = await configureExecution(
    config,
    (await import('../../apps/runner/src/agent/storage.js')).readCredentials(home),
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
    async suspend() {
      await executor.close();
      await connection.goodbye();
      storage.close();
      storageClosed = true;
    },
    async close() {
      if (!storageClosed) {
        await executor.close();
        await connection.goodbye();
        storage.close();
      }
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
      await f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
