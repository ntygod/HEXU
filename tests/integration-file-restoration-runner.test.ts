import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparedExistingApplication, selection } from './helpers/integration-existing-runner.js';
import {
  applyIntegration,
  withSettledIntegrationEvidence,
} from '../apps/runner/src/agent/integration-application.js';
import { restoreIntegrationFiles } from '../apps/runner/src/agent/integration-file-restoration.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
const silent = () => {};
const linux = { skip: process.platform !== 'linux' };
const noAsk = async () => {
  throw new Error('must not repeat consent or writes');
};
async function applied(
  format: 'sha1' | 'sha256' = 'sha1',
  onRequest?: (url: string) => Promise<void>,
  beforeApply?: (fixture: Awaited<ReturnType<typeof preparedExistingApplication>>) => Promise<void>,
) {
  const f = await preparedExistingApplication(format, onRequest);
  try {
    await beforeApply?.(f);
    const original = new Map(
      await Promise.all(
        ['README.md', 'delete.txt', 'target.txt', '.git/HEAD', '.git/index'].map(
          async (p) => [p, await readFile(join(f.target.root, p))] as const,
        ),
      ),
    );
    const result = await applyIntegration(f.target.home, f.id, f.consent, silent, undefined, {
      backup: f.backup,
    });
    assert.equal(result.state, 'completed');
    const v = await f.read(f.id);
    const res = await f.api.call(`${f.path}/${f.id}/restore`, f.alice, {
      applicationId: f.application.id,
      applicationInputHash: f.application.inputHash,
      completedReportHash: v.completedReportHash,
      paths: selection,
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      confirmFileRestoration: true,
    });
    assert.equal(res.statusCode, 200, res.body);
    const restoration = (res.json() as IntegrationView).restoration!;
    const record = () => {
      const db = new DatabaseSync(
        join(f.target.home, 'integration-application', 'journal.sqlite'),
        { readOnly: true },
      );
      try {
        return db.prepare('SELECT id,body FROM applications ORDER BY id').all() as {
          id: string;
          body: string;
        }[];
      } finally {
        db.close();
      }
    };
    return {
      ...f,
      original,
      restoration,
      record,
      restoreBackup: join(f.dir, 'restore-current-backup'),
      restoreConsent: async () => `STOPPED_AND_RESTORE ${restoration.id}`,
      close: async () => {
        try {
          new WorkspaceLease(f.target.root, `integration:${restoration.id}`, true).release();
        } catch {}
        await f.close();
      },
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format} 明确恢复原已确认增改删，保留原备份、当前文件、新建空目录和原报告`,
    linux,
    async () => {
      const f = await applied(format);
      try {
        const originalRow = f.record().find((r) => r.id === f.id)!.body;
        const backup = new Map(
          await Promise.all(
            (await readdir(f.backup)).map(
              async (n) =>
                [
                  n,
                  {
                    bytes: await readFile(join(f.backup, n)),
                    ino: (await lstat(join(f.backup, n))).ino,
                  },
                ] as const,
            ),
          ),
        );
        const current = new Map(
          await Promise.all(
            ['README.md', 'new.txt', 'new-module/nested.txt'].map(
              async (n) =>
                [
                  n,
                  {
                    bytes: await readFile(join(f.target.root, n)),
                    ino: (await lstat(join(f.target.root, n))).ino,
                  },
                ] as const,
            ),
          ),
        );
        const operation = JSON.stringify((await f.read(f.id)).operation);
        const r = await restoreIntegrationFiles(
          f.target.home,
          f.id,
          f.restoration.id,
          f.restoreConsent,
          silent,
          undefined,
          { backup: f.restoreBackup },
        );
        assert.equal(r.state, 'completed', JSON.stringify(r));
        assert.deepEqual(r.restoredPaths, selection.slice().sort());
        for (const [p, b] of f.original)
          assert.deepEqual(await readFile(join(f.target.root, p)), b, p);
        for (const p of ['new.txt', 'new-module/nested.txt'])
          await assert.rejects(lstat(join(f.target.root, p)), { code: 'ENOENT' });
        assert.deepEqual(await readdir(join(f.target.root, 'new-module')), []);
        assert.equal(f.record().find((r) => r.id === f.id)!.body, originalRow);
        assert.equal(JSON.stringify((await f.read(f.id)).operation), operation);
        for (const [n, b] of backup) {
          assert.deepEqual(await readFile(join(f.backup, n)), b.bytes);
          assert.equal((await lstat(join(f.backup, n))).ino, b.ino);
        }
        const row = JSON.parse(
          f.record().find((r) => r.id === `restoration:${f.restoration.id}`)!.body,
        );
        assert.equal(row.phase, 'completed');
        assert.equal(row.acknowledged, 2);
        assert.equal(row.pending, null);
        for (const change of row.existingChanges.changes) {
          const b = current.get(change.before.path)!;
          assert.deepEqual(await readFile(join(f.restoreBackup, change.backupName)), b.bytes);
          assert.equal((await lstat(join(f.restoreBackup, change.backupName))).ino, b.ino);
        }
        assert.equal((await lstat(f.restoreBackup)).mode & 0o777, 0o700);
        // Completion replay must not reread backups or overwrite later user work.
        await writeFile(join(f.target.root, 'README.md'), 'USER AFTER RESTORE');
        await rename(f.backup, f.backup + '-moved');
        assert.deepEqual(
          await restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent),
          r,
        );
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          'USER AFTER RESTORE',
        );
      } finally {
        await f.close();
      }
    },
  );
test('恢复缺少确认、新保留目录或后续用户编辑时拒绝写入；原完成应用不可扩权', linux, async () => {
  const f = await applied();
  try {
    const before = f.record();
    await assert.rejects(
      restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, f.restoreConsent, silent),
      /--backup/,
    );
    await assert.rejects(
      restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        async () => `STOPPED_AND_APPLY ${f.application.id}`,
        silent,
        undefined,
        { backup: f.restoreBackup },
      ),
      /未确认/,
    );
    for (const backup of [
      f.backup,
      join(f.backup, 'nested'),
      join(f.destination, 'backup'),
      join(f.target.root, 'backup'),
      join(f.target.home, 'backup'),
    ])
      await assert.rejects(
        restoreIntegrationFiles(
          f.target.home,
          f.id,
          f.restoration.id,
          f.restoreConsent,
          silent,
          undefined,
          { backup },
        ),
      );
    await writeFile(join(f.target.root, 'README.md'), 'USER MODIFIED');
    await assert.rejects(
      restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      ),
    );
    assert.deepEqual(f.record(), before);
    assert.equal(await readFile(join(f.target.root, 'README.md'), 'utf8'), 'USER MODIFIED');
    await assert.rejects(lstat(f.restoreBackup), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test(
  '恢复中断只保留已确认文件，旧应用重放不释放新恢复锁，明确停止结算后也不续写',
  linux,
  async () => {
    const { IntegrationApplicationBackup } = await import(
      '../apps/runner/src/agent/integration-application-backup.js'
    );
    const { recoverIntegration } = await import('../apps/runner/src/agent/integration-recovery.js');
    const { readIntegrationApplicationStatus } = await import(
      '../apps/runner/src/agent/integration-application-status.js'
    );
    const f = await applied(),
      controller = new AbortController(),
      verify = IntegrationApplicationBackup.prototype.verify;
    try {
      IntegrationApplicationBackup.prototype.verify = function () {
        verify.call(this);
        if (this.evidence.changes.length === 1) controller.abort();
      };
      const result = await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        controller.signal,
        { backup: f.restoreBackup },
      );
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.restoredPaths, ['README.md']);
      assert.equal(await readFile(join(f.target.root, 'README.md'), 'utf8'), 'BASE\n');
      await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
      assert.throws(() => new WorkspaceLease(f.target.root, 'other'), /受管执行/);
      await withSettledIntegrationEvidence(f.target.home, async () =>
        assert.fail('must retain credentials'),
      ).then(
        () => assert.fail('unsettled'),
        () => {},
      );
      await applyIntegration(f.target.home, f.id, noAsk, silent);
      assert.throws(() => new WorkspaceLease(f.target.root, 'after-old-application'), /受管执行/);
      const rows = f.record(),
        status = readIntegrationApplicationStatus(f.target.home, f.id);
      assert.equal(status.restorations![0]!.localPhase, 'needs_attention');
      assert.equal(status.restorations![0]!.directoryChecked, false);
      assert.deepEqual(
        await restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent),
        result,
      );
      assert.deepEqual(f.record(), rows);
      const recovered = await recoverIntegration(
        f.target.home,
        f.id,
        async () => `STOPPED ${f.restoration.id}`,
        silent,
        { restorationId: f.restoration.id },
      );
      assert.equal(recovered.publication, 'acknowledged');
      assert.equal(recovered.filesVerified, false);
      assert.equal(
        await withSettledIntegrationEvidence(f.target.home, async () => 'settled'),
        'settled',
      );
      const newer = new WorkspaceLease(f.target.root, 'later-writer');
      try {
        await recoverIntegration(f.target.home, f.id, noAsk, silent, {
          restorationId: f.restoration.id,
        });
        await restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent);
        newer.assertHeld();
        assert.deepEqual(f.record(), rows);
      } finally {
        newer.release();
      }
      assert.equal((await f.read(f.id)).operation.state, 'completed');
      assert.equal((await f.read(f.id)).restoration!.state, 'needs_attention');
      assert.equal((await readdir(f.restoreBackup)).length, 1);
    } finally {
      IntegrationApplicationBackup.prototype.verify = verify;
      await f.close();
    }
  },
);

for (const sequence of [1, 2] as const)
  test(`恢复阶段${sequence}服务接受后ACK丢失，只对账原包并保留文件与凭证`, linux, async () => {
    const f = await applied(),
      fetch = globalThis.fetch;
    let dropped = false;
    try {
      globalThis.fetch = async (...args) => {
        const response = await fetch(...args);
        if (
          !dropped &&
          String(args[0]).endsWith('/runner/v1/integration-restoration-publish') &&
          JSON.parse(String(args[1]?.body)).sequence === sequence
        ) {
          dropped = true;
          await response.text();
          throw new Error('fixture lost accepted receipt');
        }
        return response;
      };
      await assert.rejects(
        restoreIntegrationFiles(
          f.target.home,
          f.id,
          f.restoration.id,
          f.restoreConsent,
          silent,
          undefined,
          { backup: f.restoreBackup },
        ),
      );
      assert(dropped);
      await assert.rejects(
        withSettledIntegrationEvidence(f.target.home, async () => true),
        /保留原凭证/,
      );
      const row = JSON.parse(f.record().find((r) => r.id.startsWith('restoration:'))!.body);
      assert.equal(row.pending.sequence, sequence);
      if (sequence === 1) {
        assert.deepEqual(row.added, []);
        await assert.rejects(lstat(f.restoreBackup), { code: 'ENOENT' });
      }
      const retried = await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        noAsk,
        silent,
      );
      assert.equal(retried.state, sequence === 2 ? 'completed' : 'needs_attention');
      assert.equal((await f.read(f.id)).restoration!.reports.length, 2);
      if (sequence === 2)
        assert.equal(await withSettledIntegrationEvidence(f.target.home, async () => true), true);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  });

test(
  '来源撤权与完整对象副本不可用不阻止恢复本人已确认备份，当前目标授权仍必需',
  linux,
  async () => {
    const f = await applied('sha256');
    try {
      f.api.store.db
        .prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?")
        .run(f.ns[f.source.index]!.nodeId);
      // Remove the local retained-object files from their original paths without
      // deleting them; restoration must never open or rebuild either source.
      let moved = 0;
      for (const home of new Set([f.source.home, f.target.home])) {
        for (const name of ['retained-checkpoints', 'checkpoint-transfers']) {
          try {
            await rename(join(home, name), join(home, name + '-unavailable'));
            moved++;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
      }
      assert(moved >= 3, 'source, target and received-object stores actually unavailable');
      const r = await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      );
      assert.equal(r.state, 'completed');
      assert.deepEqual(
        await readFile(join(f.target.root, 'README.md')),
        f.original.get('README.md'),
      );
      f.api.store.db
        .prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?")
        .run(f.ns[f.target.index]!.nodeId);
      await assert.rejects(
        restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  '恢复日志严格绑定原应用、请求、完整选择与字节归属，旧版本解析器拒绝新记录',
  linux,
  async () => {
    const { parseLocalIntegrationRestoration } = await import(
      '../apps/runner/src/agent/integration-restoration-record.js'
    );
    const { parseLocalApplicationRecord } = await import(
      '../apps/runner/src/agent/integration-application-record.js'
    );
    const f = await applied();
    try {
      await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      );
      const rows = f.record(),
        original = parseLocalApplicationRecord(rows.find((r) => r.id === f.id)!.body, f.id),
        row = rows.find((r) => r.id.startsWith('restoration:'))!,
        r = parseLocalIntegrationRestoration(row.body, row.id, original);
      assert.throws(() => parseLocalApplicationRecord(row.body, row.id));
      for (const mutate of [
        (v: typeof r) => {
          delete (v as Partial<typeof r>).pending;
        },
        (v: typeof r) => {
          v.originalApplicationEvidenceHash = 'e'.repeat(64);
        },
        (v: typeof r) => {
          v.request.paths = ['README.md'];
        },
        (v: typeof r) => {
          v.manifest.tree = 'bad';
        },
        (v: typeof r) => {
          v.added[0]!.objectId = 'd'.repeat(40);
        },
        (v: typeof r) => {
          v.existingChanges.changes[0]!.originalIdentity = '1:2';
        },
        (v: typeof r) => {
          v.existingChanges.changes[0]!.after = null;
        },
        (v: typeof r) => {
          v.phase = 'failed';
        },
        (v: typeof r) => {
          v.acknowledged = 1;
        },
        (v: typeof r) => {
          v.intent = v.request.paths[0]!;
        },
      ]) {
        const bad = structuredClone(r);
        mutate(bad);
        assert.throws(() =>
          parseLocalIntegrationRestoration(JSON.stringify(bad), row.id, original),
        );
      }
      assert.equal(await withSettledIntegrationEvidence(f.target.home, async () => true), true);
    } finally {
      await f.close();
    }
  },
);

test('真实恢复CLI首个文件后退出，并发进程与旧应用不能写入或误释放；重启只对账', linux, async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const { readIntegrationApplicationStatus } = await import(
    '../apps/runner/src/agent/integration-application-status.js'
  );
  let active = false,
    held = false;
  let reached!: () => void, release!: () => void;
  const barrier = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const f: Awaited<ReturnType<typeof applied>> = await applied('sha1', async (url) => {
    if (!active || held || url !== '/runner/v1/integration-restoration-inspect') return;
    try {
      if (
        readIntegrationApplicationStatus(f.target.home, f.id).restorations?.[0]
          ?.confirmedRestoredPaths.length !== 1
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
      resolve('dist/apps/runner/src/integration-file-restoration.js'),
      '--operation',
      f.id,
      '--restoration',
      f.restoration.id,
      '--state',
      f.target.home,
      '--backup',
      f.restoreBackup,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  const exited = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.end(`STOPPED_AND_RESTORE ${f.restoration.id}\n`);
    await Promise.race([
      barrier,
      exited.then(() => {
        throw new Error(`child exited before barrier: ${output}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`barrier timeout: ${output}`)), 15000);
      }),
    ]);
    await assert.rejects(
      restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent),
      /已有进程/,
    );
    await assert.rejects(applyIntegration(f.target.home, f.id, noAsk, silent), /已有进程/);
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => true),
      /已有进程/,
    );
    assert(child.kill('SIGKILL'));
    await exited;
    release();
    const before = await readFile(join(f.target.root, 'README.md'));
    assert.equal(before.toString(), 'BASE\n');
    const r = await restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent);
    assert.equal(r.state, 'needs_attention');
    assert.deepEqual(r.restoredPaths, ['README.md']);
    assert.deepEqual(await readFile(join(f.target.root, 'README.md')), before);
    await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
    assert.throws(() => new WorkspaceLease(f.target.root, 'after-process'), /受管执行/);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await f.close();
  }
});

