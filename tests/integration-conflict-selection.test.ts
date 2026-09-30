import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIntegrationConflictSelection,
  type IntegrationConflictSelection,
  type IntegrationConflictChoice,
} from '../packages/contracts/src/integration-conflict-selection.js';
import { evaluateIntegrationConflictSelection } from '../packages/domain/src/integration-conflict-selection.js';
import { buildIntegrationPlan } from '../apps/runner/src/agent/integration-plan.js';
import { buildIntegrationTrialPlan } from '../apps/runner/src/agent/integration-trial-plan.js';
import { snapshot, type Format } from './helpers/integration-snapshot.js';
import { canonicalJson } from '../packages/domain/src/index.js';
const root = '/nonexistent-pure-conflict-target';
const choice = (
  selectedPaths: string[],
  conflictChoices: IntegrationConflictChoice[],
): IntegrationConflictSelection => ({
  version: 2,
  kind: 'explicit_conflict_choices',
  selectedPaths,
  conflictChoices,
});
async function fixture(format: Format = 'sha1') {
  const base = await snapshot(
    {
      modify: 'base',
      'source-delete': 'delete base',
      'target-delete': 'restore base',
      safe: 'safe base',
      unresolved: 'base',
    },
    format,
  );
  const source = await snapshot(
    {
      modify: Buffer.from([0, 255, 2]),
      add: { data: 'SOURCE SCRIPT', mode: '100755' },
      'target-delete': '',
      safe: 'safe source',
      unresolved: 'source',
    },
    format,
  );
  const target = await snapshot(
    {
      modify: 'target',
      add: 'TARGET TEXT',
      'source-delete': 'target later',
      safe: 'safe base',
      unresolved: 'target',
      'target-only': 'TARGET ONLY',
    },
    format,
  );
  const trees = { base: base.tree, source: source.tree, target: target.tree },
    snapshots = { base, source, target },
    plan = buildIntegrationPlan(format, trees, snapshots, root);
  return {
    plan,
    trees,
    snapshots,
    build: (selection: IntegrationConflictSelection) =>
      buildIntegrationTrialPlan(
        format,
        trees,
        snapshots,
        plan,
        selection.selectedPaths,
        root,
        selection,
      ),
  };
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 四类整文件冲突明确来源/目标，原报告不变，target删除后选来源是真实add`, async () => {
    const f = await fixture(format),
      before = canonicalJson(f.plan),
      paths = ['add', 'modify', 'source-delete', 'target-delete'];
    const sourceChoice = choice(
        [...paths, 'safe'],
        paths.map((path) => ({ path, choice: 'take_source' })),
      ),
      targetChoice = choice(
        ['safe'],
        paths.map((path) => ({ path, choice: 'keep_target' })),
      );
    const source = await f.build(sourceChoice),
      effective = evaluateIntegrationConflictSelection(f.plan, sourceChoice);
    assert.equal(source.version, 2);
    assert.equal(source.selection, 'explicit_conflict_choices');
    assert.equal(source.writeAuthorized, false);
    assert.deepEqual(
      effective.changes.map((f) => [f.path, f.action]),
      [
        ['add', 'modify'],
        ['modify', 'modify'],
        ['safe', 'modify'],
        ['source-delete', 'delete'],
        ['target-delete', 'add'],
      ],
    );
    assert.deepEqual(effective.unresolvedConflicts, ['unresolved']);
    assert.deepEqual(effective.unsupportedConflicts, []);
    const files = new Map(source.entries.filter((f) => f.kind === 'file').map((f) => [f.path, f]));
    assert.equal(files.get('add')!.gitMode, '100755');
    assert.equal(files.get('add')!.data.toString(), 'SOURCE SCRIPT');
    assert.equal(files.get('modify')!.data.toString('hex'), '00ff02');
    assert.equal(files.get('target-delete')!.data.length, 0);
    assert(!files.has('source-delete'));
    assert.equal(files.get('unresolved')!.data.toString(), 'target');
    assert.equal(files.get('target-only')!.data.toString(), 'TARGET ONLY');
    const target = await f.build(targetChoice),
      kept = new Map(target.entries.filter((f) => f.kind === 'file').map((f) => [f.path, f]));
    assert.equal(kept.get('add')!.data.toString(), 'TARGET TEXT');
    assert.equal(kept.get('add')!.gitMode, '100644');
    assert.equal(kept.get('modify')!.data.toString(), 'target');
    assert.equal(kept.get('source-delete')!.data.toString(), 'target later');
    assert(!kept.has('target-delete'));
    assert.equal(kept.get('safe')!.data.toString(), 'safe source');
    assert.notEqual(source.manifestHash, target.manifestHash);
    assert.equal(canonicalJson(f.plan), before);
  });
test('全部保留目标为有明确证据的0写入候选，未选择冲突仍是未处理，不伪造completed', async () => {
  const f = await fixture(),
    selection = choice([], [{ path: 'modify', choice: 'keep_target' }]),
    r = await f.build(selection),
    evaluation = evaluateIntegrationConflictSelection(f.plan, selection);
  assert.deepEqual(r.selectedPaths, []);
  assert.deepEqual(r.conflictChoices, [{ path: 'modify', choice: 'keep_target' }]);
  assert.equal(evaluation.changes.length, 0);
  assert.deepEqual(evaluation.keptTargetPaths, ['modify']);
  assert(evaluation.unresolvedConflicts.includes('add'));
  assert(r.entries.filter((f) => f.kind === 'file').every((f) => f.origin === 'target'));
  assert.equal(r.applied, false);
  assert.equal(r.writeAuthorized, false);
  const plain = await buildIntegrationTrialPlan(
    'sha1',
    f.trees,
    f.snapshots,
    f.plan,
    ['safe'],
    root,
  );
  assert.equal(plain.version, 1);
  assert.equal(plain.selection, 'apply_source');
  assert(!('conflictChoices' in plain.manifest));
  await assert.rejects(buildIntegrationTrialPlan('sha1', f.trees, f.snapshots, f.plan, [], root));
  await assert.rejects(
    buildIntegrationTrialPlan('sha1', f.trees, f.snapshots, f.plan, ['modify'], root),
  );
});
test('严格决策拒绝隐含默认、重复、未知、保留目标混入写入、分开突破80项/48KiB及未知字段', async () => {
  const valid = choice(['safe', 'modify'], [{ path: 'modify', choice: 'take_source' }]);
  assert.deepEqual(parseIntegrationConflictSelection(valid).selectedPaths, ['modify', 'safe']);
  for (const bad of [
    { ...valid, version: 1 },
    { ...valid, kind: 'apply_source' },
    { ...valid, conflictChoices: [] },
    { ...valid, conflictChoices: [{ path: 'modify', choice: 'automatic' }] },
    { ...valid, conflictChoices: [...valid.conflictChoices, ...valid.conflictChoices] },
    choice(['modify'], [{ path: 'modify', choice: 'keep_target' }]),
    choice([], [{ path: 'modify', choice: 'take_source' }]),
    { ...valid, force: true },
    choice([], [{ path: 'bad\ud800', choice: 'keep_target' }]),
    choice(
      Array.from({ length: 80 }, (_, i) => `selected-${i}`),
      [{ path: 'other', choice: 'keep_target' }],
    ),
    choice(
      Array.from({ length: 80 }, (_, i) => `${i}-${'x'.repeat(500)}`),
      Array.from({ length: 80 }, (_, i) => ({
        path: `${i}-${'x'.repeat(500)}`,
        choice: 'take_source' as const,
      })),
    ),
  ])
    assert.throws(() => parseIntegrationConflictSelection(bad));
  const f = await fixture();
  for (const selection of [
    choice(['safe'], [{ path: 'unknown', choice: 'keep_target' }]),
    choice([], [{ path: 'safe', choice: 'keep_target' }]),
    choice(['modify'], [{ path: 'add', choice: 'keep_target' }]),
  ])
    await assert.rejects(f.build(selection));
  const omitted = structuredClone(f.plan);
  omitted.omittedFiles = 1;
  assert.throws(() => evaluateIntegrationConflictSelection(omitted, valid));
});
test('明确来源选择后的目录/大小写/NFC碰撞仍拒绝，不把原结构冲突标成已处理', async () => {
  for (const [sourcePath, targetOnly] of [
    ['name', 'name/nested'],
    ['readme', 'README'],
    ['é', 'e\u0301'],
  ] as const) {
    const base = await snapshot({ [sourcePath]: 'base' }),
      source = await snapshot({ [sourcePath]: 'source' }),
      target = await snapshot({ [targetOnly]: 'target' }),
      trees = { base: base.tree, source: source.tree, target: target.tree },
      snapshots = { base, source, target },
      plan = buildIntegrationPlan('sha1', trees, snapshots, root);
    assert.equal(plan.files.find((f) => f.path === sourcePath)!.conflict, 'both_changed');
    const selection = choice([sourcePath], [{ path: sourcePath, choice: 'take_source' }]);
    await assert.rejects(
      buildIntegrationTrialPlan(
        'sha1',
        trees,
        snapshots,
        plan,
        selection.selectedPaths,
        root,
        selection,
      ),
      /碰撞/,
    );
    const kept = choice([], [{ path: sourcePath, choice: 'keep_target' }]);
    assert.equal(
      (
        await buildIntegrationTrialPlan('sha1', trees, snapshots, plan, [], root, kept)
      ).entries.filter((f) => f.kind === 'file')[0]!.path,
      targetOnly,
    );
  }
  const base = await snapshot({}),
    source = await snapshot({ a: 'source' }),
    target = await snapshot({ 'a/child': 'target' }),
    trees = { base: base.tree, source: source.tree, target: target.tree },
    snapshots = { base, source, target },
    plan = buildIntegrationPlan('sha1', trees, snapshots, root);
  assert.equal(plan.files[0]!.conflict, 'path_collision');
  for (const decision of ['take_source', 'keep_target'] as const) {
    const selected = choice(decision === 'take_source' ? ['a'] : [], [
      { path: 'a', choice: decision },
    ]);
    await assert.rejects(
      buildIntegrationTrialPlan(
        'sha1',
        trees,
        snapshots,
        plan,
        selected.selectedPaths,
        root,
        selected,
      ),
    );
  }
});
test('新决策候选依然重验三个完整对象与不可变原预检，不能按改过的元数据拼正文', async () => {
  const f = await fixture(),
    selection = choice(['modify'], [{ path: 'modify', choice: 'take_source' }]);
  const fake = structuredClone(f.plan);
  fake.files.find((f) => f.path === 'modify')!.conflict = null;
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha1',
      f.trees,
      f.snapshots,
      fake,
      selection.selectedPaths,
      root,
      selection,
    ),
    /不一致/,
  );
  const original = f.snapshots.source.objects.find((o) => o.type === 'blob')!;
  const before = Buffer.from(original.data);
  original.data.fill(0);
  await assert.rejects(f.build(selection));
  original.data = before;
  await assert.rejects(
    buildIntegrationTrialPlan('sha1', f.trees, f.snapshots, f.plan, ['safe'], root, selection),
  );
});
