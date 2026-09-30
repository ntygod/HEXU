import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  readdir,
  rename,
  symlink,
  mkdir,
  lstat,
  chmod,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../apps/runner/src/agent/integration-trial.js';
import { cleanupIntegrationTrial } from '../apps/runner/src/agent/integration-trial-cleanup.js';
import {
  IntegrationTrialJournal,
  withSettledIntegrationTrials,
  integrationTrialCleanupEvidence,
} from '../apps/runner/src/agent/integration-trial-journal.js';
const silent = () => {};
const noAsk = async () => {
  throw new Error('must not ask, clean or replay');
};
async function prepared(
  format: 'sha1' | 'sha256' = 'sha1',
  state: 'staging' | 'published' | 'full' = 'staging',
) {
  const f = await integrationRunnerFixture(
    format,
    format === 'sha256',
    false,
    {},
    { targetFiles: { 'nested/target-only.txt': 'KEEP NESTED TARGET' } },
  );
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const privateParent = join(f.dir, 'trial-parent');
    await mkdir(privateParent, { mode: 0o700 });
    const destination = join(privateParent, 'private-candidate'),
      controller = new AbortController();
    const result = await localIntegrationTrial(
      f.target.home,
      id,
      destination,
      ['new.txt'],
      async () => `TRIAL ${id}`,
      {
        log: silent,
        signal: controller.signal,
        onProgress: (p) => {
          if (
            (state === 'staging' && p.completedFiles === 1 && p.intent === null) ||
            (state === 'full' && p.state === 'verified')
          )
            controller.abort();
        },
      },
    );
    assert.equal(result.materialState, state === 'published' ? 'published' : 'staging');
    const clean = (
      ask: (p: string) => Promise<string> = async () => `STOPPED_AND_CLEAN ${result.id}`,
    ) => cleanupIntegrationTrial(f.target.home, id, result.id, ask, silent);
    return { ...f, id, result, destination, stage: join(privateParent, result.stageName), clean };
  } catch (e) {
    await f.close();
    throw e;
  }
}
function record(f: Awaited<ReturnType<typeof prepared>>) {
  const j = new IntegrationTrialJournal(f.target.home);
  try {
    const value = j.byId(f.result.id)!;
    return {
      value,
      evidence: integrationTrialCleanupEvidence(value),
      entries: [...j.entries(f.result.id)],
    };
  } finally {
    j.close();
  }
}
async function original(f: Awaited<ReturnType<typeof prepared>>) {
  return Promise.all(
    ['.git/HEAD', '.git/index', 'README.md', 'target.txt'].map((p) =>
      readFile(join(f.target.root, p)),
    ),
  );
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format}仅明确清理已知未发布暂存，保留原状态/清单/目标/副本，已核对收据解开凭证处置`, async () => {
    const f = await prepared(format, format === 'sha256' ? 'full' : 'staging'),
      fetch = globalThis.fetch;
    try {
      const before = record(f),
        root = await original(f),
        view = (await f.read(f.id)).operation,
        objects = await readFile(join(f.target.home, 'retained-checkpoints/journal.sqlite'));
      await assert.rejects(
        withSettledIntegrationTrials(f.target.home, async () => {}),
        /暂存|未知/,
      );
      if (format === 'sha256')
        f.api.store.db
          .prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?")
          .run(f.target.credentials.nodeId);
      globalThis.fetch = async () => {
        throw new Error('cleanup must not request network or material');
      };
      const cleaned = await f.clean();
      assert.equal(cleaned.cleanup!.phase, 'cleaned');
      assert.equal(cleaned.state, f.result.state);
      assert.equal(cleaned.materialState, 'staging');
      await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
      await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
      const after = record(f);
      assert.equal(after.evidence, before.evidence);
      assert.deepEqual(after.entries, before.entries);
      assert.deepEqual(await original(f), root);
      assert.deepEqual(
        await readFile(join(f.target.home, 'retained-checkpoints/journal.sqlite')),
        objects,
      );
      let entered = false;
      await withSettledIntegrationTrials(f.target.home, async () => {
        entered = true;
      });
      assert(entered);
      // The old runner's predicate remains false; a downgrade cannot erase these credentials.
      assert.equal(
        after.value.progress.state === 'ready' ||
          (after.value.progress.materialState === 'none' &&
            !after.value.progress.stageIdentity &&
            !after.value.progress.intent &&
            !after.value.progress.completedFiles &&
            !after.value.progress.writtenBytes),
        false,
      );
      await mkdir(f.stage);
      await writeFile(join(f.stage, 'later-user.txt'), 'LATER USER');
      const replay = await f.clean(noAsk);
      assert.equal(replay.historical, true);
      assert.equal(await readFile(join(f.stage, 'later-user.txt'), 'utf8'), 'LATER USER');
      globalThis.fetch = fetch;
      assert.deepEqual((await f.read(f.id)).operation, view);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  });
for (const change of [
  'user-extra',
  'user-edit',
  'replace-file',
  'replace-stage',
  'replace-parent',
  'symlink',
  'mode',
  'target-exists',
  'unknown-intent',
  'unknown-publication',
] as const)
  test(`暂存清理拒绝${change}，不删除任何剩余材料或伪造成功`, async () => {
    const f = await prepared();
    try {
      const before = record(f),
        ownedFile = before.entries.find(([, e]) => e.kind === 'file')![0],
        path = join(f.stage, ownedFile);
      if (change === 'user-extra') await writeFile(join(f.stage, 'user.txt'), 'KEEP USER');
      if (change === 'user-edit') await writeFile(path, 'KEEP EDIT');
      if (change === 'replace-file') {
        const body = await readFile(path);
        await rename(path, join(f.dir, 'original-inode'));
        await writeFile(path, body);
      }
      if (change === 'replace-stage') {
        await rename(f.stage, join(f.dir, 'original-stage'));
        await mkdir(f.stage, { mode: 0o700 });
      }
      if (change === 'replace-parent') {
        await rename(dirname(f.stage), join(f.dir, 'original-parent'));
        await mkdir(dirname(f.stage), { mode: 0o700 });
        await mkdir(f.stage, { mode: 0o700 });
      }
      if (change === 'symlink') {
        await rename(path, join(f.dir, 'original-file'));
        await symlink(join(f.dir, 'original-file'), path);
      }
      if (change === 'mode') await chmod(f.stage, 0o755);
      if (change === 'target-exists') {
        await mkdir(f.destination);
        await writeFile(join(f.destination, 'user.txt'), 'KEEP TARGET');
      }
      if (change.startsWith('unknown-')) {
        const db = new DatabaseSync(join(f.target.home, 'integration-trials/journal.sqlite'));
        const p = { ...f.result };
        if (change === 'unknown-intent') p.intent = 'new.txt';
        else p.materialState = 'unknown';
        db.prepare('UPDATE trials SET progress=? WHERE target=?').run(
          JSON.stringify(p),
          f.destination,
        );
        db.close();
      }
      const names = await readdir(f.stage),
        root = await original(f);
      await assert.rejects(f.clean(), /归属|变化|占用|未发布/);
      assert.deepEqual(await readdir(f.stage), names);
      assert.deepEqual(await original(f), root);
      assert.equal(record(f).value.progress.cleanup, undefined);
      await assert.rejects(
        withSettledIntegrationTrials(f.target.home, async () => {}),
        /暂存|未知/,
      );
    } finally {
      await f.close();
    }
  });
test('已发布候选及缺失日志不进入清理或创建状态；确认拒绝及确认期间编辑保持原暂存', async () => {
  const published = await prepared('sha1', 'published');
  try {
    const bytes = await readFile(join(published.destination, 'new.txt'));
    await assert.rejects(published.clean(noAsk), /未发布/);
    assert.deepEqual(await readFile(join(published.destination, 'new.txt')), bytes);
  } finally {
    await published.close();
  }
  const f = await prepared();
  try {
    const before = record(f);
    await assert.rejects(
      f.clean(async () => 'CLEAN'),
      /未明确确认/,
    );
    assert.equal(record(f).evidence, before.evidence);
    assert.equal(record(f).value.progress.cleanup, undefined);
    await assert.rejects(
      f.clean(async () => {
        await writeFile(join(f.stage, 'during-consent.txt'), 'KEEP');
        return `STOPPED_AND_CLEAN ${f.result.id}`;
      }),
      /归属|变化/,
    );
    assert.equal(record(f).value.progress.cleanup, undefined);
    const missing = join(f.dir, 'missing-home');
    await assert.rejects(cleanupIntegrationTrial(missing, f.id, f.result.id, noAsk, silent));
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('进程守卫贯穿停止确认，阻止另一次清理与断开；最终回执保存失败保留原证据和凭证', async () => {
  const f = await prepared();
  let release = () => {};
  let cleaning: ReturnType<typeof f.clean> | undefined;
  try {
    let entered = () => {};
    const waitEntered = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    cleaning = f.clean(async () => {
      entered();
      await gate;
      return `STOPPED_AND_CLEAN ${f.result.id}`;
    });
    await waitEntered;
    await assert.rejects(f.clean(noAsk), { code: 'RUNNER_ALREADY_STARTED' });
    await assert.rejects(
      withSettledIntegrationTrials(f.target.home, async () => {}),
      { code: 'RUNNER_ALREADY_STARTED' },
    );
    const db = new DatabaseSync(join(f.target.home, 'integration-trials/journal.sqlite'));
    db.exec(
      "CREATE TRIGGER fail_cleanup_receipt BEFORE UPDATE ON trials WHEN json_extract(NEW.progress,'$.cleanup.phase')='cleaned' BEGIN SELECT RAISE(ABORT,'fixture cleanup receipt failed'); END",
    );
    db.close();
    release();
    await assert.rejects(cleaning, /fixture cleanup receipt failed/);
    assert.equal(record(f).value.progress.cleanup!.phase, 'needs_attention');
    assert.equal(record(f).entries.length, 1);
    await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
    await assert.rejects(f.clean(noAsk), /未发布/); // Absence is not a cleanup receipt.
    await assert.rejects(
      withSettledIntegrationTrials(f.target.home, async () => {}),
      /暂存|未知/,
    );
  } finally {
    release();
    await cleaning?.catch(() => {});
    await f.close();
  }
});
test('真实独立CLI明确展示范围与停止/永久删除确认；成功后原凭证可由用户另行断开', async () => {
  const f = await prepared();
  try {
    const cli = resolve('dist/apps/runner/src/integration-trial-cleanup.js'),
      env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const args = [cli, '--operation', f.id, '--trial', f.result.id, '--state', f.target.home];
    const refused = spawnSync(process.execPath, args, { input: 'NO\n', encoding: 'utf8', env });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /STOPPED_AND_CLEAN/);
    assert.match(refused.stdout, /永久删除/);
    const result = spawnSync(process.execPath, args, {
      input: `STOPPED_AND_CLEAN ${f.result.id}\n`,
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"phase":"cleaned"/);
    const invalid = spawnSync(process.execPath, [...args, '--force', 'true'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(invalid.status, 1);
    const disconnect = spawnSync(
      process.execPath,
      [
        resolve('dist/apps/runner/src/cli.js'),
        'disconnect',
        '--local-only',
        '--state',
        f.target.home,
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(disconnect.status, 0, disconnect.stderr);
    await assert.rejects(readFile(join(f.target.home, 'credentials.json')), { code: 'ENOENT' });
    await withSettledIntegrationTrials(f.target.home, async () => {});
  } finally {
    await f.close();
  }
});
