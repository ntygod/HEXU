import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, mkdir, writeFile, readdir, lstat, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  localRetentionOperation,
  RetentionVault,
} from '../apps/runner/src/agent/checkpoint-retention.js';
import {
  localRestoreCheckpoint,
  cleanupRestoreCheckpoint,
} from '../apps/runner/src/agent/checkpoint-restore.js';
import {
  readRestoreProgress,
  RestoreJournal,
} from '../apps/runner/src/agent/checkpoint-restore-journal.js';
import { AgentStorage, writeCredentials } from '../apps/runner/src/agent/storage.js';
import { publishLocalCheckpoint } from '../apps/runner/src/agent/checkpoints.js';
import { retentionFixture, git } from './helpers/checkpoint-retention.js';

const silent = () => {};
const accept = async (prompt: string) => /(?:RESTORE|PUBLISH|CLEAN) [0-9a-f-]{36}/.exec(prompt)![0];
const noAsk = async () => {
  throw new Error('No new confirmation or replay allowed');
};
const options = { log: silent };
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
async function retained(format: 'sha1' | 'sha256' = 'sha1', external = false) {
  const f = await retentionFixture(format, external);
  await localRetentionOperation(
    f.home,
    f.first.request.id,
    'retain',
    async () => `RETAIN ${f.oid} 7`,
    silent,
  );
  return { ...f, target: join(f.dir, 'restored'), id: f.first.request.id };
}
for (const format of ['sha1', 'sha256'] as const)
  test(`${format} 真实持久副本恢复二进制，发布前目标不存在，源移动后仍可用且原HEAD/index/回执不变`, async () => {
    const f = await retained(format);
    try {
      const vaultBefore = await readFile(join(f.home, 'retained-checkpoints/journal.sqlite'));
      const remoteBefore = await f.read();
      const head = await readFile(join(f.root, '.git/HEAD'));
      const index = await readFile(join(f.root, '.git/index'));
      await rename(f.root, f.root + '-moved');
      const phases: string[] = [];
      const result = await localRestoreCheckpoint(
        f.home,
        f.id,
        f.target,
        async (p) => {
          await assert.rejects(lstat(f.target), { code: 'ENOENT' });
          return accept(p);
        },
        {
          ...options,
          onProgress: (p) => {
            phases.push(p.state);
          },
        },
      );
      assert.equal(result.state, 'restored');
      assert.equal(result.materialState, 'published');
      assert.equal(result.completedFiles, 2);
      assert.equal(
        await readFile(join(f.target, 'README.md'), 'utf8'),
        'Retain only this committed snapshot\n',
      );
      assert.deepEqual(
        await readFile(join(f.target, 'src/binary.dat')),
        Buffer.from([0, 1, 255, 13, 10, 128]),
      );
      assert.equal((await lstat(f.target)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(f.target, 'README.md'))).mode & 0o777, 0o600);
      await assert.rejects(lstat(join(f.target, '.git')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(f.target, 'private.txt')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(f.dir, result.stageName)), { code: 'ENOENT' });
      assert(
        phases.includes('writing') && phases.includes('verified') && phases.includes('publishing'),
      );
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git/HEAD')), head);
      assert.deepEqual(await readFile(join(f.root + '-moved', '.git/index')), index);
      assert.equal(
        await readFile(join(f.root + '-moved', 'README.md'), 'utf8'),
        'Local dirty only\n',
      );
      assert.deepEqual(
        await readFile(join(f.home, 'retained-checkpoints/journal.sqlite')),
        vaultBefore,
      );
      assert.deepEqual(await f.read(), remoteBefore);
      assert.equal((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().runs.length, 0);
      assert(!JSON.stringify(result).includes(f.token));
    } finally {
      await f.close();
    }
  });
