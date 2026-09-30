import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { integrationFixture } from './helpers/integrations.js';
import { buildIntegrationTrialDifference } from '../apps/runner/src/agent/integration-trial-difference.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
import { codeHash } from '../packages/db/src/result-code.js';
async function setup() {
  const f = await integrationFixture(undefined, 'sha1', { targetText: 'USER TARGET VERSION' });
  const initial = await f.create(),
    preflight = f.report(initial);
  assert.equal(preflight.plan.files.find((f) => f.path === 'README.md')!.conflict, 'both_changed');
  const result = await f.protocol('publish', preflight);
  assert.equal(result.statusCode, 200, result.body);
  const read = async () =>
    (
      await f.api.call(`${f.integrationPath}/${initial.operation.id}`, f.alice)
    ).json() as IntegrationView;
  const v = await read();
  const report = (takeSource: boolean, includeSafe = true) =>
    buildIntegrationTrialDifference(
      {
        version: 2,
        kind: 'integration_trial_difference',
        integrationId: v.operation.id,
        trialId: randomUUID(),
        integrationInputHash: v.operation.inputHash,
        preflightReportHash: v.reportHash!,
        manifestHash: 'a'.repeat(64),
        selection: 'explicit_conflict_choices',
        selectedPaths: [...(takeSource ? ['README.md'] : []), ...(includeSafe ? ['new.txt'] : [])],
        conflictChoices: [
          { path: 'README.md', choice: takeSource ? 'take_source' : 'keep_target' },
        ],
        materializedAt: new Date().toISOString(),
        comparedAt: new Date().toISOString(),
        trialOnly: true,
        applied: false,
        writeAuthorized: false,
        confirmPublication: true,
      },
      v.operation.report!.plan!,
      new Map(f.target.objects.map((o) => [o.id, o.data])),
      new Map(f.source.objects.map((o) => [o.id, o.data])),
    );
  return { ...f, v, read, report };
}
for (const take of [true, false])
  test(`冲突候选${take ? '采用来源' : '保留目标'}独立保存决策，只有真实变化路径获得另行写回许可`, async () => {
    const f = await setup();
    try {
      const r = f.report(take),
        before = JSON.stringify(f.v.operation),
        shared = await f.protocol('trial-diff-publish', r);
      assert.equal(shared.statusCode, 200, shared.body);
      assert.equal(JSON.stringify((await f.read()).operation), before);
      const apply = await f.api.call(`${f.integrationPath}/${f.v.operation.id}/apply`, f.alice, {
        expectedRevision: f.v.operation.revision,
        expectedTaskRevision: f.v.taskRevision,
        reportHash: f.v.reportHash,
        paths: r.selectedPaths,
        confirmApplication: true,
        candidate: {
          trialId: r.trialId,
          reportHash: codeHash(r),
          manifestHash: r.manifestHash,
          confirmExistingChanges: true,
        },
      });
      assert.equal(apply.statusCode, 200, apply.body);
      const v = apply.json() as IntegrationView;
      assert.deepEqual(
        v.operation.application!.paths,
        take ? ['README.md', 'new.txt'] : ['new.txt'],
      );
      assert.equal(v.operation.report!.plan!.conflicts, 1);
      assert.equal(
        v.operation.report!.plan!.files.find((f) => f.path === 'README.md')!.action,
        'conflict',
      );
      assert.deepEqual((await f.protocol('trial-diff-publish', r)).json(), shared.json());
    } finally {
      await f.close();
    }
  });
test('全部保留目标可共享0变更候选，但不能创建空应用或把原conflict改completed', async () => {
  const f = await setup();
  try {
    const r = f.report(false, false),
      shared = await f.protocol('trial-diff-publish', r);
    assert.equal(shared.statusCode, 200, shared.body);
    assert.equal(r.difference.changedFiles, 0);
    const v = await f.read();
    assert.equal(v.operation.state, 'conflict');
    assert.equal(v.operation.application, null);
    const apply = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: [],
      confirmApplication: true,
      candidate: {
        trialId: r.trialId,
        reportHash: codeHash(r),
        manifestHash: r.manifestHash,
        confirmExistingChanges: true,
      },
    });
    assert.equal(apply.statusCode, 400);
    assert.equal((await f.read()).operation.application, null);
  } finally {
    await f.close();
  }
});
test('冲突共享拒绝伪造/旧v1绕过，精确回执前仍检查当前目标授权', async () => {
  const f = await setup();
  try {
    const take = f.report(true),
      keep = f.report(false, false),
      { conflictChoices: _c, ...old } = take;
    for (const invalid of [
      { ...old, version: 1, selection: 'apply_source' },
      { ...keep, conflictChoices: [{ path: 'not-in-preflight', choice: 'keep_target' }] },
      { ...keep, conflictChoices: [{ path: 'new.txt', choice: 'keep_target' }] },
      {
        ...take,
        difference: {
          ...take.difference,
          files: take.difference.files.map((file) => ({ ...file, before: file.after })),
        },
      },
    ])
      assert.notEqual((await f.protocol('trial-diff-publish', invalid)).statusCode, 200);
    assert.equal((await f.protocol('trial-diff-publish', take)).statusCode, 200);
    const tampered = f.report(false);
    tampered.trialId = take.trialId;
    assert.equal((await f.protocol('trial-diff-publish', tampered)).statusCode, 409);
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.notEqual((await f.protocol('trial-diff-publish', take)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('完整both_changed冲突单独提供试应用选择，结构冲突和省略仍不给选择入口', async () => {
  const f = await integrationFixture(undefined, 'sha1', { targetText: 'CONFLICT TARGET' });
  try {
    for (const kind of ['both_changed', 'path_collision', 'omitted'] as const) {
      const initial = await f.create(),
        report = f.report(initial);
      report.plan.files = report.plan.files.filter((file) => file.path === 'README.md');
      report.plan.changedFiles = 1;
      report.plan.conflicts = 1;
      if (kind === 'path_collision') report.plan.files[0]!.conflict = 'path_collision';
      if (kind === 'omitted') {
        report.plan.omittedFiles = 1;
        report.plan.changedFiles = 2;
      }
      const published = await f.protocol('publish', report);
      assert.equal(published.statusCode, 200, published.body);
      const read = (
        await f.api.call(`${f.integrationPath}/${initial.operation.id}`, f.alice)
      ).json() as IntegrationView;
      assert.equal(read.canTrial, kind === 'both_changed');
      assert.equal(read.canApply, false);
    }
  } finally {
    await f.close();
  }
});