test('恢复第一文件后目标撤权，停止后可本机保留释放但报告未确认不能删除凭证', linux, async () => {
  const { readIntegrationApplicationStatus } = await import(
    '../apps/runner/src/agent/integration-application-status.js'
  );
  const { recoverIntegration } = await import('../apps/runner/src/agent/integration-recovery.js');
  let active = false,
    revoked = false;
  const f: Awaited<ReturnType<typeof applied>> = await applied('sha1', async (url) => {
    if (!active || revoked || url !== '/runner/v1/integration-restoration-inspect') return;
    if (
      readIntegrationApplicationStatus(f.target.home, f.id).restorations?.[0]
        ?.confirmedRestoredPaths.length !== 1
    )
      return;
    revoked = true;
    f.api.store.db
      .prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?")
      .run(f.ns[f.target.index]!.nodeId);
  });
  active = true;
  try {
    await assert.rejects(
      restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      ),
    );
    assert(revoked);
    const status = readIntegrationApplicationStatus(f.target.home, f.id).restorations![0]!;
    assert.equal(status.localPhase, 'needs_attention');
    assert.equal(status.pendingReport!.sequence, 2);
    assert.deepEqual(status.confirmedRestoredPaths, ['README.md']);
    const r = await recoverIntegration(
      f.target.home,
      f.id,
      async () => `STOPPED ${f.restoration.id}`,
      silent,
      { restorationId: f.restoration.id },
    );
    assert.equal(r.state, 'released');
    assert.equal(r.publication, 'pending');
    new WorkspaceLease(f.target.root, 'after-local-settlement').release();
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => true),
      /保留原凭证/,
    );
    assert.equal((await readdir(f.restoreBackup)).length, 1);
    await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test(
  '未知启动ACK可先保留结算，后来仅对账已冻结包；结算ACK丢失不触碰后续写入者',
  linux,
  async () => {
    const { recoverIntegration } = await import('../apps/runner/src/agent/integration-recovery.js');
    const f = await applied(),
      fetch = globalThis.fetch;
    let stage: 'start' | 'settlement' | 'normal' = 'start';
    try {
      globalThis.fetch = async (...args) => {
        const response = await fetch(...args);
        const url = String(args[0]);
        if (
          (stage === 'start' && url.endsWith('/integration-restoration-publish')) ||
          (stage === 'settlement' && url.endsWith('/integration-restoration-recovery-publish'))
        ) {
          await response.text();
          throw new Error('fixture lost receipt');
        }
        return response;
      };
      await assert.rejects(
        restoreIntegrationFiles(
          f.target.home,
          f.id,
          f.restoration.id,
          f.restoreConsent,
          silent,
          undefined,
          { backup: f.restoreBackup },
        ),
      );
      const frozen = f.record();
      stage = 'settlement';
      const r = await recoverIntegration(
        f.target.home,
        f.id,
        async () => `STOPPED ${f.restoration.id}`,
        silent,
        { restorationId: f.restoration.id },
      );
      assert.equal(r.publication, 'pending');
      assert.deepEqual(f.record(), frozen);
      await assert.rejects(
        withSettledIntegrationEvidence(f.target.home, async () => true),
        /保留原凭证/,
      );
      stage = 'normal';
      const newer = new WorkspaceLease(f.target.root, 'new-after-settlement');
      try {
        const repeated = await recoverIntegration(f.target.home, f.id, noAsk, silent, {
          restorationId: f.restoration.id,
        });
        assert.equal(repeated.publication, 'acknowledged');
        newer.assertHeld();
        await assert.rejects(
          withSettledIntegrationEvidence(f.target.home, async () => true),
          /保留原凭证/,
        );
        const reconciled = await restoreIntegrationFiles(
          f.target.home,
          f.id,
          f.restoration.id,
          noAsk,
          silent,
        );
        assert.equal(reconciled.state, 'prepared');
        newer.assertHeld();
        assert.equal(await withSettledIntegrationEvidence(f.target.home, async () => true), true);
        await assert.rejects(lstat(f.restoreBackup), { code: 'ENOENT' });
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          'SOURCE_COMMITTED_SECRET\n',
        );
        const view = await f.read(f.id);
        assert.equal(view.restoration!.reports.length, 1);
        assert.equal(view.restoration!.state, 'restoring');
        assert(view.restoration!.recovery);
      } finally {
        newer.release();
      }
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test('原被删除私有文件恢复仍为0600，不把备份正文意外开放给组或其他用户', linux, async () => {
  const { chmod } = await import('node:fs/promises');
  const f = await applied('sha1', undefined, async (f) => {
    await chmod(join(f.target.root, 'delete.txt'), 0o600);
  });
  try {
    const r = await restoreIntegrationFiles(
      f.target.home,
      f.id,
      f.restoration.id,
      f.restoreConsent,
      silent,
      undefined,
      { backup: f.restoreBackup },
    );
    assert.equal(r.state, 'completed');
    assert.equal((await lstat(join(f.target.root, 'delete.txt'))).mode & 0o777, 0o600);
    assert.deepEqual(
      await readFile(join(f.target.root, 'delete.txt')),
      f.original.get('delete.txt'),
    );
  } finally {
    await f.close();
  }
});

test(
  '恢复前拒绝后来占用、同内容换inode、未跟踪文件及原备份链接/编辑，全部现场保持',
  linux,
  async () => {
    const { unlink, symlink, link } = await import('node:fs/promises');
    const f = await applied();
    const restore = () =>
      restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      );
    try {
      const rows = f.record(),
        name = (await readdir(f.backup))[0]!,
        slot = join(f.backup, name),
        saved = join(f.dir, 'held-original-backup'),
        original = await readFile(slot);
      await writeFile(join(f.target.root, 'delete.txt'), 'LATER USER FILE');
      await assert.rejects(restore());
      assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'LATER USER FILE');
      await unlink(join(f.target.root, 'delete.txt'));
      const added = join(f.target.root, 'new.txt'),
        held = join(f.dir, 'held-applied-file'),
        bytes = await readFile(added);
      await rename(added, held);
      await writeFile(added, bytes);
      assert.notEqual((await lstat(added)).ino, (await lstat(held)).ino);
      await assert.rejects(restore());
      await unlink(added);
      await rename(held, added);
      await writeFile(join(f.target.root, 'extra-user-file'), 'USER');
      await assert.rejects(restore());
      await unlink(join(f.target.root, 'extra-user-file'));
      await writeFile(slot, 'EDITED BACKUP');
      await assert.rejects(restore());
      assert.equal(await readFile(slot, 'utf8'), 'EDITED BACKUP');
      await writeFile(slot, original);
      await rename(slot, saved);
      await symlink(saved, slot);
      await assert.rejects(restore());
      assert((await lstat(slot)).isSymbolicLink());
      await unlink(slot);
      await link(saved, slot);
      await assert.rejects(restore());
      assert.equal((await lstat(slot)).nlink, 2);
      await unlink(slot);
      await rename(saved, slot);
      assert.deepEqual(f.record(), rows);
      await assert.rejects(lstat(f.restoreBackup), { code: 'ENOENT' });
      assert.equal((await restore()).state, 'completed');
    } finally {
      await f.close();
    }
  },
);

