import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from './helpers/integration-snapshot.js';
import { buildIntegrationPlan } from '../apps/runner/src/agent/integration-plan.js';
import { buildIntegrationTrialPlan } from '../apps/runner/src/agent/integration-trial-plan.js';
import {
  buildIntegrationTrialDifference,
  type IntegrationTrialDifferenceMetadata,
} from '../apps/runner/src/agent/integration-trial-difference.js';
import { parseIntegrationTrialDifference } from '../packages/contracts/src/integration-trial.js';
const root = '/nonexistent-conflict-difference';
async function setup(keep = false) {
  const base = await snapshot({ file: 'BASE', deleted: 'BASE DELETED' }),
    source = await snapshot({ file: 'SOURCE', deleted: 'SOURCE RESTORED' }),
    target = await snapshot({ file: 'TARGET', 'only-target': 'PRIVATE UNSELECTED' }),
    trees = { base: base.tree, source: source.tree, target: target.tree },
    snapshots = { base, source, target },
    plan = buildIntegrationPlan('sha1', trees, snapshots, root),
    selection = {
      version: 2 as const,
      kind: 'explicit_conflict_choices' as const,
      selectedPaths: keep ? [] : ['deleted', 'file'],
      conflictChoices: ['deleted', 'file'].map((path) => ({
        path,
        choice: keep ? ('keep_target' as const) : ('take_source' as const),
      })),
    };
  const candidate = await buildIntegrationTrialPlan(
      'sha1',
      trees,
      snapshots,
      plan,
      selection.selectedPaths,
      root,
      selection,
    ),
    metadata: IntegrationTrialDifferenceMetadata = {
      version: 2,
      kind: 'integration_trial_difference',
      integrationId: 'integration',
      trialId: 'trial',
      integrationInputHash: 'a'.repeat(64),
      preflightReportHash: 'b'.repeat(64),
      manifestHash: candidate.manifestHash,
      selection: 'explicit_conflict_choices',
      selectedPaths: selection.selectedPaths,
      conflictChoices: selection.conflictChoices,
      materializedAt: '2026-09-30T00:00:00.000Z',
      comparedAt: '2026-09-30T00:00:01.000Z',
      trialOnly: true,
      applied: false,
      writeAuthorized: false,
      confirmPublication: true,
    };
  const objects = (s: typeof source) => new Map(s.objects.map((o) => [o.id, o.data]));
  return {
    plan,
    metadata,
    build: (m = metadata) =>
      buildIntegrationTrialDifference(m, plan, objects(target), objects(source)),
  };
}
test('版本2差异仅显示真实采用来源的目标→候选变化，决策与原清单指纹不可丢', async () => {
  const f = await setup(),
    r = f.build();
  assert.deepEqual(r.conflictChoices, f.metadata.conflictChoices);
  assert.equal(r.manifestHash, f.metadata.manifestHash);
  assert.deepEqual(
    r.difference.files.map((f) => [f.path, f.beforeText, f.afterText]),
    [
      ['deleted', '', 'SOURCE RESTORED'],
      ['file', 'TARGET', 'SOURCE'],
    ],
  );
  assert(!JSON.stringify(r).includes('PRIVATE UNSELECTED'));
  assert.deepEqual(parseIntegrationTrialDifference(r), r);
  for (const change of [
    { version: 1 },
    { selection: 'apply_source' },
    { conflictChoices: undefined },
    { conflictChoices: [{ path: 'deleted', choice: 'keep_target' }] },
    { selectedPaths: ['file'] },
    { writeAuthorized: true },
  ])
    assert.throws(() => parseIntegrationTrialDifference({ ...r, ...change }));
  assert.throws(() =>
    f.build({
      ...f.metadata,
      conflictChoices: [{ path: 'not-a-conflict', choice: 'keep_target' }],
    }),
  );
});
test('全部保留目标的版本2共享差异0项正文/0写入，旧v1空选择仍拒绝', async () => {
  const f = await setup(true),
    r = f.build();
  assert.equal(r.difference.changedFiles, 0);
  assert.deepEqual(r.difference.files, []);
  assert.equal(r.conflictChoices!.length, 2);
  assert.deepEqual(r.selectedPaths, []);
  assert.equal(r.applied, false);
  assert.equal(r.writeAuthorized, false);
  const { conflictChoices: _choices, ...old } = r;
  assert.throws(() =>
    parseIntegrationTrialDifference({ ...old, version: 1, selection: 'apply_source' }),
  );
  assert.throws(() =>
    parseIntegrationTrialDifference({
      ...r,
      difference: { changedFiles: 1, omittedFiles: 1, files: [] },
    }),
  );
});