test('执行位恢复但不执行脚本，原仓库filter/hook不会被运行', async () => {
  const f = await retentionFixture();
  try {
    await writeFile(join(f.root, 'run.sh'), '#!/bin/sh\ntouch SHOULD_NOT_RUN\n');
    git(f.root, 'add', 'run.sh');
    git(f.root, 'update-index', '--chmod=+x', 'run.sh');
    git(
      f.root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'executable',
    );
    const oid = git(f.root, 'rev-parse', 'HEAD');
    const req = await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
      nodeId: f.node.nodeId,
      workspaceId: f.w.id,
      commit: oid,
      label: '可执行位',
      expectedTaskRevision: 1,
      confirmReference: true,
    });
    const c = await publishLocalCheckpoint(
      f.home,
      req.json().id,
      async () => `CHECKPOINT ${oid}`,
      silent,
    );
    const r = await f.api.call(
      `tasks/${f.task.id}/checkpoints/${c.checkpointId}/retentions`,
      f.alice,
      {
        days: 7,
        expectedTaskRevision: 1,
        confirmLocalRetention: true,
      },
    );
    const id = r.json().request.id;
    await localRetentionOperation(f.home, id, 'retain', async () => `RETAIN ${oid} 7`, silent);
    git(f.root, 'config', 'core.hooksPath', '/not/a/trusted/hook');
    git(f.root, 'config', 'filter.untrusted.smudge', 'touch SHOULD_NOT_RUN');
    const target = join(f.dir, 'executable');
    assert.equal(
      (await localRestoreCheckpoint(f.home, id, target, accept, options)).state,
      'restored',
    );
    assert.equal((await lstat(join(target, 'run.sh'))).mode & 0o777, 0o700);
    await assert.rejects(lstat(join(target, 'SHOULD_NOT_RUN')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('重复恢复只返回历史记录，不覆盖用户后续修改；清理不能删除已发布目标', async () => {
  const f = await retained();
  try {
    const first = await localRestoreCheckpoint(f.home, f.id, f.target, accept, options);
    await writeFile(join(f.target, 'README.md'), 'User changes after restore');
    const repeated = await localRestoreCheckpoint(f.home, f.id, f.target, noAsk, options);
    assert.deepEqual(repeated, first);
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'User changes after restore');
    assert.deepEqual(readRestoreProgress(f.home, f.target), first);
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, noAsk),
      code('RESTORE_CLEANUP_REFUSED'),
    );
  } finally {
    await f.close();
  }
});
test('两阶段确认：拒绝第一次无目录，拒绝发布保留已核验暂存，明确清理且不复执行', async () => {
  const f = await retained();
  try {
    await assert.rejects(
      localRestoreCheckpoint(f.home, f.id, f.target, async () => 'NO', options),
      code('CONFIRMATION_REQUIRED'),
    );
    assert.equal(readRestoreProgress(f.home, f.target), null);
    assert(!(await readdir(f.dir)).some((p) => p.startsWith('.hexu-restore-')));
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => (q.includes('PUBLISH') ? 'NO' : accept(q)),
      options,
    );
    assert.equal(p.state, 'cancelled');
    assert.equal(p.materialState, 'staging');
    assert.equal(p.completedFiles, 2);
    assert((await lstat(join(f.dir, p.stageName))).isDirectory());
    assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, accept)).cleanup, 'cleaned');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.dir, p.stageName)), { code: 'ENOENT' });
    assert.equal(
      (await localRestoreCheckpoint(f.home, f.id, f.target, noAsk, options)).state,
      'cancelled',
    );
    assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, noAsk)).cleanup, 'cleaned');
  } finally {
    await f.close();
  }
});
test('写入中取消保存真实已完成数量，保留部分暂存且可以明确清理', async () => {
  const f = await retained();
  const controller = new AbortController();
  try {
    const p = await localRestoreCheckpoint(f.home, f.id, f.target, accept, {
      ...options,
      signal: controller.signal,
      onProgress: (s) => {
        if (s.completedFiles === 1) controller.abort();
      },
    });
    assert.equal(p.state, 'cancelled');
    assert.equal(p.completedFiles, 1);
    assert.equal((await readdir(join(f.dir, p.stageName))).length, 1);
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, accept)).cleanup, 'cleaned');
  } finally {
    await f.close();
  }
});
for (const occupancy of ['directory', 'file', 'symlink'] as const)
  test(`发布确认期间出现${occupancy}，不覆盖且清理只动暂存`, async () => {
    const f = await retained();
    try {
      const p = await localRestoreCheckpoint(
        f.home,
        f.id,
        f.target,
        async (q) => {
          if (q.includes('PUBLISH')) {
            if (occupancy === 'directory') await mkdir(f.target);
            else if (occupancy === 'file') await writeFile(f.target, 'user');
            else await symlink('/does/not/exist', f.target);
          }
          return accept(q);
        },
        options,
      );
      assert.equal(p.state, 'failed');
      assert.equal(p.errorCode, 'RESTORE_TARGET_EXISTS');
      const before = await lstat(f.target);
      await cleanupRestoreCheckpoint(f.home, f.target, accept);
      assert.equal((await lstat(f.target)).ino, before.ino);
    } finally {
      await f.close();
    }
  });
