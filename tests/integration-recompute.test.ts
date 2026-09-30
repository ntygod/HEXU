import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  parseIntegrationRecomputeCreate,
  type IntegrationRecomputeOptions,
} from '../packages/contracts/src/integration-recompute.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
import { CheckpointRetentionStore } from '../packages/db/src/checkpoint-retention.js';
import { IntegrationStore } from '../packages/db/src/integrations.js';
import { codeHash } from '../packages/db/src/result-code.js';
import { integrationFixture } from './helpers/integrations.js';
import { codeSnapshot, recordResultCode } from './helpers/result-code.js';
import { buildIntegrationPlan } from '../apps/runner/src/agent/integration-plan.js';
async function prepared() {
  const f = await integrationFixture();
  try {
    const initial = await f.create(),
      published = await f.protocol('publish', f.report(initial));
    assert.equal(published.statusCode, 200, published.body);
    const read = async (id = initial.operation.id) =>
      (await f.api.call(`${f.integrationPath}/${id}`, f.alice)).json() as IntegrationView;
    const original = await read(),
      next = await codeSnapshot([
        { name: 'README.md', text: 'NEW TARGET' },
        { name: 'target.txt', text: 'TARGET_ONLY' },
        { name: 'later.txt', text: 'LATER TARGET ONLY' },
      ]),
      cp = await recordResultCode(f, next),
      retention = f.retain(cp.checkpointId, next);
    const data = {
      expectedRevision: original.operation.revision,
      expectedTaskRevision: original.taskRevision,
      reportHash: original.reportHash!,
      targetCheckpointId: cp.checkpointId,
      targetRetentionId: retention.request.id,
      sourceMaterial: { kind: 'retention' as const, id: f.sr.request.id },
      confirmPreflight: true as const,
    };
    return {
      ...f,
      original,
      next,
      cp,
      retention,
      data,
      readView: read,
      recomputePath: `${f.integrationPath}/${original.operation.id}/recompute`,
      optionsPath: `${f.integrationPath}/${original.operation.id}/recompute-options`,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
function oldEvidence(f: Awaited<ReturnType<typeof prepared>>) {
  return {
    operation: f.api.store.db
      .prepare('SELECT * FROM integration_operations WHERE id=?')
      .get(f.original.operation.id),
    events: f.api.store.db
      .prepare('SELECT * FROM integration_events WHERE integration_id=?')
      .all(f.original.operation.id),
    others: [
      'tasks',
      'runs',
      'result_revisions',
      'work_branches',
      'work_branch_choices',
      'integration_trial_differences',
      'integration_recovery_observations',
      'integration_file_restorations',
    ].map((table) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${table}`).all())),
  };
}
test('重新预检严格契约固定旧来源，不接受任意路径/版本/决策/关系或隐含确认', () => {
  const good = {
    expectedRevision: 2,
    expectedTaskRevision: 1,
    reportHash: 'a'.repeat(64),
    targetCheckpointId: 'new-cp',
    targetRetentionId: 'new-retention',
    sourceMaterial: { kind: 'retention', id: 'source-retention' },
    confirmPreflight: true,
  };
  assert.deepEqual(parseIntegrationRecomputeCreate(good), good);
  for (const change of [
    { resultId: 'other' },
    { resultRevisionId: 'latest' },
    { targetNodeId: 'other' },
    { workspaceId: 'other' },
    { root: '/arbitrary' },
    { choices: [] },
    { recomputedFrom: 'forged' },
    { application: {} },
    { confirmPreflight: false },
    { expectedRevision: 0 },
    { reportHash: 'bad' },
    { sourceMaterial: { kind: 'retention', id: 'same', path: '/arbitrary' } },
  ])
    assert.throws(() => parseIntegrationRecomputeCreate({ ...good, ...change }));
});
test('固定旧v1即使最新变成无代码文字版，也只派生新目标预检；原历史/Task不变且新关系保留', async () => {
  const f = await prepared();
  try {
    const newer = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '新的纯文字版本',
    });
    assert.equal(newer.statusCode, 201, newer.body);
    const before = oldEvidence(f),
      options = await f.api.call(f.optionsPath, f.alice);
    assert.equal(options.statusCode, 200, options.body);
    const o = options.json() as IntegrationRecomputeOptions;
    assert.equal(o.source.revisionId, f.original.operation.source.revisionId);
    assert.equal(o.originalRevision, f.original.operation.revision);
    assert(o.targets.some((t) => t.target.checkpoint.id === f.cp.checkpointId));
    assert(
      !o.targets.some((t) => t.target.checkpoint.id === f.original.operation.target.checkpoint.id),
    );
    const key = randomUUID(),
      created = await f.api.call(f.recomputePath, f.alice, f.data, key);
    assert.equal(created.statusCode, 201, created.body);
    const v = created.json() as IntegrationView;
    assert.notEqual(v.operation.id, f.original.operation.id);
    assert.deepEqual(v.operation.source, f.original.operation.source);
    assert.equal(v.operation.recomputedFrom, f.original.operation.id);
    assert.equal(v.operation.state, 'queued');
    assert.equal(v.operation.report, null);
    assert.equal(v.operation.application, null);
    assert.equal(v.operation.applied, false);
    assert.equal(v.operation.target.checkpoint.id, f.cp.checkpointId);
    assert.deepEqual(oldEvidence(f), before);
    assert.equal(
      (await f.api.call(f.recomputePath, f.alice, f.data, key)).json().operation.id,
      v.operation.id,
    );
    assert.equal(
      (await f.api.call(f.recomputePath, f.alice, { ...f.data, reportHash: 'e'.repeat(64) }, key))
        .statusCode,
      409,
    );
    const report = {
      integrationId: v.operation.id,
      inputHash: v.operation.inputHash,
      observedAt: new Date().toISOString(),
      plan: buildIntegrationPlan(
        'sha1',
        { base: f.base.tree, source: f.source.tree, target: f.next.tree },
        { base: f.base, source: f.source, target: f.next },
        '/fixture-repo',
      ),
      reason: null,
      confirmPublication: true,
    };
    assert.equal((await f.protocol('publish', report)).statusCode, 200);
    const ready = await f.readView(v.operation.id);
    assert.equal(ready.operation.recomputedFrom, f.original.operation.id);
    assert.equal(
      (
        await f.api.call(`${f.integrationPath}/${v.operation.id}/cancel`, f.alice, {
          expectedRevision: ready.operation.revision,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.readView(v.operation.id)).operation.recomputedFrom,
      f.original.operation.id,
    );
    assert.deepEqual(oldEvidence(f), before);
  } finally {
    await f.close();
  }
});
test('旧副本删除可选择新的兼容副本；旧/不同目录/伪造仓库和陈旧基线拒绝', async () => {
  const f = await prepared();
  try {
    const fresh = f.retain(f.sourceCp.checkpointId, f.source);
    for (const r of [f.sr, f.tr])
      f.retained.report(f.ns[0]!.token, {
        requestId: r.request.id,
        requestHash: r.request.requestHash,
        sequence: 2,
        confirmPublication: true,
        report: { state: 'deleted', observedAt: new Date().toISOString() },
      });
    const view = await f.readView();
    assert.equal(view.available, false);
    assert.equal(view.canRecompute, true);
    const data = {
      ...f.data,
      sourceMaterial: { kind: 'retention' as const, id: fresh.request.id },
    };
    const options = await f.api.call(f.optionsPath, f.alice);
    assert.equal(options.statusCode, 200, options.body);
    for (const change of [
      {
        targetCheckpointId: f.original.operation.target.checkpoint.id,
        targetRetentionId: f.original.operation.target.retentionId,
      },
      { expectedRevision: 99 },
      { expectedTaskRevision: 99 },
      { reportHash: 'b'.repeat(64) },
      { sourceMaterial: { kind: 'retention', id: f.retention.request.id } },
    ])
      assert.notEqual(
        (await f.api.call(f.recomputePath, f.alice, { ...data, ...change })).statusCode,
        201,
      );
    const foreign = await recordResultCode(f, f.next, 1),
      foreignRetention = f.retain(foreign.checkpointId, f.next, 1);
    assert.equal(
      (
        await f.api.call(f.recomputePath, f.alice, {
          ...data,
          targetCheckpointId: foreign.checkpointId,
          targetRetentionId: foreignRetention.request.id,
        })
      ).statusCode,
      409,
    );
    const key = randomUUID(),
      created = await f.api.call(f.recomputePath, f.alice, data, key);
    assert.equal(created.statusCode, 201, created.body);
    for (const r of [fresh, f.retention])
      f.retained.report(f.ns[0]!.token, {
        requestId: r.request.id,
        requestHash: r.request.requestHash,
        sequence: 2,
        confirmPublication: true,
        report: { state: 'deleted', observedAt: new Date().toISOString() },
      });
    const replay = await f.api.call(f.recomputePath, f.alice, data, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().operation.id, created.json().operation.id);
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.notEqual((await f.api.call(f.recomputePath, f.alice, data, key)).statusCode, 201);
    assert.notEqual((await f.api.call(f.optionsPath, f.alice)).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('原材料到期与新材料当前可用分开，精确回执不会重建新操作', async (t) => {
  const f = await prepared();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    const retained = new CheckpointRetentionStore(f.api.store, () => Date.now());
    const retainFresh = (checkpointId: string, snapshot: typeof f.source) => {
      const r = f.as(() =>
        retained.create(
          f.task.id,
          checkpointId,
          {
            days: 7,
            expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
            confirmLocalRetention: true,
          },
          randomUUID(),
        ),
      );
      const at = new Date().toISOString();
      retained.report(f.ns[0]!.token, {
        requestId: r.request.id,
        requestHash: r.request.requestHash,
        sequence: 1,
        confirmPublication: true,
        report: {
          state: 'retained',
          observedAt: at,
          manifest: {
            ...f.sr.manifest!,
            commit: snapshot.commit,
            tree: snapshot.tree,
            snapshotHash: snapshot.snapshotHash,
            coverage: snapshot.coverage,
            retainedAt: at,
            expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          },
        },
      });
      return f.as(() => retained.get(f.task.id, checkpointId, r.request.id));
    };
    const cp = await recordResultCode(f, f.next),
      target = retainFresh(cp.checkpointId, f.next),
      source = retainFresh(f.sourceCp.checkpointId, f.source),
      store = new IntegrationStore(f.api.store);
    const view = f.as(() => store.get(f.task.id, f.original.operation.id));
    assert.equal(view.available, false);
    assert.equal(view.canRecompute, true);
    const data = {
        ...f.data,
        targetCheckpointId: cp.checkpointId,
        targetRetentionId: target.request.id,
        sourceMaterial: { kind: 'retention' as const, id: source.request.id },
      },
      key = randomUUID(),
      created = f.as(() => store.recompute(f.task.id, f.original.operation.id, data, key));
    assert.equal(created.operation.source.revisionId, f.original.operation.source.revisionId);
    t.mock.timers.setTime(Date.now() + 8 * 86400000);
    assert.equal(
      f.as(() => store.recompute(f.task.id, f.original.operation.id, data, key)).operation.id,
      created.operation.id,
    );
    assert.throws(() =>
      f.as(() => store.recompute(f.task.id, f.original.operation.id, data, randomUUID())),
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
test('事件/outbox/幂等回执任一失败整体回滚，新旧操作均无半份创建', async () => {
  const f = await prepared();
  try {
    for (const table of [
      'integration_operations',
      'integration_events',
      'outbox',
      'idempotency_records',
    ]) {
      const key = randomUUID(),
        before = oldEvidence(f),
        count = f.api.store.db.prepare('SELECT COUNT(*) n FROM integration_operations').get()!.n;
      f.api.store.db.exec(
        `CREATE TRIGGER recompute_fixture_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture recompute failure'); END`,
      );
      assert.equal((await f.api.call(f.recomputePath, f.alice, f.data, key)).statusCode, 500);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) n FROM integration_operations').get()!.n,
        count,
      );
      assert.deepEqual(oldEvidence(f), before);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) n FROM idempotency_records WHERE key=?').get(key)!
          .n,
        0,
      );
      f.api.store.db.exec('DROP TRIGGER recompute_fixture_failure');
      assert.equal((await f.api.call(f.recomputePath, f.alice, f.data, key)).statusCode, 201);
    }
  } finally {
    await f.close();
  }
});
test('原作者与Task/节点授权在新创建和旧回执之前，不通过相同来源借别人的节点', async () => {
  const f = await prepared();
  try {
    const key = randomUUID(),
      created = await f.api.call(f.recomputePath, f.alice, f.data, key);
    assert.equal(created.statusCode, 201, created.body);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(f.optionsPath, f.bob)).statusCode, 403);
    assert.equal((await f.api.call(f.recomputePath, f.bob, f.data, key)).statusCode, 403);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    assert.equal((await f.api.call(f.recomputePath, f.alice, f.data, key)).statusCode, 403);
  } finally {
    await f.close();
  }
});

