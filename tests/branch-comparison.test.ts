import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/db/src/store.js';
import { BranchComparisons } from '../packages/db/src/branch-comparison.js';
import { parseBranchChoice } from '../packages/contracts/src/branch-comparison.js';
import { branchResultFixture } from './helpers/branch-results.js';

async function ready() {
  const f = await branchResultFixture();
  for (let i = 0; i < 2; i++) {
    const run = f.begin(i);
    run.start();
    run.finish(i ? 'failed' : 'succeeded');
  }
  const versions: { resultId: string; revisionId: string; revision: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await f.api.call(f.path(i) + '/results', f.alice, await f.draft(i));
    assert.equal(r.statusCode, 201, r.body);
    versions.push(r.json() as { resultId: string; revisionId: string; revision: number });
  }
  const path = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}`;
  const body = (index: number | null, rev = 0) => ({
    expectedSelectionRevision: rev,
    branchId: index === null ? null : f.view.branches[index]!.id,
    resultRevisionId: index === null ? null : versions[index]!.revisionId,
    note: '用户明确选择',
  });
  return { ...f, versions, comparePath: path, choice: body };
}

test('选择契约只接收固定方案/版本与可选说明，不接受执行、合并或自动选择参数', () => {
  const b = {
    expectedSelectionRevision: 0,
    branchId: randomUUID(),
    resultRevisionId: randomUUID(),
    note: '',
  };
  assert.equal(parseBranchChoice(b).note, '');
  for (const extra of [
    { expectedSelectionRevision: -1 },
    { resultRevisionId: null },
    { branchId: null },
    { runId: randomUUID() },
    { merge: true },
    { stopOthers: true },
    { note: 'x'.repeat(2001) },
  ])
    assert.throws(() => parseBranchChoice({ ...b, ...extra }));
});

test('比较基于固定成果，选择固定到版本且后续保存不漂移，替换/取消保留完整记录', async () => {
  const f = await ready();
  try {
    const unaffected = [
      'tasks',
      'runs',
      'node_dispatches',
      'node_run_events',
      'work_branch_workspaces',
      'result_revisions',
    ];
    const snapshot = () =>
      unaffected.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    const first = await f.api.call(f.comparePath + '/selection', f.alice, f.choice(0));
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(snapshot(), before);
    assert.equal(f.read().branches[0]!.state, 'selected');
    assert.equal(f.read().branches[1]!.state, 'ready');
    const newVersion = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '未被选择的新版',
    });
    assert.equal(newVersion.statusCode, 201);
    const read = (await f.api.call(f.comparePath + '/comparison', f.alice)).json();
    assert.equal(read.work.selection.resultRevisionId, f.versions[0]!.revisionId);
    assert.equal(read.work.branches[0].state, 'selected');
    assert.equal(read.versions[f.view.branches[0]!.id].length, 2);
    assert.equal(read.work.branches[0].result.revision, 2);
    const second = await f.api.call(f.comparePath + '/selection', f.alice, f.choice(1, 1));
    assert.equal(second.statusCode, 200);
    assert.deepEqual(
      f.read().branches.map((b) => b.state),
      ['ready', 'selected'],
    );
    assert.equal(
      (await f.api.call(f.comparePath + '/selection', f.alice, f.choice(null, 2))).statusCode,
      200,
    );
    assert.deepEqual(
      f.read().branches.map((b) => b.state),
      ['ready', 'ready'],
    );
    const history = (await f.api.call(f.comparePath + '/comparison', f.alice)).json().choices;
    assert.deepEqual(
      history.map((c: { revision: number }) => c.revision),
      [3, 2, 1],
    );
    assert.equal(history[2].resultRevisionId, f.versions[0]!.revisionId);
    assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'in_progress');
  } finally {
    await f.close();
  }
});

test('另一方案/任务的成果与过期选择基线均拒绝，旧回执不会替换最新选择', async () => {
  const f = await ready();
  try {
    assert.equal(
      (
        await f.api.call(f.comparePath + '/selection', f.alice, {
          ...f.choice(0),
          resultRevisionId: f.versions[1]!.revisionId,
        })
      ).statusCode,
      404,
    );
    const other = await f.api.task(f.alice, f.project.id);
    assert.equal(
      (
        await f.api.call(
          `tasks/${other.id}/work-branches/groups/${f.view.group.id}/selection`,
          f.alice,
          f.choice(0),
        )
      ).statusCode,
      404,
    );
    const key = randomUUID();
    const first = await f.api.call(f.comparePath + '/selection', f.alice, f.choice(0), key);
    const conflict = await f.api.call(f.comparePath + '/selection', f.alice, f.choice(1));
    assert.equal(conflict.statusCode, 409);
    const second = await f.api.call(f.comparePath + '/selection', f.alice, f.choice(1, 1));
    assert.equal(second.statusCode, 200);
    assert.deepEqual(
      (await f.api.call(f.comparePath + '/selection', f.alice, f.choice(0), key)).json(),
      first.json(),
    );
    assert.equal(f.read().selection!.branchId, f.view.branches[1]!.id);
    assert.equal(
      (
        await f.api.call(
          f.comparePath + '/selection',
          f.alice,
          { ...f.choice(0), note: '换说明' },
          key,
        )
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('选择事件故障共同回滚旧选择/新选择、分支修订、outbox和回执', async () => {
  const f = await ready();
  try {
    await f.api.call(f.comparePath + '/selection', f.alice, f.choice(0));
    const tables = [
      'work_branch_choices',
      'work_branches',
      'work_branch_events',
      'outbox',
      'idempotency_records',
    ];
    const state = () =>
      tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = state(),
      key = randomUUID();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_choice BEFORE INSERT ON work_branch_events WHEN json_extract(NEW.body,'$.action')='result_selected' BEGIN SELECT RAISE(ABORT,'fixture choice failure'); END;",
    );
    assert.equal(
      (await f.api.call(f.comparePath + '/selection', f.alice, f.choice(1, 1), key)).statusCode,
      500,
    );
    assert.deepEqual(state(), before);
    f.api.store.db.exec('DROP TRIGGER fail_choice');
    assert.equal(
      (await f.api.call(f.comparePath + '/selection', f.alice, f.choice(1, 1), key)).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test('选择已有成果不会停止另一方案的未知进程，也不能选择尚无成果的方案', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin(),
      b = f.begin(1);
    a.start();
    b.start();
    a.finish();
    b.send('unknown', '未知进程保留');
    const saved = (await f.api.call(f.path() + '/results', f.alice, await f.draft())).json();
    const path = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`;
    const before = f.as(() => f.api.store.run(b.run.id));
    const body = {
      expectedSelectionRevision: 0,
      branchId: f.view.branches[0]!.id,
      resultRevisionId: saved.revisionId,
      note: '',
    };
    assert.equal((await f.api.call(path, f.alice, body)).statusCode, 200);
    assert.deepEqual(
      f.as(() => f.api.store.run(b.run.id)),
      before,
    );
    assert.equal(
      (
        await f.api.call(path, f.alice, {
          ...body,
          expectedSelectionRevision: 1,
          branchId: f.view.branches[1]!.id,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('选择记录跨重启保留，当前读取/写权限仍在旧回执前验证', async () => {
  const f = await ready();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const key = randomUUID(),
      first = await f.api.call(f.comparePath + '/selection', f.bob, f.choice(0), key);
    assert.equal(first.statusCode, 200);
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      const found = reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        new BranchComparisons(reopened).get(f.task.id, f.view.group.id),
      );
      assert.deepEqual(found.work.selection, first.json());
      assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.throws(
        () =>
          reopened.db
            .prepare('DELETE FROM work_branch_choices WHERE group_id=?')
            .run(f.view.group.id),
        /immutable/,
      );
    } finally {
      reopened.close();
    }
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(f.comparePath + '/comparison', f.bob)).statusCode, 200);
    assert.equal(
      (await f.api.call(f.comparePath + '/selection', f.bob, f.choice(0), key)).statusCode,
      403,
    );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    assert.equal((await f.api.call(f.comparePath + '/comparison', f.bob)).statusCode, 404);
    assert.equal(
      (await f.api.call(f.comparePath + '/selection', f.bob, f.choice(0), key)).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
