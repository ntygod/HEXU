import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BranchPreservations } from '../packages/db/src/branch-preservation.js';
import {
  parseBranchPreservationCreate,
  parseBranchPreservationReport,
  type BranchPreservationReport,
  type BranchPreservationView,
} from '../packages/contracts/src/branch-preservation.js';
import { branchCleanupFixture } from './helpers/branch-cleanup-check.js';

type Fixture = Awaited<ReturnType<typeof branchCleanupFixture>>;
const createBody = (f: Fixture) => {
  const { branchId: _id, ...selection } = f.selection();
  return { ...selection, confirmMoveCompleteDirectory: true, confirmKeepGitAndContents: true };
};
const report = (
  v: BranchPreservationView,
  sequence: 1 | 2,
  stage: BranchPreservationReport['stage'],
  destinationRef: string = randomUUID(),
): BranchPreservationReport => ({
  version: 1,
  kind: 'branch_directory_preservation',
  preservationId: v.request.id,
  inputHash: v.request.inputHash,
  sequence,
  stage,
  reason:
    stage === 'moving'
      ? 'move_prepared'
      : stage === 'preserved'
        ? 'directory_preserved'
        : stage === 'failed'
          ? 'preconditions_changed'
          : 'move_unknown',
  evidenceHash: (sequence === 1 ? 'a' : 'b').repeat(64),
  destinationRef,
  observedAt: new Date().toISOString(),
  confirmPublication: true,
});
async function create(f: Fixture) {
  const r = await f.api.call(f.path() + '/preservations', f.alice, createBody(f));
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as BranchPreservationView;
}
test('移出保留许可与检查不同，严格确认完整.git和内容；没有删除/任意路径/权限参数', () => {
  const good = {
    expectedRevision: 3,
    expectedTaskRevision: 1,
    retentionId: randomUUID(),
    confirmMoveCompleteDirectory: true,
    confirmKeepGitAndContents: true,
  };
  assert.equal(parseBranchPreservationCreate(good).confirmKeepGitAndContents, true);
  for (const patch of [
    { confirmKeepGitAndContents: false },
    { confirmMoveCompleteDirectory: false },
    { delete: true },
    { target: '/private' },
    { force: true },
    { release: true },
  ])
    assert.throws(() => parseBranchPreservationCreate({ ...good, ...patch }));
  const r = report(
    { request: { id: randomUUID(), inputHash: 'c'.repeat(64) } } as BranchPreservationView,
    1,
    'moving',
  );
  assert.deepEqual(parseBranchPreservationReport(r), r);
  for (const patch of [
    { stage: 'preserved' },
    { reason: 'directory_preserved' },
    { path: '/private' },
    { confirmPublication: false },
    { sequence: 3 },
  ])
    assert.throws(() => parseBranchPreservationReport({ ...r, ...patch }));
});
test('固定移出请求/两个不可变报告独立记录，原目录绑定/成果/权限/Run不改变，重复只回原收据', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const tableNames = [
      'work_branches',
      'work_branch_groups',
      'work_branch_workspaces',
      'runs',
      'node_dispatches',
      'runner_nodes',
      'checkpoint_retentions',
      'result_revisions',
    ];
    const snapshot = () =>
      tableNames.map((t) => f.api.store.db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot(),
      body = createBody(f),
      key = randomUUID();
    const response = await f.api.call(f.path() + '/preservations', f.alice, body, key);
    assert.equal(response.statusCode, 201, response.body);
    const v = response.json() as BranchPreservationView,
      store = new BranchPreservations(f.api.store);
    assert.equal(v.canBegin, true);
    assert.equal(v.executionRegistrationClosed, false);
    assert.deepEqual(v.request.scope.branch.workingCopyId, f.ns[0]!.workspace);
    assert.equal(
      (await f.api.call(f.path() + '/preservations', f.alice, body, key)).json().request.id,
      v.request.id,
    );
    assert.equal((await f.api.call(f.path() + '/preservations', f.alice, body)).statusCode, 409);
    const begin = report(v, 1, 'moving'),
      ack = store.publish(f.ns[0]!.token, begin);
    assert.deepEqual(store.publish(f.ns[0]!.token, begin), ack);
    const end = report(v, 2, 'preserved', begin.destinationRef),
      done = store.publish(f.ns[0]!.token, end);
    assert.deepEqual(store.publish(f.ns[0]!.token, end), done);
    const current = store.inspect(f.ns[0]!.token, v.request.id);
    assert.equal(current.state, 'preserved');
    assert.equal(current.executionRegistrationClosed, true);
    assert.equal(current.canBegin, false);
    assert.equal(current.reports.length, 2);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      (await f.api.call(f.path() + '/cleanup-options', f.alice)).json().canInspect,
      false,
    );
    assert.throws(() => store.publish(f.ns[0]!.token, { ...end, evidenceHash: 'e'.repeat(64) }), {
      code: 'BRANCH_PRESERVATION_REPORT_CHANGED',
    });
    assert.equal((await f.api.call(f.path() + '/preservations', f.alice, body)).statusCode, 409);
    assert.throws(() => f.begin(), { code: 'WORK_BRANCH_DISCARDED' });
  } finally {
    await f.close();
  }
});
test('取消只关闭尚未开始的请求，可另行新请求；节点开始后不能用取消撤回移动', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const first = await create(f),
      path = f.path() + '/preservations/' + first.request.id + '/cancel',
      key = randomUUID();
    assert.equal(
      (await f.api.call(path, f.alice, { expectedRevision: first.revision }, key)).statusCode,
      200,
    );
    assert.equal(
      (await f.api.call(path, f.alice, { expectedRevision: first.revision }, key)).statusCode,
      200,
    );
    const store = new BranchPreservations(f.api.store);
    assert.throws(() => store.publish(f.ns[0]!.token, report(first, 1, 'moving')), {
      code: 'BRANCH_PRESERVATION_CLOSED',
    });
    const second = await create(f);
    assert.notEqual(second.request.id, first.request.id);
    store.publish(f.ns[0]!.token, report(second, 1, 'moving'));
    const running = store.inspect(f.ns[0]!.token, second.request.id);
    assert.equal(
      (
        await f.api.call(f.path() + '/preservations/' + second.request.id + '/cancel', f.alice, {
          expectedRevision: running.revision,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test('终态不能跳过开始、改保留位置或覆盖原报告；未知现场继续阻止新请求', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const v = await create(f),
      store = new BranchPreservations(f.api.store),
      begin = report(v, 1, 'moving');
    assert.throws(
      () => store.publish(f.ns[0]!.token, report(v, 2, 'preserved', begin.destinationRef)),
      { code: 'BRANCH_PRESERVATION_REPORT_INVALID' },
    );
    store.publish(f.ns[0]!.token, begin);
    assert.throws(() => store.publish(f.ns[0]!.token, report(v, 2, 'preserved')), {
      code: 'BRANCH_PRESERVATION_REPORT_INVALID',
    });
    store.publish(f.ns[0]!.token, report(v, 2, 'needs_attention', begin.destinationRef));
    assert.equal(store.inspect(f.ns[0]!.token, v.request.id).state, 'needs_attention');
    assert.equal(
      (await f.api.call(f.path() + '/preservations', f.alice, createBody(f))).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test('旧修订/错误节点/撤权阻止开始；完成历史报告不借旧请求绕过当前权限', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const v = await create(f),
      store = new BranchPreservations(f.api.store);
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    assert.equal(store.inspect(f.ns[0]!.token, v.request.id).canBegin, false);
    assert.throws(() => store.publish(f.ns[0]!.token, report(v, 1, 'moving')), {
      code: 'REVISION_CONFLICT',
    });
    assert.throws(() => store.inspect(f.ns[1]!.token, v.request.id), { code: 'NOT_FOUND' });
    assert.equal(
      (await f.api.call(f.path() + '/preservations', f.bob, createBody(f))).statusCode,
      404,
    );
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.throws(() => store.inspect(f.ns[0]!.token, v.request.id), { code: 'NODE_REVOKED' });
    assert.throws(() => store.publish(f.ns[0]!.token, report(v, 1, 'failed')), {
      code: 'NODE_REVOKED',
    });
  } finally {
    await f.close();
  }
});
test('移动开始后副本删除不抹掉真实完成证据；保留源记录、权限及原字节指纹', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const v = await create(f),
      store = new BranchPreservations(f.api.store),
      begin = report(v, 1, 'moving');
    store.publish(f.ns[0]!.token, begin);
    f.api.store.db
      .prepare("UPDATE checkpoint_retentions SET state='deleted' WHERE id=?")
      .run(f.material.request.id);
    assert.equal(store.inspect(f.ns[0]!.token, v.request.id).canBegin, false);
    const terminal = report(v, 2, 'preserved', begin.destinationRef);
    store.publish(f.ns[0]!.token, terminal);
    assert.equal(store.inspect(f.ns[0]!.token, v.request.id).state, 'preserved');
  } finally {
    await f.close();
  }
});
test('请求和报告outbox故障均原子回滚，精确原请求/报告不能更新删除', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const key = randomUUID(),
      body = createBody(f);
    f.api.store.db.exec(
      "CREATE TRIGGER reject_preserve_outbox BEFORE INSERT ON outbox WHEN NEW.kind LIKE 'branch.preservation.%' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    assert.equal(
      (await f.api.call(f.path() + '/preservations', f.alice, body, key)).statusCode,
      500,
    );
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservations').get()!.n, 0);
    f.api.store.db.exec('DROP TRIGGER reject_preserve_outbox');
    const r = await f.api.call(f.path() + '/preservations', f.alice, body, key);
    assert.equal(r.statusCode, 201, r.body);
    const v = r.json() as BranchPreservationView,
      store = new BranchPreservations(f.api.store);
    f.api.store.db.exec(
      "CREATE TRIGGER reject_preserve_outbox BEFORE INSERT ON outbox WHEN NEW.kind LIKE 'branch.preservation.%' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    assert.throws(() => store.publish(f.ns[0]!.token, report(v, 1, 'moving')));
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservation_reports').get()!.n,
      0,
    );
    assert.equal(
      f.api.store.db.prepare('SELECT state FROM branch_preservations').get()!.state,
      'requested',
    );
    f.api.store.db.exec('DROP TRIGGER reject_preserve_outbox');
    store.publish(f.ns[0]!.token, report(v, 1, 'moving'));
    assert.throws(() =>
      f.api.store.db
        .prepare('UPDATE branch_preservations SET body=? WHERE id=?')
        .run('{}', v.request.id),
    );
    assert.throws(() =>
      f.api.store.db
        .prepare('DELETE FROM branch_preservation_reports WHERE preservation_id=?')
        .run(v.request.id),
    );
  } finally {
    await f.close();
  }
});
