import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../apps/runner/src/agent/integration-trial.js';
import { shareIntegrationTrialDifference } from '../apps/runner/src/agent/integration-trial-difference.js';
import {
  applyIntegration,
  withSettledIntegrationEvidence,
} from '../apps/runner/src/agent/integration-application.js';
import { readIntegrationApplicationStatus } from '../apps/runner/src/agent/integration-application-status.js';
import { IntegrationApplicationBackup } from '../apps/runner/src/agent/integration-application-backup.js';
import { recoverIntegration } from '../apps/runner/src/agent/integration-recovery.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
const silent = () => {};
const noAsk = async () => {
  throw new Error('must not replay or request new write consent');
};
const linux = { skip: process.platform !== 'linux' };
import {
  preparedExistingApplication as prepared,
  selection,
} from './helpers/integration-existing-runner.js';
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 固定候选明确写回增改删，私有原文件备份与候选/HEAD/index保持`, linux, async () => {
    const f = await prepared(format);
    try {
      const originals = new Map(
        await Promise.all(
          ['README.md', 'delete.txt', '.git/HEAD', '.git/index', 'target.txt'].map(
            async (name) =>
              [
                name,
                {
                  bytes: await readFile(join(f.target.root, name)),
                  inode: (await lstat(join(f.target.root, name))).ino,
                },
              ] as const,
          ),
        ),
      );
      const candidate = await readFile(join(f.destination, 'README.md'));
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
        backup: f.backup,
      });
      assert.equal(result.state, 'completed', JSON.stringify(result));
      assert.deepEqual(result.appliedPaths, [...selection].sort());
      assert.equal(
        await readFile(join(f.target.root, 'README.md'), 'utf8'),
        'SOURCE_COMMITTED_SECRET\n',
      );
      assert.equal(
        await readFile(join(f.target.root, 'new-module/nested.txt'), 'utf8'),
        'NESTED\n',
      );
      await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(f.target.root, 'unselected.txt')), { code: 'ENOENT' });
      for (const name of ['.git/HEAD', '.git/index', 'target.txt'])
        assert.deepEqual(await readFile(join(f.target.root, name)), originals.get(name)!.bytes);
      assert.deepEqual(await readFile(join(f.destination, 'README.md')), candidate);
      const status = readIntegrationApplicationStatus(f.target.home, f.id);
      assert.equal(status.localPhase, 'completed');
      assert.equal(status.existingChanges!.confirmed.length, 2);
      assert.equal(status.existingChanges!.intended, null);
      assert.equal((await lstat(f.backup)).mode & 0o777, 0o700);
      assert.equal((await readdir(f.backup)).length, 2);
      for (const change of status.existingChanges!.confirmed) {
        const path = join(f.backup, change.backupName);
        assert.deepEqual(await readFile(path), originals.get(change.before.path)!.bytes);
        assert.equal((await lstat(path)).ino, originals.get(change.before.path)!.inode);
      }
      assert.equal(
        await withSettledIntegrationEvidence(f.target.home, async () => 'settled'),
        'settled',
      );
      // After completion, removed materials or edited target cannot trigger write replay.
      await writeFile(join(f.target.root, 'README.md'), 'USER AFTER SUCCESS\n');
      await rename(f.destination, f.destination + '-moved');
      const repeated = await applyIntegration(f.target.home, f.id, noAsk, silent);
      assert.deepEqual(repeated, result);
      assert.equal(
        await readFile(join(f.target.root, 'README.md'), 'utf8'),
        'USER AFTER SUCCESS\n',
      );
      assert.equal((await f.read(f.id)).operation.state, 'completed');
    } finally {
      await f.close();
    }
  });

test('写回缺少独立备份/停止确认、重叠目录或已改候选/目标时不开始原文件写入', linux, async () => {
  const f = await prepared();
  try {
    const before = await readFile(join(f.target.root, 'README.md'));
    await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent), /--backup/);
    await assert.rejects(
      applyIntegration(
        f.target.home,
        f.id,
        async () => `APPLY ${f.application.id}`,
        silent,
        undefined,
        { backup: f.backup },
      ),
      /未确认/,
    );
    for (const backup of [
      join(f.target.root, 'backup'),
      join(f.target.home, 'backup'),
      join(f.destination, 'backup'),
      f.dir,
    ])
      await assert.rejects(
        applyIntegration(f.target.home, f.id, f.consent, silent, undefined, { backup }),
      );
    await writeFile(join(f.destination, 'README.md'), 'USER CANDIDATE EDIT');
    await assert.rejects(
      applyIntegration(f.target.home, f.id, f.consent, silent, undefined, { backup: f.backup }),
    );
    assert.deepEqual(await readFile(join(f.target.root, 'README.md')), before);
    await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
    assert.equal((await f.read(f.id)).operation.state, 'queued');
  } finally {
    await f.close();
  }
});

test(
  '只完成第一处替换后中断保留备份/未写目标和锁，重启只对账，明确停止后保留结算',
  linux,
  async () => {
    const f = await prepared();
    const controller = new AbortController(),
      original = IntegrationApplicationBackup.prototype.verify;
    try {
      IntegrationApplicationBackup.prototype.verify = function () {
        original.call(this);
        if (this.evidence.changes.length === 1) controller.abort();
      };
      const result = await applyIntegration(
        f.target.home,
        f.id,
        f.consent,
        silent,
        controller.signal,
        { backup: f.backup },
      );
      assert.equal(result.state, 'needs_attention');
      const status = readIntegrationApplicationStatus(f.target.home, f.id);
      assert.equal(status.existingChanges!.confirmed.length, 1);
      assert.equal(
        await readFile(join(f.target.root, 'README.md'), 'utf8'),
        'SOURCE_COMMITTED_SECRET\n',
      );
      assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'ORIGINAL DELETE\n');
      assert.equal((await readdir(f.backup)).length, 1);
      assert.throws(() => new WorkspaceLease(f.target.root, 'unrelated-writer'), /受管执行/);
      await assert.rejects(
        withSettledIntegrationEvidence(f.target.home, async () => 'must not unlock'),
        /未确认|未知|写入/,
      );
      IntegrationApplicationBackup.prototype.verify = original;
      assert.deepEqual(await applyIntegration(f.target.home, f.id, noAsk, silent), result);
      await writeFile(join(f.target.root, 'user-after-interruption'), 'KEEP');
      const observation = await recoverIntegration(
        f.target.home,
        f.id,
        async () => `STOPPED ${f.application.id}`,
        silent,
      );
      assert(observation);
      assert.equal(await readFile(join(f.target.root, 'user-after-interruption'), 'utf8'), 'KEEP');
      assert.equal((await readdir(f.backup)).length, 1);
      new WorkspaceLease(f.target.root, 'after-preserve-settlement').release();
      assert.equal((await f.read(f.id)).operation.state, 'needs_attention');
      assert.deepEqual(await applyIntegration(f.target.home, f.id, noAsk, silent), result);
    } finally {
      IntegrationApplicationBackup.prototype.verify = original;
      await f.close();
    }
  },
);

test('已保存原文件备份被用户编辑时后续写回停止，不覆盖备份或后续目标', linux, async () => {
  const f = await prepared();
  const original = IntegrationApplicationBackup.prototype.verify;
  let changed = false;
  try {
    const { writeFileSync } = await import('node:fs');
    IntegrationApplicationBackup.prototype.verify = function () {
      if (!changed && this.evidence.changes.length === 1) {
        changed = true;
        writeFileSync(
          join(this.evidence.backup.path, this.evidence.changes[0]!.backupName),
          'USER BACKUP EDIT',
        );
      }
      original.call(this);
    };
    const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
      backup: f.backup,
    });
    assert.equal(result.state, 'needs_attention');
    assert(changed);
    const status = readIntegrationApplicationStatus(f.target.home, f.id);
    assert.equal(status.existingChanges!.confirmed.length, 1);
    assert.equal(
      await readFile(join(f.backup, status.existingChanges!.confirmed[0]!.backupName), 'utf8'),
      'USER BACKUP EDIT',
    );
    assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'ORIGINAL DELETE\n');
    assert.throws(() => new WorkspaceLease(f.target.root, 'unrelated'), /受管执行/);
  } finally {
    IntegrationApplicationBackup.prototype.verify = original;
    await f.close();
  }
});

test('真实CLI在首个替换后等待下一次权限检查时退出，重启只对账且原备份不重写', linux, async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  let active = false;
  let reached = () => {},
    release = () => {},
    held = false;
  const barrier = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f: Awaited<ReturnType<typeof prepared>> = await prepared('sha1', async (url) => {
    if (!active || held || url !== '/runner/v1/integration-inspect') return;
    try {
      if (
        readIntegrationApplicationStatus(f.target.home, f.id).existingChanges?.confirmed.length !==
        1
      )
        return;
    } catch {
      return;
    }
    held = true;
    reached();
    await gate;
  });
  active = true;
  const child = spawn(
    process.execPath,
    [
      resolve('dist/apps/runner/src/integration-application.js'),
      '--operation',
      f.id,
      '--state',
      f.target.home,
      '--backup',
      f.backup,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exited = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.end(`STOPPED_AND_APPLY ${f.application.id}\n`);
    await Promise.race([
      barrier,
      exited.then(() => {
        throw new Error(`child exited before barrier: ${output}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`barrier timeout: ${output}`)), 15000);
      }),
    ]);
    assert(held);
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    release();
    assert.equal(readIntegrationApplicationStatus(f.target.home, f.id).localPhase, 'applying');
    const before = await Promise.all(
      (await readdir(f.backup)).map(async (name) => [name, await readFile(join(f.backup, name))]),
    );
    const result = await applyIntegration(f.target.home, f.id, noAsk, silent);
    assert.equal(result.state, 'needs_attention');
    assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'ORIGINAL DELETE\n');
    assert.deepEqual(
      await Promise.all(
        (await readdir(f.backup)).map(async (name) => [name, await readFile(join(f.backup, name))]),
      ),
      before,
    );
    assert.throws(() => new WorkspaceLease(f.target.root, 'new-process'), /受管执行/);
    await recoverIntegration(
      f.target.home,
      f.id,
      async () => `STOPPED ${f.application.id}`,
      silent,
    );
    new WorkspaceLease(f.target.root, 'after-child-settlement').release();
  } finally {
    if (timer) clearTimeout(timer);
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await f.close();
  }
});

