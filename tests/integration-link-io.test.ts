import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type SpawnSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
import { checkIntegrationAddHelper } from '../apps/runner/src/agent/integration-add-files.js';
import { checkIntegrationChangeHelper } from '../apps/runner/src/agent/integration-change-files.js';
import { applyIntegration } from '../apps/runner/src/agent/integration-application.js';
import { restoreIntegrationFiles } from '../apps/runner/src/agent/integration-file-restoration.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preparedExistingApplication, selection } from './helpers/integration-existing-runner.js';

const linux = { skip: process.platform !== 'linux' };
const silent = () => {};
const noAsk = async () => {
  throw new Error('unknown I/O must never repeat consent or writes');
};
const nativeHelper = (kind: 'add' | 'change') =>
  fileURLToPath(new URL(`../apps/runner/src/native/integration-${kind}`, import.meta.url));
const faultSource = fileURLToPath(
  new URL('../../tests/fixtures/integration-link-io.c', import.meta.url),
);

async function withFault(
  kind: 'add' | 'change',
  fault: 'before' | 'after' | 'occupied' | 'none',
  body: (calls: { status: number | null; stdout: string }[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-disposable-link-io-'));
  const library = join(dir, 'link-io.so');
  const realSpawnSync = childProcess.spawnSync;
  const built = realSpawnSync(
    'cc',
    ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', faultSource, '-o', library, '-ldl'],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  const calls: { status: number | null; stdout: string }[] = [];
  // The production modules/helper stay unchanged. Route only this exact helper
  // call to a real syscall fixture, never fabricate a result or filesystem state.
  const routed = mock.method(childProcess, 'spawnSync', ((
    command: string,
    args: readonly string[] = [],
    options: SpawnSyncOptions = {},
  ) => {
    if (command !== nativeHelper(kind) || args[0] === '--version')
      return realSpawnSync(command, args, options);
    const result = realSpawnSync(command, args, {
      ...options,
      env: {
        ...options.env,
        LD_PRELOAD: library,
        HEXU_DISPOSABLE_LINK_IO: fault,
      },
    });
    calls.push({ status: result.status, stdout: String(result.stdout) });
    return result;
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    await body(calls);
  } finally {
    routed.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
}
function journal(home: string, id: string) {
  const db = new DatabaseSync(join(home, 'integration-application/journal.sqlite'), {
    readOnly: true,
  });
  try {
    const row = db.prepare('SELECT body FROM applications WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    assert(row, `missing durable evidence ${id}`);
    return {
      raw: row.body,
      value: JSON.parse(row.body) as {
        phase: string;
        intent: string | null;
        added: { path: string }[];
        existingChanges?: {
          intent: { before: { path: string }; backupName: string } | null;
          changes: unknown[];
        };
      },
    };
  } finally {
    db.close();
  }
}
function assertLocked(root: string) {
  assert.throws(() => new WorkspaceLease(root, 'disposable-lock-probe'), /受管执行/);
}
function releaseFixture(root: string, claimId: string) {
  // Disposable fixture cleanup after every retention assertion; no real process.
  try {
    new WorkspaceLease(root, `integration:${claimId}`, true).release();
  } catch {}
}
async function preparedAddition() {
  const f = await integrationRunnerFixture();
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const view = await f.read(id);
    const response = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
      expectedRevision: view.operation.revision,
      expectedTaskRevision: view.taskRevision,
      reportHash: view.reportHash,
      paths: ['new.txt'],
      confirmApplication: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    const selected = response.json() as IntegrationView;
    const claimId = selected.operation.application!.id;
    return { ...f, id, claimId, consent: async () => `APPLY ${claimId}` };
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function preparedRestoration() {
  const f = await preparedExistingApplication();
  try {
    const applied = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
      backup: f.backup,
    });
    assert.equal(applied.state, 'completed');
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
    const restoration = (response.json() as IntegrationView).restoration!;
    const backup = join(f.dir, 'restore-link-io-backup');
    return {
      ...f,
      restoration,
      restoreBackup: backup,
      restore: (ask = async () => `STOPPED_AND_RESTORE ${restoration.id}`) =>
        restoreIntegrationFiles(f.target.home, f.id, restoration.id, ask, silent, undefined, {
          backup,
        }),
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

for (const fault of ['before', 'after'] as const)
  test(`首个顶层新增linkat ${fault} EIO保留精确意图和原锁，重启不重写`, linux, async () => {
    const f = await preparedAddition();
    try {
      await withFault('add', fault, async (calls) => {
        const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
        assert.equal(result.state, 'needs_attention');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.status, 21);
        const evidence = journal(f.target.home, f.id);
        assert.equal(evidence.value.phase, 'needs_attention');
        assert.equal(evidence.value.intent, 'new.txt');
        assert.deepEqual(evidence.value.added, []);
        if (fault === 'after')
          assert.equal(
            await readFile(join(f.target.root, 'new.txt'), 'utf8'),
            'NEW_COMMITTED_SECRET\n',
          );
        else await assert.rejects(lstat(join(f.target.root, 'new.txt')), { code: 'ENOENT' });
        assertLocked(f.target.root);
        assert.equal(
          (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
          'needs_attention',
        );
        assert.equal(calls.length, 1);
        assert.equal(journal(f.target.home, f.id).raw, evidence.raw);
        assertLocked(f.target.root);
      });
    } finally {
      releaseFixture(f.target.root, f.claimId);
      await f.close();
    }
  });

for (const fault of ['none', 'occupied'] as const)
  test(
    `顶层新增${fault === 'none' ? '正常成功' : '确定EEXIST拒绝'}保留原有结算语义`,
    linux,
    async () => {
      const f = await preparedAddition();
      try {
        await withFault('add', fault, async (calls) => {
          const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
          assert.equal(result.state, fault === 'none' ? 'completed' : 'failed');
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.status, fault === 'none' ? 0 : 20);
          assert.equal(journal(f.target.home, f.id).value.intent, null);
          assert.equal(
            await readFile(join(f.target.root, 'new.txt'), 'utf8'),
            fault === 'none' ? 'NEW_COMMITTED_SECRET\n' : 'USER RACE\n',
          );
          const available = new WorkspaceLease(f.target.root, 'after-definite-outcome');
          available.release();
        });
      } finally {
        releaseFixture(f.target.root, f.claimId);
        await f.close();
      }
    },
  );

for (const fault of ['before', 'after'] as const)
  test(`替换备份暂存linkat ${fault} EIO不清掉existingChanges意图或写锁`, linux, async () => {
    const f = await preparedExistingApplication();
    try {
      const original = await readFile(join(f.target.root, 'README.md'));
      await withFault('change', fault, async (calls) => {
        const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
          backup: f.backup,
        });
        assert.equal(result.state, 'needs_attention');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.status, 21);
        const evidence = journal(f.target.home, f.id);
        assert.equal(evidence.value.intent, 'README.md');
        assert.equal(evidence.value.existingChanges!.intent!.before.path, 'README.md');
        assert.deepEqual(evidence.value.existingChanges!.changes, []);
        assert.deepEqual(await readFile(join(f.target.root, 'README.md')), original);
        const saved = evidence.value.existingChanges!.intent!.backupName;
        if (fault === 'after') assert.equal((await lstat(join(f.backup, saved))).nlink, 1);
        else assert.deepEqual(await readdir(f.backup), []);
        assertLocked(f.target.root);
        assert.equal(
          (
            await applyIntegration(f.target.home, f.id, noAsk, silent, undefined, {
              backup: f.backup,
            })
          ).state,
          'needs_attention',
        );
        assert.equal(calls.length, 1);
        assert.equal(journal(f.target.home, f.id).raw, evidence.raw);
        assertLocked(f.target.root);
      });
    } finally {
      await f.close();
    }
  });

for (const kind of ['add', 'change'] as const)
  for (const fault of ['before', 'after'] as const)
    test(`原文件恢复${kind} linkat ${fault} EIO保留原应用、恢复意图与材料`, linux, async () => {
      const f = await preparedRestoration();
      try {
        const originalApplication = journal(f.target.home, f.id).raw;
        await withFault(kind, fault, async (calls) => {
          const result = await f.restore();
          assert.equal(result.state, 'needs_attention');
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.status, 21);
          const evidence = journal(f.target.home, `restoration:${f.restoration.id}`);
          assert.equal(evidence.value.intent, kind === 'add' ? 'delete.txt' : 'README.md');
          if (kind === 'change') assert(evidence.value.existingChanges!.intent);
          assert.equal(journal(f.target.home, f.id).raw, originalApplication);
          const beforeBackup = await readdir(f.backup);
          assert(beforeBackup.length > 0, 'original backup remains available');
          assertLocked(f.target.root);
          assert.equal((await f.restore(noAsk)).state, 'needs_attention');
          assert.equal(calls.length, 1);
          assert.equal(journal(f.target.home, `restoration:${f.restoration.id}`).raw, evidence.raw);
          assert.equal(journal(f.target.home, f.id).raw, originalApplication);
          assert.deepEqual(await readdir(f.backup), beforeBackup);
          assertLocked(f.target.root);
        });
      } finally {
        releaseFixture(f.target.root, f.restoration.id);
        await f.close();
      }
    });

for (const kind of ['add', 'change'] as const)
  test(`拒绝可能把linkat I/O报告为确定无写入的旧${kind}助手v1`, linux, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexu-disposable-old-helper-'));
    const source = join(dir, 'old-helper.c'),
      helper = join(dir, 'old-helper');
    writeFileSync(
      source,
      `#include <stdio.h>\nint main(void) { puts("hexu-integration-${kind}-v1"); return 0; }\n`,
    );
    const real = childProcess.spawnSync;
    const built = real('cc', ['-Wall', '-Wextra', '-Werror', source, '-o', helper], {
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, built.stderr);
    const routed = mock.method(childProcess, 'spawnSync', ((
      command: string,
      args: readonly string[] = [],
      options: SpawnSyncOptions = {},
    ) =>
      real(
        command === nativeHelper(kind) ? helper : command,
        args,
        options,
      )) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        kind === 'add' ? checkIntegrationAddHelper : checkIntegrationChangeHelper,
        (error) => error instanceof DomainError && error.code === 'INTEGRATION_HELPER_UNAVAILABLE',
      );
    } finally {
      routed.mock.restore();
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });
