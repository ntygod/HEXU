import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
  lstat,
  readdir,
  rename,
  rm,
  symlink,
  mkdtemp,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { integrationRunnerFixture as fixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../apps/runner/src/agent/integration-trial.js';
import {
  IntegrationTrialJournal,
  withSettledIntegrationTrials,
} from '../apps/runner/src/agent/integration-trial-journal.js';
import {
  shareIntegrationTrialDifference,
  buildIntegrationTrialDifference,
  type IntegrationTrialDifferenceMetadata,
} from '../apps/runner/src/agent/integration-trial-difference.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import { objectHash } from '../apps/runner/src/agent/checkpoint-objects.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationPlan } from '../packages/contracts/src/integrations.js';
import type { IntegrationTrialDifferenceDetail } from '../packages/contracts/src/integration-trial.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('must not ask, reread or replay local writes');
};
const accept = async (prompt: string) =>
  /(?:SHARE_TRIAL_DIFF|DIFF_TRIAL|TRIAL) [0-9a-f-]{36}/.exec(prompt)![0];
const paths = ['README.md', 'new.txt', 'delete.txt', 'nested/binary.dat', 'run.sh', 'empty.txt'];
async function prepared(format: 'sha1' | 'sha256' = 'sha1', transfer = false) {
  const f = await fixture(
    format,
    transfer,
    false,
    {
      'nested/binary.dat': Buffer.from([0, 255]),
      'run.sh': '#!/bin/sh\ntouch SHOULD_NOT_RUN\n',
      'empty.txt': '',
      'unselected.txt': 'UNSELECTED_SOURCE_SECRET\n',
    },
    {
      baseFiles: { 'delete.txt': 'BASE_DELETE\n' },
      sourceDeletePaths: ['delete.txt'],
      sourceExecutablePaths: ['run.sh'],
    },
  );
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const destination = join(f.dir, 'private-trial');
    const trial = await localIntegrationTrial(f.target.home, id, destination, paths, accept, {
      log: silent,
    });
    assert.equal(trial.state, 'ready', JSON.stringify(trial));
    return { ...f, id, destination, trial };
  } catch (cause) {
    await f.close();
    throw cause;
  }
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
async function details(f: Awaited<ReturnType<typeof prepared>>) {
  const r = await f.api.call(`${f.path}/${f.id}/trials/${f.trial.id}`, f.alice);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as IntegrationTrialDifferenceDetail;
}
function localDifference(f: Awaited<ReturnType<typeof prepared>>) {
  const j = new IntegrationTrialJournal(f.target.home);
  try {
    return j.difference(j.byId(f.trial.id)!);
  } finally {
    j.close();
  }
}

