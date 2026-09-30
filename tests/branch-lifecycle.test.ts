import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  parseWorkBranchDiscardPreserving,
  type WorkBranchDiscardPreview,
} from '../packages/contracts/src/work-branch-lifecycle.js';
import { Store } from '../packages/db/src/store.js';
import { WorkBranchStore } from '../packages/db/src/work-branches.js';
import { branchResultFixture } from './helpers/branch-results.js';
type Fixture = Awaited<ReturnType<typeof branchResultFixture>>;
const path = (f: Fixture, index = 0) => f.path(index) + '/discard-preserving';
async function preview(f: Fixture, index = 0) {
  const r = await f.api.call(f.path(index) + '/discard-preview', f.alice);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as WorkBranchDiscardPreview;
}
async function body(f: Fixture, index = 0) {
  const v = await preview(f, index);
  return {
    expectedRevision: v.branch.revision,
    expectedTaskRevision: v.taskRevision,
    confirmPreserveWorkspace: true,
    confirmExecutionContinues: true,
  };
}
const snapshot = (f: Fixture, tables: string[]) =>
  tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
const untouched = [
  'tasks',
  'runs',
  'node_dispatches',
  'node_run_events',
  'runner_nodes',
  'work_branch_groups',
  'work_branch_workspaces',
  'work_branch_choices',
  'result_revisions',
];
test('保留现场放弃契约只允许明确两项确认和修订，不接收停止/路径/删除/选择参数', () => {
  const good = {
    expectedRevision: 2,
    expectedTaskRevision: 1,
    confirmPreserveWorkspace: true,
    confirmExecutionContinues: true,
  };
  assert.deepEqual(parseWorkBranchDiscardPreserving(good), good);
  for (const change of [
    { confirmPreserveWorkspace: false },
    { confirmExecutionContinues: false },
    { expectedRevision: 0 },
    { stop: true },
    { deleteFiles: true },
    { force: true },
    { path: '/private' },
    { runId: 'other' },
    { clearChoice: true },
  ])
    assert.throws(() => parseWorkBranchDiscardPreserving({ ...good, ...change }));
});
test('已登记未运行方案可明确放弃且全部现场/授权保持，旧planned入口不升级许可', async () => {
  const f = await branchResultFixture();
  try {
    const old = f.read(),
      request = await body(f),
      before = snapshot(f, untouched);
    assert.equal((await preview(f)).canDiscard, true);
    assert.equal(
      (
        await f.api.call(f.path() + '/discard', f.alice, {
          expectedRevision: request.expectedRevision,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(path(f), f.alice, { expectedRevision: request.expectedRevision }))
        .statusCode,
      400,
    );
    const key = randomUUID(),
      r = await f.api.call(path(f), f.alice, request, key);
    assert.equal(r.statusCode, 200, r.body);
    const current = f.read();
    assert.equal(current.branches[0]!.state, 'discarded');
    assert.equal(current.branches[0]!.workingCopyId, old.branches[0]!.workingCopyId);
    assert.equal(current.branches[0]!.runId, null);
    assert.deepEqual(current.branches[1], old.branches[1]);
    assert.deepEqual(snapshot(f, untouched), before);
    assert.equal((await preview(f)).canDiscard, false);
    const history = (await f.api.call(f.path() + '/history', f.alice)).json().items;
    assert.equal(history.at(-1).action, 'discard_preserving');
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 200);
    assert.equal(f.read().branches[0]!.revision, current.branches[0]!.revision);
    assert.throws(() => f.begin(), { code: 'WORK_BRANCH_DISCARDED' });
  } finally {
    await f.close();
  }
});
test('放弃已启动但连接未知的方案不停止它或同伴；独立停止仍需终止确认，保存终态成果不复活方案', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin(),
      b = f.begin(1, 'codex');
    a.start();
    b.start();
    a.send('output', 'KEEP DISCARDED RUN OUTPUT');
    // This protocol fixture and the HTTP app have distinct registry epochs.
    // Settle the intended connection-unknown observation before the immutability
    // baseline, rather than racing the app's independent 250ms reconciliation.
    for (const node of f.ns) f.nodes.goodbye(node.token, node.connection);
    f.execution.reconcile();
    for (const branch of f.read().branches) {
      assert.equal(branch.run!.state, 'running');
      assert.equal(branch.run!.observation, 'unknown');
      assert.equal(f.as(() => f.api.store.run(branch.run!.id)).node!.terminationConfirmed, false);
    }
    const request = await body(f),
      before = snapshot(f, untouched);
    f.execution.reconcile();
    assert.deepEqual(snapshot(f, untouched), before);
    const r = await f.api.call(path(f), f.alice, request);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(snapshot(f, untouched), before);
    let branch = f.read().branches[0]!;
    assert.equal(branch.state, 'discarded');
    assert.equal(branch.run!.state, 'running');
    assert.equal((await f.api.call(`runs/${a.run.id}/stop`, f.alice, {})).statusCode, 200);
    branch = f.read().branches[0]!;
    assert.equal(branch.state, 'discarded');
    assert.equal(branch.run!.state, 'stopping');
    assert.equal(f.read().branches[1]!.run!.state, 'running');
    assert.notEqual((await f.api.call(f.path() + '/result-preview', f.alice)).statusCode, 200);
    a.finish('cancelled', 'KEEP FINISHED OUTPUT');
    const saved = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    assert.equal(saved.statusCode, 201, saved.body);
    const version = (
      await f.api.call(
        `results/${saved.json().resultId}/versions/${saved.json().revisionId}`,
        f.alice,
      )
    ).json().version;
    assert.equal(version.source.run.state, 'cancelled');
    assert(version.source.output.text.includes('KEEP FINISHED OUTPUT'));
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.equal(f.read().branches[0]!.resultId, saved.json().resultId);
    assert.equal(f.read().branches[1]!.run!.state, 'running');
    assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'in_progress');
  } finally {
    await f.close();
  }
});
test('既有首轮请求的迟到启动/终态不取消放弃历史，新执行仍被拒绝', async () => {
  const f = await branchResultFixture();
  try {
    const run = f.begin(),
      request = await body(f);
    assert.equal((await f.api.call(path(f), f.alice, request)).statusCode, 200);
    const discardedRevision = f.read().branches[0]!.revision;
    run.start();
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.equal(f.read().branches[0]!.revision, discardedRevision);
    assert.equal(f.read().branches[0]!.run!.state, 'running');
    run.finish();
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.throws(() => f.begin(), { code: 'WORK_BRANCH_DISCARDED' });
  } finally {
    await f.close();
  }
});
test('当前选用方案必须先明确取消选择；原成果版本/选择历史/回执不被放弃抹除', async () => {
  const f = await branchResultFixture();
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const saved = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    assert.equal(saved.statusCode, 201, saved.body);
    const versionPath = `results/${saved.json().resultId}/versions/${saved.json().revisionId}`,
      original = (await f.api.call(versionPath, f.alice)).json().version;
    const choicePath = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`,
      key = randomUUID();
    const selected = {
      expectedSelectionRevision: 0,
      branchId: f.view.branches[0]!.id,
      resultRevisionId: saved.json().revisionId,
      note: '选择固定成果',
    };
    assert.equal((await f.api.call(choicePath, f.alice, selected, key)).statusCode, 200);
    const denied = await preview(f);
    assert.equal(denied.canDiscard, false);
    assert.match(denied.unavailableReason!, /先.*取消|替换/);
    const rejected = await f.api.call(path(f), f.alice, await body(f));
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, 'WORK_BRANCH_SELECTED');
    assert.equal(
      (
        await f.api.call(choicePath, f.alice, {
          expectedSelectionRevision: 1,
          branchId: null,
          resultRevisionId: null,
          note: '明确取消再放弃',
        })
      ).statusCode,
      200,
    );
    const before = snapshot(f, untouched),
      r = await f.api.call(path(f), f.alice, await body(f));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(snapshot(f, untouched), before);
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.equal((await f.api.call(choicePath, f.alice, selected, key)).statusCode, 200);
    assert.equal(f.read().selection!.branchId, null);
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.equal(
      (await f.api.call(choicePath, f.alice, { ...selected, expectedSelectionRevision: 2 }))
        .statusCode,
      409,
    );
    assert.deepEqual((await f.api.call(versionPath, f.alice)).json().version, original);
  } finally {
    await f.close();
  }
});
test('旧分支/Task修订和未完成现场准备拒绝，更新不默认丢弃或取消准备', async () => {
  const f = await branchResultFixture();
  try {
    const request = await body(f);
    for (const change of [{ expectedRevision: 1 }, { expectedTaskRevision: 99 }])
      assert.equal((await f.api.call(path(f), f.alice, { ...request, ...change })).statusCode, 409);
    const b = f.read().branches[0]!,
      op = b.workspace!;
    op.state = 'prepared';
    f.api.store.db
      .prepare("UPDATE work_branch_workspaces SET state='prepared',body=? WHERE id=?")
      .run(JSON.stringify(op), op.ticket.id);
    const before = snapshot(f, untouched);
    assert.equal((await preview(f)).canDiscard, false);
    assert.equal((await f.api.call(path(f), f.alice, request)).statusCode, 409);
    assert.deepEqual(snapshot(f, untouched), before);
  } finally {
    await f.close();
  }
});
test('分支/事件/outbox/幂等回执任一步失败整体回滚；同key换正文不覆盖历史', async () => {
  const f = await branchResultFixture();
  try {
    const request = await body(f),
      tables = [
        'work_branches',
        'work_branch_events',
        'outbox',
        'idempotency_records',
        ...untouched,
      ];
    for (const [table, action] of [
      ['work_branches', 'UPDATE'],
      ['work_branch_events', 'INSERT'],
      ['outbox', 'INSERT'],
      ['idempotency_records', 'INSERT'],
    ]) {
      const before = snapshot(f, tables),
        key = randomUUID();
      f.api.store.db.exec(
        `CREATE TRIGGER lifecycle_fixture_failure BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
      );
      assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 500);
      assert.deepEqual(snapshot(f, tables), before);
      f.api.store.db.exec('DROP TRIGGER lifecycle_fixture_failure');
    }
    const key = randomUUID();
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 200);
    assert.equal(
      (
        await f.api.call(
          path(f),
          f.alice,
          { ...request, expectedRevision: request.expectedRevision + 1 },
          key,
        )
      ).statusCode,
      409,
    );
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('当前Task编辑权覆盖预览、创建和旧回执；跨Task与降权不可借保留现场扩大权限', async () => {
  const f = await branchResultFixture();
  try {
    const request = await body(f),
      key = randomUUID();
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 200);
    assert.equal((await f.api.call(f.path() + '/discard-preview', f.bob)).statusCode, 404);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(f.path() + '/discard-preview', f.bob)).statusCode, 403);
    assert.equal((await f.api.call(path(f), f.bob, request, key)).statusCode, 403);
    const other = await f.api.task(f.alice, f.project.id);
    assert.equal(
      (
        await f.api.call(
          `tasks/${other.id}/work-branches/${f.view.branches[0]!.id}/discard-preserving`,
          f.alice,
          request,
          key,
        )
      ).statusCode,
      404,
    );
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    assert.equal((await f.api.call(f.path() + '/discard-preview', f.alice)).statusCode, 403);
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 403);
    assert.equal(f.read().branches[0]!.state, 'discarded');
  } finally {
    await f.close();
  }
});

test('未知执行仍可标记放弃但不伪造终止或清理，固定成果继续拒绝未知来源', async () => {
  const f = await branchResultFixture();
  try {
    const run = f.begin();
    run.send('unknown', 'UNCONFIRMED WRITER');
    const before = snapshot(f, untouched),
      observed = f.read().branches[0]!.run!;
    assert.equal(observed.observation, 'unknown');
    const r = await f.api.call(path(f), f.alice, await body(f));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(snapshot(f, untouched), before);
    assert.deepEqual(f.read().branches[0]!.run, observed);
    assert.equal(f.read().branches[0]!.state, 'discarded');
    assert.equal((await f.api.call(f.path() + '/result-preview', f.alice)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('保留现场放弃和原回执跨SQLite重开保持，不初始化新执行或重放状态变更', async () => {
  const f = await branchResultFixture();
  try {
    const request = await body(f),
      key = randomUUID();
    assert.equal((await f.api.call(path(f), f.alice, request, key)).statusCode, 200);
    const before = f.read(),
      reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const actual = reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        new WorkBranchStore(reopened).discardPreserving(
          f.task.id,
          f.view.branches[0]!.id,
          request,
          key,
        ),
      );
      assert.deepEqual(actual, before);
      assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
