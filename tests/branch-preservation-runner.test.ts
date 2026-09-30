import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseLocalBranchPreservation } from '../apps/runner/src/agent/branch-preservation-record.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchCleanupRunnerFixture } from './helpers/branch-cleanup-runner.js';
import { branchCli } from './helpers/branch-workspace.js';
import { git } from './helpers/checkpoint-retention.js';
import { preserveBranchWorkspace } from '../apps/runner/src/agent/branch-preservation.js';
import { assertBranchEvidenceSettled } from '../apps/runner/src/agent/branch-workspace.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { BranchPreservationView } from '../packages/contracts/src/branch-preservation.js';

async function ready(format: 'sha1' | 'sha256' = 'sha1') {
  const f = await branchCleanupRunnerFixture(format);
  try {
    const { branchId: _id, ...selection } = f.selection;
    const response = await f.api.call(f.p.path + '/preservations', f.alice, {
      ...selection,
      confirmMoveCompleteDirectory: true,
      confirmKeepGitAndContents: true,
    });
    assert.equal(response.statusCode, 201, response.body);
    const view = response.json() as BranchPreservationView;
    const parent = join(f.dir, 'private-preserved');
    await mkdir(parent, { mode: 0o700 });
    const target = join(parent, '完整保留');
    return {
      ...f,
      view,
      target,
      yes: async (prompt: string) =>
        /\b(?:STOPPED_AND_PRESERVE|PRESERVE) [0-9a-f-]{36}/.exec(prompt)![0],
      current: async () =>
        (
          await f.api.call(f.p.path + '/preservations/' + view.request.id, f.alice)
        ).json() as BranchPreservationView,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function tree(root: string) {
  const result: unknown[] = [];
  async function walk(relative = '') {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const p = relative ? relative + '/' + name : name,
        s = await lstat(join(root, p));
      assert(!s.isSymbolicLink());
      result.push({
        path: p,
        dev: s.dev,
        ino: s.ino,
        mode: s.mode,
        hash: s.isFile()
          ? createHash('sha256')
              .update(await readFile(join(root, p)))
              .digest('hex')
          : null,
      });
      if (s.isDirectory()) await walk(p);
    }
  }
  await walk();
  return result;
}
const args = (f: Awaited<ReturnType<typeof ready>>) => [
  '--preservation',
  f.view.request.id,
  '--state',
  f.home,
  '--target',
  f.target,
];
const lines = (f: Awaited<ReturnType<typeof ready>>) =>
  `STOPPED_AND_PRESERVE ${f.view.request.id}\nPRESERVE ${f.view.request.id}\n`;
for (const format of ['sha1', 'sha256'] as const)
  test(`${format}真实CLI完整移出保留.git/额外引用，不改字节权限或凭证；重复不触碰后来原路径`, async () => {
    const f = await ready(format);
    let later: WorkspaceLease | undefined;
    try {
      git(f.p.target, 'tag', 'KEEP_EXTRA_REF', f.commit);
      await writeFile(join(f.p.target, '.git/private-note'), 'KEEP COMPLETE GIT METADATA');
      const before = await tree(f.p.target),
        credentials = await readFile(join(f.home, 'credentials.json')),
        source = await readFile(join(f.root, 'README.md'));
      const r = await branchCli('branch-preservation.js', args(f), lines(f));
      assert.equal(r.status, 0, r.output);
      assert.equal(existsSync(f.p.target), false);
      assert.deepEqual(await tree(f.target), before);
      assert.equal(git(f.target, 'rev-parse', 'HEAD'), f.commit);
      assert.equal(git(f.target, 'rev-parse', 'KEEP_EXTRA_REF'), f.commit);
      assert.deepEqual(await readFile(join(f.home, 'credentials.json')), credentials);
      assert.deepEqual(await readFile(join(f.root, 'README.md')), source);
      assert.equal((await f.current()).state, 'preserved');
      assert.equal((await f.current()).executionRegistrationClosed, true);
      assert.equal((await f.read()).branches[0]!.state, 'discarded');
      assertBranchEvidenceSettled(f.home);
      await mkdir(f.p.target, { mode: 0o700 });
      await writeFile(join(f.p.target, 'later'), 'KEEP LATER USER FILE');
      later = new WorkspaceLease(f.p.target, 'later-' + randomUUID());
      await rename(f.target, f.target + '-user-moved');
      const repeat = await branchCli('branch-preservation.js', args(f), '');
      assert.equal(repeat.status, 0, repeat.output);
      later.assertHeld();
      assert.equal(await readFile(join(f.p.target, 'later'), 'utf8'), 'KEEP LATER USER FILE');
      assert.deepEqual(await tree(f.target + '-user-moved'), before);
    } finally {
      later?.release();
      await f.close();
    }
  });
test('本机两次确认分别必需，用户脏文件仍明确阻止，不因保留移动放宽原核对标准', async () => {
  const f = await ready();
  try {
    const before = await tree(f.p.target);
    await assert.rejects(
      preserveBranchWorkspace(
        f.home,
        f.view.request.id,
        f.target,
        async () => '',
        () => {},
      ),
      { code: 'CONFIRMATION_REQUIRED' },
    );
    await assert.rejects(
      preserveBranchWorkspace(
        f.home,
        f.view.request.id,
        f.target,
        async (prompt) => (prompt.includes('STOPPED_AND_PRESERVE') ? f.yes(prompt) : ''),
        () => {},
      ),
      { code: 'CONFIRMATION_REQUIRED' },
    );
    assert.deepEqual(await tree(f.p.target), before);
    assert.equal(existsSync(f.target), false);
    await writeFile(join(f.p.target, 'user-unsaved'), 'KEEP UNSAVED');
    const dirty = await tree(f.p.target);
    await assert.rejects(
      preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {}),
      { code: 'WORKSPACE_COMMIT_CHANGED' },
    );
    assert.deepEqual(await tree(f.p.target), dirty);
    assert.equal((await f.current()).state, 'requested');
  } finally {
    await f.close();
  }
});
test('开始报告ACK丢失只重放原包，重启明确结算未进入移动的准备而不自动继续', async () => {
  const f = await ready();
  try {
    const before = await tree(f.p.target);
    f.dropNext('/runner/v1/branch-preservation-publish');
    await assert.rejects(
      preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {}),
    );
    assert.equal((await f.current()).state, 'moving');
    assert.equal(existsSync(f.target), false);
    assert.throws(() => assertBranchEvidenceSettled(f.home), { code: 'WORK_BRANCH_UNSETTLED' });
    const old = (await f.current()).reports[0]!.hash;
    const replay = await preserveBranchWorkspace(
      f.home,
      f.view.request.id,
      f.target,
      async () => {
        throw new Error('must not re-consent/replay movement');
      },
      () => {},
    );
    assert.equal(replay.outcome, 'not_moved');
    assert.equal(replay.phase, 'settled');
    assert.equal((await f.current()).state, 'failed');
    assert.equal((await f.current()).reports[0]!.hash, old);
    assert.deepEqual(await tree(f.p.target), before);
    assert.equal(existsSync(f.target), false);
    assertBranchEvidenceSettled(f.home);
  } finally {
    await f.close();
  }
});
test('完成ACK丢失保留同一终态包；保留目录被用户再移动和后来新原路径都不被重试触碰', async () => {
  const f = await ready(),
    originalFetch = globalThis.fetch;
  let later: WorkspaceLease | undefined;
  try {
    let dropped = false;
    globalThis.fetch = async (...a) => {
      if (
        String(a[0]).endsWith('/runner/v1/branch-preservation-publish') &&
        JSON.parse(String(a[1]?.body)).sequence === 2 &&
        !dropped
      ) {
        dropped = true;
        f.dropNext('/runner/v1/branch-preservation-publish');
      }
      return originalFetch(...a);
    };
    const before = await tree(f.p.target);
    await assert.rejects(
      preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {}),
    );
    assert.equal(dropped, true);
    assert.equal((await f.current()).state, 'preserved');
    assert.throws(() => assertBranchEvidenceSettled(f.home), { code: 'WORK_BRANCH_UNSETTLED' });
    const db = new DatabaseSync(join(f.home, 'journal.sqlite'), { readOnly: true });
    const saved = JSON.parse(
      String(
        db
          .prepare('SELECT body FROM branch_binding WHERE id=?')
          .get('preservation:' + f.view.request.id)!.body,
      ),
    );
    db.close();
    const packet = saved.pending;
    assert.equal(packet.sequence, 2);
    assert(saved.releaseReceipt);
    await rename(f.target, f.target + '-later');
    await mkdir(f.p.target, { mode: 0o700 });
    await writeFile(join(f.p.target, 'later'), 'KEEP NEW ORIGINAL');
    later = new WorkspaceLease(f.p.target, 'later-' + randomUUID());
    const replay = await preserveBranchWorkspace(
      f.home,
      f.view.request.id,
      f.target,
      async () => {
        throw new Error('must not move again');
      },
      () => {},
    );
    assert.equal(replay.phase, 'settled');
    assert.equal(replay.acknowledgedHash, (await f.current()).reports[1]!.hash);
    later.assertHeld();
    assertBranchEvidenceSettled(f.home);
    assert.deepEqual((await f.current()).reports[1]!.report, packet);
    assert.deepEqual(await tree(f.target + '-later'), before);
    assert.equal(await readFile(join(f.p.target, 'later'), 'utf8'), 'KEEP NEW ORIGINAL');
  } finally {
    globalThis.fetch = originalFetch;
    later?.release();
    await f.close();
  }
});
test('目标在本机确认期间被用户抢先创建时拒绝，保留两侧，不保存伪移动报告', async () => {
  const f = await ready();
  try {
    const before = await tree(f.p.target);
    await assert.rejects(
      preserveBranchWorkspace(
        f.home,
        f.view.request.id,
        f.target,
        async (prompt) => {
          if (prompt.includes('输入 PRESERVE')) {
            await mkdir(f.target, { mode: 0o700 });
            await writeFile(join(f.target, 'mine'), 'KEEP TARGET OWNER');
          }
          return f.yes(prompt);
        },
        () => {},
      ),
      { code: 'RESTORE_TARGET_EXISTS' },
    );
    assert.deepEqual(await tree(f.p.target), before);
    assert.equal(await readFile(join(f.target, 'mine'), 'utf8'), 'KEEP TARGET OWNER');
    assert.equal((await f.current()).state, 'requested');
  } finally {
    await f.close();
  }
});
test('取得原claim后当前节点撤权仍阻止移动，已知未移动只结算自己的claim并保留待发证据', async () => {
  const f = await ready(),
    originalFetch = globalThis.fetch;
  try {
    const before = await tree(f.p.target);
    let count = 0;
    globalThis.fetch = async (...a) => {
      if (String(a[0]).endsWith('/runner/v1/branch-preservation-inspect') && ++count === 3) {
        const node = (await f.api.call('nodes', f.alice))
          .json()
          .items.find((n: { id: string }) => n.id === f.c.nodeId);
        assert.equal(
          (
            await f.api.call(`nodes/${f.c.nodeId}/revoke`, f.alice, {
              expectedRevision: node.revision,
            })
          ).statusCode,
          200,
        );
      }
      return originalFetch(...a);
    };
    await assert.rejects(
      preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {}),
      { code: 'NODE_REVOKED' },
    );
    assert.equal(count, 3);
    assert.deepEqual(await tree(f.p.target), before);
    assert.equal(existsSync(f.target), false);
    const db = new DatabaseSync(join(f.home, 'journal.sqlite'), { readOnly: true });
    const saved = JSON.parse(
      String(
        db
          .prepare('SELECT body FROM branch_binding WHERE id=?')
          .get('preservation:' + f.view.request.id)!.body,
      ),
    );
    db.close();
    assert.equal(saved.outcome, 'not_moved');
    assert.equal(saved.releaseReceipt.outcome, 'not_moved');
    assert.equal(saved.pending.sequence, 2);
    const later = new WorkspaceLease(f.p.target, 'later-after-refusal');
    later.release();
    assert.throws(() => assertBranchEvidenceSettled(f.home), { code: 'WORK_BRANCH_UNSETTLED' });
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});
for (const stage of ['before_move', 'after_move'] as const)
  test(`真实CLI进程在${stage}屏障退出，重启只核对原记录、保留后来文件且不重放移动`, async () => {
    const f = await ready();
    let child: ReturnType<typeof spawn> | undefined, response: ServerResponse | undefined;
    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const listener = (req: IncomingMessage, res: ServerResponse) => {
      if (
        req.url === '/runner/v1/branch-preservation-inspect' &&
        ++count === (stage === 'before_move' ? 3 : 4)
      ) {
        response = res;
        res.end = ((..._args: unknown[]) => {
          release();
          return res;
        }) as typeof res.end;
      }
    };
    f.api.app.server.prependListener('request', listener);
    try {
      const before = await tree(f.p.target);
      child = spawn(
        process.execPath,
        [resolve('dist/apps/runner/src/branch-preservation.js'), ...args(f)],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      let output = '';
      child.stdout!.on('data', (b) => {
        output += b;
      });
      child.stderr!.on('data', (b) => {
        output += b;
      });
      child.stdin!.end(lines(f));
      const early = once(child, 'close').then(() => {
        throw new Error('CLI exited before barrier: ' + output);
      });
      await Promise.race([reached, early]);
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      response!.destroy();
      f.api.app.server.removeListener('request', listener);
      if (stage === 'before_move') {
        assert.equal(existsSync(f.target), false);
        assert.deepEqual(await tree(f.p.target), before);
        const replay = await preserveBranchWorkspace(
          f.home,
          f.view.request.id,
          f.target,
          async () => {
            throw new Error('must not replay movement');
          },
          () => {},
        );
        assert.equal(replay.outcome, 'not_moved');
        assert.equal(replay.phase, 'settled');
        assert.deepEqual(await tree(f.p.target), before);
        assert.equal(existsSync(f.target), false);
      } else {
        assert.equal(existsSync(f.p.target), false);
        assert.deepEqual(await tree(f.target), before);
        await mkdir(f.p.target, { mode: 0o700 });
        await writeFile(join(f.p.target, 'later'), 'KEEP LATER ORIGINAL');
        const replay = await preserveBranchWorkspace(
          f.home,
          f.view.request.id,
          f.target,
          async () => {
            throw new Error('must not replay movement');
          },
          () => {},
        );
        assert.equal(replay.phase, 'needs_attention');
        assert.equal(replay.helperOutcome, 'preserved');
        assert.equal(replay.intent, true);
        assert.equal((await f.current()).state, 'needs_attention');
        assert.throws(() => new WorkspaceLease(f.p.target, 'new-writer'), {
          code: 'LOCAL_WORKSPACE_BUSY',
        });
        assert.throws(() => new WorkspaceLease(f.target, 'new-writer'), {
          code: 'LOCAL_WORKSPACE_BUSY',
        });
        assert.deepEqual(await tree(f.target), before);
        assert.equal(await readFile(join(f.p.target, 'later'), 'utf8'), 'KEEP LATER ORIGINAL');
        assert.throws(() => assertBranchEvidenceSettled(f.home), { code: 'WORK_BRANCH_UNSETTLED' });
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      response?.destroy();
      f.api.app.server.removeListener('request', listener);
      // Only this temporary fixture's deliberately retained unknown claim.
      const db = new DatabaseSync(join(homedir(), '.hexu/workspace-leases/registry.sqlite'));
      db.prepare('DELETE FROM claims WHERE dispatch_id=?').run(
        'branch-preserve:' + f.view.request.id,
      );
      db.close();
      await f.close();
    }
  });
for (const phase of ['before', 'after'] as const)
  test(`最终${phase}移动授权读取期间用户编辑不会被声明为原固定干净现场`, async () => {
    const f = await ready(),
      originalFetch = globalThis.fetch;
    try {
      let inspections = 0;
      const path = join(phase === 'before' ? f.p.target : f.target, 'README.md');
      globalThis.fetch = async (...a) => {
        if (
          String(a[0]).endsWith('/runner/v1/branch-preservation-inspect') &&
          ++inspections === (phase === 'before' ? 3 : 4)
        )
          await writeFile(path, 'KEEP USER EDIT DURING FINAL READ');
        return originalFetch(...a);
      };
      await assert.rejects(
        preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {}),
        { code: 'WORKSPACE_COMMIT_CHANGED' },
      );
      assert.equal(await readFile(path, 'utf8'), 'KEEP USER EDIT DURING FINAL READ');
      assert.equal((await f.current()).state, phase === 'before' ? 'failed' : 'needs_attention');
      if (phase === 'after')
        assert.throws(() => new WorkspaceLease(f.target, 'new-writer'), {
          code: 'LOCAL_WORKSPACE_BUSY',
        });
    } finally {
      globalThis.fetch = originalFetch;
      const db = new DatabaseSync(join(homedir(), '.hexu/workspace-leases/registry.sqlite'));
      db.prepare('DELETE FROM claims WHERE dispatch_id=?').run(
        'branch-preserve:' + f.view.request.id,
      );
      db.close();
      await f.close();
    }
  });
test('严格本机记录拒绝伪造结算、回执、意图或字段；旧凭证守卫不忽略新增保留行', async () => {
  const f = await ready();
  try {
    await preserveBranchWorkspace(f.home, f.view.request.id, f.target, f.yes, () => {});
    const before = await tree(f.target),
      db = new DatabaseSync(join(f.home, 'journal.sqlite'));
    const key = 'preservation:' + f.view.request.id,
      original = String(db.prepare('SELECT body FROM branch_binding WHERE id=?').get(key)!.body),
      saved = JSON.parse(original);
    try {
      for (const patch of [
        { acknowledgedHash: null },
        { releaseReceipt: null },
        { intent: true },
        { kind: 'other' },
        { root: '/other' },
        { helperOutcome: 'unknown' },
        { delete: true },
      ]) {
        const changed = { ...saved, ...patch };
        assert.throws(() => parseLocalBranchPreservation(changed));
        db.prepare('UPDATE branch_binding SET body=? WHERE id=?').run(JSON.stringify(changed), key);
        assert.throws(() => assertBranchEvidenceSettled(f.home));
        await assert.rejects(
          preserveBranchWorkspace(
            f.home,
            f.view.request.id,
            f.target,
            async () => {
              throw new Error('corrupted record must not run');
            },
            () => {},
          ),
        );
        assert.deepEqual(await tree(f.target), before);
      }
    } finally {
      db.prepare('UPDATE branch_binding SET body=? WHERE id=?').run(original, key);
      db.close();
    }
    assertBranchEvidenceSettled(f.home);
  } finally {
    await f.close();
  }
});
test('保留父目录不安全而早期拒绝时关闭已固定的原父链，不在重复核对中泄漏描述符', async () => {
  const f = await ready();
  try {
    const parent = join(f.dir, 'unsafe-preservation-parent');
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o777);
    const target = join(parent, 'new-preserved');
    const attempt = () =>
      assert.rejects(
        preserveBranchWorkspace(f.home, f.view.request.id, target, f.yes, () => {}),
        { code: 'RESTORE_FILES_CHANGED' },
      );
    await attempt();
    const before = (await readdir('/proc/self/fd')).length;
    for (let i = 0; i < 3; i++) await attempt();
    assert.equal((await readdir('/proc/self/fd')).length, before);
    assert.equal(existsSync(target), false);
    assert.equal((await f.current()).state, 'requested');
  } finally {
    await f.close();
  }
});