for (const format of ['sha1', 'sha256'] as const)
  test(`${format} ready candidate shares only selected fixed-object add/modify/delete text after two distinct confirmations`, async () => {
    const f = await prepared(format, format === 'sha256');
    try {
      const original = await tree(f.target.root),
        candidate = await tree(f.destination),
        view = await f.read(f.id);
      const prompts: string[] = [],
        logs: string[] = [];
      const receipt = await shareIntegrationTrialDifference(
        f.target.home,
        f.id,
        f.trial.id,
        async (prompt) => {
          prompts.push(prompt);
          return accept(prompt);
        },
        { log: (s) => logs.push(s) },
      );
      assert.equal(prompts.length, 2);
      assert.match(prompts[0]!, /DIFF_TRIAL/);
      assert.match(prompts[1]!, /SHARE_TRIAL_DIFF/);
      const detail = await details(f),
        packet = detail.report;
      assert.equal(receipt.hash, detail.hash);
      assert.equal(packet.trialId, f.trial.id);
      assert.deepEqual(packet.selectedPaths, [...paths].sort());
      assert.equal(packet.difference.changedFiles, paths.length);
      assert.equal(packet.difference.omittedFiles, 0);
      assert.equal(
        packet.difference.files.find((f) => f.path === 'README.md')!.beforeText,
        'BASE\n',
      );
      assert.equal(
        packet.difference.files.find((f) => f.path === 'README.md')!.afterText,
        'SOURCE_COMMITTED_SECRET\n',
      );
      assert.equal(packet.difference.files.find((f) => f.path === 'delete.txt')!.after, null);
      assert.equal(
        packet.difference.files.find((f) => f.path === 'nested/binary.dat')!.display,
        'binary',
      );
      assert.equal(packet.difference.files.find((f) => f.path === 'run.sh')!.after!.mode, '100755');
      assert.equal(packet.difference.files.find((f) => f.path === 'empty.txt')!.afterText, '');
      for (const hidden of [
        'UNSELECTED_SOURCE_SECRET',
        'unselected.txt',
        'target.txt',
        'TARGET_PRIVATE_ONLY',
        f.destination,
        'stageIdentity',
        'entries',
      ])
        assert(!JSON.stringify(packet).includes(hidden), hidden);
      assert.equal(packet.applied, false);
      assert.equal(packet.writeAuthorized, false);
      assert.deepEqual(await tree(f.target.root), original);
      assert.deepEqual(await tree(f.destination), candidate);
      assert.deepEqual(await f.read(f.id), view);
      assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
      assert.equal(localDifference(f)!.state, 'shared');
      await rename(f.destination, f.destination + '-moved');
      await rename(f.target.root, f.target.root + '-moved');
      assert.deepEqual(
        await shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, {
          log: silent,
        }),
        receipt,
      );
    } finally {
      await f.close();
    }
  });

test('read denial never visits candidate; share denial freezes local report but does not block credential guard', async () => {
  const f = await prepared();
  try {
    await rename(f.destination, f.destination + '-moved');
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, async () => 'no', {
        log: silent,
      }),
      /未确认候选差异读取/,
    );
    assert.equal(localDifference(f), undefined);
    await rename(f.destination + '-moved', f.destination);
    await assert.rejects(
      shareIntegrationTrialDifference(
        f.target.home,
        f.id,
        f.trial.id,
        async (p) => (p.includes('SHARE_TRIAL_DIFF') ? 'no' : accept(p)),
        { log: silent },
      ),
      /未共享/,
    );
    const frozen = localDifference(f)!;
    assert.equal(frozen.state, 'frozen');
    let allowed = false;
    await withSettledIntegrationTrials(f.target.home, async () => {
      allowed = true;
    });
    assert(allowed);
    const logs: string[] = [];
    await shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, accept, {
      log: (s) => logs.push(s),
    });
    assert(logs.some((s) => s.includes(frozen.report.comparedAt) && s.includes('原核验时间')));
    assert.deepEqual((await details(f)).report, frozen.report);
  } finally {
    await f.close();
  }
});

test('candidate edits, extras, mode changes, symlinks and inode replacements refuse without altering evidence', async () => {
  for (const attack of ['bytes', 'extra', 'mode', 'symlink', 'replacement', 'root'] as const) {
    const f = await prepared();
    try {
      const file = join(f.destination, 'new.txt');
      if (attack === 'bytes') await writeFile(file, 'USER_EDIT');
      if (attack === 'extra') await writeFile(join(f.destination, 'extra.txt'), 'KEEP_EXTRA');
      if (attack === 'mode') await chmod(file, 0o644);
      if (attack === 'symlink') {
        await rm(file);
        await symlink(join(f.target.root, 'README.md'), file);
      }
      if (attack === 'replacement') {
        const data = await readFile(file);
        await rm(file);
        await writeFile(file, data, { mode: 0o600 });
      }
      if (attack === 'root') {
        await rename(f.destination, f.destination + '-saved');
        await mkdir(f.destination, { mode: 0o700 });
      }
      const original = await tree(f.target.root);
      let prompts = 0;
      await assert.rejects(
        shareIntegrationTrialDifference(
          f.target.home,
          f.id,
          f.trial.id,
          async (p) => {
            prompts++;
            return accept(p);
          },
          { log: silent },
        ),
      );
      assert.equal(prompts, 1, attack);
      assert.equal(localDifference(f), undefined, attack);
      assert.deepEqual(await tree(f.target.root), original);
      if (attack === 'bytes') assert.equal(await readFile(file, 'utf8'), 'USER_EDIT');
      if (attack === 'extra')
        assert.equal(await readFile(join(f.destination, 'extra.txt'), 'utf8'), 'KEEP_EXTRA');
    } finally {
      await f.close();
    }
  }
});

