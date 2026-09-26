from pathlib import Path
marker=Path('.staging/applied-04')
if marker.exists(): raise SystemExit(0)
p=Path('apps/runner/src/workspace-lease.ts'); s=p.read_text()
old="    const home = ensurePrivateHome(join(homedir(), '.hexu', 'workspace-leases'));\n    const path = join(home, 'registry.sqlite');"
assert s.count(old)==1
s=s.replace(old,"""    const home = ensurePrivateHome(join(homedir(), '.hexu', 'workspace-leases'));
    if (within(canonical, home))
      throw new DomainError(
        'LEASE_INSIDE_WORKSPACE',
        '授权目录不能包含受管工作区锁目录；请使用更小的独立 Git 目录',
      );
    const path = join(home, 'registry.sqlite');""")
p.write_text(s)
p=Path('tests/node-executor.test.ts')
s=p.read_text()
assert '授权根不能包含执行锁目录' not in s
s+='''

test('授权根不能包含执行锁目录，正常的个人仓库仍可占用', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexu-private-lease-home-'));
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.throws(() => new WorkspaceLease(home, randomUUID()), /不能包含受管工作区锁目录/);
    const repository = join(home, 'repo');
    await mkdir(repository);
    new WorkspaceLease(repository, randomUUID()).release();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
'''
p.write_text(s)
p=Path('docs/engineering/runner-execution.md');s=p.read_text()
s=s.replace('同时保护相同及父子重叠目录。','同时保护相同及父子重叠目录。授权根不能包含这个锁目录，过大的授权范围会被拒绝。')
p.write_text(s)
marker.write_text('Refuse editable roots containing the persistent execution registry.\n')
