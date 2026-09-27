import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainError } from '../packages/contracts/src/index.js';
import { captureCommitReference } from '../apps/runner/src/agent/checkpoints.js';
import { authorizeDirectories } from '../apps/runner/src/agent/workspaces.js';
import { AgentStorage, writeCredentials } from '../apps/runner/src/agent/storage.js';
import { NodeRegistry } from '../packages/db/src/nodes.js';
import { CheckpointStore } from '../packages/db/src/checkpoints.js';
import { Store } from '../packages/db/src/store.js';
import { teamFixture } from './helpers/team.js';
const key = () => randomUUID();
const code = (v: string) => (e: unknown) => e instanceof DomainError && e.code === v;
const git = (root: string, ...args: string[]) =>
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
async function repo(format = 'sha1') {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-checkpoint-test-')),
    root = join(dir, 'repo'),
    home = join(dir, 'state');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  git(root, 'init', '-q', `--object-format=${format}`);
  await writeFile(join(root, 'README.md'), 'Fictional checkpoint repository\n');
  git(root, 'add', 'README.md');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const oid = git(root, 'rev-parse', 'HEAD');
  const [w] = await authorizeDirectories([{ name: '已授权项目副本', path: root }], home);
  return { dir, root, home, oid, w: w!, close: () => rm(dir, { recursive: true, force: true }) };
}
const fingerprint = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function cli(home: string, requestId: string, input: string) {
  const child = spawn(
    process.execPath,
    [resolve('dist/apps/runner/src/cli.js'), 'checkpoint', '--request', requestId, '--state', home],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return { status, output };
}
for (const format of ['sha1', 'sha256'])
  test(`真实 ${format} 提交与根树哈希核对，脏文件/暂存/未跟踪内容和 index/HEAD 不改变`, async () => {
    const f = await repo(format);
    try {
      await writeFile(join(f.root, 'README.md'), 'staged\n');
      git(f.root, 'add', 'README.md');
      await writeFile(join(f.root, 'README.md'), 'modified\n');
      await writeFile(join(f.root, 'not-included.txt'), 'local only');
      git(f.root, 'remote', 'add', 'origin', 'https://private-token@example.invalid/secret/repo');
      const beforeIndex = fingerprint(await readFile(join(f.root, '.git', 'index'))),
        head = await readFile(join(f.root, '.git', 'HEAD'), 'utf8');
      const m = await captureCommitReference(f.w, f.oid, 'client-one', f.home);
      assert.equal(m.commit, f.oid);
      assert.equal(m.tree, git(f.root, 'rev-parse', `${f.oid}^{tree}`));
      assert.equal(m.objectFormat, format);
      assert.equal(m.workingCopy.staged, 1);
      assert.equal(m.workingCopy.modified, 1);
      assert.equal(m.workingCopy.untracked, 1);
      assert.equal(fingerprint(await readFile(join(f.root, '.git', 'index'))), beforeIndex);
      assert.equal(await readFile(join(f.root, '.git', 'HEAD'), 'utf8'), head);
      assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'modified\n');
      assert.doesNotMatch(
        JSON.stringify(m),
        /README|not-included|private-token|secret\/repo|modified\\n/,
      );
      assert.equal(m.availability, 'local_reference');
    } finally {
      await f.close();
    }
  });