test(
  '恢复原删除文件后核验中断，保留真实文件和精确未确认意图，不补报成功或重放',
  linux,
  async () => {
    const { OriginalIntegrationBackup } = await import(
      '../apps/runner/src/agent/integration-original-backup.js'
    );
    const { recoverIntegration } = await import('../apps/runner/src/agent/integration-recovery.js');
    const f = await applied(),
      permissions = OriginalIntegrationBackup.prototype.permissions;
    let calls = 0;
    try {
      OriginalIntegrationBackup.prototype.permissions = function (path) {
        const mode = permissions.call(this, path);
        if (path === 'delete.txt' && ++calls === 2)
          throw new Error('fixture interruption after exclusive publication');
        return mode;
      };
      const r = await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      );
      assert.equal(r.state, 'needs_attention');
      assert.deepEqual(r.restoredPaths, ['README.md']);
      const row = JSON.parse(f.record().find((r) => r.id.startsWith('restoration:'))!.body);
      assert.equal(row.intent, 'delete.txt');
      assert.equal(row.added.length, 0);
      assert.deepEqual(
        await readFile(join(f.target.root, 'delete.txt')),
        f.original.get('delete.txt'),
      );
      assert.deepEqual(
        await restoreIntegrationFiles(f.target.home, f.id, f.restoration.id, noAsk, silent),
        r,
      );
      const released = await recoverIntegration(
        f.target.home,
        f.id,
        async () => `STOPPED ${f.restoration.id}`,
        silent,
        { restorationId: f.restoration.id },
      );
      assert.equal(released.publication, 'acknowledged');
      assert.deepEqual(
        await readFile(join(f.target.root, 'delete.txt')),
        f.original.get('delete.txt'),
      );
      const view = await f.read(f.id);
      assert.equal(view.restoration!.recovery!.report.unresolvedWriteIntent, true);
      assert.equal(view.restoration!.recovery!.report.recordedRestoredCount, 1);
    } finally {
      OriginalIntegrationBackup.prototype.permissions = permissions;
      await f.close();
    }
  },
);

