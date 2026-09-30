import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, lstat, readdir, rename, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { integrationRunnerFixture as fixture } from './helpers/integration-runner.js';
import { git } from './helpers/checkpoint-retention.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import {
  localIntegrationTrial,
  integrationTrialSelection,
} from '../apps/runner/src/agent/integration-trial.js';
import {
  IntegrationTrialJournal,
  withSettledIntegrationTrials,
} from '../apps/runner/src/agent/integration-trial-journal.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('must not ask or replay');
};
const accept = async (prompt: string) => /TRIAL [0-9a-f-]{36}/.exec(prompt)![0];
async function prepared(format: 'sha1' | 'sha256' = 'sha1', transfer = false) {
  const f = await fixture(
    format,
    transfer,
    false,
    {
      'nested/binary.dat': Buffer.from([0, 1, 255, 128, 13, 10]),
      'run.sh': '#!/bin/sh\ntouch SHOULD_NOT_RUN\n',
      'unselected.txt': 'UNSELECTED_SOURCE\n',
    },
    {
      baseFiles: { 'delete.txt': 'BASE_DELETE\n', 'keep.txt': 'BASE_KEEP\n' },
      sourceDeletePaths: ['delete.txt'],
      sourceExecutablePaths: ['run.sh'],
      targetFiles: { 'keep.txt': 'TARGET_UPDATED\n' },
    },
  );
  const id = await f.create();
  await preflightIntegration(f.target.home, id, f.ask(id), silent);
  assert.equal((await f.read(id)).operation.state, 'awaiting_choice');
  return { ...f, id, destination: join(f.dir, 'private-trial') };
}
async function tree(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name),
      s = await lstat(path);
    entries.push([
      name,
      s.mode,
      s.ino,
      s.nlink,
      s.isDirectory() ? await tree(path) : (await readFile(path)).toString('hex'),
    ]);
  }
  return entries;
}
const paths = ['README.md', 'new.txt', 'delete.txt', 'nested/binary.dat', 'run.sh'];
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} real trial copies selected add/modify/delete plus full target tree privately, no shared or original mutation`, async () => {
    const f = await prepared(format, format === 'sha256');
    try {
      const before = await tree(f.target.root),
        view = await f.read(f.id);
      const vault = await readFile(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
      let prompts = 0;
      const result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        paths,
        async (p) => {
          prompts++;
          return accept(p);
        },
        { log: silent },
      );
      assert.equal(result.state, 'ready', JSON.stringify(result));
      assert.equal(result.materialState, 'published');
      assert.equal(prompts, 1);
      assert.equal(result.trialOnly, true);
      assert.equal(result.applied, false);
      assert.equal(result.writeAuthorized, false);
      assert.equal(
        await readFile(join(f.destination, 'README.md'), 'utf8'),
        'SOURCE_COMMITTED_SECRET\n',
      );
      assert.equal(
        await readFile(join(f.destination, 'target.txt'), 'utf8'),
        'TARGET_PRIVATE_ONLY\n',
      );
      assert.equal(await readFile(join(f.destination, 'keep.txt'), 'utf8'), 'TARGET_UPDATED\n');
      assert.deepEqual(
        await readFile(join(f.destination, 'nested/binary.dat')),
        Buffer.from([0, 1, 255, 128, 13, 10]),
      );
      for (const name of ['.git', 'delete.txt', 'unselected.txt', 'SHOULD_NOT_RUN'])
        await assert.rejects(lstat(join(f.destination, name)), { code: 'ENOENT' });
      assert.equal((await lstat(f.destination)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(f.destination, 'nested'))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(f.destination, 'nested/binary.dat'))).mode & 0o777, 0o600);
      assert.equal((await lstat(join(f.destination, 'run.sh'))).mode & 0o777, 0o700);
      assert.deepEqual(await tree(f.target.root), before);
      assert.deepEqual(await f.read(f.id), view);
      assert.deepEqual(
        await readFile(join(f.target.home, 'retained-checkpoints/journal.sqlite')),
        vault,
      );
      assert.equal(git(f.target.root, 'rev-parse', 'HEAD'), f.targetCommit);
      assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
      await writeFile(join(f.destination, 'README.md'), 'USER_TRIAL_EDIT');
      const repeated = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        paths,
        noAsk,
        { log: silent },
      );
      assert.equal(repeated.id, result.id);
      assert.equal(repeated.historical, true);
      assert.equal(repeated.updatedAt, result.updatedAt);
      assert.equal(await readFile(join(f.destination, 'README.md'), 'utf8'), 'USER_TRIAL_EDIT');
    } finally {
      await f.close();
    }
  });
test('unselected modification/deletion remain from target; exact repeat does not reread expired/deleted objects or original target', async () => {
  const f = await prepared();
  try {
    const result = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      accept,
      { log: silent },
    );
    assert.equal(result.state, 'ready');
    assert.equal(await readFile(join(f.destination, 'README.md'), 'utf8'), 'BASE\n');
    assert.equal(await readFile(join(f.destination, 'delete.txt'), 'utf8'), 'BASE_DELETE\n');
    const db = new DatabaseSync(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
    db.prepare('DELETE FROM objects WHERE bundle_id=?').run(f.sr);
    db.close();
    await rename(f.target.root, f.target.root + '-moved');
    const again = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      noAsk,
      { log: silent },
    );
    assert.equal(again.state, 'ready');
    assert.equal(again.historical, true);
    assert.equal(again.id, result.id);
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['README.md'], noAsk, {
        log: silent,
      }),
      /不同原身份/,
    );
  } finally {
    await f.close();
  }
});
test('occupied, overlapping, non-owned-mode targets and cancelled confirmation create no trial files', async () => {
  const f = await prepared();
  try {
    await mkdir(f.destination);
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
        log: silent,
      }),
      /目标已存在|目标已被占用|已经存在/,
    );
    await rm(f.destination, { recursive: true });
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, join(f.target.root, 'trial'), ['new.txt'], noAsk, {
        log: silent,
      }),
      /重叠/,
    );
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, join(f.target.home, 'trial'), ['new.txt'], noAsk, {
        log: silent,
      }),
      /重叠/,
    );
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], async () => 'no', {
        log: silent,
      }),
      /未确认/,
    );
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    assert(!(await readdir(f.dir)).some((p) => p.startsWith('.hexu-restore-')));
    await chmod(f.dir, 0o777);
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
        log: silent,
      }),
      /本人|变化|归属/,
    );
    await chmod(f.dir, 0o700);
  } finally {
    await chmod(f.dir, 0o700);
    await f.close();
  }
});
test('current binding, revoked owner, corrupted material and unknown target writer fail closed before new files', async () => {
  const f = await prepared();
  try {
    const before = await tree(f.target.root),
      lease = new WorkspaceLease(f.target.root, 'trial-fixture-' + randomUUID());
    try {
      await assert.rejects(
        localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], accept, {
          log: silent,
        }),
        /占用|未知/,
      );
    } finally {
      lease.release();
    }
    await assert.rejects(
      localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        ['new.txt'],
        async (p) => {
          writeCredentials(f.target.home, {
            ...f.target.credentials,
            name: 'changed binding',
            clientId: randomUUID(),
          });
          return accept(p);
        },
        { log: silent },
      ),
      /身份|目录/,
    );
    writeCredentials(f.target.home, f.target.credentials);
    const db = new DatabaseSync(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
    db.prepare(
      "UPDATE objects SET data=zeroblob(length(data)) WHERE bundle_id=? AND type='blob'",
    ).run(f.sr);
    db.close();
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], accept, {
        log: silent,
      }),
    );
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    assert.deepEqual(await tree(f.target.root), before);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
        log: silent,
      }),
      /撤销|权限/,
    );
  } finally {
    await f.close();
  }
});
test('signal between files retains stage, records exact intent, repeat never resumes or publishes', async () => {
  const f = await prepared();
  try {
    const before = await tree(f.target.root),
      controller = new AbortController();
    const result = await localIntegrationTrial(f.target.home, f.id, f.destination, paths, accept, {
      log: silent,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.completedFiles === 1) controller.abort();
      },
    });
    assert.equal(result.state, 'interrupted');
    assert.equal(result.materialState, 'staging');
    assert.equal(result.completedFiles, 1);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    const stage = join(f.dir, result.stageName),
      saved = await tree(stage);
    const repeat = await localIntegrationTrial(f.target.home, f.id, f.destination, paths, noAsk, {
      log: silent,
    });
    assert.equal(repeat.state, 'interrupted');
    assert.deepEqual(await tree(stage), saved);
    assert.deepEqual(await tree(f.target.root), before);
  } finally {
    await f.close();
  }
});
test('stage replacement, target occupation and revoked authority before publish retain evidence without overwriting', async () => {
  for (const attack of ['stage', 'target', 'authority'] as const) {
    const f = await prepared();
    try {
      const before = await tree(f.target.root);
      let changed = false;
      const result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        paths,
        accept,
        {
          log: silent,
          onProgress: async (p) => {
            if (p.state !== 'verified' || changed) return;
            changed = true;
            if (attack === 'stage') {
              await rename(join(f.dir, p.stageName), join(f.dir, p.stageName + '-saved'));
              await mkdir(join(f.dir, p.stageName), { mode: 0o700 });
            }
            if (attack === 'target') {
              await mkdir(f.destination);
              await writeFile(join(f.destination, 'user.txt'), 'KEEP');
            }
            if (attack === 'authority')
              f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
          },
        },
      );
      assert.equal(result.state, 'failed', JSON.stringify(result));
      assert.notEqual(result.materialState, 'published');
      if (attack === 'target')
        assert.equal(await readFile(join(f.destination, 'user.txt'), 'utf8'), 'KEEP');
      else await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
      assert.deepEqual(await tree(f.target.root), before);
    } finally {
      await f.close();
    }
  }
});
test('lost publication evidence never infers ready from existing directory or rewrites on repeat', async () => {
  const f = await prepared();
  try {
    // The helper itself is unchanged: simulate the process losing the final durable
    // receipt AFTER actual publication by throwing from the final journal save.
    const save = IntegrationTrialJournal.prototype.save;
    let lost = false;
    IntegrationTrialJournal.prototype.save = function (record) {
      if (record.progress.state === 'ready' && !lost) {
        lost = true;
        throw new Error('lost durable publication receipt');
      }
      return save.call(this, record);
    };
    let result;
    try {
      result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        ['new.txt'],
        accept,
        { log: silent },
      );
    } finally {
      IntegrationTrialJournal.prototype.save = save;
    }
    assert.equal(result.state, 'interrupted');
    assert.equal(result.materialState, 'unknown');
    assert.equal(result.publishedAt, null);
    assert.equal((await lstat(f.destination)).isDirectory(), true);
    const before = await tree(f.destination);
    const repeat = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      noAsk,
      { log: silent },
    );
    assert.equal(repeat.state, 'interrupted');
    assert.equal(repeat.materialState, 'unknown');
    assert.deepEqual(await tree(f.destination), before);
  } finally {
    await f.close();
  }
});
test('actual killed writer releases process guard but repeat only records interrupted, no continuation', async () => {
  const f = await prepared();
  try {
    const before = await tree(f.target.root),
      module = resolve('dist/apps/runner/src/agent/integration-trial.js');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { localIntegrationTrial } from ${JSON.stringify('file://' + module)};
      await localIntegrationTrial(${JSON.stringify(f.target.home)},${JSON.stringify(f.id)},${JSON.stringify(f.destination)},['new.txt'],async()=>${JSON.stringify('TRIAL ' + f.id)},{log:()=>{},onProgress:async p=>{
        if(p.state==='writing'&&p.completedFiles===1){console.log('PARTIAL');await new Promise(()=>{setInterval(()=>{},1000);});}
      }});
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    child.stdout!.on('data', (b) => {
      out += b;
    });
    child.stderr!.on('data', (b) => {
      err += b;
    });
    const exit = once(child, 'exit');
    const deadline = Date.now() + 20000;
    while (!out.includes('PARTIAL') && child.exitCode === null && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    if (!out.includes('PARTIAL')) {
      child.kill('SIGKILL');
      await exit;
      assert.fail('child did not reach partial write: ' + err);
    }
    await assert.rejects(
      localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
        log: silent,
      }),
      /已有进程/,
    );
    child.kill('SIGKILL');
    await exit;
    const result = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      noAsk,
      { log: silent },
    );
    assert.equal(result.state, 'interrupted');
    assert.equal(result.materialState, 'unknown');
    assert.equal(result.completedFiles, 1);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    assert.deepEqual(await tree(f.target.root), before);
    const saved = await tree(join(f.dir, result.stageName));
    await localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
      log: silent,
    });
    assert.deepEqual(await tree(join(f.dir, result.stageName)), saved);
  } finally {
    await f.close();
  }
});
test('selection parser is unambiguous, bounded, rejects duplicates and unsafe paths', () => {
  for (const value of [
    [],
    ['a', 'a'],
    ['../a'],
    ['a//b'],
    ['/a'],
    ['a\n'],
    ['.git/HEAD'],
    Array(81).fill('a'),
  ]) {
    assert.throws(() => integrationTrialSelection(value));
  }
  assert.deepEqual(integrationTrialSelection(['b', 'a']), ['a', 'b']);
});

test('credential change guard covers entire prompt/write and CLI disconnect preserves interrupted evidence', async () => {
  const f = await prepared();
  const cli = resolve('dist/apps/runner/src/cli.js');
  const disconnect = () =>
    spawnSync(process.execPath, [cli, 'disconnect', '--local-only', '--state', f.target.home], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
  try {
    const credentials = await readFile(join(f.target.home, 'credentials.json'));
    const controller = new AbortController();
    let activeChecked = false;
    const result = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      async (p) => {
        const denied = disconnect();
        assert.equal(denied.status, 1);
        assert.match(denied.stdout + denied.stderr, /RUNNER_ALREADY_STARTED/);
        activeChecked = true;
        return accept(p);
      },
      {
        log: silent,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.completedFiles === 1) controller.abort();
        },
      },
    );
    assert(activeChecked);
    assert.equal(result.materialState, 'staging');
    const denied = disconnect();
    assert.equal(denied.status, 1);
    assert.match(denied.stdout + denied.stderr, /INTEGRATION_TRIAL_UNSETTLED/);
    await assert.rejects(
      withSettledIntegrationTrials(f.target.home, async () => {}),
      /暂存|未知/,
    );
    assert.deepEqual(await readFile(join(f.target.home, 'credentials.json')), credentials);
  } finally {
    await f.close();
  }
});
test('settled private trial permits explicit CLI disconnect; reconnect guard needs no old credentials', async () => {
  const f = await prepared();
  try {
    const result = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      accept,
      { log: silent },
    );
    assert.equal(result.state, 'ready');
    const cli = resolve('dist/apps/runner/src/cli.js');
    const done = spawnSync(
      process.execPath,
      [cli, 'disconnect', '--local-only', '--state', f.target.home],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );
    assert.equal(done.status, 0, done.stderr);
    await assert.rejects(readFile(join(f.target.home, 'credentials.json')), { code: 'ENOENT' });
    let entered = false;
    await withSettledIntegrationTrials(f.target.home, async () => {
      entered = true;
    });
    assert(entered);
    assert.equal(await readFile(join(f.destination, 'new.txt'), 'utf8'), 'NEW_COMMITTED_SECRET\n');
  } finally {
    await f.close();
  }
});
test('held credential-action guard blocks new trial throughout asynchronous action', async () => {
  const f = await prepared();
  try {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      wait = new Promise<void>((r) => (release = r));
    const changing = withSettledIntegrationTrials(f.target.home, async () => {
      enter();
      await wait;
    });
    await entered;
    try {
      await assert.rejects(
        localIntegrationTrial(f.target.home, f.id, f.destination, ['new.txt'], noAsk, {
          log: silent,
        }),
        /已有进程/,
      );
    } finally {
      release();
      await changing;
    }
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('expiry before final publication retains verified stage without extending material lifetime', async (t) => {
  const f = await prepared();
  try {
    const expiry = Date.parse((await f.read(f.id)).operation.material.manifest.expiresAt);
    const result = await localIntegrationTrial(
      f.target.home,
      f.id,
      f.destination,
      ['new.txt'],
      accept,
      {
        log: silent,
        onProgress: (p) => {
          if (p.state === 'verified') t.mock.method(Date, 'now', () => expiry + 1000);
        },
      },
    );
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'RESTORE_RETENTION_EXPIRED');
    assert.equal(result.materialState, 'staging');
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
test('nonconflicting selection may leave an unrelated conflict intact in the independent trial', async () => {
  const f = await fixture('sha1', false, true);
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    assert.equal((await f.read(id)).operation.state, 'conflict');
    const target = join(f.dir, 'trial');
    await assert.rejects(
      localIntegrationTrial(f.target.home, id, target, ['README.md'], noAsk, { log: silent }),
      /无冲突/,
    );
    const result = await localIntegrationTrial(f.target.home, id, target, ['new.txt'], accept, {
      log: silent,
    });
    assert.equal(result.state, 'ready');
    assert.equal(await readFile(join(target, 'README.md'), 'utf8'), 'TARGET_DIFFERENT\n');
    assert.equal(await readFile(join(target, 'new.txt'), 'utf8'), 'NEW_COMMITTED_SECRET\n');
  } finally {
    await f.close();
  }
});

test('final publishing boundary rehashes material and checks original target/stage bytes after hooks', async () => {
  for (const attack of ['objects', 'original', 'stage_bytes', 'stage_mode'] as const) {
    const f = await prepared();
    try {
      let changed = false;
      const result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        ['new.txt'],
        accept,
        {
          log: silent,
          onProgress: async (p) => {
            if (p.state !== 'publishing' || changed) return;
            changed = true;
            if (attack === 'objects') {
              const db = new DatabaseSync(
                join(f.target.home, 'retained-checkpoints/journal.sqlite'),
              );
              db.prepare(
                "UPDATE objects SET data=zeroblob(length(data)) WHERE bundle_id=? AND type='blob'",
              ).run(f.sr);
              db.close();
            }
            if (attack === 'original')
              await writeFile(join(f.target.root, 'README.md'), 'USER_ORIGINAL_EDIT');
            if (attack === 'stage_bytes')
              await writeFile(join(f.dir, p.stageName, 'new.txt'), 'USER_STAGE_EDIT');
            if (attack === 'stage_mode') await chmod(join(f.dir, p.stageName, 'new.txt'), 0o644);
          },
        },
      );
      assert.equal(result.state, 'failed', JSON.stringify(result));
      assert.equal(result.materialState, 'staging');
      await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
      if (attack === 'original')
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          'USER_ORIGINAL_EDIT',
        );
      if (attack === 'stage_bytes')
        assert.equal(
          await readFile(join(f.dir, result.stageName, 'new.txt'), 'utf8'),
          'USER_STAGE_EDIT',
        );
    } finally {
      await f.close();
    }
  }
});

test('real CLI accepts strict JSON selection with one confirmation and handles SIGTERM while awaiting consent', async () => {
  const f = await prepared();
  try {
    const cli = resolve('dist/apps/runner/src/integration-trial.js');
    const run = async (target: string, stopAtPrompt = false) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          '--operation',
          f.id,
          '--state',
          f.target.home,
          '--target',
          target,
          '--files',
          '["new.txt"]',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      let stdout = '',
        stderr = '',
        stopped = false;
      child.stdout.on('data', (b) => {
        stdout += b;
        if (stopAtPrompt && !stopped && stdout.includes('输入 TRIAL')) {
          stopped = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      if (!stopAtPrompt) child.stdin.end(`TRIAL ${f.id}\n`);
      try {
        const [code] = await once(child, 'exit');
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
        child.stdin.destroy();
      }
    };
    const done = await run(f.destination);
    assert.equal(done.code, 0, done.stderr);
    assert.equal((done.stdout.match(/输入 TRIAL/g) ?? []).length, 1);
    assert.match(done.stdout, /"state":"ready"/);
    assert.match(done.stdout, /"applied":false/);
    const stoppedTarget = join(f.dir, 'cancelled-cli');
    const stopped = await run(stoppedTarget, true);
    assert.equal(stopped.code, 1, stopped.stderr);
    await assert.rejects(lstat(stoppedTarget), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('last target authority response cannot hide an original-target edit or source-only expiry', async (t) => {
  for (const attack of ['original', 'source_expiry'] as const) {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      const view = await f.read(f.id),
        sourceExpiry = Date.parse(view.operation.material.manifest.expiresAt),
        targetExpiry = Date.parse(view.operation.target.manifest.expiresAt);
      assert(sourceExpiry + 1 < targetExpiry);
      let publishing = false,
        targetChecks = 0,
        attacked = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          publishing &&
          String(input).endsWith('/checkpoint-retention-inspect') &&
          JSON.parse(String(init?.body)).requestId === f.tr &&
          ++targetChecks === 3
        ) {
          attacked = true;
          if (attack === 'original')
            await writeFile(join(f.target.root, 'README.md'), 'LAST_AUTH_USER_EDIT');
          else t.mock.method(Date, 'now', () => sourceExpiry + 1);
        }
        return response;
      };
      const result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        ['new.txt'],
        accept,
        {
          log: silent,
          onProgress: (p) => {
            if (p.state === 'publishing') publishing = true;
          },
        },
      );
      assert(attacked);
      assert.equal(result.state, 'failed', JSON.stringify(result));
      assert.equal(result.materialState, 'staging');
      assert.equal(
        result.errorCode,
        attack === 'original' ? 'WORKSPACE_COMMIT_CHANGED' : 'RESTORE_RETENTION_EXPIRED',
      );
      await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
      if (attack === 'original')
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          'LAST_AUTH_USER_EDIT',
        );
    } finally {
      globalThis.fetch = fetch;
      t.mock.restoreAll();
      await f.close();
    }
  }
});
test('synchronous final observation and expiry checks follow owned-stage verification', async (t) => {
  for (const attack of ['original', 'source_expiry', 'index', 'head', 'extra'] as const) {
    const f = await prepared(),
      entries = IntegrationTrialJournal.prototype.entries,
      fetch = globalThis.fetch;
    try {
      const view = await f.read(f.id),
        sourceExpiry = Date.parse(view.operation.material.manifest.expiresAt);
      let publishing = false,
        targetChecks = 0,
        attacked = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          publishing &&
          String(input).endsWith('/checkpoint-retention-inspect') &&
          JSON.parse(String(init?.body)).requestId === f.tr
        )
          targetChecks++;
        return response;
      };
      IntegrationTrialJournal.prototype.entries = function (id) {
        const value = entries.call(this, id);
        if (publishing && targetChecks === 3 && !attacked) {
          attacked = true;
          if (attack === 'original')
            writeFileSync(join(f.target.root, 'README.md'), 'DURING_STAGE_VERIFY');
          else if (attack === 'source_expiry') t.mock.method(Date, 'now', () => sourceExpiry + 1);
          else if (attack === 'index')
            writeFileSync(join(f.target.root, '.git/index'), 'USER_INDEX_EDIT');
          else if (attack === 'head')
            writeFileSync(join(f.target.root, '.git/HEAD'), 'USER_HEAD_EDIT');
          else writeFileSync(join(f.target.root, 'user-added.txt'), 'USER_EXTRA');
        }
        return value;
      };
      const result = await localIntegrationTrial(
        f.target.home,
        f.id,
        f.destination,
        ['new.txt'],
        accept,
        {
          log: silent,
          onProgress: (p) => {
            if (p.state === 'publishing') publishing = true;
          },
        },
      );
      assert(attacked);
      assert.equal(result.state, 'failed', JSON.stringify(result));
      assert.equal(
        result.errorCode,
        attack === 'source_expiry' ? 'RESTORE_RETENTION_EXPIRED' : 'WORKSPACE_COMMIT_CHANGED',
      );
      await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    } finally {
      IntegrationTrialJournal.prototype.entries = entries;
      globalThis.fetch = fetch;
      t.mock.restoreAll();
      await f.close();
    }
  }
});
