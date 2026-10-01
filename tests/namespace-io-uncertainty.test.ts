import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparedExistingApplication, selection } from './helpers/integration-existing-runner.js';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { namespaceErrorRuntime } from './helpers/namespace-error-runtime.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { applyIntegration } from '../apps/runner/src/agent/integration-application.js';
import { parseLocalApplicationRecord } from '../apps/runner/src/agent/integration-application-record.js';
import { IntegrationTrialJournal } from '../apps/runner/src/agent/integration-trial-journal.js';
import { cleanupIntegrationTrial } from '../apps/runner/src/agent/integration-trial-cleanup.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';

const linux = { skip: process.platform !== 'linux' };
const silent = () => {};
const noAsk = async () => {
  throw new Error('must not authorize another filesystem action');
};
function applicationBody(home: string, id: string): string {
  const db = new DatabaseSync(join(home, 'integration-application', 'journal.sqlite'), {
    readOnly: true,
  });
  try {
    return db.prepare('SELECT body FROM applications WHERE id=?').get(id)!.body as string;
  } finally {
    db.close();
  }
}

// These are controlled errno models, not claims of a naturally reproduced
// hardware failure. The after model performs a real rename before returning EIO.
for (const [error, after] of [
  ['EIO', false],
  ['EIO', true],
  ['EEXIST', false],
] as const) {
  test(
    `移出文件${error}/${after ? 'rename后' : 'rename前'}保留准确意图，独立CLI重启不重放`,
    linux,
    async () => {
      const f = await preparedExistingApplication();
      try {
        const runtime = await namespaceErrorRuntime(f.dir, 'integration-change', after, error);
        const original = await lstat(join(f.target.root, 'delete.txt'));
        const args = ['--operation', f.id, '--state', f.target.home, '--backup', f.backup];
        const result = await runtime.run(
          'integration-application.js',
          args,
          `STOPPED_AND_APPLY ${f.application.id}\n`,
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(result.signal, null);
        const body = applicationBody(f.target.home, f.id);
        const record = parseLocalApplicationRecord(body, f.id);
        assert.equal(record.phase, 'needs_attention');
        assert.equal(record.acknowledged, 2);
        assert.equal(record.pending, null);
        assert.equal(record.intent, error === 'EIO' ? 'delete.txt' : null);
        assert.equal(
          record.existingChanges!.intent?.before.path ?? null,
          error === 'EIO' ? 'delete.txt' : null,
        );
        assert.throws(() => new WorkspaceLease(f.target.root, 'unrelated-writer'), /受管执行/);
        if (after) {
          await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
          const saved = join(f.backup, record.existingChanges!.intent!.backupName);
          assert.equal((await lstat(saved)).ino, original.ino);
          assert.equal(await readFile(saved, 'utf8'), 'ORIGINAL DELETE\n');
        } else {
          assert.equal((await lstat(join(f.target.root, 'delete.txt'))).ino, original.ino);
          assert.equal(
            await readFile(join(f.target.root, 'delete.txt'), 'utf8'),
            'ORIGINAL DELETE\n',
          );
        }
        const names = await readdir(f.backup);
        await writeFile(join(f.target.root, 'later-user-file'), 'KEEP LATER USER WORK');
        const repeated = await runtime.run('integration-application.js', args);
        assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
        assert.doesNotMatch(repeated.stdout, /输入 STOPPED_AND_APPLY/);
        assert.equal(applicationBody(f.target.home, f.id), body);
        assert.deepEqual(await readdir(f.backup), names);
        assert.equal(
          await readFile(join(f.target.root, 'later-user-file'), 'utf8'),
          'KEEP LATER USER WORK',
        );
        assert.throws(() => new WorkspaceLease(f.target.root, 'still-unrelated'), /受管执行/);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `私有候选发布${error}/${after ? 'rename后' : 'rename前'}日志区分未知与拒绝，重启不重写`,
    linux,
    async () => {
      const f = await integrationRunnerFixture();
      try {
        const id = await f.create();
        await preflightIntegration(f.target.home, id, f.ask(id), silent);
        const runtime = await namespaceErrorRuntime(f.dir, 'restore-publish', after, error);
        const target = join(f.dir, 'private-candidate');
        const args = [
          '--operation',
          id,
          '--state',
          f.target.home,
          '--target',
          target,
          '--files',
          '["new.txt"]',
        ];
        const result = await runtime.run('integration-trial.js', args, `TRIAL ${id}\n`);
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.equal(result.signal, null);
        const read = () => {
          const journal = new IntegrationTrialJournal(f.target.home);
          try {
            return journal.row(target)!;
          } finally {
            journal.close();
          }
        };
        const record = read(),
          p = record.progress;
        assert.equal(p.state, error === 'EIO' ? 'interrupted' : 'failed');
        assert.equal(p.materialState, error === 'EIO' ? 'unknown' : 'staging');
        assert.equal(
          p.errorCode,
          error === 'EIO' ? 'INTEGRATION_TRIAL_PUBLICATION_UNKNOWN' : 'RESTORE_PUBLISH_REFUSED',
        );
        assert.equal(p.publishedAt, null);
        const material = after ? target : join(f.dir, p.stageName);
        const inode = (await lstat(material)).ino;
        assert.equal(await readFile(join(material, 'new.txt'), 'utf8'), 'NEW_COMMITTED_SECRET\n');
        await assert.rejects(lstat(after ? join(f.dir, p.stageName) : target), { code: 'ENOENT' });
        if (error === 'EIO') {
          await assert.rejects(
            cleanupIntegrationTrial(f.target.home, id, p.id, noAsk, silent),
            /仅可清理/,
          );
          assert.doesNotMatch(result.stdout, /仅已知未发布暂存可另行核对/);
        }
        await writeFile(join(material, 'later-user-file'), 'KEEP LATER CANDIDATE WORK');
        const repeated = await runtime.run('integration-trial.js', args);
        assert.equal(repeated.code, 1, repeated.stdout + repeated.stderr);
        assert.doesNotMatch(repeated.stdout, /输入 TRIAL/);
        assert.deepEqual(read(), record);
        assert.equal((await lstat(material)).ino, inode);
        assert.equal(
          await readFile(join(material, 'later-user-file'), 'utf8'),
          'KEEP LATER CANDIDATE WORK',
        );
      } finally {
        await f.close();
      }
    },
  );
}

test('原应用文件恢复遇移出后EIO仍保留恢复意图、原备份与独立写锁，不重放恢复', linux, async () => {
  const f = await preparedExistingApplication();
  let restorationId: string | undefined;
  try {
    assert.equal(
      (
        await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
          backup: f.backup,
        })
      ).state,
      'completed',
    );
    const view = await f.read(f.id);
    const response = await f.api.call(`${f.path}/${f.id}/restore`, f.alice, {
      applicationId: f.application.id,
      applicationInputHash: f.application.inputHash,
      completedReportHash: view.completedReportHash,
      paths: selection,
      expectedRevision: view.operation.revision,
      expectedTaskRevision: view.taskRevision,
      confirmFileRestoration: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    restorationId = (response.json() as IntegrationView).restoration!.id;
    const originalBody = applicationBody(f.target.home, f.id);
    const originalBackup = await readdir(f.backup);
    const runtime = await namespaceErrorRuntime(f.dir, 'integration-change', true);
    const backup = join(f.dir, 'restore-current-backup');
    const args = [
      '--operation',
      f.id,
      '--restoration',
      restorationId,
      '--state',
      f.target.home,
      '--backup',
      backup,
    ];
    const result = await runtime.run(
      'integration-file-restoration.js',
      args,
      `STOPPED_AND_RESTORE ${restorationId}\n`,
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const key = `restoration:${restorationId}`,
      body = applicationBody(f.target.home, key);
    const record = JSON.parse(body);
    assert.equal(record.phase, 'needs_attention');
    assert.equal(record.intent, 'new-module/nested.txt');
    assert.equal(record.existingChanges.intent.before.path, record.intent);
    assert.equal(
      await readFile(join(backup, record.existingChanges.intent.backupName), 'utf8'),
      'NESTED\n',
    );
    await assert.rejects(lstat(join(f.target.root, record.intent)), { code: 'ENOENT' });
    assert.throws(() => new WorkspaceLease(f.target.root, 'restoration-unrelated'), /受管执行/);
    assert.equal(applicationBody(f.target.home, f.id), originalBody);
    assert.deepEqual(await readdir(f.backup), originalBackup);
    await writeFile(join(f.target.root, record.intent), 'LATER USER REPLACEMENT');
    const repeated = await runtime.run('integration-file-restoration.js', args);
    assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
    assert.doesNotMatch(repeated.stdout, /输入 STOPPED_AND_RESTORE/);
    assert.equal(applicationBody(f.target.home, key), body);
    assert.equal(
      await readFile(join(f.target.root, record.intent), 'utf8'),
      'LATER USER REPLACEMENT',
    );
  } finally {
    if (restorationId) {
      try {
        new WorkspaceLease(f.target.root, `integration:${restorationId}`, true).release();
      } catch {
        /* release only this disposable fixture's claim */
      }
    }
    await f.close();
  }
});