test(
  '恢复最后备份核验期间目标被用户编辑，短观察阻止第一次文件写入并保留新目录',
  linux,
  async () => {
    const { writeFileSync } = await import('node:fs');
    const { IntegrationApplicationBackup } = await import(
      '../apps/runner/src/agent/integration-application-backup.js'
    );
    const f = await applied(),
      verify = IntegrationApplicationBackup.prototype.verify;
    let changed = false;
    try {
      IntegrationApplicationBackup.prototype.verify = function () {
        verify.call(this);
        if (!changed) {
          changed = true;
          writeFileSync(join(f.target.root, 'README.md'), 'USER DURING RESTORE CHECK');
        }
      };
      const r = await restoreIntegrationFiles(
        f.target.home,
        f.id,
        f.restoration.id,
        f.restoreConsent,
        silent,
        undefined,
        { backup: f.restoreBackup },
      );
      assert(changed);
      assert.equal(r.state, 'needs_attention');
      assert.deepEqual(r.restoredPaths, []);
      assert.deepEqual(await readdir(f.restoreBackup), []);
      assert.equal(
        await readFile(join(f.target.root, 'README.md'), 'utf8'),
        'USER DURING RESTORE CHECK',
      );
      assert.throws(() => new WorkspaceLease(f.target.root, 'after-user-edit'), /受管执行/);
    } finally {
      IntegrationApplicationBackup.prototype.verify = verify;
      await f.close();
    }
  },
);