for (const change of ['extra', 'edited', 'replaced', 'symlink'] as const)
  test(`清理前${change}材料时保留整个现场，不先删除其他文件`, async () => {
    const f = await retained();
    try {
      const p = await localRestoreCheckpoint(
        f.home,
        f.id,
        f.target,
        async (q) => (q.includes('PUBLISH') ? '' : accept(q)),
        options,
      );
      const dir = join(f.dir, p.stageName),
        path = join(dir, 'README.md');
      if (change === 'extra') await writeFile(join(dir, 'USER.txt'), 'Keep');
      else if (change === 'edited') await writeFile(path, 'Keep my edit');
      else {
        await rename(path, join(f.dir, 'original-readme'));
        if (change === 'replaced') await writeFile(path, 'Keep replacement');
        else await symlink(join(f.dir, 'original-readme'), path);
      }
      const before = await readdir(dir);
      await assert.rejects(
        cleanupRestoreCheckpoint(f.home, f.target, accept),
        code('RESTORE_FILES_CHANGED'),
      );
      assert.deepEqual(await readdir(dir), before);
      assert.equal((await readFile(join(dir, 'src/binary.dat'))).length, 6);
      assert.equal(readRestoreProgress(f.home, f.target)!.cleanup, 'needs_attention');
    } finally {
      await f.close();
    }
  });