async function queueOriginal(f: Awaited<ReturnType<typeof prepared>>) {
  const v = await f.readView(),
    r = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: ['new.txt'],
      confirmApplication: true,
    });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as IntegrationView;
}
async function applicationStage(
  f: Awaited<ReturnType<typeof prepared>>,
  v: IntegrationView,
  stage: 'applying' | 'completed' | 'needs_attention',
) {
  const a = v.operation.application!;
  const r = await f.protocol('apply-publish', {
    integrationId: v.operation.id,
    applicationId: a.id,
    inputHash: a.inputHash,
    sequence: stage === 'applying' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    appliedPaths: stage === 'applying' ? [] : a.paths,
    reason: stage === 'needs_attention' ? 'interrupted' : null,
    confirmPublication: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  return f.readView();
}
test('原排队/进行中/未知应用不借新预检越过，明确结算后只另建只读记录且旧状态不变', async () => {
  const f = await prepared();
  try {
    let v = await queueOriginal(f);
    for (const stage of ['queued', 'applying', 'needs_attention'] as const) {
      if (stage !== 'queued') v = await applicationStage(f, v, stage);
      assert.equal(v.canRecompute, false);
      assert.equal((await f.api.call(f.optionsPath, f.alice)).statusCode, 409);
      const result = await f.api.call(f.recomputePath, f.alice, {
        ...f.data,
        expectedRevision: v.operation.revision,
      });
      assert.equal(result.statusCode, 409, result.body);
    }
    const a = v.operation.application!,
      at = new Date().toISOString();
    const settled = await f.protocol('recovery-publish', {
      version: 1,
      kind: 'local_integration_settlement',
      integrationId: v.operation.id,
      applicationId: a.id,
      recoveryId: randomUUID(),
      integrationInputHash: v.operation.inputHash,
      applicationInputHash: a.inputHash,
      originalApplicationEvidenceHash: 'e'.repeat(64),
      stoppedConfirmedAt: at,
      releasedAt: at,
      disposition: 'preserve_files',
      processEvidence: 'operator_confirmed_stopped',
      lease: 'released',
      filesVerified: false,
      recordedAddedCount: 1,
      unresolvedWriteIntent: true,
      confirmPublication: true,
    });
    assert.equal(settled.statusCode, 200, settled.body);
    v = await f.readView();
    assert.equal(v.canRecompute, true);
    const before = oldEvidence(f),
      r = await f.api.call(f.recomputePath, f.alice, {
        ...f.data,
        expectedRevision: v.operation.revision,
      });
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(oldEvidence(f), before);
    assert.equal((await f.readView()).operation.state, 'needs_attention');
    assert.equal((await f.readView()).recovery!.report.filesVerified, false);
  } finally {
    await f.close();
  }
});
test('原完成应用允许新预检，但独立文件恢复排队/进行中/未知须先结算；原完成证据始终不变', async () => {
  const f = await prepared();
  try {
    let v = await queueOriginal(f);
    v = await applicationStage(f, v, 'applying');
    v = await applicationStage(f, v, 'completed');
    assert.equal(v.canRecompute, true);
    const queued = await f.api.call(`${f.integrationPath}/${v.operation.id}/restore`, f.alice, {
      applicationId: v.operation.application!.id,
      applicationInputHash: v.operation.application!.inputHash,
      completedReportHash: v.completedReportHash,
      paths: v.operation.application!.paths,
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      confirmFileRestoration: true,
    });
    assert.equal(queued.statusCode, 200, queued.body);
    v = queued.json();
    for (const stage of ['queued', 'restoring', 'needs_attention'] as const) {
      if (stage !== 'queued') {
        const r = v.restoration!;
        const p = await f.protocol('restoration-publish', {
          version: 1,
          kind: 'integration_file_restoration',
          integrationId: v.operation.id,
          applicationId: r.applicationId,
          restorationId: r.id,
          inputHash: r.inputHash,
          originalApplicationEvidenceHash: 'e'.repeat(64),
          sequence: stage === 'restoring' ? 1 : 2,
          stage,
          observedAt: new Date().toISOString(),
          restoredPaths: [],
          reason: stage === 'restoring' ? null : 'interrupted',
          confirmPublication: true,
        });
        assert.equal(p.statusCode, 200, p.body);
        v = await f.readView();
      }
      assert.equal(v.canRecompute, false);
      assert.equal((await f.api.call(f.optionsPath, f.alice)).statusCode, 409);
    }
    const r = v.restoration!,
      at = new Date().toISOString();
    const recovered = await f.protocol('restoration-recovery-publish', {
      version: 1,
      kind: 'local_integration_restoration_settlement',
      integrationId: v.operation.id,
      applicationId: r.applicationId,
      restorationId: r.id,
      recoveryId: randomUUID(),
      integrationInputHash: v.operation.inputHash,
      applicationInputHash: v.operation.application!.inputHash,
      restorationInputHash: r.inputHash,
      originalApplicationEvidenceHash: 'e'.repeat(64),
      restorationEvidenceHash: 'f'.repeat(64),
      pendingReportHash: null,
      stoppedConfirmedAt: at,
      releasedAt: at,
      disposition: 'preserve_files',
      processEvidence: 'operator_confirmed_stopped',
      lease: 'released',
      filesVerified: false,
      recordedRestoredCount: 0,
      unresolvedWriteIntent: true,
      confirmPublication: true,
    });
    assert.equal(recovered.statusCode, 200, recovered.body);
    v = await f.readView();
    assert.equal(v.canRecompute, true);
    const before = oldEvidence(f),
      created = await f.api.call(f.recomputePath, f.alice, {
        ...f.data,
        expectedRevision: v.operation.revision,
      });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(oldEvidence(f), before);
    assert.equal((await f.readView()).operation.state, 'completed');
    assert.equal((await f.readView()).restoration!.state, 'needs_attention');
  } finally {
    await f.close();
  }
});
test('同目录选项先筛选后限额，同提交的新检查点有效；目标仓库身份替换拒绝', async () => {
  const f = await prepared();
  try {
    const same = await recordResultCode(f, f.target),
      retained = f.retain(same.checkpointId, f.target);
    // Many newer valid foreign-node checkpoints must not hide this workspace's candidates.
    for (let n = 0; n < 52; n++) await recordResultCode(f, f.next, 1);
    const options = await f.api.call(f.optionsPath, f.alice);
    assert.equal(options.statusCode, 200, options.body);
    assert(
      options
        .json()
        .targets.some(
          (t: { target: { retentionId: string } }) => t.target.retentionId === retained.request.id,
        ),
    );
    const created = await f.api.call(f.recomputePath, f.alice, {
      ...f.data,
      targetCheckpointId: same.checkpointId,
      targetRetentionId: retained.request.id,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(
      created.json().operation.target.manifest.commit,
      f.original.operation.target.manifest.commit,
    );
    // Corruption fixture: new checkpoint metadata alone cannot authorize a different repository.
    const row = f.api.store.db
      .prepare('SELECT body FROM commit_checkpoints WHERE id=?')
      .get(f.cp.checkpointId) as { body: string };
    const replaced = JSON.parse(row.body);
    replaced.manifest.repositoryIdentity = 'd'.repeat(64);
    f.api.store.db
      .prepare('UPDATE commit_checkpoints SET body=? WHERE id=?')
      .run(JSON.stringify(replaced), f.cp.checkpointId);
    assert.equal((await f.api.call(f.recomputePath, f.alice, f.data)).statusCode, 409);
  } finally {
    await f.close();
  }
});
