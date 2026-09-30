import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildIntegrationPlan } from '../apps/runner/src/agent/integration-plan.js';
import {
  integrationAdditions,
  integrationAdditionPlan,
} from '../apps/runner/src/agent/integration-application-plan.js';
import {
  objectHash,
  verifySnapshot,
  type SnapshotObject,
} from '../apps/runner/src/agent/checkpoint-objects.js';
import { parseIntegrationReport } from '../packages/contracts/src/integrations.js';

async function snapshot(
  files: Record<string, string | { data: string; mode: string }>,
  format: 'sha1' | 'sha256' = 'sha1',
) {
  const objects = new Map<string, SnapshotObject>();
  const put = (type: SnapshotObject['type'], data: Buffer) => {
    const id = objectHash(format, type, data);
    objects.set(id, { id, type, data });
    return id;
  };
  const tree = (prefix: string): string => {
    const leaves = new Map<string, { mode: string; id: string }>(),
      dirs = new Set<string>();
    for (const [path, value] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const p = path.slice(prefix.length),
        slash = p.indexOf('/');
      if (slash >= 0) dirs.add(p.slice(0, slash));
      else
        leaves.set(p, {
          mode: typeof value === 'string' ? '100644' : value.mode,
          id: put('blob', Buffer.from(typeof value === 'string' ? value : value.data)),
        });
    }
    for (const dir of dirs) leaves.set(dir, { mode: '40000', id: tree(prefix + dir + '/') });
    return put(
      'tree',
      Buffer.concat(
        [...leaves]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, v]) =>
            Buffer.concat([Buffer.from(`${v.mode} ${name}\0`), Buffer.from(v.id, 'hex')]),
          ),
      ),
    );
  };
  const root = tree(''),
    commit = put('commit', Buffer.from(`tree ${root}\n\nfixture\n`));
  return {
    tree: root,
    commit,
    ...(await verifySnapshot(format, commit, root, async (id) => objects.get(id)!.data)),
  };
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format}完整对象三方比较保留目标独有文件，识别增删/二进制/模式与双方修改，报告不含正文`, async () => {
    const base = await snapshot(
      { modify: 'b', delete: 'd', conflict: 'b', mode: 'x', already: 'b' },
      format,
    );
    const source = await snapshot(
      {
        modify: 'SOURCE_PRIVATE',
        add: 'a',
        conflict: 's',
        mode: { data: 'x', mode: '100755' },
        already: 's',
        binary: '\0\u0001',
      },
      format,
    );
    const target = await snapshot(
      { modify: 'b', delete: 'd', conflict: 't', mode: 'x', already: 's', 'target-only': 'z' },
      format,
    );
    const plan = buildIntegrationPlan(
      format,
      { base: base.tree, source: source.tree, target: target.tree },
      { base, source, target },
      '/fixture',
    );
    assert.equal(plan.changedFiles, 7);
    assert.equal(plan.conflicts, 1);
    assert.equal(plan.alreadyPresent, 1);
    assert.equal(plan.omittedFiles, 0);
    assert.deepEqual(Object.fromEntries(plan.files.map((f) => [f.path, f.action])), {
      add: 'add',
      already: 'already_present',
      binary: 'add',
      conflict: 'conflict',
      delete: 'delete',
      mode: 'modify',
      modify: 'modify',
    });
    assert(!JSON.stringify(plan).includes('SOURCE_PRIVATE'));
    assert(!plan.files.some((f) => f.path === 'target-only'));
    assert.deepEqual(
      parseIntegrationReport({
        integrationId: randomUUID(),
        inputHash: 'a'.repeat(64),
        observedAt: new Date().toISOString(),
        plan,
        reason: null,
        confirmPublication: true,
      }).plan,
      plan,
    );
  });
test('两个完整快照各自合法，组合后仍识别文件/目录、父目录大小写与NFC碰撞', async () => {
  for (const [s, t] of [
    [{ 'a/x': 'source' }, { a: 'target' }],
    [{ a: 'source' }, { 'a/x': 'target' }],
    [{ 'Dir/source': 'source' }, { 'dir/target': 'target' }],
    [{ 'e\u0301/source': 'source' }, { 'é/target': 'target' }],
  ]) {
    const base = await snapshot({}),
      source = await snapshot(s!),
      target = await snapshot(t!);
    const plan = buildIntegrationPlan(
      'sha1',
      { base: base.tree, source: source.tree, target: target.tree },
      { base, source, target },
      '/fixture',
    );
    assert.equal(plan.conflicts, 1, JSON.stringify(plan));
    assert.equal(plan.files[0]!.conflict, 'path_collision');
  }
});
test('同名改大小写的明确删除+新增可以预检；双方删除与无变化不制造合并', async () => {
  const base = await snapshot({ Name: 'x', gone: 'g' }),
    source = await snapshot({ name: 'x' }),
    target = await snapshot({ Name: 'x' });
  const plan = buildIntegrationPlan(
    'sha1',
    { base: base.tree, source: source.tree, target: target.tree },
    { base, source, target },
    '/fixture',
  );
  assert.equal(plan.conflicts, 0);
  assert.equal(plan.alreadyPresent, 1);
  assert.equal(
    buildIntegrationPlan(
      'sha1',
      { base: base.tree, source: base.tree, target: target.tree },
      { base, source: base, target },
      '/fixture',
    ).changedFiles,
    0,
  );
});
test('符号链接、LFS和歧义名字阻止完整计划；有界展示省略标记与完整冲突计数保留', async () => {
  const base = await snapshot({}),
    target = base;
  const unsupported: Parameters<typeof snapshot>[0][] = [
    { link: { data: '../elsewhere', mode: '120000' } },
    {
      lfs:
        'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 10\n',
    },
    { 'name.': 'x' },
  ];
  for (const files of unsupported) {
    const source = await snapshot(files);
    assert.throws(() =>
      buildIntegrationPlan(
        'sha1',
        { base: base.tree, source: source.tree, target: target.tree },
        { base, source, target },
        '/fixture',
      ),
    );
  }
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`file-${i}`, 'x'])),
    source = await snapshot(files);
  const plan = buildIntegrationPlan(
    'sha1',
    { base: base.tree, source: source.tree, target: target.tree },
    { base, source, target },
    '/fixture',
  );
  assert.equal(plan.changedFiles, 100);
  assert.equal(plan.files.length, 80);
  assert.equal(plan.omittedFiles, 20);
});

test('Git空子树不能被文件清单静默省略成无变化', async () => {
  const base = await snapshot({}),
    empty = Buffer.alloc(0),
    emptyId = objectHash('sha1', 'tree', empty);
  const treeBytes = Buffer.concat([Buffer.from('40000 empty\0'), Buffer.from(emptyId, 'hex')]),
    tree = objectHash('sha1', 'tree', treeBytes);
  const commitBytes = Buffer.from(`tree ${tree}\n\nfixture\n`),
    commit = objectHash('sha1', 'commit', commitBytes);
  const objects = new Map([
    [emptyId, empty],
    [tree, treeBytes],
    [commit, commitBytes],
  ]);
  const source = await verifySnapshot('sha1', commit, tree, async (id) => objects.get(id)!);
  assert.throws(
    () =>
      buildIntegrationPlan(
        'sha1',
        { base: base.tree, source: tree, target: base.tree },
        { base, source, target: base },
        '/fixture',
      ),
    /空子树/,
  );
});

test('所选新增范围重新核对完整目标树，不能借未选删除绕过大小写/NFC碰撞', async () => {
  for (const [oldName, newName] of [
    ['Name', 'name'],
    ['é', 'e\u0301'],
  ]) {
    const base = await snapshot({ [oldName!]: 'x' }),
      source = await snapshot({ [newName!]: 'x' }),
      target = base;
    const plan = buildIntegrationPlan(
      'sha1',
      { base: base.tree, source: source.tree, target: target.tree },
      { base, source, target },
      '/fixture',
    );
    assert.equal(plan.conflicts, 0);
    assert.throws(
      () => integrationAdditions('sha1', target.tree, target, plan, [newName!], '/fixture'),
      /碰撞/,
    );
  }
});
test('只选新增文件并规划新父目录，保留其他修改；重复/未列出或省略计划拒绝', async () => {
  const base = await snapshot({ 'src/keep': 'base' }),
    source = await snapshot({ 'src/keep': 'changed', 'src/new': 'new', 'brand-new/file': 'new' }),
    target = base;
  const plan = buildIntegrationPlan(
    'sha1',
    { base: base.tree, source: source.tree, target: target.tree },
    { base, source, target },
    '/fixture',
  );
  assert.deepEqual(
    integrationAdditions('sha1', target.tree, target, plan, ['src/new'], '/fixture').map(
      (e) => e.path,
    ),
    ['src/new'],
  );
  assert.deepEqual(
    integrationAdditionPlan('sha1', target.tree, target, plan, ['brand-new/file'], '/fixture')
      .directories,
    ['brand-new'],
  );
  for (const paths of [['src/keep'], ['unknown'], ['src/new', 'src/new'], []])
    assert.throws(() => integrationAdditions('sha1', target.tree, target, plan, paths, '/fixture'));
  assert.throws(() =>
    integrationAdditions(
      'sha1',
      target.tree,
      target,
      { ...plan, omittedFiles: 1 },
      ['src/new'],
      '/fixture',
    ),
  );
});

test('new parent planning reuses shared directories, preserves frozen ancestor anchors and bounds directory expansion', async () => {
  const base = await snapshot({ 'existing/keep': 'base' });
  const source = await snapshot({
    'existing/keep': 'base',
    'existing/new/deep/a': 'A',
    'existing/new/deep/b': 'B',
    'fresh/c': 'C',
  });
  const plan = buildIntegrationPlan(
    'sha1',
    { base: base.tree, source: source.tree, target: base.tree },
    { base, source, target: base },
    '/fixture',
  );
  const selected = integrationAdditionPlan(
    'sha1',
    base.tree,
    base,
    plan,
    ['existing/new/deep/a', 'existing/new/deep/b', 'fresh/c'],
    '/fixture',
  );
  assert.deepEqual(selected.directories, ['fresh', 'existing/new', 'existing/new/deep']);
  assert.deepEqual(selected.anchors, ['existing/new', 'fresh']);
  assert.equal(selected.files.length, 3);
  const data: Record<string, string> = { keep: 'base' };
  for (let i = 0; i < 80; i++) data[`d${String(i).padStart(2, '0')}/a/b/c/file`] = 'one';
  const target = await snapshot({ keep: 'base' }),
    wide = await snapshot(data);
  const widePlan = buildIntegrationPlan(
    'sha1',
    { base: target.tree, source: wide.tree, target: target.tree },
    { base: target, source: wide, target },
    '/fixture',
  );
  const paths = Object.keys(data).filter((p) => p !== 'keep');
  assert.equal(
    integrationAdditionPlan('sha1', target.tree, target, widePlan, paths.slice(0, 64), '/fixture')
      .directories.length,
    256,
  );
  assert.throws(
    () =>
      integrationAdditionPlan(
        'sha1',
        target.tree,
        target,
        widePlan,
        paths.slice(0, 65),
        '/fixture',
      ),
    /有界|新父目录/,
  );
});

test('new-directory evidence has a total path-byte budget independent of selected file count', async () => {
  const base = await snapshot({ keep: 'base' });
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(118)).join('/') +
    '/file';
  for (const [depth, allowed] of [
    [32, true],
    [33, false],
  ] as const) {
    const path = make(depth),
      source = await snapshot({ keep: 'base', [path]: 'new' });
    const plan = buildIntegrationPlan(
      'sha1',
      { base: base.tree, source: source.tree, target: base.tree },
      { base, source, target: base },
      '/fixture',
    );
    const build = () => integrationAdditionPlan('sha1', base.tree, base, plan, [path], '/fixture');
    if (allowed) assert.equal(build().directories.length, depth);
    else assert.throws(build, /有界|新父目录/);
  }
});