test('不存在、blob/tree/tag 对象及可变 ref 均拒绝；replace refs 不替换固定提交身份', async () => {
  const f = await repo();
  try {
    const tree = git(f.root, 'rev-parse', 'HEAD^{tree}'),
      blob = git(f.root, 'rev-parse', 'HEAD:README.md');
    git(
      f.root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'tag',
      '-a',
      'tag',
      '-m',
      'tag',
    );
    for (const oid of ['f'.repeat(40), tree, blob, git(f.root, 'rev-parse', 'tag')])
      await assert.rejects(
        () => captureCommitReference(f.w, oid, 'client', f.home),
        code('CHECKPOINT_UNAVAILABLE'),
      );
    await assert.rejects(
      () => captureCommitReference(f.w, 'HEAD', 'client', f.home),
      code('INVALID_COMMIT'),
    );
    await writeFile(join(f.root, 'README.md'), 'replacement');
    git(f.root, 'add', '.');
    git(
      f.root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'replace',
    );
    git(f.root, 'replace', f.oid, 'HEAD');
    assert.equal((await captureCommitReference(f.w, f.oid, 'client', f.home)).tree, tree);
  } finally {
    await f.close();
  }
});
test('packed Git 与 linked worktree 可核对；alternate/对象符号链接/授权目录替换明确拒绝', async () => {
  const f = await repo();
  try {
    git(f.root, 'gc', '--prune=now');
    const linked = join(f.dir, 'linked');
    git(f.root, 'worktree', 'add', '--detach', linked, f.oid);
    const [w] = await authorizeDirectories([{ name: '独立工作树', path: linked }], f.home);
    assert.equal((await captureCommitReference(w!, f.oid, 'client', f.home)).commit, f.oid);
    const info = join(f.root, '.git', 'objects', 'info', 'alternates');
    await writeFile(info, '/outside/not-authorized\n');
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', f.home),
      code('CHECKPOINT_UNAVAILABLE'),
    );
    await rm(info);
    const link = join(f.root, '.git', 'objects', 'external');
    await symlink('/tmp', link);
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', f.home),
      code('CHECKPOINT_UNAVAILABLE'),
    );
    await rm(link);
    await rename(f.root, f.root + '-moved');
    await mkdir(f.root);
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', f.home),
      code('CHECKPOINT_UNAVAILABLE'),
    );
  } finally {
    await f.close();
  }
});
test('仓库 filter/credential helper 不运行，数量不可确认不伪造干净，未启动模型或网络工具', async () => {
  const f = await repo();
  try {
    const marker = join(f.dir, 'must-not-run');
    git(f.root, 'config', 'filter.unsafe.clean', `touch ${marker}`);
    git(f.root, 'config', 'credential.helper', `!touch ${marker}`);
    await writeFile(join(f.root, '.gitattributes'), '* filter=unsafe\n');
    const m = await captureCommitReference(f.w, f.oid, 'client', f.home);
    assert.equal(m.workingCopy.state, 'unavailable');
    assert.equal(existsSync(marker), false);
  } finally {
    await f.close();
  }
});
test('真实 CLI/HTTP 明确核对后发布；回执丢失持久保留原结果，重试不读变更后的仓库，记录跨服务重开保留', async () => {
  const f = await repo(),
    api = await teamFixture();
  let drop = true;
  api.app.addHook('onSend', async (req, reply, payload) => {
    if (drop && req.url === '/runner/v1/checkpoint-publish') {
      drop = false;
      reply.hijack();
      reply.raw.destroy();
    }
    return payload;
  });
  let guard: AgentStorage | undefined;
  try {
    const alice = await api.space(await api.setup()),
      project = await api.project(alice),
      task = await api.task(alice, project.id);
    const registry = new NodeRegistry(api.store),
      token = randomBytes(32).toString('base64url'),
      clientId = key();
    const pairing = api.store.as({ user: alice.user, spaceId: alice.spaceId }, () =>
      registry.createPairing(project.id, key()),
    );
    const paired = registry.pair({
      code: pairing.code!,
      nodeToken: token,
      clientId,
      projectId: project.id,
      name: '检查点电脑',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: f.w.id, name: f.w.name }],
    });
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = api.app.server.address();
    assert(address && typeof address !== 'string');
    writeCredentials(f.home, {
      version: 1,
      controlUrl: `http://127.0.0.1:${address.port}`,
      clientId,
      nodeToken: token,
      name: '检查点电脑',
      projectId: project.id,
      spaceId: alice.spaceId,
      nodeId: paired.nodeId,
      directories: [f.w],
    });
    const response = await api.call(`tasks/${task.id}/checkpoint-requests`, alice, {
      nodeId: paired.nodeId,
      workspaceId: f.w.id,
      commit: f.oid,
      label: '已提交基线',
      expectedTaskRevision: 1,
      confirmReference: true,
    });
    assert.equal(response.statusCode, 201, response.body);
    const r = response.json();
    guard = new AgentStorage(f.home); // Existing agent need not stop for immutable object reading.
    assert.equal((await cli(f.home, r.id, 'NO\n')).status, 1);
    assert.equal(
      (await api.call(`tasks/${task.id}/checkpoints`, alice)).json().checkpoints.length,
      0,
    );
    const lost = await cli(f.home, r.id, `CHECKPOINT ${f.oid}\n`);
    assert.equal(lost.status, 1, lost.output);
    const first = (await api.call(`tasks/${task.id}/checkpoints`, alice)).json();
    assert.equal(first.checkpoints.length, 1);
    await rename(f.root, f.root + '-moved');
    const retry = await cli(f.home, r.id, '');
    assert.equal(retry.status, 0, retry.output);
    assert.match(retry.output, new RegExp(first.checkpoints[0].id));
    assert.doesNotMatch(retry.output, /CHECKPOINT_UNAVAILABLE|sk-/);
    assert.deepEqual(
      (await api.call(`tasks/${task.id}/checkpoints`, alice)).json().checkpoints,
      first.checkpoints,
    );
    guard.close();
    guard = undefined;
    await api.app.close();
    const reopened = new Store(api.dbPath, undefined, { team: true });
    try {
      assert.deepEqual(
        reopened.as({ user: alice.user, spaceId: alice.spaceId }, () =>
          new CheckpointStore(reopened).list(task.id),
        ).checkpoints,
        first.checkpoints,
      );
    } finally {
      reopened.close();
    }
  } finally {
    guard?.close();
    await api.close();
    await f.close();
  }
});
test('linked worktree 的 commondir 被改向另一仓库时拒绝，不借同路径授权读取其他对象库', async () => {
  const f = await repo(),
    other = await repo();
  try {
    const linked = join(f.dir, 'linked');
    git(f.root, 'worktree', 'add', '--detach', linked, f.oid);
    const [w] = await authorizeDirectories([{ name: '原工作树', path: linked }], f.home);
    await writeFile(join(w!.gitDir, 'commondir'), join(other.root, '.git') + '\n');
    await assert.rejects(
      () => captureCommitReference(w!, other.oid, 'client', f.home),
      code('CHECKPOINT_UNAVAILABLE'),
    );
  } finally {
    await f.close();
    await other.close();
  }
});

// A name beginning with two dots is still a child, not a parent-path traversal.
test('双点前缀子目录仍在仓库内，状态或临时目录重叠在写入前拒绝', async () => {
  const f = await repo();
  const original = process.env.TMPDIR;
  try {
    const child = join(f.root, '..local');
    await mkdir(child, { mode: 0o700 });
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', child),
      code('CHECKPOINT_UNAVAILABLE'),
    );
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', f.dir),
      code('CHECKPOINT_UNAVAILABLE'),
    );
    process.env.TMPDIR = child;
    await assert.rejects(
      () => captureCommitReference(f.w, f.oid, 'client', f.home),
      code('CHECKPOINT_UNAVAILABLE'),
    );
    assert.deepEqual(await readdir(child), []);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.oid);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    await f.close();
  }
});