test('unknown publication, wrong original binding and wrong operation cannot reuse an existing directory as ready', async () => {
  const f = await prepared();
  try {
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, randomUUID(), noAsk, { log: silent }),
      /没有此候选/,
    );
    writeCredentials(f.target.home, { ...f.target.credentials, clientId: randomUUID() });
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, { log: silent }),
      /原身份|只读核验/,
    );
    writeCredentials(f.target.home, f.target.credentials);
    const other = await f.create();
    await preflightIntegration(f.target.home, other, f.ask(other), silent);
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, other, f.trial.id, noAsk, { log: silent }),
      /只读核验/,
    );
    const journal = new IntegrationTrialJournal(f.target.home);
    try {
      const r = journal.byId(f.trial.id)!;
      r.progress.state = 'interrupted';
      r.progress.materialState = 'unknown';
      r.progress.publishedAt = null;
      journal.save(r);
    } finally {
      journal.close();
    }
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, { log: silent }),
      /只读核验/,
    );
    assert.equal((await lstat(f.destination)).isDirectory(), true);
  } finally {
    await f.close();
  }
});

test('new report refuses corrupt full objects, dirty original and expired material', async (t) => {
  for (const attack of ['objects', 'original', 'expiry'] as const) {
    const f = await prepared();
    try {
      if (attack === 'objects') {
        const db = new DatabaseSync(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
        db.prepare(
          "UPDATE objects SET data=zeroblob(length(data)) WHERE bundle_id=? AND type='blob'",
        ).run(f.sr);
        db.close();
      }
      if (attack === 'original')
        await writeFile(join(f.target.root, 'README.md'), 'USER_ORIGINAL_EDIT');
      if (attack === 'expiry') {
        const expiry = Date.parse((await f.read(f.id)).operation.material.manifest.expiresAt);
        t.mock.method(Date, 'now', () => expiry + 1000);
      }
      await assert.rejects(
        shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, accept, { log: silent }),
      );
      assert.equal(localDifference(f), undefined);
    } finally {
      t.mock.restoreAll();
      await f.close();
    }
  }
});

test('edits during share confirmation are rejected after the second complete verification; frozen report remains private', async () => {
  const f = await prepared();
  try {
    await assert.rejects(
      shareIntegrationTrialDifference(
        f.target.home,
        f.id,
        f.trial.id,
        async (prompt) => {
          if (prompt.includes('SHARE_TRIAL_DIFF'))
            await writeFile(join(f.destination, 'new.txt'), 'DURING_CONFIRM');
          return accept(prompt);
        },
        { log: silent },
      ),
    );
    assert.equal(localDifference(f)!.state, 'frozen');
    const response = await f.api.call(`${f.path}/${f.id}/trials`, f.alice);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { items: [] });
    await withSettledIntegrationTrials(f.target.home, async () => {});
  } finally {
    await f.close();
  }
});

