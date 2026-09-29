import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handoffAcceptanceFixture } from './helpers/handoff-acceptance.js';
import { withReceivedRestoreSource } from '../apps/runner/src/agent/checkpoint-received-source.js';
import { verifySnapshot } from '../apps/runner/src/agent/checkpoint-objects.js';
import {
  gitWorkspaceMetadata,
  snapshotIndex,
} from '../apps/runner/src/agent/git-workspace-metadata.js';
import { authorizeDirectories, captureDirectory } from '../apps/runner/src/agent/workspaces.js';
import type { RestorePlan } from '../apps/runner/src/agent/checkpoint-restore-journal.js';

for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 原对象直接构成单提交Git现场，索引可读且不修改文件或源仓库`, async () => {
    const f = await handoffAcceptanceFixture(false, true, format);
    try {
      const originals = await Promise.all(
        ['README.md', 'src/binary.dat'].map((p) => readFile(join(f.target, p))),
      );
      const sourceIndex = await readFile(join(f.root, '.git/index'));
      const db = new DatabaseSync(join(f.receiverHome, 'checkpoint-restores/journal.sqlite'), {
        readOnly: true,
      });
      const plan = JSON.parse(
        String(db.prepare('SELECT plan FROM restores WHERE target=?').get(f.target)!.plan),
      ) as RestorePlan;
      db.close();
      const metadata = await withReceivedRestoreSource(f.receiverHome, f.id, undefined, (source) =>
        source.snapshot(async (read) => {
          const snapshot = await verifySnapshot(
            format,
            source.manifest.commit,
            source.manifest.tree,
            read,
          );
          return gitWorkspaceMetadata(format, source.manifest.commit, snapshot, plan.entries);
        }),
      );
      for (const [path, bytes] of metadata) {
        const file = join(f.target, '.git', path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      }
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', f.target, '-c', 'protocol.allow=never', ...args], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: f.dir,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
        }).trim();
      assert.equal(git('rev-parse', 'HEAD'), f.oid);
      assert.equal(git('rev-parse', '--is-shallow-repository'), 'true');
      assert.equal(git('rev-list', '--count', 'HEAD'), '1');
      assert.equal(git('status', '--porcelain=v1'), '');
      assert.equal(git('fsck', '--no-reflogs', '--no-dangling'), '');
      assert.equal(git('config', '--get', 'core.hooksPath'), '/dev/null');
      const state = join(f.dir, 'separate-node-state');
      await mkdir(state, { mode: 0o700 });
      const [directory] = await authorizeDirectories([{ name: '接手代码', path: f.target }], state);
      assert.equal((await captureDirectory(directory!)).state, 'available');
      assert.deepEqual(
        await Promise.all(['README.md', 'src/binary.dat'].map((p) => readFile(join(f.target, p)))),
        originals,
      );
      assert.deepEqual(await readFile(join(f.root, '.git/index')), sourceIndex);
      await writeFile(join(f.target, 'README.md'), 'Later user change\n');
      assert.match(git('status', '--porcelain=v1'), /M README.md/);
    } finally {
      await f.close();
    }
  });

test('索引拒绝冲突、路径穿越和不受支持的模式，不生成隐藏有效标志', () => {
  const e = {
    path: 'src/file.txt',
    kind: 'file' as const,
    objectId: 'a'.repeat(40),
    gitMode: '100644' as const,
    bytes: 1,
  };
  assert.throws(() => snapshotIndex('sha1', [e, e]));
  for (const path of ['../escape', '.git/config', '/absolute', 'a\0b', 'a\\b'])
    assert.throws(() => snapshotIndex('sha1', [{ ...e, path }]));
  const index = snapshotIndex('sha1', [e]);
  assert.equal(index.subarray(0, 4).toString(), 'DIRC');
  assert.equal(index.readUInt16BE(12 + 60) & 0xf000, 0);
});
