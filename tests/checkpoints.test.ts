import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  commitOid,
  parseCheckpointCreate,
  parseCheckpointPublish,
  type CheckpointManifest,
} from '../packages/contracts/src/checkpoints.js';
import { CheckpointStore } from '../packages/db/src/checkpoints.js';
import { aiStoreFixture } from './helpers/ai-store.js';
import { teamFixture } from './helpers/team.js';
const code = (v: string) => (e: unknown) => e instanceof DomainError && e.code === v;
const oid = 'a'.repeat(40);
function fixture() {
  const f = aiStoreFixture();
  let clock = Date.now();
  const checkpoints = new CheckpointStore(f.store, () => clock);
  const body = () => ({
    nodeId: f.n.nodeId,
    workspaceId: f.workspace,
    commit: oid,
    label: '接口基线',
    expectedTaskRevision: f.as(() => f.store.getTask(f.task.id).revision),
    confirmReference: true,
  });
  const create = (key = randomUUID()) => f.as(() => checkpoints.create(f.task.id, body(), key));
  const manifest = (): CheckpointManifest => ({
    version: 1,
    kind: 'git_commit_reference',
    objectFormat: 'sha1',
    commit: oid,
    tree: 'b'.repeat(40),
    repositoryIdentity: 'c'.repeat(64),
    verifiedAt: new Date(clock).toISOString(),
    verifiedObjects: 'commit_and_root_tree',
    availability: 'local_reference',
    workingCopy: {
      id: f.workspace,
      state: 'available',
      capturedAt: new Date(clock).toISOString(),
      staged: 1,
      modified: 2,
      untracked: 3,
      conflicts: 0,
    },
  });
  const packet = (r: ReturnType<typeof create>) => ({
    requestId: r.id,
    requestHash: r.requestHash,
    manifest: manifest(),
    confirmPublication: true,
  });
  return {
    ...f,
    checkpoints,
    body,
    create,
    manifest,
    packet,
    advance: () => {
      clock += 31 * 60000;
    },
  };
}
test('检查点严格契约只接受完整对象引用和独立同意，不接受路径、正文、恢复或执行参数', () => {
  const f = fixture();
  try {
    for (const v of [
      'HEAD',
      'main',
      '--help',
      'abcd',
      oid.toUpperCase(),
      oid + '^{}',
      '0'.repeat(41),
    ])
      assert.throws(() => commitOid(v));
    assert.equal(commitOid('f'.repeat(64), 'sha256').length, 64);
    for (const extra of [
      { path: '/tmp/code' },
      { confirmReference: false },
      { expectedTaskRevision: '1' },
      { label: '../private' },
      { run: true },
    ])
      assert.throws(() => parseCheckpointCreate({ ...f.body(), ...extra }));
    const request = f.create();
    for (const change of [
      { availability: 'remote' },
      { verifiedObjects: 'all' },
      { code: 'secret' },
      { tree: 'x' },
      { workingCopy: { ...f.manifest().workingCopy, absolutePath: '/home/private' } },
    ])
      assert.throws(() =>
        parseCheckpointPublish({ ...f.packet(request), manifest: { ...f.manifest(), ...change } }),
      );
    assert.throws(() =>
      parseCheckpointPublish({ ...f.packet(request), confirmPublication: false }),
    );
  } finally {
    f.store.close();
  }
});
test('明确请求才允许本人节点发布，不改 Task/Run/材料或未知目录锁，同请求原子记录且不重复', () => {
  const f = fixture();
  try {
    const active = f.running();
    const before = f.as(() => f.store.getTask(f.task.id));
    const runs = f.store.db.prepare('SELECT * FROM runs').all();
    const key = randomUUID(),
      r = f.create(key),
      packet = f.packet(r);
    assert.equal(f.create(key).id, r.id);
    assert.throws(() => f.checkpoints.inspect(f.token, 'missing'), code('NOT_FOUND'));
    const receipt = f.checkpoints.publish(f.token, packet);
    assert.deepEqual(f.checkpoints.publish(f.token, packet), receipt);
    const page = f.as(() => f.checkpoints.list(f.task.id));
    assert.equal(page.checkpoints.length, 1);
    assert.equal(page.requests[0]!.state, 'recorded');
    assert.equal(page.checkpoints[0]!.manifest.commit, oid);
    assert.deepEqual(
      f.as(() => f.store.getTask(f.task.id)),
      before,
    );
    assert.deepEqual(f.store.db.prepare('SELECT * FROM runs').all(), runs);
    assert.equal(
      f.as(() => f.store.run(active.run.id).state),
      'running',
    );
    assert.throws(
      () =>
        f.checkpoints.publish(f.token, {
          ...packet,
          manifest: { ...packet.manifest, tree: 'd'.repeat(40) },
        }),
      code('CHECKPOINT_MISMATCH'),
    );
  } finally {
    f.store.close();
  }
});
test('请求/源项目/节点/目录与当前权限绑定，有限协助或项目编辑不授予他人节点检查点权限', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.as(() => f.checkpoints.create(f.task.id, f.body(), randomUUID()), f.bob),
      code('NODE_OWNER_REQUIRED'),
    );
    const r = f.create();
    assert.throws(
      () =>
        f.checkpoints.publish(f.token, {
          ...f.packet(r),
          manifest: { ...f.manifest(), commit: 'e'.repeat(40) },
        }),
      code('CHECKPOINT_MISMATCH'),
    );
    assert.throws(
      () =>
        f.as(() =>
          f.checkpoints.create(f.task.id, { ...f.body(), workspaceId: 'other' }, randomUUID()),
        ),
      code('WORKSPACE_SCOPE_MISMATCH'),
    );
    const privateTask = f.as(() =>
      f.store.createTask({ title: '私有', description: '', projectId: null }, randomUUID()),
    );
    assert.throws(
      () => f.as(() => f.checkpoints.create(privateTask.id, f.body(), randomUUID())),
      code('CHECKPOINT_SCOPE_UNSUPPORTED'),
    );
    f.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE user_id=?")
      .run(f.alice.id);
    assert.throws(() => f.checkpoints.inspect(f.token, r.id), code('NODE_REVOKED'));
    assert.throws(
      () => f.as(() => f.checkpoints.create(f.task.id, f.body(), randomUUID())),
      code('FORBIDDEN'),
    );
    assert.equal(f.as(() => f.checkpoints.list(f.task.id)).requests.length, 1);
    f.store.db.prepare('DELETE FROM collab_project_members WHERE user_id=?').run(f.bob.id);
    assert.throws(() => f.as(() => f.checkpoints.list(f.task.id), f.bob), code('NOT_FOUND'));
  } finally {
    f.store.close();
  }
});
test('取消与过期拒绝晚到核对，不取消主执行；已保存回执在过期后保持原记录', () => {
  const f = fixture();
  try {
    const r = f.create();
    const original = f.as(() => f.store.getTask(f.task.id));
    f.as(() => f.checkpoints.cancel(f.task.id, r.id, randomUUID()));
    assert.throws(
      () => f.checkpoints.publish(f.token, f.packet(r)),
      code('CHECKPOINT_REQUEST_CLOSED'),
    );
    const pending = f.create(),
      saved = f.create(),
      packet = f.packet(saved);
    const receipt = f.checkpoints.publish(f.token, packet);
    f.advance();
    assert.equal(f.checkpoints.inspect(f.token, pending.id).state, 'expired');
    assert.throws(
      () => f.checkpoints.publish(f.token, f.packet(pending)),
      code('CHECKPOINT_REQUEST_CLOSED'),
    );
    assert.deepEqual(f.checkpoints.publish(f.token, packet), receipt);
    assert.throws(
      () => f.as(() => f.checkpoints.cancel(f.task.id, saved.id, randomUUID())),
      code('CHECKPOINT_ALREADY_RECORDED'),
    );
    assert.deepEqual(
      f.as(() => f.store.getTask(f.task.id)),
      original,
    );
  } finally {
    f.store.close();
  }
});
test('记录/请求状态/outbox 任一步失败共同回滚，原核对结果可安全重放', () => {
  for (const [table, operation] of [
    ['commit_checkpoints', 'INSERT'],
    ['checkpoint_requests', 'UPDATE'],
    ['outbox', 'INSERT'],
  ]) {
    const f = fixture();
    try {
      const r = f.create(),
        packet = f.packet(r);
      const events = f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get();
      f.store.db.exec(
        `CREATE TRIGGER inject_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.throws(() => f.checkpoints.publish(f.token, packet), /injected/);
      assert.equal(f.checkpoints.inspect(f.token, r.id).state, 'pending');
      assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get(), events);
      assert.equal(f.as(() => f.checkpoints.list(f.task.id)).checkpoints.length, 0);
      f.store.db.exec('DROP TRIGGER inject_failure');
      f.checkpoints.publish(f.token, packet);
      assert.equal(f.as(() => f.checkpoints.list(f.task.id)).checkpoints.length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('检查点创建事务故障不留下半份授权或回执；陈旧任务修订不会创建请求', () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.as(() =>
          f.checkpoints.create(f.task.id, { ...f.body(), expectedTaskRevision: 99 }, randomUUID()),
        ),
      code('REVISION_CONFLICT'),
    );
    const key = randomUUID();
    f.store.db.exec(
      "CREATE TRIGGER checkpoint_failure BEFORE INSERT ON idempotency_records BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => f.create(key), /injected/);
    assert.equal(f.as(() => f.checkpoints.list(f.task.id)).requests.length, 0);
    f.store.db.exec('DROP TRIGGER checkpoint_failure');
    assert.equal(f.create(key).state, 'pending');
  } finally {
    f.store.close();
  }
});
test('真实 HTTP 节点与浏览器通道隔离；当前项目权限、严格分页与撤销重放生效', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id);
    const n = new CheckpointStore(f.store);
    const headers = { cookie: alice.cookie, 'x-hexu-runner': '1' };
    const badChannel = await f.app.inject({
      method: 'POST',
      url: '/runner/v1/checkpoint-inspect',
      headers,
      payload: { requestId: 'missing' },
    });
    assert.equal(badChannel.statusCode, 403);
    assert.equal((await f.call(`tasks/${task.id}/checkpoints`, bob)).statusCode, 404);
    assert.equal((await f.call(`tasks/${task.id}/checkpoints?cursor=../x`, alice)).statusCode, 400);
    assert.equal(
      (await f.call(`tasks/${task.id}/checkpoint-options`, alice)).json().items.length,
      0,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commit_checkpoints').get()!.n, 0);
    assert.equal(n.nodes.list instanceof Function, true);
  } finally {
    await f.close();
  }
});
test('本机引用历史按不可变顺序分页，后续任务修改不回写检查点', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 23; i++) {
      const r = f.create();
      f.checkpoints.publish(f.token, f.packet(r));
    }
    const first = f.as(() => f.checkpoints.list(f.task.id));
    const before = first.checkpoints[0];
    f.as(() =>
      f.store.patchTask(
        f.task.id,
        { expectedRevision: 1, description: '后来的说明' },
        randomUUID(),
      ),
    );
    const second = f.as(() => f.checkpoints.list(f.task.id, first.nextCursor));
    assert.equal(first.requests.length, 20);
    assert.equal(second.requests.length, 3);
    assert.equal(new Set([...first.requests, ...second.requests].map((r) => r.id)).size, 23);
    assert.deepEqual(f.as(() => f.checkpoints.list(f.task.id)).checkpoints[0], before);
  } finally {
    f.store.close();
  }
});
test('节点权限撤销永久使原请求失效，重新入组不复活；历史仍按当前任务权限保留', () => {
  const f = fixture();
  try {
    const old = f.create(),
      saved = f.create();
    const packet = f.packet(saved),
      receipt = f.checkpoints.publish(f.token, packet);
    f.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE user_id=?")
      .run(f.alice.id);
    assert.equal(
      f.as(() => f.checkpoints.list(f.task.id)).requests.find((r) => r.id === old.id)!.state,
      'invalidated',
    );
    f.store.db
      .prepare("UPDATE collab_project_members SET role='manage' WHERE user_id=?")
      .run(f.alice.id);
    assert.throws(() => f.checkpoints.inspect(f.token, old.id), code('NODE_REVOKED'));
    assert.throws(() => f.checkpoints.publish(f.token, packet), code('NODE_REVOKED'));
    assert.equal(
      f.as(() => f.checkpoints.list(f.task.id)).checkpoints[0]!.id,
      receipt.checkpointId,
    );
    assert.equal(f.as(() => f.checkpoints.options(f.task.id)).items.length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM commit_checkpoints').get()!.n, 1);
  } finally {
    f.store.close();
  }
});
