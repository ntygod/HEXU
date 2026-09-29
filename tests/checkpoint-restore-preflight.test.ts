import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  localRetentionOperation,
  RetentionVault,
} from '../apps/runner/src/agent/checkpoint-retention.js';
import { localRestorePreflight } from '../apps/runner/src/agent/checkpoint-restore-preflight.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import { retentionFixture } from './helpers/checkpoint-retention.js';
const code = (value: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === value;
const silent = () => {};
async function retained() {
  const f = await retentionFixture();
  try {
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'retain',
      async () => `RETAIN ${f.oid} 7`,
      silent,
    );
    return f;
  } catch (cause) {
    await f.close();
    throw cause;
  }
}
for (const format of ['sha1', 'sha256'] as const)
  test(`真实 ${format} 持久副本独立预检，源目录移走仍可用，原代码/回执不变`, async () => {
    const f = await retentionFixture(format);
    try {
      const id = f.first.request.id;
      await localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent);
      const dbPath = join(f.home, 'retained-checkpoints', 'journal.sqlite');
      const before = await readFile(dbPath);
      const beforeView = await f.read();
      const head = await readFile(join(f.root, '.git', 'HEAD'));
      const index = await readFile(join(f.root, '.git', 'index'));
      await rename(f.root, f.root + '-moved');
      const plan = await localRestorePreflight(
        f.home,
        id,
        join(f.dir, 'new'),
        async () => `PLAN ${id}`,
        silent,
      );
      assert.deepEqual(
        plan.entries.map((e) => e.path),
        ['README.md', 'src', 'src/binary.dat'],
      );
      assert.equal(plan.restored, false);
      assert.equal(plan.writeAuthorized, false);
      assert.equal(plan.source.manifest.commit, f.oid);
      assert.deepEqual(await readFile(dbPath), before);
      assert.deepEqual(await f.read(), beforeView);
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git', 'HEAD')), head);
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git', 'index')), index);
      assert.equal(
        await readFile(join(f.root + '-moved', 'README.md'), 'utf8'),
        'Local dirty only\n',
      );
      assert(!JSON.stringify(plan).includes(f.token));
      await assert.rejects(readFile(join(f.dir, 'new')), { code: 'ENOENT' });
    } finally {
      await f.close();
    }
  });
test('真实 CLI 仅输出本机预检，明确 restored/writeAuthorized=false', async () => {
  const f = await retained();
  try {
    const id = f.first.request.id;
    const child = spawn(
      process.execPath,
      [
        resolve('dist/apps/runner/src/restore-plan.js'),
        '--request',
        id,
        '--state',
        f.home,
        '--target',
        join(f.dir, 'new'),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    let output = '';
    child.stdout.on('data', (value) => {
      output += value;
    });
    child.stderr.on('data', (value) => {
      output += value;
    });
    child.stdin.end(`PLAN ${id}\n`);
    const [status] = await once(child, 'close');
    assert.equal(status, 0, output);
    assert.match(output, /"restored":false/);
    assert.match(output, /"writeAuthorized":false/);
    assert.match(output, /实际恢复使用 runner:restore 另行确认/);
    assert(!output.includes(f.token));
    await assert.rejects(readFile(join(f.dir, 'new')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('拒绝确认不暴露文件清单，且没有本机数据库初始化或回执修改', async () => {
  const f = await retained();
  try {
    const logs: string[] = [];
    const path = join(f.home, 'retained-checkpoints', 'journal.sqlite');
    const before = await readFile(path);
    await assert.rejects(
      localRestorePreflight(
        f.home,
        f.first.request.id,
        join(f.dir, 'new'),
        async () => 'NO',
        (line) => logs.push(line),
      ),
      code('CONFIRMATION_REQUIRED'),
    );
    assert(!logs.join('\n').includes('binary.dat'));
    assert.deepEqual(await readFile(path), before);
    const missing = join(f.dir, 'missing-state');
    await assert.rejects(
      localRestorePreflight(
        missing,
        f.first.request.id,
        join(f.dir, 'new'),
        async () => 'NO',
        silent,
      ),
      { code: 'ENOENT' },
    );
    await assert.rejects(readFile(missing), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('确认期间凭证/目录绑定改变，不能借旧对象继续预检', async () => {
  const f = await retained();
  try {
    const id = f.first.request.id;
    await assert.rejects(
      localRestorePreflight(
        f.home,
        id,
        join(f.dir, 'new'),
        async () => {
          writeCredentials(f.home, {
            ...f.credentials,
            directories: [{ ...f.w, name: 'changed' }],
          });
          return `PLAN ${id}`;
        },
        silent,
      ),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('最终权限重验阻止遍历后撤权，不返回已经算出的计划', async (t) => {
  const f = await retained();
  try {
    const original = globalThis.fetch;
    let inspections = 0;
    t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      if (
        String(args[0]).includes('/runner/v1/checkpoint-retention-inspect') &&
        ++inspections === 3
      )
        f.api.store.db
          .prepare('UPDATE runner_nodes SET revoked_at=?,revision=revision+1 WHERE id=?')
          .run(new Date().toISOString(), f.node.nodeId);
      return original(...args);
    });
    const id = f.first.request.id;
    await assert.rejects(
      localRestorePreflight(f.home, id, join(f.dir, 'new'), async () => `PLAN ${id}`, silent),
    );
    assert.equal(inspections, 3);
    await assert.rejects(readFile(join(f.dir, 'new')), { code: 'ENOENT' });
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
test('损坏的实际持久对象拒绝计划，不重读来源修补或发布核验回执', async () => {
  const f = await retained();
  try {
    const id = f.first.request.id;
    const vault = new RetentionVault(f.home);
    vault.db.prepare("UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'").run();
    vault.close();
    const beforeView = await f.read();
    await assert.rejects(
      localRestorePreflight(f.home, id, join(f.dir, 'new'), async () => `PLAN ${id}`, silent),
      code('SNAPSHOT_INCOMPLETE'),
    );
    assert.deepEqual(await f.read(), beforeView);
  } finally {
    await f.close();
  }
});
test('待确认保留回执不能被预检隐式重放或升级', async () => {
  const f = await retentionFixture();
  try {
    const id = f.first.request.id;
    f.dropNext();
    await assert.rejects(
      localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${f.oid} 7`, silent),
    );
    await assert.rejects(
      localRestorePreflight(f.home, id, join(f.dir, 'new'), async () => `PLAN ${id}`, silent),
      code('RESTORE_NOT_AVAILABLE'),
    );
    const vault = new RetentionVault(f.home);
    try {
      assert(vault.row(id)!.pending);
    } finally {
      vault.close();
    }
  } finally {
    await f.close();
  }
});
test('确认期间目标被创建便拒绝；不覆盖用户新目录', async () => {
  const f = await retained();
  try {
    const id = f.first.request.id;
    const target = join(f.dir, 'new');
    await assert.rejects(
      localRestorePreflight(
        f.home,
        id,
        target,
        async () => {
          await mkdir(target);
          return `PLAN ${id}`;
        },
        silent,
      ),
      code('RESTORE_TARGET_EXISTS'),
    );
  } finally {
    await f.close();
  }
});