test('lost ACK persists exact authorized packet and blocks disconnect; retry after removed objects and directories only reconciles', async () => {
  const f = await prepared(),
    fetch = globalThis.fetch;
  const published: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/integration-trial-diff-publish')) {
        published.push(String(init?.body));
        if (published.length === 1) throw new Error('lost response after server commit');
        if (published.length === 2)
          return new Response(
            JSON.stringify({
              ...(await response.json()),
              hash: '0'.repeat(64),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
      }
      return response;
    };
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, accept, { log: silent }),
      /lost response/,
    );
    const pending = localDifference(f)!;
    assert.equal(pending.state, 'pending');
    await assert.rejects(
      withSettledIntegrationTrials(f.target.home, async () => {}),
      /共享回执待确认/,
    );
    const cliHome = await mkdtemp(join(f.dir, 'disconnect-home-'));
    const disconnect = spawnSync(
      process.execPath,
      [
        resolve('dist/apps/runner/src/cli.js'),
        'disconnect',
        '--local-only',
        '--state',
        f.target.home,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cliHome } },
    );
    assert.equal(disconnect.status, 1);
    assert.match(disconnect.stderr + disconnect.stdout, /INTEGRATION_TRIAL_DIFFERENCE_PENDING/);
    await readFile(join(f.target.home, 'credentials.json'));
    const db = new DatabaseSync(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
    db.prepare('DELETE FROM objects').run();
    db.close();
    await rename(f.destination, f.destination + '-moved');
    await rename(f.target.root, f.target.root + '-moved');
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, { log: silent }),
      /记录不一致/,
    );
    assert.equal(localDifference(f)!.state, 'pending');
    const receipt = await shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, {
      log: silent,
    });
    assert.equal(receipt.hash, pending.hash);
    assert.deepEqual(published, [published[0], published[0], published[0]]);
    assert.equal(localDifference(f)!.state, 'shared');
    await withSettledIntegrationTrials(f.target.home, async () => {});
  } finally {
    globalThis.fetch = fetch;
    await f.close();
  }
});

test('current revocation defeats pending ACK replay and retains packet and credentials', async () => {
  const f = await prepared(),
    fetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/integration-trial-diff-publish')) throw new Error('lost ACK');
      return response;
    };
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, accept, { log: silent }),
    );
    globalThis.fetch = fetch;
    const packet = localDifference(f)!;
    f.as(() => f.nodes.revoke(f.ns[f.target.index]!.nodeId, 1, randomUUID()));
    await assert.rejects(
      shareIntegrationTrialDifference(f.target.home, f.id, f.trial.id, noAsk, { log: silent }),
    );
    assert.deepEqual(localDifference(f), packet);
    await assert.rejects(
      withSettledIntegrationTrials(f.target.home, async () => {}),
      /待确认/,
    );
    await readFile(join(f.target.home, 'credentials.json'));
  } finally {
    globalThis.fetch = fetch;
    await f.close();
  }
});

test('full metadata and selection budgets reserve space before complete bodies; no truncation or fake Result envelope', () => {
  const time = new Date().toISOString();
  const metadata: IntegrationTrialDifferenceMetadata = {
    version: 1,
    kind: 'integration_trial_difference',
    integrationId: randomUUID(),
    trialId: randomUUID(),
    integrationInputHash: 'a'.repeat(64),
    preflightReportHash: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64),
    selection: 'apply_source',
    selectedPaths: [],
    materializedAt: time,
    comparedAt: time,
    trialOnly: true,
    applied: false,
    writeAuthorized: false,
    confirmPublication: true,
  };
  const data = Buffer.from('中'.repeat(2000)),
    id = objectHash('sha1', 'blob', data);
  const plan: IntegrationPlan = {
    baseSnapshotHash: 'a'.repeat(64),
    sourceSnapshotHash: 'b'.repeat(64),
    targetSnapshotHash: 'c'.repeat(64),
    changedFiles: 80,
    conflicts: 0,
    alreadyPresent: 0,
    omittedFiles: 0,
    files: [],
    applied: false,
    writeAuthorized: false,
  };
  for (let n = 0; n < 80; n++) {
    const path = `file-${n.toString().padStart(3, '0')}-` + 'x'.repeat(300);
    metadata.selectedPaths.push(path);
    plan.files.push({
      path,
      action: 'add',
      conflict: null,
      base: null,
      target: null,
      source: { objectId: id, mode: '100644', bytes: data.length },
    });
  }
  const packet = buildIntegrationTrialDifference(metadata, plan, new Map(), new Map([[id, data]]));
  assert.deepEqual(packet.selectedPaths, metadata.selectedPaths);
  assert.equal(packet.difference.changedFiles, 80);
  assert(packet.difference.omittedFiles >= 40);
  assert(packet.difference.files.some((f) => f.display === 'budget'));
  assert(Buffer.byteLength(JSON.stringify(packet)) <= 48 * 1024);
  assert(Buffer.byteLength(JSON.stringify(packet.difference)) <= 24 * 1024);
  for (const file of packet.difference.files.filter((f) => f.display === 'text'))
    assert.equal(file.afterText, data.toString('utf8'));
  assert(!('revisionId' in packet));
  assert.throws(
    () =>
      buildIntegrationTrialDifference(
        { ...metadata, selectedPaths: metadata.selectedPaths.map((p) => p + 'y'.repeat(700)) },
        { ...plan, files: plan.files.map((f) => ({ ...f, path: f.path + 'y'.repeat(700) })) },
        new Map(),
        new Map([[id, data]]),
      ),
    /超出/,
  );
});

