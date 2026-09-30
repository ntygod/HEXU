import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import { RETENTION_LIMITS } from '../packages/contracts/src/checkpoint-retention.js';
import type { IntegrationPlan } from '../packages/contracts/src/integrations.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import {
  objectHash,
  verifySnapshot,
  type SnapshotObject,
} from '../apps/runner/src/agent/checkpoint-objects.js';
import { buildIntegrationPlan } from '../apps/runner/src/agent/integration-plan.js';
import {
  buildIntegrationTrialPlan,
  type IntegrationTrialPlan,
} from '../apps/runner/src/agent/integration-trial-plan.js';

type Format = 'sha1' | 'sha256';
type Value = string | Buffer | { data: string | Buffer; mode: string };
interface Item {
  name: string | Buffer;
  children?: Item[];
  mode?: string;
  data?: Buffer;
}
async function itemsSnapshot(items: Item[], format: Format = 'sha1') {
  const objects = new Map<string, SnapshotObject>();
  const put = (type: SnapshotObject['type'], data: Buffer) => {
    const id = objectHash(format, type, data);
    objects.set(id, { id, type, data });
    return id;
  };
  const makeTree = (children: Item[]): string =>
    put(
      'tree',
      Buffer.concat(
        children.map((item) => {
          const mode = item.mode ?? (item.children ? '40000' : '100644');
          const id = item.children
            ? makeTree(item.children)
            : mode === '160000'
              ? 'a'.repeat(format === 'sha1' ? 40 : 64)
              : put('blob', item.data ?? Buffer.alloc(0));
          return Buffer.concat([
            Buffer.from(`${mode} `),
            Buffer.from(item.name),
            Buffer.from([0]),
            Buffer.from(id, 'hex'),
          ]);
        }),
      ),
    );
  const tree = makeTree(items),
    commit = put('commit', Buffer.from(`tree ${tree}\n\ntrial fixture\n`));
  return {
    tree,
    commit,
    ...(await verifySnapshot(format, commit, tree, async (id) => objects.get(id)!.data)),
  };
}
async function snapshot(files: Record<string, Value>, format: Format = 'sha1') {
  const root: Item[] = [];
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split('/');
    let children = root;
    for (const name of parts.slice(0, -1)) {
      let item = children.find((i) => i.name === name);
      if (!item) {
        item = { name, children: [] };
        children.push(item);
      }
      children = item.children!;
    }
    const file = typeof value === 'string' || Buffer.isBuffer(value) ? { data: value } : value;
    children.push({
      name: parts.at(-1)!,
      data: Buffer.from(file.data),
      mode: 'mode' in file ? file.mode : undefined,
    });
  }
  return itemsSnapshot(root, format);
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const root = '/nonexistent-pure-trial-input';
function setup(
  base: Snapshot,
  source: Snapshot,
  target: Snapshot,
  format: Format = 'sha1',
  targetRoot = root,
) {
  const trees = { base: base.tree, source: source.tree, target: target.tree },
    snapshots = { base, source, target };
  const plan = buildIntegrationPlan(format, trees, snapshots, targetRoot);
  return {
    trees,
    snapshots,
    plan,
    trial: (paths: readonly string[], original: IntegrationPlan = plan) =>
      buildIntegrationTrialPlan(format, trees, snapshots, original, paths, targetRoot),
  };
}
const code = (expected: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === expected;
const files = (trial: IntegrationTrialPlan) => trial.entries.filter((e) => e.kind === 'file');
const bodies = (trial: IntegrationTrialPlan) =>
  Object.fromEntries(files(trial).map((e) => [e.path, e.data.toString('hex')]));

for (const format of ['sha1', 'sha256'] as const)
  test(`${format} selected add/modify/delete preserve every unselected target file and private provenance`, async () => {
    const base = await snapshot(
      { modify: 'old', delete: 'gone', unselectedDelete: 'keep', mode: 'run', conflict: 'base' },
      format,
    );
    const source = await snapshot(
      {
        modify: 'source-private',
        mode: { data: 'run', mode: '100755' },
        conflict: 'source conflict',
        'new/nested/binary': Buffer.from([0, 255, 2]),
        'new/empty': '',
        unselectedAdd: 'omit',
      },
      format,
    );
    const target = await snapshot(
      {
        modify: 'old',
        delete: 'gone',
        unselectedDelete: 'keep',
        mode: 'run',
        conflict: 'target conflict',
        'target-only/file': 'target private',
      },
      format,
    );
    const input = setup(base, source, target, format);
    const selected = ['modify', 'delete', 'mode', 'new/nested/binary', 'new/empty'];
    const before = canonicalJson(input.plan);
    const trial = await input.trial(selected);
    assert.deepEqual(bodies(trial), {
      conflict: Buffer.from('target conflict').toString('hex'),
      mode: Buffer.from('run').toString('hex'),
      modify: Buffer.from('source-private').toString('hex'),
      'new/empty': '',
      'new/nested/binary': '00ff02',
      'target-only/file': Buffer.from('target private').toString('hex'),
      unselectedDelete: Buffer.from('keep').toString('hex'),
    });
    assert.equal(files(trial).find((f) => f.path === 'mode')!.gitMode, '100755');
    assert.deepEqual(
      trial.entries.filter((e) => e.kind === 'directory').map((e) => e.path),
      ['new', 'new/nested', 'target-only'],
    );
    assert(trial.entries.filter((e) => e.kind === 'directory').every((e) => !('objectId' in e)));
    for (const file of files(trial)) {
      const origin = selected.includes(file.path) ? 'source' : 'target';
      assert.equal(file.origin, origin);
      assert.equal(file.snapshotHash, input.snapshots[origin].snapshotHash);
      assert.equal(objectHash(format, 'blob', file.data), file.objectId);
      assert.equal(file.bytes, file.data.length);
    }
    assert.equal(
      trial.materializedBytes,
      files(trial).reduce((n, f) => n + f.data.length, 0),
    );
    assert.equal(trial.selection, 'apply_source');
    assert.equal(trial.trialOnly, true);
    assert.equal(trial.applied, false);
    assert.equal(trial.writeAuthorized, false);
    assert(!JSON.stringify(trial.manifest).includes('source-private'));
    assert(trial.manifest.entries.every((entry) => !('data' in entry)));
    assert.equal(
      trial.manifestHash,
      createHash('sha256').update(canonicalJson(trial.manifest)).digest('hex'),
    );
    assert.deepEqual(await input.trial([...selected].reverse()), trial);
    assert.equal(canonicalJson(input.plan), before);
    const file = files(trial).find((f) => f.path === 'modify')!;
    const originalBlob = source.objects.find((o) => o.id === file.objectId)!.data;
    file.data.fill(0);
    assert.equal(originalBlob.toString(), 'source-private');
    assert.equal((await input.trial(selected)).manifestHash, trial.manifestHash);
  });

test('empty/duplicate/unknown/too-many selections and conflicts/already-present are not implicit choices', async () => {
  const base = await snapshot({ conflict: 'base', already: 'base' }),
    source = await snapshot({ conflict: 'source', already: 'source', add: 'new' }),
    target = await snapshot({ conflict: 'target', already: 'source' });
  const input = setup(base, source, target);
  for (const paths of [
    [],
    ['add', 'add'],
    ['unknown'],
    ['../add'],
    ['conflict'],
    ['already'],
    Array.from({ length: 81 }, (_, i) => `file-${i}`),
  ])
    await assert.rejects(input.trial(paths), code('INTEGRATION_TRIAL_UNSUPPORTED'));
  assert.deepEqual(
    files(await input.trial(['add'])).map((e) => e.path),
    ['add', 'already', 'conflict'],
  );
});

test('entire original report is rederived, not just selected metadata or its summary hashes', async () => {
  const base = await snapshot({ change: 'old', unselected: 'old' }),
    source = await snapshot({ change: 'new', unselected: 'new' });
  const input = setup(base, source, base);
  const mutations: ((p: IntegrationPlan) => void)[] = [
    (p) => {
      p.files[1]!.source!.bytes++;
    },
    (p) => {
      p.files[1]!.source!.objectId = 'a'.repeat(40);
    },
    (p) => {
      p.files[1]!.target!.mode = '100755';
    },
    (p) => {
      p.files[1]!.action = 'already_present';
    },
    (p) => {
      p.files[1]!.path = 'another';
    },
    (p) => {
      p.files[1] = p.files[0]!;
    },
    (p) => {
      p.conflicts++;
    },
    (p) => {
      p.alreadyPresent++;
    },
    (p) => {
      p.sourceSnapshotHash = 'a'.repeat(64);
    },
    (p) => {
      p.omittedFiles = 1;
    },
    (p) => {
      p.files.pop();
      p.changedFiles--;
    },
    (p) => {
      p.files.reverse();
    },
    (p) => {
      Object.assign(p, { writeAuthorized: true });
    },
    (p) => {
      Object.assign(p, { applied: true });
    },
    (p) => {
      Object.assign(p, { data: 'pretend body' });
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(input.plan);
    mutate(forged);
    await assert.rejects(input.trial(['change'], forged), code('INTEGRATION_PLAN_CHANGED'));
  }
  const empty = await snapshot({}),
    many = await snapshot(Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`f${i}`, 'x']))),
    omitted = setup(empty, many, empty);
  assert.equal(omitted.plan.omittedFiles, 1);
  await assert.rejects(omitted.trial(['f0']), code('INTEGRATION_PLAN_CHANGED'));
  const disguised = { ...omitted.plan, omittedFiles: 0, changedFiles: omitted.plan.files.length };
  await assert.rejects(omitted.trial(['f0'], disguised), code('INTEGRATION_PLAN_CHANGED'));
});