test('第一处写回后撤销原目标授权阻止下一文件；保留未确认报告/备份和原锁', linux, async () => {
  let active = false,
    revoked = false;
  const f: Awaited<ReturnType<typeof prepared>> = await prepared('sha1', async (url) => {
    if (!active || revoked || url !== '/runner/v1/integration-inspect') return;
    try {
      if (
        readIntegrationApplicationStatus(f.target.home, f.id).existingChanges?.confirmed.length !==
        1
      )
        return;
    } catch {
      return;
    }
    revoked = true;
    f.api.store.db
      .prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?")
      .run(f.ns[f.target.index]!.nodeId);
  });
  active = true;
  try {
    await assert.rejects(
      applyIntegration(f.target.home, f.id, f.consent, silent, undefined, { backup: f.backup }),
    );
    assert(revoked);
    const status = readIntegrationApplicationStatus(f.target.home, f.id);
    assert.equal(status.localPhase, 'needs_attention');
    assert.equal(status.pendingReportSequence, 2);
    assert.equal(status.existingChanges!.confirmed.length, 1);
    assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'ORIGINAL DELETE\n');
    assert.equal((await readdir(f.backup)).length, 1);
    assert.throws(() => new WorkspaceLease(f.target.root, 'after-revocation'), /受管执行/);
  } finally {
    await f.close();
  }
});

