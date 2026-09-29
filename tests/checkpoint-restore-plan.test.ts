import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainError } from '../packages/contracts/src/index.js';
import type { RetentionManifest } from '../packages/contracts/src/checkpoint-retention.js';
import {
  objectHash,
  verifySnapshot,
  type SnapshotObject,
} from '../apps/runner/src/agent/checkpoint-objects.js';
import {
  buildRestorePlan,
  inspectRestoreTarget,
} from '../apps/runner/src/agent/checkpoint-restore-plan.js';

const code = (value: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === value;
interface TreeItem {
  name: string | Buffer;
  mode?: string;
  data?: Buffer;
  children?: TreeItem[];
}
async function snapshot(items: TreeItem[], format: 'sha1' | 'sha256' = 'sha1') {
  const objects = new Map<string, SnapshotObject>();
  const put = (type: SnapshotObject['type'], data: Buffer) => {
    const id = objectHash(format, type, data);
    objects.set(id, { id, type, data });
    return id;
  };
  const treeFor = (children: TreeItem[]): string => {
    const parts = children.map((item) => {
      const mode = item.mode ?? (item.children ? '40000' : '100644');
      const id = item.children
        ? treeFor(item.children)
        : mode === '160000'
          ? 'a'.repeat(format === 'sha1' ? 40 : 64)
          : put('blob', item.data ?? Buffer.from('same contents\n'));
      return Buffer.concat([
        Buffer.from(`${mode} `),
        Buffer.from(item.name),
        Buffer.from([0]),
        Buffer.from(id, 'hex'),
      ]);
    });
    return put('tree', Buffer.concat(parts));
  };
  const tree = treeFor(items);
  const commit = put('commit', Buffer.from(`tree ${tree}\n\nfixture\n`));
  const read = async (id: string) => {
    const o = objects.get(id);
    if (!o) throw new Error('Missing fixture object');
    return o.data;
  };
  const verified = await verifySnapshot(format, commit, tree, read);
  const manifest: RetentionManifest = {
    version: 1,
    kind: 'git_snapshot_objects',
    objectFormat: format,
    commit,
    tree,
    repositoryIdentity: 'b'.repeat(64),
    snapshotHash: verified.snapshotHash,
    coverage: verified.coverage,
    scope: 'commit_snapshot_without_ancestors_or_external_content',
    retainedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  return {
    source: {
      requestId: randomUUID(),
      checkpointId: randomUUID(),
      nodeId: randomUUID(),
      workspaceId: randomUUID(),
      manifest,
    },
    read,
    objects,
  };
}
async function temporary<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-restore-plan-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 计划保留二进制/可执行模式/空目录和重复对象路径，不落盘且指纹稳定`, async () => {
    await temporary(async (dir) => {
      const f = await snapshot(
        [
          {
            name: '中文目录',
            children: [{ name: 'binary.dat', data: Buffer.from([0, 255, 128]) }],
          },
          { name: 'run.sh', mode: '100755' },
          { name: 'copy.txt' },
          { name: 'empty', children: [] },
        ],
        format,
      );
      const target = join(dir, 'new');
      const a = await buildRestorePlan(f.source, f.read, target, []);
      const b = await buildRestorePlan(f.source, f.read, target, []);
      assert.equal(a.planHash, b.planHash);
      assert.equal(a.restored, false);
      assert.equal(a.writeAuthorized, false);
      assert.equal(a.committedSensitiveContentMayBeIncluded, true);
      assert.equal(a.entries.find((e) => e.path === 'run.sh')!.gitMode, '100755');
      assert.equal(a.entries.find((e) => e.path === '中文目录/binary.dat')!.bytes, 3);
      assert.equal(a.entries.find((e) => e.path === 'empty')!.kind, 'directory');
      assert.equal(a.materializedBytes, 3 + Buffer.byteLength('same contents\n') * 2);
      assert.equal(a.source.manifest.expiresAt, f.source.manifest.expiresAt);
      await assert.rejects(readFile(target), { code: 'ENOENT' });
    });
  });
test('空提交树生成零文件计划；不会声称已创建目录', async () => {
  await temporary(async (dir) => {
    const f = await snapshot([]);
    const plan = await buildRestorePlan(f.source, f.read, join(dir, 'new'), []);
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.materializedBytes, 0);
    assert.equal(plan.restored, false);
  });
});
test('拒绝现有文件/目录/悬空链接、符号链接祖先、重叠与非规范绝对目标', async () => {
  await temporary(async (dir) => {
    const file = join(dir, 'file');
    const folder = join(dir, 'folder');
    const link = join(dir, 'dangling');
    await writeFile(file, 'keep');
    await mkdir(folder);
    await symlink(join(dir, 'missing'), link);
    for (const target of [file, folder, link])
      assert.throws(() => inspectRestoreTarget(target, []), code('RESTORE_TARGET_EXISTS'));
    await symlink(folder, join(dir, 'alias'));
    assert.throws(
      () => inspectRestoreTarget(join(dir, 'alias', 'new'), []),
      code('RESTORE_PATH_UNSUPPORTED'),
    );
    assert.throws(
      () => inspectRestoreTarget(join(folder, 'new'), [folder]),
      code('RESTORE_TARGET_OVERLAP'),
    );
    assert.throws(
      () => inspectRestoreTarget(join(dir, 'new'), [join(dir, 'new', 'source')]),
      code('RESTORE_TARGET_OVERLAP'),
    );
    for (const target of ['relative/path', `${dir}/folder/../new`, `${dir}/new/`, `${dir}/new\n`])
      assert.throws(() => inspectRestoreTarget(target, []), code('RESTORE_PATH_UNSUPPORTED'));
    assert.throws(() => inspectRestoreTarget(join(dir, 'missing', 'new'), []), { code: 'ENOENT' });
    assert.equal(await readFile(file, 'utf8'), 'keep');
  });
});
for (const name of [
  'trailing.',
  'trailing ',
  'file:stream',
  '.git ',
  'CON.txt',
  'bad\u202ename',
  Buffer.from([0xc0, 0xaf]),
  'x'.repeat(256),
])
  test(`拒绝不支持的文件名字节 ${JSON.stringify(name)}`, async () => {
    await temporary(async (dir) => {
      const f = await snapshot([{ name }]);
      await assert.rejects(
        buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
        code('RESTORE_PATH_UNSUPPORTED'),
      );
    });
  });
for (const names of [
  ['README', 'readme'],
  ['é.txt', 'e\u0301.txt'],
])
  test(`拒绝大小写或 Unicode 规范化冲突 ${JSON.stringify(names)}`, async () => {
    await temporary(async (dir) => {
      const f = await snapshot(names.map((name) => ({ name })));
      await assert.rejects(
        buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
        code('RESTORE_PATH_UNSUPPORTED'),
      );
    });
  });
for (const item of [
  { name: 'link', mode: '120000', data: Buffer.from('/outside') },
  { name: 'module', mode: '160000' },
  {
    name: 'large',
    data: Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 100\n`,
    ),
  },
])
  test(`拒绝外部内容，不跳过后伪造成功 ${item.name}`, async () => {
    await temporary(async (dir) => {
      const f = await snapshot([item]);
      await assert.rejects(
        buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
        code('RESTORE_EXTERNAL_CONTENT'),
      );
    });
  });