test('case/NFC renames and file-directory transitions recheck the actual selected union', async () => {
  for (const [oldPath, newPath] of [
    ['Name', 'name'],
    ['é', 'e\u0301'],
    ['Dir/old', 'dir/new'],
    ['a', 'a/b'],
    ['a/b', 'a'],
  ]) {
    const base = await snapshot({ [oldPath!]: 'old' }),
      source = await snapshot({ [newPath!]: 'new' });
    const input = setup(base, source, base);
    assert.equal(input.plan.conflicts, 0);
    await assert.rejects(input.trial([newPath!]), code('INTEGRATION_PATH_COLLISION'));
    const complete = await input.trial([oldPath!, newPath!]);
    assert.deepEqual(
      files(complete).map((f) => f.path),
      [newPath],
    );
    const deletion = await input.trial([oldPath!]);
    assert.deepEqual(deletion.entries, []);
    assert.equal(deletion.materializedBytes, 0);
    assert.notEqual(deletion.manifestHash, complete.manifestHash);
  }
});

test('all three complete inputs reject unsupported links/LFS/gitlinks/names and empty subtrees, including unselected source files', async () => {
  const base = await snapshot({}),
    ordinary = await snapshot({ selected: 'safe' }),
    input = setup(base, ordinary, base);
  const bad: Item[] = [
    { name: 'link', mode: '120000', data: Buffer.from('../outside') },
    { name: 'module', mode: '160000' },
    {
      name: 'lfs',
      data: Buffer.from(
        `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`,
      ),
    },
    { name: 'name.' },
    { name: 'CON' },
    { name: Buffer.from([0xff]) },
    { name: 'control\nname' },
    { name: 'empty', children: [] },
  ];
  for (const item of bad) {
    const unsupported = await itemsSnapshot([
      { name: 'selected', data: Buffer.from('safe') },
      item,
    ]);
    for (const side of ['base', 'source', 'target'] as const)
      await assert.rejects(
        buildIntegrationTrialPlan(
          'sha1',
          { ...input.trees, [side]: unsupported.tree },
          { ...input.snapshots, [side]: unsupported },
          input.plan,
          ['selected'],
          root,
        ),
      );
  }
});