test('仅创建备份目录就停止时0文件仍保留原锁与目录，明确结算不清理', linux, async () => {
  const f = await prepared(),
    controller = new AbortController();
  const original = IntegrationApplicationBackup.prototype.create;
  try {
    IntegrationApplicationBackup.prototype.create = function (...args) {
      original.apply(this, args);
      controller.abort();
    };
    const before = await readFile(join(f.target.root, 'README.md'));
    const result = await applyIntegration(
      f.target.home,
      f.id,
      f.consent,
      silent,
      controller.signal,
      { backup: f.backup },
    );
    assert.equal(result.state, 'needs_attention');
    assert.deepEqual(result.appliedPaths, []);
    const status = readIntegrationApplicationStatus(f.target.home, f.id);
    assert.equal(status.existingChanges!.confirmed.length, 0);
    assert(status.existingChanges!.backupIdentity);
    assert.deepEqual(await readdir(f.backup), []);
    assert.deepEqual(await readFile(join(f.target.root, 'README.md')), before);
    assert.throws(() => new WorkspaceLease(f.target.root, 'zero-file-writer'), /受管执行/);
    await recoverIntegration(
      f.target.home,
      f.id,
      async () => `STOPPED ${f.application.id}`,
      silent,
    );
    assert.deepEqual(await readdir(f.backup), []);
    new WorkspaceLease(f.target.root, 'after-zero-file-settlement').release();
  } finally {
    IntegrationApplicationBackup.prototype.create = original;
    await f.close();
  }
});

