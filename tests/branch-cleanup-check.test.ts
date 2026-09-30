import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseBranchCleanupSelection } from '../packages/contracts/src/branch-cleanup-check.js';
import { BranchCleanupChecks } from '../packages/db/src/branch-cleanup-check.js';
import { branchCleanupFixture } from './helpers/branch-cleanup-check.js';
import { branchCleanupCommand } from '../apps/web/src/branch-cleanup-command.js';

test('清理前核对契约没有路径/删除/释放许可，修订和副本必须明确', () => {
  const good = {
    branchId: randomUUID(),
    expectedRevision: 3,
    expectedTaskRevision: 2,
    retentionId: randomUUID(),
  };
  assert.deepEqual(parseBranchCleanupSelection(good), good);
  assert.equal(
    branchCleanupCommand(good),
    `npm run runner:branch-cleanup-check -- --branch '${good.branchId}' --revision 3 --task-revision 2 --retention '${good.retentionId}' --state '<原方案节点状态目录>'`,
  );
  for (const patch of [
    { delete: true },
    { path: '/private' },
    { force: true },
    { release: true },
    { expectedRevision: 0 },
    { retentionId: '../other' },
  ])
    assert.throws(() => parseBranchCleanupSelection({ ...good, ...patch }));
});
test('同目录筛选在限额前，其他方案的新引用不能挤走有效原现场副本', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const cp = f.view.group.start.checkpoint;
    for (let i = 0; i < 55; i++) {
      const id = randomUUID(),
        requestId = randomUUID();
      const request = {
        ...cp.request,
        id: requestId,
        nodeId: f.ns[1]!.nodeId,
        workspaceId: f.ns[1]!.workspace,
      };
      f.api.store.db
        .prepare(
          'INSERT INTO checkpoint_requests(id,task_id,node_id,owner_id,state,body) VALUES(?,?,?,?,?,?)',
        )
        .run(
          requestId,
          f.task.id,
          f.ns[1]!.nodeId,
          f.alice.user.id,
          'recorded',
          JSON.stringify(request),
        );
      f.api.store.db
        .prepare('INSERT INTO commit_checkpoints VALUES(?,?,?,?)')
        .run(id, f.task.id, requestId, JSON.stringify({ ...cp, id, request }));
    }
    const r = await f.api.call(f.path() + '/cleanup-options', f.alice);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(
      r
        .json()
        .materials.map((m: { retention: { request: { id: string } } }) => m.retention.request.id),
      [f.material.request.id],
    );
  } finally {
    await f.close();
  }
});
test('已放弃原现场只读列出有效同目录副本，不创建请求、报告、锁或删除授权', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const tables = [
      'work_branches',
      'work_branch_events',
      'work_branch_workspaces',
      'runs',
      'node_dispatches',
      'checkpoint_requests',
      'checkpoint_retentions',
      'outbox',
      'idempotency_records',
    ];
    const snapshot = () => tables.map((t) => f.api.store.db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot(),
      checks = new BranchCleanupChecks(f.api.store);
    const r = await f.api.call(f.path() + '/cleanup-options', f.alice);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().canInspect, true);
    assert.equal(r.json().deletionAuthorized, false);
    assert.equal(r.json().materials.length, 1);
    assert.equal(r.json().materials[0].retention.request.id, f.material.request.id);
    const v = checks.inspect(f.ns[0]!.token, f.selection());
    assert.equal(v.deletionAuthorized, false);
    assert.equal(v.branch.state, 'discarded');
    assert.deepEqual(checks.inspect(f.ns[0]!.token, f.selection()), v);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      (await f.api.call(f.path() + '/cleanup-options?force=true', f.alice)).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
test('尚未放弃、正在执行、停止未确认和未知现场不能借副本核对进入清理', async () => {
  const f = await branchCleanupFixture();
  try {
    const checks = new BranchCleanupChecks(f.api.store);
    assert.equal(
      (await f.api.call(f.path() + '/cleanup-options', f.alice)).json().canInspect,
      false,
    );
    assert.throws(() => checks.inspect(f.ns[0]!.token, f.selection()), {
      code: 'BRANCH_NOT_DISCARDED',
    });
    const run = f.begin();
    run.start();
    await f.discard();
    assert.equal(
      (await f.api.call(f.path() + '/cleanup-options', f.alice)).json().canInspect,
      false,
    );
    assert.throws(() => checks.inspect(f.ns[0]!.token, f.selection()), {
      code: 'BRANCH_EXECUTION_UNSETTLED',
    });
    await f.api.call(`runs/${run.run.id}/stop`, f.alice, {});
    assert.throws(() => checks.inspect(f.ns[0]!.token, f.selection()), {
      code: 'BRANCH_EXECUTION_UNSETTLED',
    });
    run.send('unknown', '未知不是已结束');
    assert.throws(() => checks.inspect(f.ns[0]!.token, f.selection()), {
      code: 'BRANCH_EXECUTION_UNSETTLED',
    });
  } finally {
    await f.close();
  }
});
test('核对固定修订和本人同目录身份；外部节点/只读成员不能取得本机检查范围', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const checks = new BranchCleanupChecks(f.api.store),
      s = f.selection();
    assert.throws(
      () => checks.inspect(f.ns[0]!.token, { ...s, expectedRevision: s.expectedRevision - 1 }),
      { code: 'REVISION_CONFLICT' },
    );
    assert.throws(
      () =>
        checks.inspect(f.ns[0]!.token, { ...s, expectedTaskRevision: s.expectedTaskRevision + 1 }),
      { code: 'REVISION_CONFLICT' },
    );
    assert.throws(() => checks.inspect(f.ns[1]!.token, s), { code: 'NOT_FOUND' });
    assert.equal((await f.api.call(f.path() + '/cleanup-options', f.bob)).statusCode, 404);
    const b = f.read().branches[0]!;
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.throws(() => checks.inspect(f.ns[0]!.token, s), { code: 'NODE_REVOKED' });
    assert.equal(f.read().branches[0]!.revision, b.revision);
  } finally {
    await f.close();
  }
});
test('副本删除/到期不可用不会从共同起点或原报告猜测可恢复，缺少副本明确为空', async () => {
  const f = await branchCleanupFixture();
  try {
    await f.discard();
    const checks = new BranchCleanupChecks(f.api.store);
    f.api.store.db
      .prepare("UPDATE checkpoint_retentions SET state='deleted' WHERE id=?")
      .run(f.material.request.id);
    assert.deepEqual(
      (await f.api.call(f.path() + '/cleanup-options', f.alice)).json().materials,
      [],
    );
    assert.throws(() => checks.inspect(f.ns[0]!.token, f.selection()), {
      code: 'BRANCH_CLEANUP_MATERIAL_UNAVAILABLE',
    });
  } finally {
    await f.close();
  }
});