test('snapshot metadata is never body: rehash bytes, reject missing/extra/duplicate objects and wrong graph/hash/coverage', async () => {
  const base = await snapshot({}),
    source = await snapshot({ selected: 'verified bytes' }),
    input = setup(base, source, base);
  const variants = [
    { ...source, objects: source.objects.filter((o) => o.type !== 'blob') },
    { ...source, objects: [...source.objects, source.objects[0]!] },
    { ...source, snapshotHash: 'f'.repeat(64) },
    { ...source, coverage: { ...source.coverage, files: 0 } },
    {
      ...source,
      objects: source.objects.map((o) =>
        o.type === 'blob' ? { ...o, data: Buffer.from('diff instead') } : o,
      ),
    },
    {
      ...source,
      objects: [
        ...source.objects,
        {
          id: objectHash('sha1', 'blob', Buffer.from('extra')),
          type: 'blob' as const,
          data: Buffer.from('extra'),
        },
      ],
    },
  ];
  for (const variant of variants)
    await assert.rejects(
      buildIntegrationTrialPlan(
        'sha1',
        input.trees,
        { ...input.snapshots, source: variant },
        input.plan,
        ['selected'],
        root,
      ),
    );
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha1',
      { ...input.trees, source: base.tree },
      input.snapshots,
      input.plan,
      ['selected'],
      root,
    ),
  );
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha256',
      input.trees,
      input.snapshots,
      input.plan,
      ['selected'],
      root,
    ),
  );
  const pending = input.trial(['selected']);
  source.objects.find((o) => o.type === 'blob')!.data.fill(0);
  input.trees.source = base.tree;
  input.plan.files[0]!.source!.bytes = 100;
  const detached = await pending;
  assert.equal(files(detached)[0]!.data.toString(), 'verified bytes');
});

