import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  AgentStorage,
  readCredentials,
  writeCredentials,
  ensurePrivateHome,
  type NodeCredentials,
} from '../apps/runner/src/agent/storage.js';
import {
  authorizeDirectories,
  captureSnapshot,
  captureDirectory,
  countStatus,
} from '../apps/runner/src/agent/workspaces.js';
import { AgentConnection, nodeRequest } from '../apps/runner/src/agent/connection.js';
import { teamFixture } from './helpers/team.js';
const key = () => randomUUID();
const codeIs = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
const cli = resolve('dist/apps/runner/src/cli.js');
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-node-agent-')),
    root = join(dir, 'repo'),
    home = join(dir, 'state');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional node workspace\n');
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
  return { dir, root, home, close: () => rm(dir, { recursive: true, force: true }) };
}
async function command(args: string[], input = '') {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let out = '',
    err = '';
  child.stdout.on('data', (v) => {
    out += v;
  });
  child.stderr.on('data', (v) => {
    err += v;
  });
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  return { code, out, err };
}

test('本地授权只接受明确 Git 根，拒绝重复、符号链接别名、重叠目录和仓库内凭证目录', async () => {
  const f = await repo();
  try {
    const dirs = await authorizeDirectories([{ name: '开发副本', path: f.root }], f.home);
    assert.equal(dirs[0]?.root, f.root);
    const link = join(f.dir, 'alias');
    await symlink(f.root, link);
    await assert.rejects(
      () =>
        authorizeDirectories(
          [
            { name: 'A', path: f.root },
            { name: 'B', path: link },
          ],
          f.home,
        ),
      codeIs('OVERLAPPING_WORKSPACES'),
    );
    const sub = join(f.root, 'sub');
    await mkdir(sub);
    await assert.rejects(
      () => authorizeDirectories([{ name: 'A', path: sub }], f.home),
      codeIs('WORKSPACE_UNAVAILABLE'),
    );
    const badState = join(f.root, '.private-node');
    await mkdir(badState, { mode: 0o700 });
    await assert.rejects(
      () => authorizeDirectories([{ name: 'A', path: f.root }], badState),
      codeIs('STATE_INSIDE_WORKSPACE'),
    );
  } finally {
    await f.close();
  }
});

test('实际 Git 状态只生成数量摘要，文件名、路径、内容和远程地址不进入载荷', async () => {
  const f = await repo();
  try {
    const [w] = await authorizeDirectories([{ name: '开发副本', path: f.root }], f.home);
    await writeFile(join(f.root, 'README.md'), 'changed\n');
    await writeFile(join(f.root, 'do-not-upload-secret.env'), 'sk-fixture-secret-never-send');
    const s = await captureSnapshot([w!]);
    assert.equal(s.workspaces[0]?.state, 'available');
    assert.equal(s.workspaces[0]?.modified, 1);
    assert.equal(s.workspaces[0]?.untracked, 1);
    for (const forbidden of [
      f.root,
      'README.md',
      'do-not-upload-secret.env',
      'sk-fixture-secret-never-send',
    ])
      assert.ok(!JSON.stringify(s).includes(forbidden));
    assert.deepEqual(countStatus('R  new\0old\0?? odd\nname\0UU conflict\0'), {
      staged: 1,
      modified: 0,
      untracked: 1,
      conflicts: 1,
    });
  } finally {
    await f.close();
  }
});

test('Git fsmonitor 仓库脚本不会运行，授权目录被替换后不读取新仓库', async () => {
  const f = await repo();
  try {
    const marker = join(f.dir, 'unexpected-script'),
      hook = join(f.dir, 'fsmonitor');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o700);
    execFileSync('git', ['-C', f.root, 'config', 'core.fsmonitor', hook]);
    const [w] = await authorizeDirectories([{ name: '开发副本', path: f.root }], f.home);
    assert.equal((await captureDirectory(w!)).state, 'available');
    assert.equal(existsSync(marker), false);
    await rename(f.root, join(f.dir, 'old'));
    await mkdir(f.root);
    execFileSync('git', ['init', '-q', f.root]);
    assert.equal((await captureDirectory(w!)).state, 'authorization_changed');
  } finally {
    await f.close();
  }
});