test('逐对象重验哈希，拒绝损坏及与原保留清单不符的覆盖率', async () => {
  await temporary(async (dir) => {
    const f = await snapshot([{ name: 'file' }]);
    const blob = [...f.objects.values()].find((o) => o.type === 'blob')!;
    const original = blob.data;
    blob.data = Buffer.alloc(original.length);
    await assert.rejects(
      buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
      code('SNAPSHOT_INCOMPLETE'),
    );
    blob.data = original;
    f.source.manifest.coverage.files++;
    await assert.rejects(
      buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
      code('RESTORE_SNAPSHOT_MISMATCH'),
    );
  });
});
test('到期和取消不生成计划；读取期间取消保持明确错误', async () => {
  await temporary(async (dir) => {
    const f = await snapshot([{ name: 'file' }]);
    const signal = new AbortController();
    signal.abort();
    await assert.rejects(
      buildRestorePlan(f.source, f.read, join(dir, 'new'), [], signal.signal),
      code('RESTORE_PLAN_CANCELLED'),
    );
    const during = new AbortController();
    await assert.rejects(
      buildRestorePlan(
        f.source,
        async (id) => {
          during.abort();
          return f.read(id);
        },
        join(dir, 'new'),
        [],
        during.signal,
      ),
      code('RESTORE_PLAN_CANCELLED'),
    );
    f.source.manifest.retainedAt = new Date(Date.now() - 86400000).toISOString();
    f.source.manifest.expiresAt = new Date(Date.now() - 1).toISOString();
    await assert.rejects(
      buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
      code('RESTORE_RETENTION_EXPIRED'),
    );
  });
});
test('展开体积按每个文件路径计费，不因对象去重绕过 64 MiB', async () => {
  await temporary(async (dir) => {
    const data = Buffer.alloc(8 * 1024 * 1024, 65);
    const f = await snapshot(Array.from({ length: 9 }, (_, i) => ({ name: `copy-${i}`, data })));
    assert(f.source.manifest.coverage.bytes < 9 * 1024 * 1024);
    await assert.rejects(
      buildRestorePlan(f.source, f.read, join(dir, 'new'), []),
      code('RESTORE_EXPANSION_LIMIT'),
    );
  });
});
test('预检期间父目录被换位即拒绝，不把旧父目录观察当作写入许可', async () => {
  await temporary(async (dir) => {
    const parent = join(dir, 'parent');
    await mkdir(parent);
    const f = await snapshot([{ name: 'file' }]);
    let changed = false;
    await assert.rejects(
      buildRestorePlan(
        f.source,
        async (id) => {
          if (!changed) {
            changed = true;
            await rename(parent, parent + '-old');
            await mkdir(parent);
          }
          return f.read(id);
        },
        join(parent, 'new'),
        [],
      ),
      code('RESTORE_TARGET_CHANGED'),
    );
  });
});