test('expanded bytes count every output path, including reused blobs and target-only files, with the exact 64 MiB boundary', async () => {
  const blob = Buffer.alloc(RETENTION_LIMITS.blob, 0x58),
    base = await snapshot({}),
    source = await snapshot(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`new-${i}`, blob])),
    ),
    target = await snapshot({ retained: blob }),
    input = setup(base, source, target);
  const trial = await input.trial(Array.from({ length: 7 }, (_, i) => `new-${i}`));
  assert.equal(trial.materializedBytes, RETENTION_LIMITS.bytes);
  assert.equal(files(trial).length, 8);
  assert(files(trial).every((e) => e.objectId === files(trial)[0]!.objectId));
  files(trial)[0]!.data[0] = 0;
  assert.equal(files(trial)[1]!.data[0], 0x58);
  await assert.rejects(
    input.trial(Array.from({ length: 8 }, (_, i) => `new-${i}`)),
    code('RESTORE_EXPANSION_LIMIT'),
  );
  const over = await snapshot(
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`over-${i}`, blob])),
  );
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha1',
      { ...input.trees, source: over.tree },
      { ...input.snapshots, source: over },
      input.plan,
      ['new-0'],
      root,
    ),
    code('RESTORE_EXPANSION_LIMIT'),
  );
});

test('the selected full tree respects expanded entry count including root and new directories', async () => {
  const base = await snapshot({}),
    source = await snapshot({ added: '', extra: '' }),
    target = await snapshot(
      Object.fromEntries(
        Array.from({ length: RETENTION_LIMITS.entries - 2 }, (_, i) => [`retained-${i}`, '']),
      ),
    ),
    input = setup(base, source, target);
  const atLimit = await input.trial(['added']);
  assert.equal(atLimit.entries.length, RETENTION_LIMITS.entries - 1);
  assert.equal(atLimit.materializedBytes, 0);
  await assert.rejects(input.trial(['added', 'extra']), code('RESTORE_EXPANSION_LIMIT'));
});

test('path/depth/blob bounds apply to independently verified inputs and the complete output', async () => {
  const base = await snapshot({}),
    source = await snapshot({ a: 'x' });
  const allowedRoot = '/' + 'r'.repeat(4092);
  assert.equal(files(await setup(base, source, base, 'sha1', allowedRoot).trial(['a'])).length, 1);
  const input = setup(base, source, base);
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha1',
      input.trees,
      input.snapshots,
      input.plan,
      ['a'],
      allowedRoot + 'r',
    ),
    code('RESTORE_PATH_UNSUPPORTED'),
  );
  for (const path of ['relative', '/has/../alias', '/contains\\slash', '/contains\ncontrol'])
    await assert.rejects(
      buildIntegrationTrialPlan('sha1', input.trees, input.snapshots, input.plan, ['a'], path),
      code('RESTORE_PATH_UNSUPPORTED'),
    );
  const deepPath = [...Array.from({ length: RETENTION_LIMITS.depth }, () => 'd'), 'file'].join('/'),
    deepest = await snapshot({ [deepPath]: '' });
  const deepTrial = await setup(base, deepest, base).trial([deepPath]);
  assert.equal(deepTrial.entries.length, RETENTION_LIMITS.depth + 1);
  await assert.rejects(snapshot({ ['d/' + deepPath]: '' }), code('RETENTION_LIMIT'));
  const huge = Buffer.alloc(RETENTION_LIMITS.blob + 1);
  await assert.rejects(snapshot({ huge }), code('SNAPSHOT_INCOMPLETE'));
});

