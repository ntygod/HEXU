import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseRetentionCreate,
  parseRetentionManifest,
  parseRetentionReport,
  type RetentionView,
} from '../packages/contracts/src/checkpoint-retention.js';
import { CheckpointRetentionStore } from '../packages/db/src/checkpoint-retention.js';
import { CheckpointStore } from '../packages/db/src/checkpoints.js';
import { aiStoreFixture } from './helpers/ai-store.js';
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
function fixture() {
  const f = aiStoreFixture();
  let clock = Date.now();
  const refs = new CheckpointStore(f.store, () => clock),
    retained = new CheckpointRetentionStore(f.store, () => clock);
  const now = () => new Date(clock).toISOString();
  const r = f.as(() =>
    refs.create(
      f.task.id,
      {
        nodeId: f.n.nodeId,
        workspaceId: f.workspace,
        label: '保留基线',
        commit: 'a'.repeat(40),
        expectedTaskRevision: 1,
        confirmReference: true,
      },
      randomUUID(),
    ),
  );
  const reference = refs.publish(f.token, {
    requestId: r.id,
    requestHash: r.requestHash,
    confirmPublication: true,
    manifest: {
      version: 1,
      kind: 'git_commit_reference',
      objectFormat: 'sha1',
      commit: r.commit,
      tree: 'b'.repeat(40),
      repositoryIdentity: 'c'.repeat(64),
      verifiedAt: now(),
      verifiedObjects: 'commit_and_root_tree',
      availability: 'local_reference',
      workingCopy: {
        id: f.workspace,
        state: 'available',
        capturedAt: now(),
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
    },
  });
  const body = () => ({
    days: 7,
    expectedTaskRevision: f.as(() => f.store.getTask(f.task.id).revision),
    confirmLocalRetention: true,
  });
  const create = (key = randomUUID()) =>
    f.as(() => retained.create(f.task.id, reference.checkpointId, body(), key));
  const manifest = () => ({
    version: 1,
    kind: 'git_snapshot_objects',
    objectFormat: 'sha1',
    commit: r.commit,
    tree: 'b'.repeat(40),
    repositoryIdentity: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    coverage: {
      objects: 3,
      bytes: 120,
      files: 1,
      trees: 1,
      symlinks: 0,
      gitlinks: 0,
      lfsPointers: 0,
    },
    scope: 'commit_snapshot_without_ancestors_or_external_content',
    retainedAt: now(),
    expiresAt: new Date(clock + 7 * 86400000).toISOString(),
  });
  const first = (v: RetentionView) => ({
    requestId: v.request.id,
    requestHash: v.request.requestHash,
    sequence: 1,
    report: { state: 'retained', observedAt: now(), manifest: manifest() },
    confirmPublication: true,
  });
  const next = (v: RetentionView, state = 'verified', sequence = 2) => ({
    requestId: v.request.id,
    requestHash: v.request.requestHash,
    sequence,
    report: { state, observedAt: now() },
    confirmPublication: true,
  });
  return {
    ...f,
    refs,
    retained,
    reference,
    body,
    create,
    manifest,
    first,
    next,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
test('保留严格契约拒绝远端可用性、目录/正文注入、错误期限与伪造完整范围', () => {
  const f = fixture();
  try {
    for (const change of [
      { days: 0 },
      { days: 31 },
      { days: '7' },
      { confirmLocalRetention: false },
      { path: '/tmp' },
      { fetch: true },
    ])
      assert.throws(() => parseRetentionCreate({ ...f.body(), ...change }));
    for (const change of [
      { availability: 'ready' },
      { scope: 'all_repository_history' },
      { tree: 'x' },
      { retainedAt: '2026-99-99' },
      { coverage: { ...f.manifest().coverage, objects: 10001 } },
      { coverage: { ...f.manifest().coverage, files: 0, lfsPointers: 1 } },
    ])
      assert.throws(() => parseRetentionManifest({ ...f.manifest(), ...change }));
    const r = f.create();
    for (const change of [
      { sequence: 2 },
      { sequence: 0 },
      { confirmPublication: false },
      { token: 'fake' },
    ])
      assert.throws(() => parseRetentionReport({ ...f.first(r), ...change }));
    assert.throws(() => parseRetentionReport(f.next(r, 'verified', 1)));
  } finally {
    f.close();
  }
});
test('明确保留和重复回执仅新增对象元数据，不改变任务/运行/等待材料或未知占用', () => {
  const f = fixture();
  try {
    f.running();
    const before = f.as(() => f.store.getTask(f.task.id));
    const tables = [
      'runs',
      'node_dispatches',
      'node_continuation_operations',
      'continuation_operations',
      'native_workspace_locks',
    ];
    const values = tables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all());
    const key = randomUUID(),
      r = f.create(key),
      packet = f.first(r);
    assert.equal(f.create(key).request.id, r.request.id);
    assert.equal(f.retained.report(f.token, packet).state, 'retained');
    assert.equal(f.retained.report(f.token, packet).sequence, 1);
    assert.deepEqual(
      f.as(() => f.store.getTask(f.task.id)),
      before,
    );
    tables.forEach((t, i) =>
      assert.deepEqual(f.store.db.prepare(`SELECT * FROM ${t}`).all(), values[i]),
    );
    assert.equal(
      f.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_retention_reports').get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});
test('保留权限分别检查任务/原节点所有者与来源，有限阅读和跨任务标识不能发起', () => {
  const f = fixture();
  try {
    const r = f.create();
    assert.throws(
      () =>
        f.as(
          () => f.retained.create(f.task.id, f.reference.checkpointId, f.body(), randomUUID()),
          f.bob,
        ),
      code('NODE_OWNER_REQUIRED'),
    );
    assert.equal(
      f.as(() => f.retained.list(f.task.id, f.reference.checkpointId), f.bob).items.length,
      1,
    );
    const other = f.as(() =>
      f.store.createTask({ title: '其他', description: '', projectId: f.project.id }, randomUUID()),
    );
    assert.throws(
      () => f.as(() => f.retained.list(other.id, f.reference.checkpointId)),
      code('NOT_FOUND'),
    );
    f.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE user_id=?")
      .run(f.alice.id);
    assert.equal(
      f.as(() => f.retained.list(f.task.id, f.reference.checkpointId)).items[0]!.state,
      'invalidated',
    );
    f.store.db
      .prepare("UPDATE collab_project_members SET role='manage' WHERE user_id=?")
      .run(f.alice.id);
    assert.throws(() => f.retained.report(f.token, f.first(r)), code('NODE_REVOKED'));
  } finally {
    f.close();
  }
});
test('保留创建的请求/事件/回执任一步失败共同回滚，陈旧任务拒绝且原请求可重试', () => {
  for (const table of ['checkpoint_retentions', 'outbox', 'idempotency_records']) {
    const f = fixture();
    try {
      const key = randomUUID();
      f.store.db.exec(
        `CREATE TRIGGER fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.throws(() => f.create(key), /injected/);
      assert.equal(
        f.as(() => f.retained.list(f.task.id, f.reference.checkpointId)).items.length,
        0,
      );
      f.store.db.exec('DROP TRIGGER fail');
      assert.equal(f.create(key).state, 'pending');
      assert.throws(
        () =>
          f.as(() =>
            f.retained.create(
              f.task.id,
              f.reference.checkpointId,
              { ...f.body(), expectedTaskRevision: 99 },
              randomUUID(),
            ),
          ),
        code('REVISION_CONFLICT'),
      );
    } finally {
      f.close();
    }
  }
});
test('保留清单/顺序记录/状态与事件失败原子回滚，不能留下假已保留状态', () => {
  for (const [table, operation] of [
    ['checkpoint_retentions', 'UPDATE'],
    ['checkpoint_retention_reports', 'INSERT'],
    ['outbox', 'INSERT'],
  ]) {
    const f = fixture();
    try {
      const r = f.create(),
        packet = f.first(r),
        events = f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get();
      f.store.db.exec(
        `CREATE TRIGGER fail BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.throws(() => f.retained.report(f.token, packet), /injected/);
      assert.equal(f.retained.inspect(f.token, r.request.id).manifest, null);
      assert.equal(f.retained.inspect(f.token, r.request.id).sequence, 0);
      assert.deepEqual(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get(), events);
      f.store.db.exec('DROP TRIGGER fail');
      assert.equal(f.retained.report(f.token, packet).state, 'retained');
    } finally {
      f.close();
    }
  }
});
test('生命周期报告按序且不可改写清单，旧保留回执不能复活删除或覆盖后续核验', () => {
  const f = fixture();
  try {
    const r = f.create(),
      first = f.first(r);
    f.retained.report(f.token, first);
    assert.throws(
      () => f.retained.report(f.token, f.next(r, 'verified', 3)),
      code('RETENTION_REPORT_CONFLICT'),
    );
    assert.throws(
      () =>
        f.retained.report(f.token, {
          ...first,
          report: {
            ...first.report,
            manifest: { ...first.report.manifest, snapshotHash: 'e'.repeat(64) },
          },
        }),
      code('CHECKPOINT_MISMATCH'),
    );
    f.advance(1);
    f.retained.report(f.token, f.next(r, 'corrupt'));
    f.advance(1);
    const deleted = f.retained.report(f.token, f.next(r, 'deleted', 3));
    assert.equal(deleted.state, 'deleted');
    assert.equal(f.retained.report(f.token, first).state, 'deleted');
    assert.throws(
      () => f.retained.report(f.token, f.next(r, 'verified', 4)),
      code('RETENTION_REPORT_CONFLICT'),
    );
    assert.equal(deleted.manifest!.snapshotHash, first.report.manifest.snapshotHash);
  } finally {
    f.close();
  }
});
test('取消/核验请求过期拒绝首次发布，保留期限过后重新核验不续期', () => {
  const f = fixture();
  try {
    const cancelled = f.create();
    f.as(() =>
      f.retained.cancel(f.task.id, f.reference.checkpointId, cancelled.request.id, randomUUID()),
    );
    assert.throws(
      () => f.retained.report(f.token, f.first(cancelled)),
      code('CHECKPOINT_REQUEST_CLOSED'),
    );
    const expired = f.create(),
      saved = f.create();
    f.retained.report(f.token, f.first(saved));
    f.advance(31 * 60000);
    assert.throws(
      () => f.retained.report(f.token, f.first(expired)),
      code('CHECKPOINT_REQUEST_CLOSED'),
    );
    f.advance(8 * 86400000);
    const verified = f.retained.report(f.token, f.next(saved));
    assert.equal(verified.state, 'expired');
    assert.equal(verified.sequence, 2);
    assert.equal(
      verified.manifest!.expiresAt,
      new Date(Date.parse(saved.request.createdAt) + 7 * 86400000).toISOString(),
    );
  } finally {
    f.close();
  }
});
test('提交/树/本机对象库身份与期限必须匹配原引用，拒绝换来源发布', () => {
  const f = fixture();
  try {
    const r = f.create(),
      p = f.first(r);
    for (const change of [
      { commit: 'e'.repeat(40) },
      { tree: 'e'.repeat(40) },
      { repositoryIdentity: 'e'.repeat(64) },
      { expiresAt: new Date(Date.parse(p.report.manifest.retainedAt) + 86400000).toISOString() },
    ])
      assert.throws(
        () =>
          f.retained.report(f.token, {
            ...p,
            report: { ...p.report, manifest: { ...p.report.manifest, ...change } },
          }),
        code('CHECKPOINT_MISMATCH'),
      );
    assert.equal(f.retained.inspect(f.token, r.request.id).manifest, null);
  } finally {
    f.close();
  }
});
