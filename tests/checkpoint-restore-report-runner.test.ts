import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  RestoreJournal,
  readRestoreProgress,
} from '../apps/runner/src/agent/checkpoint-restore-journal.js';
import {
  localRestoreCheckpoint,
  cleanupRestoreCheckpoint,
} from '../apps/runner/src/agent/checkpoint-restore.js';
import { reportRestoreCheckpoint } from '../apps/runner/src/agent/checkpoint-restore-report.js';
import { localRetentionOperation } from '../apps/runner/src/agent/checkpoint-retention.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import {
  restoreResultFixture,
  accept,
  noAsk,
  silent,
} from './helpers/checkpoint-restore-results.js';
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
const delivery = (home: string, id: string) => {
  const j = new RestoreJournal(home);
  try {
    return j.storage.db.prepare('SELECT * FROM restore_result_delivery WHERE id=?').get(id);
  } finally {
    j.close();
  }
};
for (const format of ['sha1', 'sha256'] as const)
  test(`真实${format}恢复后明确报告，只上传元数据，原文件/保留回执/Task不变`, async () => {
    const f = await restoreResultFixture(format);
    try {
      const progress = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
        log: silent,
      });
      assert.equal(progress.state, 'restored');
      const head = await readFile(join(f.root, '.git/HEAD')),
        index = await readFile(join(f.root, '.git/index'));
      const retained = await f.read();
      await rename(f.target, f.target + '-moved'); // Reporting must not assert current file existence.
      const result = await reportRestoreCheckpoint(f.home, f.target, accept, silent);
      assert.equal(result.receipt.latest.report.state, 'restored');
      assert(result.receipt.latest.report.verifiedAt);
      assert.equal(result.currentFilesVerified, false);
      assert.equal(result.receipt.latest.sequence, 1);
      const again = await reportRestoreCheckpoint(f.home, f.target, noAsk, silent);
      assert.equal(again.receipt.latest.sequence, 1);
      const text = JSON.stringify(f.list());
      for (const secret of [
        f.target,
        f.root,
        f.token,
        f.home,
        'README.md',
        'binary.dat',
        'Retain only',
      ])
        assert(!text.includes(secret));
      assert.deepEqual(readRestoreProgress(f.home, f.target), progress);
      assert.deepEqual(await readFile(join(f.root, '.git/HEAD')), head);
      assert.deepEqual(await readFile(join(f.root, '.git/index')), index);
      assert.deepEqual(await f.read(), retained);
      assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 0);
    } finally {
      await f.close();
    }
  });