test('节点状态目录与文件为独占权限，符号链接和宽权限目录拒绝使用', async () => {
  const f = await repo();
  try {
    const storage = new AgentStorage(f.home);
    assert.equal((await stat(join(f.home, 'journal.sqlite'))).mode & 0o777, 0o600);
    assert.throws(() => new AgentStorage(f.home), codeIs('RUNNER_ALREADY_STARTED'));
    storage.close();
    const second = new AgentStorage(f.home);
    second.close();
    const alias = join(f.dir, 'alias');
    await symlink(f.home, alias);
    assert.throws(() => ensurePrivateHome(alias), codeIs('INSECURE_STATE_DIRECTORY'));
    await chmod(f.home, 0o755);
    assert.throws(() => ensurePrivateHome(f.home), codeIs('INSECURE_STATE_DIRECTORY'));
  } finally {
    await f.close();
  }
});

test('本地未确认摘要跨重启保留，ACK 原子推进，不能覆盖、跳号或接受服务端回退', async () => {
  const f = await repo();
  let storage = new AgentStorage(f.home);
  try {
    const dirs = await authorizeDirectories([{ name: '工作副本', path: f.root }], f.home),
      s = await captureSnapshot(dirs);
    const item = storage.enqueue(s);
    assert.equal(item.sequence, 1);
    assert.deepEqual(storage.enqueue({ ...s, capturedAt: '2000-01-01T00:00:00.000Z' }), item);
    storage.close();
    storage = new AgentStorage(f.home);
    assert.deepEqual(storage.pending(), item);
    storage.reconcile(1);
    assert.ok(storage.pending()); // Lost ACK must still prove exact duplicate payload.
    assert.throws(() => storage.reconcile(2), codeIs('JOURNAL_MISMATCH'));
    assert.throws(() => storage.acknowledge(2), codeIs('ACK_MISMATCH'));
    storage.acknowledge(1);
    assert.equal(storage.acknowledged(), 1);
    assert.equal(storage.pending(), null);
    assert.throws(() => storage.reconcile(0), codeIs('JOURNAL_MISMATCH'));
  } finally {
    storage.close();
    await f.close();
  }
});