test(
  '严格写回日志拒绝备份路径/归属/字段/选区错配，不能把留存材料伪装无写入失败',
  linux,
  async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { parseLocalApplicationRecord } = await import(
      '../apps/runner/src/agent/integration-application-record.js'
    );
    const f = await prepared();
    try {
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
        backup: f.backup,
      });
      assert.equal(result.state, 'completed');
      const db = new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'), {
        readOnly: true,
      });
      let body: string;
      try {
        body = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id)!.body as string;
      } finally {
        db.close();
      }
      const valid = parseLocalApplicationRecord(body!, f.id);
      for (const mutate of [
        (r: typeof valid) => {
          delete r.existingChanges;
        },
        (r: typeof valid) => {
          r.existingChanges!.backup.path = join(f.target.root, 'private-backup');
        },
        (r: typeof valid) => {
          r.existingChanges!.backup.parents[0]!.identity = 'invalid';
        },
        (r: typeof valid) => {
          r.existingChanges!.backupIdentity = '1:2:3';
        },
        (r: typeof valid) => {
          r.existingChanges!.changes[0]!.backupIdentity = '1:2';
        },
        (r: typeof valid) => {
          r.existingChanges!.changes[0]!.before.path = 'unselected.txt';
        },
        (r: typeof valid) => {
          r.existingChanges!.changes[1]!.backupName = r.existingChanges!.changes[0]!.backupName;
        },
        (r: typeof valid) => {
          r.existingChanges!.changes[0]!.before.gitMode = '40000';
        },
        (r: typeof valid) => {
          r.existingChanges!.changes[0]!.targetIdentity = null;
        },
        (r: typeof valid) => {
          r.phase = 'failed';
          r.added = [];
          r.directories = [];
        },
        (r: typeof valid) => {
          (r.existingChanges as unknown as Record<string, unknown>).extra = true;
        },
      ]) {
        const r = structuredClone(valid);
        mutate(r);
        assert.throws(() => parseLocalApplicationRecord(JSON.stringify(r), f.id));
      }
      assert.deepEqual(parseLocalApplicationRecord(body!, f.id), valid);
    } finally {
      await f.close();
    }
  },
);

for (const place of ['target', 'backup'] as const)
  test(`最后核验备份期间${place}出现用户改动，发布前短检查阻止第一次目标写入`, linux, async () => {
    const { writeFileSync } = await import('node:fs');
    const f = await prepared();
    const original = IntegrationApplicationBackup.prototype.verify;
    let changed = false;
    try {
      IntegrationApplicationBackup.prototype.verify = function () {
        original.call(this);
        if (!changed) {
          changed = true;
          writeFileSync(
            place === 'target' ? join(f.target.root, 'README.md') : join(f.backup, 'user-file'),
            'USER DURING FINAL READ',
          );
        }
      };
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
        backup: f.backup,
      });
      assert(changed);
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.appliedPaths, []);
      const status = readIntegrationApplicationStatus(f.target.home, f.id);
      assert.equal(status.confirmedCreatedDirectories.length, 0);
      assert.equal(status.existingChanges!.confirmed.length, 0);
      assert.equal(
        await readFile(
          place === 'target' ? join(f.target.root, 'README.md') : join(f.backup, 'user-file'),
          'utf8',
        ),
        'USER DURING FINAL READ',
      );
      await assert.rejects(lstat(join(f.target.root, 'new.txt')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(f.target.root, 'new-module')), { code: 'ENOENT' });
    } finally {
      IntegrationApplicationBackup.prototype.verify = original;
      await f.close();
    }
  });