test('pure candidate builder supports case and NFC rename pairs as deletion/addition across distinct sides', () => {
  const time = new Date().toISOString(),
    data = Buffer.from('fixed\n'),
    id = objectHash('sha256', 'blob', data);
  const names = ['Name.txt', 'name.txt', 'e\u0301.txt', '\u00e9.txt'].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const file = { objectId: id, mode: '100644' as const, bytes: data.length };
  const plan: IntegrationPlan = {
    baseSnapshotHash: 'a'.repeat(64),
    sourceSnapshotHash: 'b'.repeat(64),
    targetSnapshotHash: 'c'.repeat(64),
    changedFiles: 4,
    conflicts: 0,
    alreadyPresent: 0,
    omittedFiles: 0,
    files: names.map((path) => {
      const remove = path === 'Name.txt' || path === 'e\u0301.txt';
      return {
        path,
        action: remove ? 'delete' : 'add',
        conflict: null,
        base: remove ? file : null,
        source: remove ? null : file,
        target: remove ? file : null,
      };
    }),
    applied: false,
    writeAuthorized: false,
  };
  const packet = buildIntegrationTrialDifference(
    {
      version: 1,
      kind: 'integration_trial_difference',
      integrationId: randomUUID(),
      trialId: randomUUID(),
      integrationInputHash: 'a'.repeat(64),
      preflightReportHash: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64),
      selection: 'apply_source',
      selectedPaths: names,
      materializedAt: time,
      comparedAt: time,
      trialOnly: true,
      applied: false,
      writeAuthorized: false,
      confirmPublication: true,
    },
    plan,
    new Map([[id, data]]),
    new Map([[id, data]]),
  );
  assert.equal(packet.difference.files.length, 4);
});