test('源持久对象在发布确认时损坏，不因已有好暂存跳过重新核验', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => {
        if (q.includes('PUBLISH')) {
          const v = new RetentionVault(f.home);
          v.db.prepare("UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'").run();
          v.close();
        }
        return accept(q);
      },
      options,
    );
    assert.equal(p.state, 'failed');
    assert.equal(p.errorCode, 'SNAPSHOT_INCOMPLETE');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, accept)).cleanup, 'cleaned');
  } finally {
    await f.close();
  }
});
test('发布前撤权阻止发布，原身份离线/撤权后仍能明确清理本次暂存', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => {
        if (q.includes('PUBLISH'))
          f.api.store.db
            .prepare('UPDATE runner_nodes SET revoked_at=?,revision=revision+1 WHERE id=?')
            .run(new Date().toISOString(), f.node.nodeId);
        return accept(q);
      },
      options,
    );
    assert.equal(p.state, 'failed');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, accept)).cleanup, 'cleaned');
  } finally {
    await f.close();
  }
});
test('发布前更换本机凭证拒绝，旧恢复记录不能由新身份读取或清理', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => {
        if (q.includes('PUBLISH'))
          writeCredentials(f.home, { ...f.credentials, clientId: randomUUID() });
        return accept(q);
      },
      options,
    );
    assert.equal(p.state, 'failed');
    assert.equal(p.errorCode, 'CHECKPOINT_SCOPE_CHANGED');
    assert.throws(() => readRestoreProgress(f.home, f.target), code('CHECKPOINT_SCOPE_CHANGED'));
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, noAsk),
      code('RESTORE_NOT_AVAILABLE'),
    );
  } finally {
    await f.close();
  }
});
test('父目录换位后不向新父目录写入或清理，也不自动找到旧目录继续', async () => {
  const f = await retained();
  try {
    const parent = join(f.dir, 'parent');
    await mkdir(parent, { mode: 0o700 });
    const target = join(parent, 'new');
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      target,
      async (q) => {
        if (q.includes('PUBLISH')) {
          await rename(parent, parent + '-moved');
          await mkdir(parent, { mode: 0o700 });
        }
        return accept(q);
      },
      options,
    );
    assert.equal(p.state, 'failed');
    assert.deepEqual(await readdir(parent), []);
    assert((await lstat(join(parent + '-moved', p.stageName))).isDirectory());
    await assert.rejects(cleanupRestoreCheckpoint(f.home, target, accept));
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await f.close();
  }
});
test('移动后的原来源身份仍受保护，不能在原仓库的新路径内部恢复', async () => {
  const f = await retained();
  try {
    await rename(f.root, f.root + '-moved');
    await assert.rejects(
      localRestoreCheckpoint(f.home, f.id, join(f.root + '-moved', 'nested'), accept, options),
      code('RESTORE_FILES_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('含LFS/符号链接/子模块的快照整份拒绝，没有写出不完整目录', async () => {
  const f = await retained('sha1', true);
  try {
    await assert.rejects(
      localRestoreCheckpoint(f.home, f.id, f.target, accept, options),
      code('RESTORE_EXTERNAL_CONTENT'),
    );
    assert(!(await readdir(f.dir)).some((p) => p.startsWith('.hexu-restore-')));
  } finally {
    await f.close();
  }
});
test('归属日志写入故障保留未确认文件，清理拒绝猜测删除；不标记恢复完成', async () => {
  const f = await retained();
  try {
    const journal = new RestoreJournal(f.home);
    journal.storage.db.exec(
      "CREATE TRIGGER fail_restore_entry BEFORE INSERT ON restore_entries BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    journal.close();
    const p = await localRestoreCheckpoint(f.home, f.id, f.target, accept, options);
    assert.equal(p.state, 'failed');
    assert.equal(p.completedFiles, 0);
    assert((await readdir(join(f.dir, p.stageName))).includes('README.md'));
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, accept),
      code('RESTORE_FILES_CHANGED'),
    );
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
for (const stop of ['SIGKILL', 'SIGINT'] as const)
  test(`真实CLI在发布前${stop}，重启不自动写入/发布，同一目标保留同一记录`, async () => {
    const f = await retained();
    try {
      const child = spawn(
        process.execPath,
        [
          resolve('dist/apps/runner/src/restore-checkpoint.js'),
          'restore',
          '--request',
          f.id,
          '--state',
          f.home,
          '--target',
          f.target,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      let output = '',
        stopped = false;
      child.stdout.on('data', (b) => {
        output += b;
        if (!stopped && output.includes('输入 PUBLISH')) {
          stopped = true;
          child.kill(stop);
        }
      });
      child.stderr.on('data', (b) => {
        output += b;
      });
      child.stdin.write(`RESTORE ${f.id}\n`);
      await once(child, 'close');
      assert(stopped, output);
      assert(!output.includes(f.token));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      const first = readRestoreProgress(f.home, f.target)!;
      const repeated = await localRestoreCheckpoint(f.home, f.id, f.target, noAsk, options);
      assert.equal(repeated.id, first.id);
      assert.equal(repeated.state, stop === 'SIGKILL' ? 'interrupted' : 'cancelled');
      assert.equal((await cleanupRestoreCheckpoint(f.home, f.target, accept)).cleanup, 'cleaned');
    } finally {
      await f.close();
    }
  });
test('真实CLI两次确认成功，status是历史观察而非持续文件可用保证', async () => {
  const f = await retained();
  try {
    const child = spawn(
      process.execPath,
      [
        resolve('dist/apps/runner/src/restore-checkpoint.js'),
        'restore',
        '--request',
        f.id,
        '--state',
        f.home,
        '--target',
        f.target,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      confirmed = false;
    child.stdout.on('data', (b) => {
      output += b;
      const match = /输入 PUBLISH ([0-9a-f-]{36})/.exec(output);
      if (match && !confirmed) {
        confirmed = true;
        child.stdin.end(`PUBLISH ${match[1]}\n`);
      }
    });
    child.stderr.on('data', (b) => {
      output += b;
    });
    child.stdin.write(`RESTORE ${f.id}\n`);
    const [status] = await once(child, 'close');
    assert.equal(status, 0, output);
    assert.match(output, /"state":"restored"/);
    assert(!output.includes(f.token));
    assert.equal(readRestoreProgress(f.home, f.target)!.state, 'restored');
  } finally {
    await f.close();
  }
});
test('最终发布阶段再次撤权也不能沿用先前检查结果', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(f.home, f.id, f.target, accept, {
      ...options,
      onProgress: (s) => {
        if (s.state === 'publishing')
          f.api.store.db
            .prepare('UPDATE runner_nodes SET revoked_at=?,revision=revision+1 WHERE id=?')
            .run(new Date().toISOString(), f.node.nodeId);
      },
    });
    assert.equal(p.state, 'failed');
    assert.equal(p.materialState, 'staging');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('等待发布确认期间到期，拒绝发布且不续期', async (t) => {
  const f = await retained();
  try {
    const expiry = Date.parse((await f.read())[0]!.manifest!.expiresAt);
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => {
        if (q.includes('PUBLISH')) t.mock.method(Date, 'now', () => expiry + 1000);
        return accept(q);
      },
      options,
    );
    assert.equal(p.state, 'failed');
    assert.equal(p.errorCode, 'RESTORE_RETENTION_EXPIRED');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
test('暂存文件在最终发布阶段被编辑，不能发布与原对象不符的字节', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(f.home, f.id, f.target, accept, {
      ...options,
      onProgress: async (s) => {
        if (s.state === 'publishing')
          await writeFile(join(f.dir, s.stageName, 'README.md'), 'changed after verification');
      },
    });
    assert.equal(p.state, 'failed');
    assert.equal(p.errorCode, 'RESTORE_FILES_CHANGED');
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, accept),
      code('RESTORE_FILES_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('发布成功但本机成功回执写入失败，保留unknown且重试/清理均不会覆盖或删除目标', async () => {
  const f = await retained();
  try {
    const j = new RestoreJournal(f.home);
    j.storage.db.exec(`CREATE TRIGGER fail_restore_receipt BEFORE UPDATE ON restores
      WHEN json_extract(NEW.progress,'$.state')='restored'
      BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    j.close();
    const p = await localRestoreCheckpoint(f.home, f.id, f.target, accept, options);
    assert.equal(p.state, 'interrupted');
    assert.equal(p.materialState, 'unknown');
    assert.equal(p.errorCode, 'RESTORE_PUBLICATION_UNKNOWN');
    const before = await readFile(join(f.target, 'README.md'));
    assert.equal((await localRestoreCheckpoint(f.home, f.id, f.target, noAsk, options)).id, p.id);
    await assert.rejects(cleanupRestoreCheckpoint(f.home, f.target, accept), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(f.target, 'README.md')), before);
  } finally {
    await f.close();
  }
});
test('清理中途日志故障保存needs_attention，后续不把缺失记录当作已清理', async () => {
  const f = await retained();
  try {
    const p = await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => (q.includes('PUBLISH') ? '' : accept(q)),
      options,
    );
    const j = new RestoreJournal(f.home);
    j.storage.db.exec(
      "CREATE TRIGGER fail_cleanup BEFORE DELETE ON restore_entries BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    j.close();
    await assert.rejects(cleanupRestoreCheckpoint(f.home, f.target, accept));
    assert.equal(readRestoreProgress(f.home, f.target)!.cleanup, 'needs_attention');
    assert((await lstat(join(f.dir, p.stageName))).isDirectory());
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, accept),
      code('RESTORE_FILES_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('持久记录暂存路径遭篡改时明确拒绝，不能把清理重定向到用户目录', async () => {
  const f = await retained();
  try {
    await localRestoreCheckpoint(
      f.home,
      f.id,
      f.target,
      async (q) => (q.includes('PUBLISH') ? '' : accept(q)),
      options,
    );
    const userDir = join(f.dir, 'user-data');
    await mkdir(userDir);
    await writeFile(join(userDir, 'keep'), 'user');
    const j = new RestoreJournal(f.home);
    j.storage.db
      .prepare(
        "UPDATE restores SET progress=json_set(progress,'$.stageName','user-data') WHERE target=?",
      )
      .run(f.target);
    j.close();
    assert.throws(() => readRestoreProgress(f.home, f.target), code('RESTORE_JOURNAL_INVALID'));
    await assert.rejects(
      cleanupRestoreCheckpoint(f.home, f.target, noAsk),
      code('RESTORE_JOURNAL_INVALID'),
    );
    assert.equal(await readFile(join(userDir, 'keep'), 'utf8'), 'user');
    // A corrupt journal must also release its process guard when construction fails.
    const guard = new AgentStorage(join(f.home, 'checkpoint-restores'));
    guard.close();
  } finally {
    await f.close();
  }
});