test('真实HTTP已保存但回执丢失：先固定确认旧取消结果，再明确报告后续清理，不再写目录', async () => {
  const f = await restoreResultFixture();
  try {
    const progress = await localRestoreCheckpoint(
      f.home,
      f.first.request.id,
      f.target,
      async (q) => (q.includes('PUBLISH') ? 'NO' : accept(q)),
      { log: silent },
    );
    f.dropNext('/runner/v1/checkpoint-restore-report');
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, accept, silent));
    assert.equal(f.list().items[0]!.sequence, 1);
    const frozen = delivery(f.home, progress.id)!.pending;
    assert(frozen);
    const cleaned = await cleanupRestoreCheckpoint(f.home, f.target, accept);
    assert.equal(cleaned.cleanup, 'cleaned');
    const ack = await reportRestoreCheckpoint(f.home, f.target, noAsk, silent);
    assert.equal(ack.receipt.latest.report.cleanup, 'retained');
    assert.equal(ack.localChangesPending, true);
    assert.equal(delivery(f.home, progress.id)!.last_packet, frozen);
    const current = await reportRestoreCheckpoint(f.home, f.target, accept, silent);
    assert.equal(current.receipt.latest.sequence, 2);
    assert.equal(current.receipt.latest.report.cleanup, 'cleaned');
    assert.equal(current.localChangesPending, false);
    assert(
      !(await readdir(f.dir)).some((n) => n.startsWith('.hexu-restore-') || n === 'restore-target'),
    );
  } finally {
    await f.close();
  }
});
test('报告确认拒绝不上传；确认中撤权阻止发布，不修改恢复文件', async () => {
  const f = await restoreResultFixture();
  try {
    await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, { log: silent });
    const before = readRestoreProgress(f.home, f.target);
    await assert.rejects(
      reportRestoreCheckpoint(f.home, f.target, async () => 'NO', silent),
      code('CONFIRMATION_REQUIRED'),
    );
    assert.equal(f.list().items.length, 0);
    await assert.rejects(
      reportRestoreCheckpoint(
        f.home,
        f.target,
        async (q) => {
          f.as(() => f.registry.revoke(f.node.nodeId, 1, randomUUID()));
          return accept(q);
        },
        silent,
      ),
      code('NODE_REVOKED'),
    );
    assert.deepEqual(readRestoreProgress(f.home, f.target), before);
    assert.equal(f.list().items.length, 0);
  } finally {
    await f.close();
  }
});
test('已确认或待决回执不能绕过撤权；更换凭证不能读取或发布原恢复', async () => {
  const f = await restoreResultFixture();
  try {
    const p = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
      log: silent,
    });
    f.dropNext('/runner/v1/checkpoint-restore-report');
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, accept, silent));
    const pending = delivery(f.home, p.id)!.pending;
    f.as(() => f.registry.revoke(f.node.nodeId, 1, randomUUID()));
    await assert.rejects(
      reportRestoreCheckpoint(f.home, f.target, noAsk, silent),
      code('NODE_REVOKED'),
    );
    assert.equal(delivery(f.home, p.id)!.pending, pending);
    writeCredentials(f.home, {
      ...f.credentials,
      name: 'changed binding',
      nodeToken: 'x'.repeat(43),
    });
    await assert.rejects(
      reportRestoreCheckpoint(f.home, f.target, noAsk, silent),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('报告无需仍保留对象字节；删除来源副本不抹去原恢复事实或赋予执行权', async () => {
  const f = await restoreResultFixture();
  try {
    await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, { log: silent });
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'forget',
      async () => `DELETE ${f.first.request.id}`,
      silent,
    );
    const report = await reportRestoreCheckpoint(f.home, f.target, accept, silent);
    assert.equal(report.receipt.latest.report.state, 'restored');
    assert.equal((await f.read())[0]!.state, 'deleted');
    assert.equal(report.modelExecutionAuthorized, false);
  } finally {
    await f.close();
  }
});
test('本机报告待发写入失败不先发网络；确认回执写入失败保留固定报告可对账', async () => {
  const f = await restoreResultFixture();
  try {
    const p = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
      log: silent,
    });
    // First refusal initializes only the bounded delivery table, not a packet.
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, async () => 'NO', silent));
    let j = new RestoreJournal(f.home);
    j.storage.db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON restore_result_delivery BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    j.close();
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, accept, silent));
    assert.equal(f.list().items.length, 0);
    j = new RestoreJournal(f.home);
    j.storage.db.exec(
      "DROP TRIGGER fail; CREATE TRIGGER fail BEFORE UPDATE ON restore_result_delivery WHEN NEW.pending IS NULL BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    j.close();
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, accept, silent));
    assert.equal(f.list().items.length, 1);
    assert(delivery(f.home, p.id)!.pending);
    j = new RestoreJournal(f.home);
    j.storage.db.exec('DROP TRIGGER fail');
    j.close();
    assert.equal(
      (await reportRestoreCheckpoint(f.home, f.target, noAsk, silent)).receipt.latest.sequence,
      1,
    );
  } finally {
    await f.close();
  }
});
test('错误服务回执不能清除待确认报告或把本机恢复状态改写', async () => {
  const f = await restoreResultFixture();
  const original = globalThis.fetch;
  try {
    const p = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
      log: silent,
    });
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith('/checkpoint-restore-report')) {
        const body = (await response.json()) as { acceptedHash: string };
        body.acceptedHash = '0'.repeat(64);
        return new Response(JSON.stringify(body), { status: response.status });
      }
      return response;
    };
    await assert.rejects(
      reportRestoreCheckpoint(f.home, f.target, accept, silent),
      code('RESTORE_RECEIPT_MISMATCH'),
    );
    assert(delivery(f.home, p.id)!.pending);
    assert.deepEqual(readRestoreProgress(f.home, f.target), p);
    globalThis.fetch = original;
    assert.equal(
      (await reportRestoreCheckpoint(f.home, f.target, noAsk, silent)).receipt.latest.sequence,
      1,
    );
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
test('真实CLI报告固定结果；status不偷偷发布或重新验证文件', async () => {
  const f = await restoreResultFixture();
  try {
    const p = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
      log: silent,
    });
    const run = async (mode: string, confirm: string) => {
      const child = spawn(
        process.execPath,
        [
          resolve('dist/apps/runner/src/restore-checkpoint.js'),
          mode,
          '--state',
          f.home,
          '--target',
          f.target,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } },
      );
      let output = '';
      child.stdout.on('data', (v) => (output += v));
      child.stderr.on('data', (v) => (output += v));
      child.stdin.end(confirm + '\n');
      const [status] = await once(child, 'close');
      return { status, output };
    };
    assert.equal((await run('status', '')).status, 0);
    assert.equal(f.list().items.length, 0);
    const r = await run('report', `REPORT ${p.id}`);
    assert.equal(r.status, 0, r.output);
    assert(r.output.includes('"publication":"confirmed"'));
    assert(!r.output.includes(f.token));
    assert(!r.output.includes(f.target));
    await writeFile(join(f.target, 'README.md'), 'User editing after restore');
    const repeat = await run('report', '');
    assert.equal(repeat.status, 0, repeat.output);
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'User editing after restore');
  } finally {
    await f.close();
  }
});
test('没有本机记录不能伪造报告；损坏的计划指纹保留现场拒绝发布', async () => {
  const f = await restoreResultFixture();
  try {
    await assert.rejects(reportRestoreCheckpoint(f.home, f.target, noAsk, silent));
    assert.equal(f.list().items.length, 0);
    await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, { log: silent });
    const j = new RestoreJournal(f.home),
      row = j.row(f.target)!;
    const plan = JSON.parse(row.plan);
    plan.materializedBytes += 1;
    j.storage.db.prepare('UPDATE restores SET plan=? WHERE id=?').run(JSON.stringify(plan), row.id);
    j.close();
    await assert.rejects(
      reportRestoreCheckpoint(f.home, f.target, noAsk, silent),
      code('RESTORE_JOURNAL_INVALID'),
    );
    assert.equal(f.list().items.length, 0);
  } finally {
    await f.close();
  }
});
test('正在使用恢复日志时报告进程拒绝，不把活跃写入者误报为中断', async () => {
  const f = await restoreResultFixture();
  try {
    const p = await localRestoreCheckpoint(f.home, f.first.request.id, f.target, accept, {
      log: silent,
    });
    const guard = new RestoreJournal(f.home);
    try {
      await assert.rejects(
        reportRestoreCheckpoint(f.home, f.target, noAsk, silent),
        code('RUNNER_ALREADY_STARTED'),
      );
    } finally {
      guard.close();
    }
    assert.deepEqual(readRestoreProgress(f.home, f.target), p);
    assert.equal(f.list().items.length, 0);
  } finally {
    await f.close();
  }
});
test('实际CLI在发布确认时被终止，报告保留中断/未知及暂存核验时间，不推断已恢复', async () => {
  const f = await restoreResultFixture();
  try {
    const child = spawn(
      process.execPath,
      [
        resolve('dist/apps/runner/src/restore-checkpoint.js'),
        'restore',
        '--state',
        f.home,
        '--target',
        f.target,
        '--request',
        f.first.request.id,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } },
    );
    let output = '';
    let supplied = false;
    child.stdout.on('data', (v) => {
      output += v;
      if (!supplied && output.includes(`输入 RESTORE ${f.first.request.id}`)) {
        supplied = true;
        child.stdin.write(`RESTORE ${f.first.request.id}\n`);
      }
      if (output.includes('输入 PUBLISH')) child.kill('SIGKILL');
    });
    child.stderr.on('data', (v) => (output += v));
    const [, signal] = await once(child, 'close');
    assert.equal(signal, 'SIGKILL', output);
    const reported = await reportRestoreCheckpoint(f.home, f.target, accept, silent);
    assert.equal(reported.receipt.latest.report.state, 'interrupted');
    assert.equal(reported.receipt.latest.report.materialState, 'unknown');
    assert(reported.receipt.latest.report.verifiedAt);
    assert.equal(reported.currentFilesVerified, false);
  } finally {
    await f.close();
  }
});
