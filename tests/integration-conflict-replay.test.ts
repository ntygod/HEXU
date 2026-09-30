import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  preparedConflictApplication,
  silentConflict as silent,
} from './helpers/integration-conflict-runner.js';
import {
  applyIntegration,
  withSettledIntegrationEvidence,
} from '../apps/runner/src/agent/integration-application.js';
import { readIntegrationApplicationStatus } from '../apps/runner/src/agent/integration-application-status.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
const noAsk = async () => {
    throw new Error('no reselection, consent or write replay');
  },
  linux = { skip: process.platform !== 'linux' };
for (const sequence of [1, 2] as const)
  test(
    `冲突候选应用阶段${sequence}丢ACK保留原决策与凭证，重复不重新选择或读取候选`,
    linux,
    async () => {
      const f = await preparedConflictApplication(),
        fetch = globalThis.fetch;
      let dropped = false;
      try {
        globalThis.fetch = async (...args) => {
          const response = await fetch(...args);
          if (
            !dropped &&
            String(args[0]).endsWith('/integration-apply-publish') &&
            JSON.parse(String(args[1]?.body)).sequence === sequence
          ) {
            dropped = true;
            await response.text();
            throw new Error('fixture lost accepted ACK');
          }
          return response;
        };
        await assert.rejects(
          applyIntegration(f.target.home, f.id, f.consent, silent, undefined, { backup: f.backup }),
        );
        assert(dropped);
        const before = readIntegrationApplicationStatus(f.target.home, f.id);
        assert.equal(before.pendingReportSequence, sequence);
        await assert.rejects(withSettledIntegrationEvidence(f.target.home, async () => true));
        await rename(f.destination, f.destination + '-moved');
        await writeFile(join(f.target.root, 'README.md'), 'USER AFTER ACK WINDOW');
        const result = await applyIntegration(f.target.home, f.id, noAsk, silent);
        assert.equal(result.state, sequence === 1 ? 'needs_attention' : 'completed');
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          'USER AFTER ACK WINDOW',
        );
        assert.equal(
          readIntegrationApplicationStatus(f.target.home, f.id).pendingReportSequence,
          null,
        );
        if (sequence === 1) {
          assert.deepEqual(result.appliedPaths, []);
          await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
          assert.throws(() => new WorkspaceLease(f.target.root, 'unrelated-writer'), /受管执行/);
        } else {
          assert.deepEqual(result.appliedPaths, f.selection.selectedPaths);
          assert.equal((await readdir(f.backup)).length, 2);
          assert.equal(await withSettledIntegrationEvidence(f.target.home, async () => true), true);
        }
      } finally {
        globalThis.fetch = fetch;
        await f.close();
      }
    },
  );
test('冲突候选第一项写回后目标撤权，第二项与原决策不变，部分现场和待发包留锁', linux, async () => {
  let active = false,
    revoked = false;
  const f: Awaited<ReturnType<typeof preparedConflictApplication>> =
    await preparedConflictApplication(async (url) => {
      if (!active || revoked || url !== '/runner/v1/integration-inspect') return;
      try {
        if (
          readIntegrationApplicationStatus(f.target.home, f.id).existingChanges?.confirmed
            .length !== 1
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
    assert.equal(
      await readFile(join(f.target.root, 'README.md'), 'utf8'),
      'SOURCE_COMMITTED_SECRET\n',
    );
    assert.equal(await readFile(join(f.target.root, 'delete.txt'), 'utf8'), 'USER TARGET DELETE\n');
    assert.throws(() => new WorkspaceLease(f.target.root, 'after-revocation'), /受管执行/);
    await assert.rejects(withSettledIntegrationEvidence(f.target.home, async () => true));
  } finally {
    await f.close();
  }
});
test('本机候选决策被改写或降级不能借原共享指纹开始应用', linux, async () => {
  const f = await preparedConflictApplication();
  try {
    const db = new DatabaseSync(join(f.target.home, 'integration-trials', 'journal.sqlite'));
    try {
      const row = db.prepare('SELECT context FROM trials WHERE target=?').get(f.destination)!,
        body = JSON.parse(row.context as string);
      body.version = 1;
      db.prepare('UPDATE trials SET context=? WHERE target=?').run(
        JSON.stringify(body),
        f.destination,
      );
    } finally {
      db.close();
    }
    const before = await readFile(join(f.target.root, 'README.md'));
    await assert.rejects(
      applyIntegration(f.target.home, f.id, f.consent, silent, undefined, { backup: f.backup }),
    );
    assert.deepEqual(await readFile(join(f.target.root, 'README.md')), before);
    await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
    assert.deepEqual((await f.read(f.id)).operation.application!.reports, []);
  } finally {
    await f.close();
  }
});