test('节点 HTTP 客户端不跟随重定向，凭证不会被转发到另一地址', async () => {
  let received = 0;
  const other = createServer((_q, r) => {
    received++;
    r.end('{}');
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  const second = other.address() as { port: number };
  const redirect = createServer((_q, r) => {
    r.writeHead(307, { location: `http://127.0.0.1:${second.port}/steal` });
    r.end();
  });
  redirect.listen(0, '127.0.0.1');
  await once(redirect, 'listening');
  try {
    await assert.rejects(() =>
      nodeRequest(
        `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
        'hello',
        {},
        randomBytes(32).toString('base64url'),
      ),
    );
    assert.equal(received, 0);
  } finally {
    redirect.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => redirect.close(() => r())),
      new Promise<void>((r) => other.close(() => r())),
    ]);
  }
});

test('实际 CLI 隐藏配对、独立同步、重启和撤销，token 不进入 argv/输出或共享载荷', async () => {
  const f = await repo(),
    team = await teamFixture();
  try {
    const { alice } = await team.pair(),
      project = await team.project(alice);
    const pairing = (await team.call('nodes/pairings', alice, { projectId: project.id })).json();
    const origin = await team.app.listen({ host: '127.0.0.1', port: 0 });
    const config = join(f.dir, 'runner.json');
    await writeFile(
      config,
      JSON.stringify({
        controlUrl: origin,
        name: '独立 CLI（测试）',
        workspaces: [{ name: '项目副本', path: f.root }],
      }),
    );
    const connected = await command(
      ['connect', '--config', config, '--state', f.home],
      pairing.code + '\nCONNECT\n',
    );
    assert.equal(connected.code, 0, connected.out + connected.err);
    assert.ok(!connected.out.includes(pairing.code));
    const credentials = readCredentials(f.home);
    assert.ok(credentials.nodeId);
    assert.equal((await stat(join(f.home, 'credentials.json'))).mode & 0o777, 0o600);
    assert.ok(!connected.out.includes(credentials.nodeToken));
    await writeFile(join(f.root, 'private-file.txt'), 'not uploaded');
    const first = await command(['start', '--state', f.home, '--once']);
    assert.equal(first.code, 0, first.out + first.err);
    const second = await command(['start', '--state', f.home, '--once']);
    assert.equal(second.code, 0, second.out + second.err);
    const nodes = (await team.call('nodes', alice)).json().items;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].acknowledgedSequence, 2);
    assert.equal(nodes[0].presence, 'offline');
    assert.equal(nodes[0].snapshot.workspaces[0].untracked, 1);
    assert.ok(!JSON.stringify(nodes).includes(f.root));
    assert.equal(nodes[0].executionEnabled, false);
    const status = await command(['status', '--state', f.home]);
    assert.equal(status.code, 0);
    assert.ok(!status.out.includes(credentials.nodeToken));
    assert.ok(!status.out.includes(f.root));
    const disconnected = await command(['disconnect', '--state', f.home]);
    assert.equal(disconnected.code, 0, disconnected.out);
    assert.equal(existsSync(join(f.home, 'credentials.json')), false);
    assert.equal(
      (await team.call(`nodes/${credentials.nodeId}`, alice)).json().presence,
      'revoked',
    );
  } finally {
    await team.close();
    await f.close();
  }
});

test('真实服务已保存但 ACK 丢失时，独立连接重放同序号而不创建第二条状态', async () => {
  const f = await repo(),
    team = await teamFixture();
  let storage = new AgentStorage(f.home);
  try {
    const { alice } = await team.pair(),
      project = await team.project(alice);
    const pairing = (await team.call('nodes/pairings', alice, { projectId: project.id })).json();
    const origin = await team.app.listen({ host: '127.0.0.1', port: 0 });
    const directories = await authorizeDirectories([{ name: '重放副本', path: f.root }], f.home);
    const c: NodeCredentials = {
      version: 1,
      name: '重放节点',
      controlUrl: origin,
      clientId: key(),
      nodeToken: randomBytes(32).toString('base64url'),
      projectId: project.id,
      spaceId: alice.spaceId,
      nodeId: null,
      directories,
    };
    writeCredentials(f.home, c);
    const paired = await nodeRequest<{ nodeId: string }>(origin, 'pair', {
      protocol: 1,
      code: pairing.code,
      clientId: c.clientId,
      nodeToken: c.nodeToken,
      projectId: project.id,
      name: c.name,
      platform: 'linux',
      arch: 'x64',
      workspaces: directories.map(({ id, name }) => ({ id, name })),
    });
    // Simulate a lost pairing response: local nodeId stays null and hello recovers it.
    const agent = new AgentConnection(storage);
    await agent.hello();
    assert.equal(agent.credentials.nodeId, paired.nodeId);
    const pending = storage.enqueue(await captureSnapshot(directories));
    await nodeRequest(
      origin,
      'sync',
      { connectionId: agent.connectionId, sequence: pending.sequence, snapshot: pending.snapshot },
      c.nodeToken,
    );
    assert.equal(storage.acknowledged(), 0);
    assert.ok(storage.pending());
    await agent.goodbye();
    storage.close();
    storage = new AgentStorage(f.home);
    const retry = new AgentConnection(storage);
    await retry.cycle();
    await retry.goodbye();
    assert.equal(storage.acknowledged(), 1);
    assert.equal(storage.pending(), null);
    assert.equal((await team.call('nodes', alice)).json().items[0].acknowledgedSequence, 1);
    assert.equal(team.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 0);
  } finally {
    storage.close();
    await team.close();
    await f.close();
  }
});

test('CLI 不接受参数中的配对凭证，缺少本机确认时不注册节点', async () => {
  const token = randomBytes(32).toString('base64url');
  const response = await command(['connect', '--token', token]);
  assert.equal(response.code, 1);
  assert.ok(!response.out.includes(token));
  assert.ok(response.out.includes('不支持此参数'));
});

test('Git clean/process/smudge 与 include 配置不能执行，过滤型仓库不伪造干净状态', async () => {
  for (const driver of ['clean', 'process', 'smudge', 'included']) {
    const f = await repo();
    try {
      const marker = join(f.dir, 'filter-invoked');
      await writeFile(join(f.root, '.gitattributes'), 'README.md filter=probe\n');
      execFileSync('git', ['-C', f.root, 'add', '.gitattributes']);
      const command = `touch '${marker}'; cat`;
      if (driver === 'included') {
        const config = join(f.dir, 'extra.config');
        await writeFile(config, `[filter "probe"]\nclean = "${command}"\n`);
        execFileSync('git', ['-C', f.root, 'config', 'include.path', config]);
      } else execFileSync('git', ['-C', f.root, 'config', `filter.probe.${driver}`, command]);
      await utimes(join(f.root, 'README.md'), 1000000000, 1000000000);
      const index = await readFile(join(f.root, '.git', 'index'));
      const [w] = await authorizeDirectories([{ name: '安全目录', path: f.root }], f.home);
      const result = await captureDirectory(w!);
      assert.equal(result.state, 'unavailable');
      assert.equal(existsSync(marker), false);
      assert.deepEqual(await readFile(join(f.root, '.git', 'index')), index);
    } finally {
      await f.close();
    }
  }
});

test('配置预检后新增过滤器仍不会被状态采集进程执行', async () => {
  const f = await repo(),
    previous = process.env.PATH;
  try {
    const marker = join(f.dir, 'race-filter-invoked');
    const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await writeFile(join(f.root, '.gitattributes'), 'README.md filter=late\n');
    await utimes(join(f.root, 'README.md'), 1000000000, 1000000000);
    const [w] = await authorizeDirectories([{ name: '工作副本', path: f.root }], f.home);
    const bin = join(f.dir, 'bin');
    await mkdir(bin);
    // Test-only interception at the exact isolation boundary, not a production hook.
    const wrapper = join(bin, 'git');
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args.some(a=>a.startsWith('--git-dir='))) spawnSync(${JSON.stringify(git)},['-C',${JSON.stringify(f.root)},'config','filter.late.clean',${JSON.stringify(`touch '${marker}'; cat`)}]);\nconst result=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'});process.exit(result.status??1);\n`,
    );
    await chmod(wrapper, 0o700);
    process.env.PATH = bin + ':' + previous;
    assert.equal((await captureDirectory(w!)).state, 'unavailable');
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = previous;
    await f.close();
  }
});

test('隔离 Git 摘要支持未提交首版与 linked worktree，且不写入原始索引', async () => {
  const f = await repo();
  try {
    const linked = join(f.dir, 'linked');
    execFileSync('git', ['-C', f.root, 'worktree', 'add', '-q', '-b', 'summary-test', linked]);
    await writeFile(join(linked, 'README.md'), 'changed in linked workspace\n');
    const empty = join(f.dir, 'empty');
    await mkdir(empty);
    execFileSync('git', ['init', '-q', empty]);
    await writeFile(join(empty, 'new.txt'), 'not yet committed\n');
    execFileSync('git', ['-C', empty, 'add', 'new.txt']);
    const dirs = await authorizeDirectories(
      [
        { name: 'linked', path: linked },
        { name: 'unborn', path: empty },
      ],
      f.home,
    );
    const indexes = await Promise.all(dirs.map((w) => readFile(join(w.gitDir, 'index'))));
    const summary = await captureSnapshot(dirs);
    assert.equal(summary.workspaces[0]?.state, 'available');
    assert.equal(summary.workspaces[0]?.modified, 1);
    assert.equal(summary.workspaces[1]?.state, 'available');
    assert.equal(summary.workspaces[1]?.staged, 1);
    for (let i = 0; i < dirs.length; i++)
      assert.deepEqual(await readFile(join(dirs[i]!.gitDir, 'index')), indexes[i]);
  } finally {
    await f.close();
  }
});
