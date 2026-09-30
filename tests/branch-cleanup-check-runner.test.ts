import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { branchWorkspaceFixture, branchCli } from './helpers/branch-workspace.js';
import { git } from './helpers/checkpoint-retention.js';
import { publishLocalCheckpoint } from '../apps/runner/src/agent/checkpoints.js';
import { localRetentionOperation } from '../apps/runner/src/agent/checkpoint-retention.js';
import { checkBranchCleanup } from '../apps/runner/src/agent/branch-cleanup-check.js';
import { AgentStorage } from '../apps/runner/src/agent/storage.js';
import { ExecutionJournal } from '../apps/runner/src/agent/execution-journal.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';

async function ready(format: 'sha1' | 'sha256' = 'sha1') {
  const f = await branchWorkspaceFixture(format);
  try {
    const p = await f.prepare();
    const c = await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const home = p.p.git!.nodeState!,
      commit = git(p.target, 'rev-parse', 'HEAD');
    const task = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    const r = await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
      nodeId: c.nodeId,
      workspaceId: c.directories[0]!.id,
      commit,
      label: '清理前固定保留起点',
      expectedTaskRevision: task.revision,
      confirmReference: true,
    });
    assert.equal(r.statusCode, 201, r.body);
    const cp = await publishLocalCheckpoint(
      home,
      r.json().id,
      async () => `CHECKPOINT ${commit}`,
      () => {},
    );
    const retained = await f.api.call(
      `tasks/${f.task.id}/checkpoints/${cp.checkpointId}/retentions`,
      f.alice,
      { days: 7, expectedTaskRevision: task.revision, confirmLocalRetention: true },
    );
    assert.equal(retained.statusCode, 201, retained.body);
    const retentionId = retained.json().request.id;
    await localRetentionOperation(
      home,
      retentionId,
      'retain',
      async () => `RETAIN ${commit} 7`,
      () => {},
    );
    const preview = (await f.api.call(p.path + '/discard-preview', f.alice)).json();
    const discarded = await f.api.call(p.path + '/discard-preserving', f.alice, {
      expectedRevision: preview.branch.revision,
      expectedTaskRevision: preview.taskRevision,
      confirmPreserveWorkspace: true,
      confirmExecutionContinues: true,
    });
    assert.equal(discarded.statusCode, 200, discarded.body);
    const selection = {
      branchId: p.branch.id,
      expectedRevision: (await f.read()).branches[0]!.revision,
      expectedTaskRevision: task.revision,
      retentionId,
    };
    return { ...f, p, c, home, commit, selection, yes: async () => `CHECK_BRANCH ${p.branch.id}` };
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function preserved(f: Awaited<ReturnType<typeof ready>>) {
  const paths = [
    join(f.p.target, 'README.md'),
    join(f.p.target, 'src/binary.dat'),
    join(f.p.target, '.git/HEAD'),
    join(f.p.target, '.git/index'),
    join(f.home, 'credentials.json'),
    join(f.root, 'README.md'),
    join(f.root, '.git/index'),
  ];
  const bytes = await Promise.all(paths.map((p) => readFile(p)));
  return async () => assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), bytes);
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format}真实已登记方案核对完整副本与当前文件，重复不删代码/解绑/改HEAD或凭证`, async () => {
    const f = await ready(format);
    try {
      const unchanged = await preserved(f),
        first = await checkBranchCleanup(f.home, f.selection, f.yes, () => {});
      assert.equal(first.cleanSnapshotVerified, true);
      assert.equal(first.retainedSnapshotVerified, true);
      assert.equal(first.deletionAuthorized, false);
      assert.equal(first.workspaceReserved, false);
      assert.equal(first.unmanagedProcessesStopped, false);
      assert.equal(
        (await checkBranchCleanup(f.home, f.selection, f.yes, () => {})).snapshotHash,
        first.snapshotHash,
      );
      await unchanged();
      assert.equal((await f.read()).branches[0]!.workspace!.state, 'bound');
      const later = new WorkspaceLease(f.p.target, 'later-writer-' + randomUUID());
      later.release();
      const cli = await branchCli(
        'branch-cleanup-check.js',
        [
          '--branch',
          f.selection.branchId,
          '--revision',
          String(f.selection.expectedRevision),
          '--task-revision',
          String(f.selection.expectedTaskRevision),
          '--retention',
          f.selection.retentionId,
          '--state',
          f.home,
        ],
        `CHECK_BRANCH ${f.selection.branchId}\n`,
      );
      assert.equal(cli.status, 0, cli.output);
      assert.match(cli.output, /"deletionAuthorized":false/);
      await unchanged();
    } finally {
      await f.close();
    }
  });
test('清理前取消与当前撤权均保留用户现场，不取得后续删除许可', async () => {
  const f = await ready();
  try {
    const unchanged = await preserved(f);
    await assert.rejects(
      checkBranchCleanup(
        f.home,
        f.selection,
        async () => '',
        () => {},
      ),
      { code: 'CONFIRMATION_REQUIRED' },
    );
    await unchanged();
    await assert.rejects(
      checkBranchCleanup(
        f.home,
        f.selection,
        async () => {
          const node = (await f.api.call('nodes', f.alice))
            .json()
            .items.find((n: { id: string }) => n.id === f.c.nodeId);
          const r = await f.api.call(`nodes/${f.c.nodeId}/revoke`, f.alice, {
            expectedRevision: node.revision,
          });
          assert.equal(r.statusCode, 200, r.body);
          return f.yes();
        },
        () => {},
      ),
      { code: 'NODE_REVOKED' },
    );
    await unchanged();
  } finally {
    await f.close();
  }
});
for (const kind of ['modified', 'staged', 'untracked', 'ignored'] as const)
  test(`${kind}用户未保存内容明确阻止清理前核对且不回滚/暂存/删除`, async () => {
    const f = await ready();
    try {
      let path = join(f.p.target, 'README.md');
      if (kind === 'untracked' || kind === 'ignored') path = join(f.p.target, 'private-user.txt');
      if (kind === 'ignored') {
        await mkdir(join(f.p.target, '.git/info'), { recursive: true });
        await writeFile(join(f.p.target, '.git/info/exclude'), 'private-user.txt\n');
      }
      await writeFile(path, 'KEEP PRIVATE UNSAVED CONTENT');
      if (kind === 'staged') git(f.p.target, 'add', 'README.md');
      const unchanged = await preserved(f),
        user = await readFile(path);
      await assert.rejects(
        checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
        { code: 'WORKSPACE_COMMIT_CHANGED' },
      );
      await unchanged();
      assert.deepEqual(await readFile(path), user);
    } finally {
      await f.close();
    }
  });
test('本机进程守卫与未知/后来的目录claim均阻止核对，不据日志缺失清锁', async () => {
  const f = await ready();
  try {
    const unchanged = await preserved(f),
      storage = new AgentStorage(f.home);
    try {
      await assert.rejects(
        checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
        { code: 'RUNNER_ALREADY_STARTED' },
      );
    } finally {
      storage.close();
    }
    const claim = new WorkspaceLease(f.p.target, 'unknown-fixture-writer');
    try {
      await assert.rejects(
        checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
        { code: 'RESULT_CODE_WRITER_ACTIVE' },
      );
      claim.assertHeld();
      await unchanged();
    } finally {
      claim.release();
    }
  } finally {
    await f.close();
  }
});
test('独立副本损坏不能从仍存在的原目录修补，原文件与凭证保持', async () => {
  const f = await ready();
  try {
    const unchanged = await preserved(f),
      db = new DatabaseSync(join(f.home, 'retained-checkpoints/journal.sqlite'));
    try {
      db.prepare("UPDATE objects SET data=? WHERE bundle_id=? AND type='blob'").run(
        Buffer.from('CORRUPT'),
        f.selection.retentionId,
      );
    } finally {
      db.close();
    }
    await assert.rejects(
      checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
      { code: 'SNAPSHOT_INCOMPLETE' },
    );
    await unchanged();
  } finally {
    await f.close();
  }
});
test('原Git目录被替换时拒绝，保留后来目录与原目录，不把同字节当同身份', async () => {
  const f = await ready();
  try {
    const originalHead = await readFile(join(f.p.target, '.git/HEAD'));
    await rename(join(f.p.target, '.git'), join(f.p.target, '.git-original'));
    git(f.p.target, 'init', '-q');
    const before = await readFile(join(f.p.target, '.git/HEAD'));
    await assert.rejects(
      checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
      { code: 'BRANCH_CLEANUP_SCOPE_CHANGED' },
    );
    assert.deepEqual(await readFile(join(f.p.target, '.git/HEAD')), before);
    assert.deepEqual(await readFile(join(f.p.target, '.git-original/HEAD')), originalHead);
  } finally {
    await f.close();
  }
});
test('终态仍有待发执行证据时拒绝，保留精确原包与凭证', async () => {
  const f = await ready();
  try {
    const unchanged = await preserved(f),
      s = new AgentStorage(f.home),
      id = randomUUID();
    new ExecutionJournal(s);
    s.db
      .prepare('INSERT INTO execution_commands VALUES(?,?,?)')
      .run(id, JSON.stringify({ id }), 'terminal');
    s.db
      .prepare('INSERT INTO execution_events VALUES(?,?,?,?)')
      .run(id, 1, JSON.stringify({ sequence: 1, kind: 'terminal' }), 0);
    s.close();
    await assert.rejects(
      checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
      { code: 'EXECUTION_UNSETTLED' },
    );
    const db = new DatabaseSync(join(f.home, 'journal.sqlite'), { readOnly: true });
    try {
      assert.equal(
        db.prepare('SELECT acknowledged FROM execution_events WHERE dispatch_id=?').get(id)!
          .acknowledged,
        0,
      );
    } finally {
      db.close();
    }
    await unchanged();
  } finally {
    await f.close();
  }
});
test('最终授权读取期间用户再编辑会使核对失败，不返回过时的完整现场观察', async () => {
  const f = await ready(),
    originalFetch = globalThis.fetch;
  try {
    let inspections = 0;
    const path = join(f.p.target, 'README.md');
    globalThis.fetch = async (...args) => {
      if (String(args[0]).endsWith('/runner/v1/branch-cleanup-inspect') && ++inspections === 3)
        await writeFile(path, 'KEEP EDIT DURING FINAL AUTHORITY READ');
      return originalFetch(...args);
    };
    await assert.rejects(
      checkBranchCleanup(f.home, f.selection, f.yes, () => {}),
      { code: 'WORKSPACE_COMMIT_CHANGED' },
    );
    assert.equal(inspections, 3);
    assert.equal(await readFile(path, 'utf8'), 'KEEP EDIT DURING FINAL AUTHORITY READ');
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});