test('real CLI requires distinct DIFF and SHARE, holds original trial guard, and stops cleanly at consent', async () => {
  const f = await prepared();
  try {
    const cli = resolve('dist/apps/runner/src/integration-trial-difference.js');
    const run = async (stop = false) => {
      const home = await mkdtemp(join(f.dir, 'cli-home-'));
      const child = spawn(
        process.execPath,
        [cli, '--operation', f.id, '--state', f.target.home, '--trial', f.trial.id],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home } },
      );
      let stdout = '',
        stderr = '',
        stopped = false,
        checkedGuard = false;
      const disconnectHome = await mkdtemp(join(f.dir, 'guard-cli-home-'));
      child.stdout.on('data', (b) => {
        stdout += b;
        if (!checkedGuard && stdout.includes('输入 DIFF_TRIAL')) {
          checkedGuard = true;
          const disconnect = spawnSync(
            process.execPath,
            [
              resolve('dist/apps/runner/src/cli.js'),
              'disconnect',
              '--local-only',
              '--state',
              f.target.home,
            ],
            { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: disconnectHome } },
          );
          assert.equal(disconnect.status, 1);
          assert.match(disconnect.stderr + disconnect.stdout, /RUNNER_ALREADY_STARTED/);
        }
        if (stop && !stopped && stdout.includes('输入 DIFF_TRIAL')) {
          stopped = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      if (!stop) child.stdin.end(`DIFF_TRIAL ${f.trial.id}\nSHARE_TRIAL_DIFF ${f.trial.id}\n`);
      try {
        const [code] = await once(child, 'exit');
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
        child.stdin.destroy();
      }
    };
    const stop = await run(true);
    assert.equal(stop.code, 1, stop.stderr);
    assert.equal(localDifference(f), undefined);
    const done = await run();
    assert.equal(done.code, 0, done.stderr);
    assert.equal((done.stdout.match(/输入 DIFF_TRIAL/g) ?? []).length, 1);
    assert.equal((done.stdout.match(/输入 SHARE_TRIAL_DIFF/g) ?? []).length, 1);
    assert.match(done.stdout, /"receivedAt"/);
    const published = await details(f);
    const listing = await f.api.call(`${f.path}/${f.id}/trials`, f.alice);
    assert.equal(listing.statusCode, 200, listing.body);
    assert.equal(listing.json().items[0].trialId, f.trial.id);
    assert.equal(published.report.trialId, f.trial.id);
    assert.deepEqual(published.report.selectedPaths, [...paths].sort());
    assert.equal(
      published.report.difference.files.find((file) => file.path === 'README.md')!.beforeText,
      'BASE\n',
    );
    assert.equal(
      published.report.difference.files.find((file) => file.path === 'README.md')!.afterText,
      'SOURCE_COMMITTED_SECRET\n',
    );
    const home = await mkdtemp(join(f.dir, 'invalid-cli-home-'));
    const bad = spawnSync(
      process.execPath,
      [cli, '--operation', f.id, '--state', f.target.home, '--target', f.destination],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /INVALID_INPUT/);
  } finally {
    await f.close();
  }
});

test('final private-trial verification waits for an unrelated short registry transaction without weakening workspace claims', async () => {
  const f = await fixture();
  let lease: WorkspaceLease | undefined;
  let blocker: ReturnType<typeof spawn> | undefined;
  let exit: Promise<unknown> | undefined;
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const unrelated = join(f.dir, 'unrelated-workspace');
    await mkdir(unrelated);
    lease = new WorkspaceLease(unrelated, 'unrelated-trial-' + randomUUID());
    const original = await tree(f.target.root);
    const registry = join(homedir(), '.hexu', 'workspace-leases', 'registry.sqlite');
    let held = false;
    const trial = await localIntegrationTrial(
      f.target.home,
      id,
      join(f.dir, 'trial-with-short-transaction'),
      ['new.txt'],
      accept,
      {
        log: silent,
        onProgress: async (progress) => {
          if (progress.state !== 'publishing' || blocker) return;
          blocker = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(${JSON.stringify(registry)});
          db.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE;');
          process.stdout.write('HELD\\n');
          setTimeout(() => { db.exec('COMMIT'); db.close(); }, 700);
        `,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { PATH: process.env.PATH, HOME: process.env.HOME },
            },
          );
          exit = once(blocker, 'exit');
          const timeout = setTimeout(() => blocker?.kill('SIGKILL'), 10000);
          try {
            const event = await Promise.race([
              once(blocker.stdout!, 'data').then(([data]) => String(data)),
              exit.then(() => 'EXITED'),
            ]);
            assert.match(event, /HELD/);
            held = true;
          } finally {
            clearTimeout(timeout);
          }
        },
      },
    );
    await exit;
    assert(held);
    assert.equal(blocker!.exitCode, 0);
    assert.equal(trial.state, 'ready', JSON.stringify(trial));
    lease.assertHeld();
    assert.deepEqual(await tree(f.target.root), original);
    assert.equal(
      await readFile(join(f.dir, 'trial-with-short-transaction/new.txt'), 'utf8'),
      'NEW_COMMITTED_SECRET\n',
    );
  } finally {
    if (blocker && blocker.exitCode === null) {
      blocker.kill('SIGKILL');
      await exit;
    }
    lease?.release();
    await f.close();
  }
});