test('the 80-path selection boundary is exact and report-byte truncation cannot be hidden', async () => {
  const base = await snapshot({}),
    source = await snapshot(
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`file-${i}`, 'x'])),
    ),
    input = setup(base, source, base);
  assert.equal(input.plan.omittedFiles, 0);
  const selected = input.plan.files.map((f) => f.path);
  assert.equal(files(await input.trial(selected)).length, 80);
  const reversedObjects = {
    base: { ...base, objects: [...base.objects].reverse() },
    source: { ...source, objects: [...source.objects].reverse() },
    target: { ...base, objects: [...base.objects].reverse() },
  };
  assert.equal(
    (
      await buildIntegrationTrialPlan(
        'sha1',
        input.trees,
        reversedObjects,
        input.plan,
        selected,
        root,
      )
    ).manifestHash,
    (await input.trial(selected)).manifestHash,
  );
  const longSource = await snapshot(
    Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `${'p'.repeat(240)}/${'q'.repeat(240)}/file-${i}`,
        'x',
      ]),
    ),
  );
  const clipped = setup(base, longSource, base);
  assert(clipped.plan.files.length < 80);
  assert(clipped.plan.omittedFiles > 0);
  await assert.rejects(
    clipped.trial([clipped.plan.files[0]!.path]),
    code('INTEGRATION_PLAN_CHANGED'),
  );
  const disguised = { ...clipped.plan, omittedFiles: 0, changedFiles: clipped.plan.files.length };
  await assert.rejects(
    clipped.trial([clipped.plan.files[0]!.path], disguised),
    code('INTEGRATION_PLAN_CHANGED'),
  );
});

test('conservative name byte boundaries and cross-snapshot collisions are retained', async () => {
  const base = await snapshot({}),
    source = await snapshot({ ['n'.repeat(255)]: '' });
  assert.equal(files(await setup(base, source, base).trial(['n'.repeat(255)])).length, 1);
  const tooLong = await snapshot({ ['n'.repeat(256)]: '' }),
    original = setup(base, source, base);
  await assert.rejects(
    buildIntegrationTrialPlan(
      'sha1',
      { ...original.trees, source: tooLong.tree },
      { ...original.snapshots, source: tooLong },
      original.plan,
      ['n'.repeat(255)],
      root,
    ),
    code('RESTORE_PATH_UNSUPPORTED'),
  );
  const colliding = await snapshot({ 'Dir/source': '' }),
    target = await snapshot({ 'dir/target': '' }),
    collision = setup(base, colliding, target);
  assert.equal(collision.plan.files[0]!.conflict, 'path_collision');
  await assert.rejects(collision.trial(['Dir/source']), code('INTEGRATION_TRIAL_UNSUPPORTED'));
});

test('a complete metadata manifest has its own bounded budget even for zero-byte files', async () => {
  const base = await snapshot({}),
    source = await snapshot({ selected: '' });
  // Repeated parent names are legal on different levels; the graph is tiny but
  // every expanded path must be represented in the complete private manifest.
  let items: Item[] = Array.from({ length: 18000 }, (_, i) => ({ name: `file-${i}` }));
  for (let i = 0; i < 15; i++) items = [{ name: 'd'.repeat(240), children: items }];
  const target = await itemsSnapshot(items),
    input = setup(base, source, target);
  await assert.rejects(input.trial(['selected']), code('RESTORE_EXPANSION_LIMIT'));
});
