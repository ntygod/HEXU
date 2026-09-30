import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { git } from './helpers/checkpoint-retention.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
const silent = () => {};
const noAsk = async () => {
  throw new Error('replay must not read or reconfirm');
};
type Fixture = Awaited<ReturnType<typeof integrationRunnerFixture>>;
async function newTarget(f: Fixture) {
  await writeFile(join(f.target.root, 'target.txt'), 'EXPLICIT NEW TARGET\n');
  await writeFile(join(f.target.root, 'later.txt'), 'LATER TARGET ONLY\n');
  git(f.target.root, 'add', '.');
  git(
    f.target.root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'explicit fixture new target',
  );
  const commit = git(f.target.root, 'rev-parse', 'HEAD'),
    cp = await f.checkpoint(f.target, commit),
    retention = await f.retain(f.target, cp, commit);
  return { commit, cp, retention };
}
async function recompute(
  f: Fixture,
  original: IntegrationView,
  newer: Awaited<ReturnType<typeof newTarget>>,
) {
  const r = await f.api.call(`${f.path}/${original.operation.id}/recompute`, f.alice, {
    expectedRevision: original.operation.revision,
    expectedTaskRevision: original.taskRevision,
    reportHash: original.reportHash,
    targetCheckpointId: newer.cp,
    targetRetentionId: newer.retention,
    sourceMaterial: { kind: original.operation.material.kind, id: original.operation.material.id },
    confirmPreflight: true,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as IntegrationView;
}
async function bytes(f: Fixture) {
  return Promise.all(
    ['.git/HEAD', '.git/index', 'README.md', 'target.txt', 'later.txt'].map((p) =>
      readFile(join(f.target.root, p)),
    ),
  );
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format}固定原成果和新目标真实Git只读重算，不改旧报告/HEAD/index或目标独有文件`, async () => {
    const f = await integrationRunnerFixture(format, format === 'sha256');
    try {
      const id = await f.create();
      await preflightIntegration(f.target.home, id, f.ask(id), silent);
      const original = await f.read(id),
        newer = await newTarget(f),
        snapshot = await bytes(f),
        queued = await recompute(f, original, newer);
      assert.deepEqual(queued.operation.source, original.operation.source);
      assert.equal(queued.operation.recomputedFrom, id);
      assert.equal(queued.operation.application, null);
      await preflightIntegration(
        f.target.home,
        queued.operation.id,
        f.ask(queued.operation.id),
        silent,
      );
      const next = await f.read(queued.operation.id);
      assert.equal(next.operation.state, 'awaiting_choice');
      assert.equal(next.operation.target.manifest.commit, newer.commit);
      assert.equal(next.operation.report!.plan!.changedFiles, 2);
      assert(
        !next.operation.report!.plan!.files.some(
          (x) => x.path === 'later.txt' || x.path === 'target.txt',
        ),
      );
      assert.deepEqual(await bytes(f), snapshot);
      assert.deepEqual((await f.read(id)).operation, original.operation);
      await preflightIntegration(f.target.home, queued.operation.id, noAsk, silent);
      assert.deepEqual(await bytes(f), snapshot);
    } finally {
      await f.close();
    }
  });
test('新记录不越过脏/忽略文件、后来工作区锁或替换Git目录，保留原新两条历史', async () => {
  const f = await integrationRunnerFixture();
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const original = await f.read(id),
      newer = await newTarget(f),
      queued = await recompute(f, original, newer),
      nextId = queued.operation.id;
    const lease = new WorkspaceLease(f.target.root, 'later-writer-' + randomUUID());
    try {
      await assert.rejects(
        preflightIntegration(f.target.home, nextId, f.ask(nextId), silent),
        /占用|未知/,
      );
    } finally {
      lease.release();
    }
    assert.equal((await f.read(nextId)).operation.report, null);
    // Retain old Git inode, then place a different directory at the same name.
    await rename(join(f.target.root, '.git'), join(f.target.root, '.git-original'));
    await mkdir(join(f.target.root, '.git'));
    try {
      await preflightIntegration(f.target.home, nextId, f.ask(nextId), silent);
      const blocked = await f.read(nextId);
      assert.equal(blocked.operation.state, 'failed');
      assert.equal(blocked.operation.report!.plan, null);
      assert(blocked.operation.report!.reason);
    } finally {
      await rename(join(f.target.root, '.git'), join(f.dir, 'unrecognized-git'));
      await rename(join(f.target.root, '.git-original'), join(f.target.root, '.git'));
    }
    await mkdir(join(f.target.root, 'ignored'));
    await writeFile(join(f.target.root, 'ignored', 'private.txt'), 'USER EXTRA');
    const snapshot = await bytes(f),
      another = await recompute(f, original, newer);
    await preflightIntegration(
      f.target.home,
      another.operation.id,
      f.ask(another.operation.id),
      silent,
    );
    assert.equal((await f.read(another.operation.id)).operation.report!.reason, 'target_changed');
    assert.equal(
      await readFile(join(f.target.root, 'ignored', 'private.txt'), 'utf8'),
      'USER EXTRA',
    );
    assert.deepEqual(await bytes(f), snapshot);
    assert.deepEqual((await f.read(id)).operation, original.operation);
  } finally {
    await f.close();
  }
});
test('原丢ACK包不得改投新目标，先只对账原包再明确执行新只读预检', async () => {
  const f = await integrationRunnerFixture(),
    realFetch = globalThis.fetch;
  try {
    const id = await f.create();
    let lost = true;
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (lost && String(input).endsWith('/integration-publish')) {
        lost = false;
        await response.text();
        throw new TypeError('lost old acknowledgement');
      }
      return response;
    };
    await assert.rejects(
      preflightIntegration(f.target.home, id, f.ask(id), silent),
      /lost old acknowledgement/,
    );
    const original = await f.read(id),
      newer = await newTarget(f),
      queued = await recompute(f, original, newer),
      snapshot = await bytes(f);
    await assert.rejects(
      preflightIntegration(f.target.home, queued.operation.id, noAsk, silent),
      /原预检回执|待发包/,
    );
    assert.equal((await f.read(queued.operation.id)).operation.report, null);
    await preflightIntegration(f.target.home, id, noAsk, silent);
    assert.deepEqual((await f.read(id)).operation, original.operation);
    await preflightIntegration(
      f.target.home,
      queued.operation.id,
      f.ask(queued.operation.id),
      silent,
    );
    assert.equal((await f.read(queued.operation.id)).operation.state, 'awaiting_choice');
    assert.deepEqual(await bytes(f), snapshot);
  } finally {
    globalThis.fetch = realFetch;
    await f.close();
  }
});
