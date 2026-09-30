import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { branchResultFixture } from './branch-results.js';
import { saveResultCode } from './result-code.js';
import { git } from './checkpoint-retention.js';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../../apps/runner/src/agent/storage.js';
import { publishLocalCheckpoint } from '../../apps/runner/src/agent/checkpoints.js';
import { localRetentionOperation } from '../../apps/runner/src/agent/checkpoint-retention.js';
import { localTransfer } from '../../apps/runner/src/agent/checkpoint-transfer.js';
import { preflightIntegration } from '../../apps/runner/src/agent/integration-preflight.js';
import { WorkspaceLease } from '../../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../../packages/contracts/src/integrations.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('must not repeat capture or consent');
};
export async function integrationRunnerFixture(
  format: 'sha1' | 'sha256' = 'sha1',
  transfer = false,
  conflict = false,
  extraFiles: Record<string, string | Buffer> = {},
  changes: {
    baseFiles?: Record<string, string>;
    sourceDeletePaths?: string[];
    sourceExecutablePaths?: string[];
    targetFiles?: Record<string, string>;
    targetDeletePaths?: string[];
    beforeListen?: (app: Awaited<ReturnType<typeof branchResultFixture>>['api']['app']) => void;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-integration-')),
    root = join(dir, 'source-repo');
  await mkdir(root);
  git(root, 'init', '-q', `--object-format=${format}`);
  const commit = (root: string, label: string) => {
    git(root, 'add', '.');
    git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      label,
    );
    return git(root, 'rev-parse', 'HEAD');
  };
  await writeFile(join(root, 'README.md'), 'BASE\n');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  for (const [path, body] of Object.entries(changes.baseFiles ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  const base = commit(root, 'base'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const f = await branchResultFixture(undefined, { objectFormat: format, commit: base, tree });
  try {
    const run = f.begin();
    run.start();
    run.finish(); // Explicit metadata protocol fixture, no model.
    changes.beforeListen?.(f.api.app);
    await f.api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = f.api.app.server.address();
    assert(address && typeof address !== 'string');
    const setup = async (index: number, root: string) => {
      const home = join(dir, `node-${index}`);
      await mkdir(home, { mode: 0o700 });
      const [w] = await authorizeDirectories([{ name: '预检夹具目录', path: root }], home),
        n = f.ns[index]!;
      const credentials = {
        version: 1 as const,
        controlUrl: `http://127.0.0.1:${address.port}`,
        nodeToken: n.token,
        nodeId: n.nodeId,
        clientId: randomUUID(),
        name: '预检夹具',
        projectId: f.project.id,
        spaceId: f.alice.spaceId,
        directories: [{ ...w!, id: n.workspace }],
      };
      writeCredentials(home, credentials);
      return { home, credentials, root, index };
    };
    const source = await setup(0, root);
    const checkpoint = async (node: typeof source, commit: string) => {
      const r = await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
        nodeId: f.ns[node.index]!.nodeId,
        workspaceId: f.ns[node.index]!.workspace,
        commit,
        label: '明确整合提交',
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmReference: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      return (
        await publishLocalCheckpoint(
          node.home,
          r.json().id,
          async () => `CHECKPOINT ${commit}`,
          silent,
        )
      ).checkpointId;
    };
    const retain = async (node: typeof source, cp: string, commit: string) => {
      const r = await f.api.call(`tasks/${f.task.id}/checkpoints/${cp}/retentions`, f.alice, {
        days: 7,
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmLocalRetention: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      const id = r.json().request.id as string;
      await localRetentionOperation(
        node.home,
        id,
        'retain',
        async () => `RETAIN ${commit} 7`,
        silent,
      );
      return id;
    };
    await writeFile(join(root, 'README.md'), 'SOURCE_COMMITTED_SECRET\n');
    await writeFile(join(root, 'new.txt'), 'NEW_COMMITTED_SECRET\n');
    for (const [path, body] of Object.entries(extraFiles)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), body);
    }
    for (const path of changes.sourceDeletePaths ?? []) await rm(join(root, path));
    for (const path of changes.sourceExecutablePaths ?? []) await chmod(join(root, path), 0o755);
    const sourceCommit = commit(root, 'source'),
      sourceCp = await checkpoint(source, sourceCommit),
      sr = await retain(source, sourceCp, sourceCommit);
    const saved = await saveResultCode(f, sourceCp);
    let target = source;
    if (transfer) {
      const targetRoot = join(dir, 'target-repo');
      git(root, 'clone', '-q', '--no-hardlinks', root, targetRoot);
      target = await setup(1, targetRoot);
    }
    git(target.root, 'checkout', '--detach', '-q', base);
    await writeFile(join(target.root, 'target.txt'), 'TARGET_PRIVATE_ONLY\n');
    if (conflict) await writeFile(join(target.root, 'README.md'), 'TARGET_DIFFERENT\n');
    for (const [path, body] of Object.entries(changes.targetFiles ?? {})) {
      await mkdir(dirname(join(target.root, path)), { recursive: true });
      await writeFile(join(target.root, path), body);
    }
    for (const path of changes.targetDeletePaths ?? []) await rm(join(target.root, path));
    const targetCommit = commit(target.root, 'target'),
      targetCp = await checkpoint(target, targetCommit),
      tr = await retain(target, targetCp, targetCommit);
    let material: { kind: string; id: string } = { kind: 'retention', id: sr };
    if (transfer) {
      const r = await f.api.call(
        `tasks/${f.task.id}/checkpoints/${sourceCp}/retentions/${sr}/transfers`,
        f.alice,
        {
          targetNodeId: f.ns[1]!.nodeId,
          expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
          confirmTransfer: true,
        },
      );
      assert.equal(r.statusCode, 201, r.body);
      const id = r.json().ticket.id as string;
      await localTransfer(target.home, id, 'accept', async () => `RECEIVE ${id}`, silent);
      await localTransfer(source.home, id, 'send', async () => `SEND ${id}`, silent);
      await localTransfer(target.home, id, 'receive', noAsk, silent);
      material = { kind: 'transfer', id };
    }
    const path = `tasks/${f.task.id}/integrations`;
    const create = async () => {
      const r = await f.api.call(path, f.alice, {
        resultId: saved.resultId,
        resultRevisionId: saved.revisionId,
        targetCheckpointId: targetCp,
        targetRetentionId: tr,
        sourceMaterial: material,
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmPreflight: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      return (r.json() as IntegrationView).operation.id;
    };
    const read = async (id: string) =>
      (await f.api.call(`${path}/${id}`, f.alice)).json() as IntegrationView;
    const ask = (id: string) => async (prompt: string) =>
      prompt.includes('SHARE_PREFLIGHT') ? `SHARE_PREFLIGHT ${id}` : `PREFLIGHT ${id}`;
    const close = async () => {
      await f.close();
      assert(dir.startsWith(tmpdir()));
      await rm(dir, { recursive: true, force: true });
    };
    return {
      ...f,
      dir,
      source,
      target,
      sr,
      tr,
      base,
      targetCommit,
      checkpoint,
      retain,
      create,
      read,
      ask,
      path,
      close,
    };
  } catch (e) {
    await f.close();
    assert(dir.startsWith(tmpdir()));
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
