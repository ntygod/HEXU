import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { branchWorkspaceFixture } from './helpers/branch-workspace.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { BranchResultPreview } from '../packages/contracts/src/results.js';
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
// Real isolated Git roots, original credentials and two clearly named protocol
// executables. Never use a real provider/account or delete a user's workspace.
test('真实双目录/协议进程：放弃不停止或解锁，独立停止保留用户修改与另一执行，终态成果不复活方案', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const a = await f.prepare(0),
      b = await f.prepare(1);
    await f.pairBranch(a.p);
    await f.bindBranch(a.p);
    await f.pairBranch(b.p);
    await f.bindBranch(b.p);
    const na = await f.enableBranch(a.p),
      nb = await f.enableBranch(b.p, 'codex');
    const ra = await f.runBranch(0, na, 'FIXTURE_CAPTURE_INPUT FIXTURE_HANG'),
      rb = await f.runBranch(1, nb, 'CODEX_CAPTURE_INPUT CODEX_HANG');
    assert.equal(ra.reply.statusCode, 201, ra.reply.body);
    assert.equal(rb.reply.statusCode, 201, rb.reply.body);
    for (let i = 0; i < 80; i++) {
      await f.tick();
      if (
        (await f.read()).branches.every((branch) => branch.run?.state === 'running') &&
        [a, b].every((p) => existsSync(join(p.target, 'received-context.txt')))
      )
        break;
      await pause();
    }
    assert((await f.read()).branches.every((branch) => branch.run?.state === 'running'));
    await writeFile(join(a.target, 'user-unsaved.txt'), 'KEEP UNSAVED USER EDIT');
    const paths = [a, b]
      .flatMap((p) =>
        ['README.md', '.git/HEAD', '.git/index', 'received-context.txt'].map((name) =>
          join(p.target, name),
        ),
      )
      .concat([
        join(a.target, 'user-unsaved.txt'),
        join(a.p.git!.nodeState!, 'credentials.json'),
        join(b.p.git!.nodeState!, 'credentials.json'),
        join(f.home, 'credentials.json'),
        join(f.root, 'README.md'),
        join(f.root, '.git/HEAD'),
        join(f.root, '.git/index'),
      ]);
    const bytes = await Promise.all(paths.map((p) => readFile(p)));
    const preview = (await f.api.call(a.path + '/discard-preview', f.alice)).json();
    const r = await f.api.call(a.path + '/discard-preserving', f.alice, {
      expectedRevision: preview.branch.revision,
      expectedTaskRevision: preview.taskRevision,
      confirmPreserveWorkspace: true,
      confirmExecutionContinues: true,
    });
    assert.equal(r.statusCode, 200, r.body);
    await f.tick();
    let view = await f.read();
    assert.equal(view.branches[0]!.state, 'discarded');
    assert.equal(view.branches[0]!.run!.state, 'running');
    assert.equal(view.branches[1]!.run!.state, 'running');
    assert.throws(() => new WorkspaceLease(a.target, 'discard-must-not-unlock'), {
      code: 'LOCAL_WORKSPACE_BUSY',
    });
    assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), bytes);
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, ra.body, ra.key)).json().id,
      ra.run.id,
    );
    const denied = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, {
      ...ra.body,
      expectedRevision: f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        f.api.store.getTask(f.task.id),
      ).revision,
      workBranch: { ...ra.body.workBranch, expectedRevision: view.branches[0]!.revision },
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal((await f.api.call(`runs/${ra.run.id}/stop`, f.alice, {})).statusCode, 200);
    assert.equal((await f.read()).branches[0]!.run!.state, 'stopping');
    for (let i = 0; i < 80; i++) {
      await f.tick();
      if ((await f.read()).branches[0]!.run?.state === 'cancelled') break;
      await pause();
    }
    view = await f.read();
    assert.equal(view.branches[0]!.state, 'discarded');
    assert.equal(view.branches[0]!.run!.state, 'cancelled');
    assert.equal(view.branches[0]!.run!.node!.terminationConfirmed, true);
    assert.equal(view.branches[1]!.run!.state, 'running');
    assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), bytes);
    const source = await f.api.call(a.path + '/result-preview', f.alice);
    assert.equal(source.statusCode, 200, source.body);
    const v = source.json() as BranchResultPreview;
    const saved = await f.api.call(a.path + '/results', f.alice, {
      expectedRevision: v.branchRevision,
      expectedResultRevision: v.resultRevision,
      sourceRunId: v.source.run.id,
      expectedRunRevision: v.source.run.revision,
      title: '中止后明确保留的成果',
      body: '仅保留已共享的协议夹具输出',
      limitations: '不是实际模型联调',
    });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal((await f.read()).branches[0]!.state, 'discarded');
    for (const p of [a, b])
      assert.equal(
        await readFile(join(p.p.git!.nodeState!, 'fixture-starts.txt'), 'utf8'),
        'start\n',
      );
    assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), bytes);
  } finally {
    await f.close();
  }
});
