import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamFixture } from './team.js';
import { NodeRegistry } from '../../packages/db/src/nodes.js';
import { CheckpointRetentionStore } from '../../packages/db/src/checkpoint-retention.js';
import type { RetentionView } from '../../packages/contracts/src/checkpoint-retention.js';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../../apps/runner/src/agent/storage.js';
import { publishLocalCheckpoint } from '../../apps/runner/src/agent/checkpoints.js';
export const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
export async function retentionFixture(format: 'sha1' | 'sha256' = 'sha1', external = false) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-retention-test-')),
    root = join(dir, 'repo'),
    home = join(dir, 'state');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  git(root, 'init', '-q', `--object-format=${format}`);
  await writeFile(join(root, 'README.md'), 'Original prior history not retained\n');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'ancestor',
  );
  const parent = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'README.md'), 'Retain only this committed snapshot\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 255, 13, 10, 128]));
  if (external) {
    await writeFile(
      join(root, 'large.dat'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 99999\n`,
    );
    await symlink('/outside/not-to-be-read', join(root, 'link'));
  }
  git(root, 'add', '.');
  if (external) git(root, 'update-index', '--add', '--cacheinfo', `160000,${parent},module`);
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'snapshot',
  );
  const oid = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'README.md'), 'Staged only\n');
  git(root, 'add', 'README.md');
  await writeFile(join(root, 'README.md'), 'Local dirty only\n');
  await writeFile(join(root, 'private.txt'), 'Not retained');
  const [w] = await authorizeDirectories([{ name: '保留来源', path: root }], home);
  const api = await teamFixture();
  let drop = false;
  api.app.addHook('onSend', async (req, reply, payload) => {
    if (drop && req.url === '/runner/v1/checkpoint-retention-report') {
      drop = false;
      reply.hijack();
      reply.raw.destroy();
    }
    return payload;
  });
  try {
    const alice = await api.space(await api.setup()),
      project = await api.project(alice),
      task = await api.task(alice, project.id);
    const registry = new NodeRegistry(api.store),
      token = randomBytes(32).toString('base64url'),
      clientId = randomUUID();
    const pairing = api.store.as({ user: alice.user, spaceId: alice.spaceId }, () =>
      registry.createPairing(project.id, randomUUID()),
    );
    const node = registry.pair({
      code: pairing.code!,
      nodeToken: token,
      clientId,
      projectId: project.id,
      name: '保留测试节点',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: w!.id, name: w!.name }],
    });
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = api.app.server.address();
    assert(addr && typeof addr !== 'string');
    const credentials = {
      version: 1 as const,
      controlUrl: `http://127.0.0.1:${addr.port}`,
      clientId,
      nodeToken: token,
      name: '保留测试节点',
      projectId: project.id,
      spaceId: alice.spaceId,
      nodeId: node.nodeId,
      directories: [w!],
    };
    writeCredentials(home, credentials);
    const requested = await api.call(`tasks/${task.id}/checkpoint-requests`, alice, {
      nodeId: node.nodeId,
      workspaceId: w!.id,
      commit: oid,
      label: '原始引用',
      expectedTaskRevision: 1,
      confirmReference: true,
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const recorded = await publishLocalCheckpoint(
      home,
      requested.json().id,
      async () => `CHECKPOINT ${oid}`,
      () => {},
    );
    const path = `tasks/${task.id}/checkpoints/${recorded.checkpointId}/retentions`;
    const create = async () => {
      const res = await api.call(path, alice, {
        days: 7,
        expectedTaskRevision: 1,
        confirmLocalRetention: true,
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json() as RetentionView;
    };
    const first = await create();
    const read = async () => (await api.call(path, alice)).json().items as RetentionView[];
    return {
      dir,
      root,
      home,
      oid,
      parent,
      w: w!,
      api,
      alice,
      task,
      project,
      node,
      registry,
      token,
      credentials,
      path,
      first,
      create,
      read,
      retained: new CheckpointRetentionStore(api.store),
      dropNext: () => {
        drop = true;
      },
      close: async () => {
        await api.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await api.close();
    await rm(dir, { recursive: true, force: true });
    throw cause;
  }
}
