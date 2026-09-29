import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import { branchWorkspaceFixture, branchYes } from './helpers/branch-workspace.js';
import { noAsk } from './helpers/checkpoint-transfer.js';
import {
  prepareBranchWorkspace,
  bindBranchWorkspace,
  assertBranchEvidenceSettled,
  cleanupBranchPreparation,
} from '../apps/runner/src/agent/branch-workspace.js';
import { nodeRequest } from '../apps/runner/src/agent/connection.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { readCredentials } from '../apps/runner/src/agent/storage.js';
import {
  branchOriginHash,
  readBranchOrigin,
  verifyBranchOrigin,
} from '../apps/runner/src/agent/branch-origin.js';
import { ownedEntry } from '../apps/runner/src/agent/checkpoint-restore-files.js';
import { objectHash } from '../apps/runner/src/agent/checkpoint-objects.js';
import {
  parseBranchWorkspaceCommand,
  parseBranchWorkspaceCreate,
} from '../packages/contracts/src/work-branch-workspaces.js';
import { Store } from '../packages/db/src/store.js';
import { WorkBranchStore } from '../packages/db/src/work-branches.js';
const code = (name: string) => (e: unknown) => e instanceof DomainError && e.code === name;
const pause = () => new Promise((r) => setTimeout(r, 30));

test('现场请求和节点报告严格拒绝任意路径、执行指令与伪造阶段', () => {
  const value = { expectedRevision: 1, retentionId: randomUUID(), snapshotHash: 'a'.repeat(64) };
  for (const extra of [
    { target: '/tmp/other' },
    { execute: true },
    { state: 'bound' },
    { nodeId: 'other' },
    { tool: 'codex' },
  ])
    assert.throws(() => parseBranchWorkspaceCreate({ ...value, ...extra }));
  for (const extra of [
    { target: '/tmp/other' },
    { proof: {} },
    { state: 'prepared' },
    { command: 'touch file' },
  ])
    assert.throws(() =>
      parseBranchWorkspaceCommand({ action: 'inspect', operationId: randomUUID(), ...extra }),
    );
});

for (const format of ['sha1', 'sha256'] as const)
  test(`${format}真实方案副本独立准备和登记，原仓库/凭证不变，配对不启动模型`, async () => {
    const f = await branchWorkspaceFixture(format);
    try {
      const original = await readFile(join(f.root, 'README.md')),
        credentials = await readFile(join(f.home, 'credentials.json'));
      const p = await f.prepare();
      assert.equal(
        await readFile(join(p.target, 'README.md'), 'utf8'),
        'Retain only this committed snapshot\n',
      );
      assert(!existsSync(join(p.target, 'private.txt')));
      assert.equal(
        (await prepareBranchWorkspace(f.home, p.op.ticket.id, p.target, noAsk, () => {})).phase,
        'settled',
      );
      const node = await f.pairBranch(p.p),
        bound = await f.bindBranch(p.p);
      assert.equal(bound.state, 'bound');
      assert.equal(bound.nodeId, node.nodeId);
      assert.notEqual(node.nodeId, f.node.nodeId);
      assert.equal((await f.read()).branches[0]!.workingCopyId, node.directories[0]!.id);
      assert.equal((await f.read()).branches[0]!.runId, null);
      assert.deepEqual(await readFile(join(f.root, 'README.md')), original);
      assert.deepEqual(await readFile(join(f.home, 'credentials.json')), credentials);
      assertBranchEvidenceSettled(f.home);
      assertBranchEvidenceSettled(p.p.git!.nodeState!);
    } finally {
      await f.close();
    }
  });
test('两方案在不同节点/目录同Task并发，固定共同输入与各自目标，真实输出不互相写入', async () => {
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
    const patch = await f.api.call(
      `tasks/${f.task.id}`,
      f.alice,
      { expectedRevision: 2, description: 'AFTER_PLAN_NOT_SHARED' },
      randomUUID(),
      'PATCH',
    );
    assert.equal(patch.statusCode, 200, patch.body);
    const ra = await f.runBranch(0, na, 'FIXTURE_CAPTURE_INPUT FIXTURE_HANG'),
      rb = await f.runBranch(1, nb, 'CODEX_CAPTURE_INPUT CODEX_HANG');
    assert.equal(ra.reply.statusCode, 201, ra.reply.body);
    assert.equal(rb.reply.statusCode, 201, rb.reply.body);
    for (let i = 0; i < 80; i++) {
      await f.tick();
      if ((await f.read()).branches.every((v) => v.run?.state === 'running')) break;
      await pause();
    }
    const v = await f.read();
    assert(v.branches.every((b) => b.state === 'active' && b.run?.state === 'running'));
    const ca = await readFile(join(a.target, 'received-context.txt'), 'utf8'),
      cb = await readFile(join(b.target, 'received-context.txt'), 'utf8');
    assert.match(ca, /COMMON_BRANCH_INPUT/);
    assert.match(cb, /COMMON_BRANCH_INPUT/);
    assert.match(ca, /ALPHA_ONLY/);
    assert.doesNotMatch(ca, /BETA_ONLY|AFTER_PLAN_NOT_SHARED/);
    assert.match(cb, /BETA_ONLY/);
    assert.doesNotMatch(cb, /ALPHA_ONLY|AFTER_PLAN_NOT_SHARED/);
    assert(!existsSync(join(f.root, 'received-context.txt')));
    const stopped = await f.api.call(`runs/${ra.run.id}/stop`, f.alice, {});
    assert.equal(stopped.statusCode, 200, stopped.body);
    for (let i = 0; i < 80; i++) {
      await f.tick();
      if ((await f.read()).branches[0]!.run?.state === 'cancelled') break;
      await pause();
    }
    const after = await f.read();
    assert.equal(after.branches[0]!.run?.state, 'cancelled');
    assert.equal(after.branches[1]!.run?.state, 'running');
    assert.equal(
      await readFile(join(a.p.git!.nodeState!, 'fixture-starts.txt'), 'utf8'),
      'start\n',
    );
    assert.equal(
      await readFile(join(b.p.git!.nodeState!, 'fixture-starts.txt'), 'utf8'),
      'start\n',
    );
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task.status,
      'in_progress',
    );
  } finally {
    await f.close();
  }
});
test('准备报告与登记丢失回执，只重发原包，不重做目录或重复登记', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const c = await f.createPreparation(),
      target = join(f.dir, 'receipt-copy');
    f.dropNext('/runner/v1/work-branch-workspace', 'prepare');
    await assert.rejects(() =>
      prepareBranchWorkspace(f.home, c.op.ticket.id, target, branchYes, () => {}),
    );
    assert.throws(() => assertBranchEvidenceSettled(f.home), code('WORK_BRANCH_UNSETTLED'));
    const p = await prepareBranchWorkspace(f.home, c.op.ticket.id, target, noAsk, () => {});
    assert.equal(p.result?.state, 'prepared');
    await f.pairBranch(p);
    f.dropNext('/runner/v1/work-branch-workspace', 'bind');
    await assert.rejects(() => bindBranchWorkspace(p.git!.nodeState!, branchYes));
    assert.throws(
      () => assertBranchEvidenceSettled(p.git!.nodeState!),
      code('WORK_BRANCH_UNSETTLED'),
    );
    assert.equal((await bindBranchWorkspace(p.git!.nodeState!, noAsk)).state, 'bound');
    assert.equal(
      (await f.api.call(c.path + '/history', f.alice))
        .json()
        .items.filter((e: { action: string }) => e.action === 'workspace_bound').length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('首轮运行前重新核验实际文件，准备后用户修改会失败且不调用模型', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const n = await f.enableBranch(p.p);
    await writeFile(join(p.target, 'README.md'), 'user edits after binding');
    const r = await f.runBranch(0, n);
    assert.equal(r.reply.statusCode, 201, r.reply.body);
    for (let i = 0; i < 50; i++) {
      await f.tick();
      if ((await f.read()).branches[0]!.run?.state === 'failed') break;
      await pause();
    }
    assert.equal((await f.read()).branches[0]!.run?.state, 'failed');
    assert(!existsSync(join(p.p.git!.nodeState!, 'fixture-starts.txt')));
    assert.equal(await readFile(join(p.target, 'README.md'), 'utf8'), 'user edits after binding');
    const retry = await f.runBranch(0, n);
    assert.equal(retry.reply.statusCode, 409);
  } finally {
    await f.close();
  }
});
test('已绑定目录不能借普通运行/接续或另一个方案使用，原Run回执不重复执行', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const n = await f.enableBranch(p.p);
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/node-options`, f.alice)).json().items.length,
      0,
    );
    const r = await f.runBranch(0, n);
    assert.equal(r.reply.statusCode, 201, r.reply.body);
    const { workBranch: _branch, ...plain } = r.body;
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, plain)).json().error.code,
      'WORK_BRANCH_REQUIRED',
    );
    assert.equal(
      (
        await f.api.call(`tasks/${f.task.id}/runs`, f.alice, {
          ...r.body,
          workBranch: { ...r.body.workBranch, branchId: f.view.branches[1]!.id },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, r.body, r.key)).json().id,
      r.run.id,
    );
    for (let i = 0; i < 80; i++) {
      await f.tick();
      if ((await f.read()).branches[0]!.run?.state === 'succeeded') break;
      await pause();
    }
    assert.equal((await f.read()).branches[0]!.run?.state, 'succeeded');
    assert.equal(await readFile(join(p.target, 'native-output.txt'), 'utf8'), 'fixture edit\n');
    assert.equal(
      await readFile(join(p.p.git!.nodeState!, 'fixture-starts.txt'), 'utf8'),
      'start\n',
    );
    assert.equal(
      (
        await f.api.call(
          `tasks/${f.task.id}/node-continuation-preview?sourceRunId=${r.run.id}`,
          f.alice,
        )
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test('准备途中遇到未知写入保留目录和占用，取消/本机处置不删除已发布代码', async () => {
  const f = await branchWorkspaceFixture();
  let lease: WorkspaceLease | undefined;
  try {
    const c = await f.createPreparation(),
      target = join(f.dir, 'unknown-writer');
    await assert.rejects(
      () =>
        prepareBranchWorkspace(
          f.home,
          c.op.ticket.id,
          target,
          async (q) => {
            if (q.includes('输入 GIT '))
              lease = new WorkspaceLease(target, 'fixture-unknown-model');
            return branchYes(q);
          },
          () => {},
        ),
      code('LOCAL_WORKSPACE_BUSY'),
    );
    assert.equal(
      (await prepareBranchWorkspace(f.home, c.op.ticket.id, target, noAsk, () => {})).phase,
      'needs_attention',
    );
    const op = (await f.api.call(`${c.path}/workspaces/${c.op.ticket.id}`, f.alice)).json();
    assert.equal(
      (
        await f.api.call(`${c.path}/workspaces/${c.op.ticket.id}/cancel`, f.alice, {
          expectedRevision: op.revision,
        })
      ).statusCode,
      200,
    );
    await cleanupBranchPreparation(f.home, c.op.ticket.id, branchYes);
    assert(existsSync(join(target, 'README.md')));
    assert.throws(() => new WorkspaceLease(target, 'another-model'), code('LOCAL_WORKSPACE_BUSY'));
    assertBranchEvidenceSettled(f.home);
  } finally {
    lease?.release();
    await f.close();
  }
});
test('派发与方案关联原子提交，事务失败不留下半个Run或付费许可', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const n = await f.enableBranch(p.p);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_branch_run BEFORE INSERT ON work_branch_events WHEN json_extract(NEW.body,'$.action')='run_created' BEGIN SELECT RAISE(ABORT,'fixture branch binding failure'); END;",
    );
    const r = await f.runBranch(0, n);
    assert.equal(r.reply.statusCode, 500);
    assert.equal((await f.read()).branches[0]!.runId, null);
    assert.equal(f.api.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    f.api.store.db.exec('DROP TRIGGER fail_branch_run;');
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, r.body, r.key)).statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});
test('重复创建和撤权仍核对原节点权限，浏览器与错误节点不能发布现场证明', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const c = await f.createPreparation();
    const cookie = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/work-branch-workspace',
      headers: { cookie: f.alice.cookie, authorization: `Bearer ${f.token}`, 'x-hexu-runner': '1' },
      payload: { action: 'inspect', operationId: c.op.ticket.id },
    });
    assert.equal(cookie.statusCode, 403);
    const bob = await f.api.joinAccount((await f.api.invite(f.alice)).token);
    await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, {
      role: 'manage',
    });
    await f.api.call(`projects/${f.project.id}/members/${f.alice.user.id}`, bob, { role: 'view' });
    assert.equal(
      (await f.api.call(c.path + '/workspaces', f.alice, c.body, c.key)).statusCode,
      403,
    );
    await assert.rejects(() =>
      nodeRequest(
        f.credentials.controlUrl,
        'work-branch-workspace',
        { action: 'inspect', operationId: c.op.ticket.id },
        f.token,
      ),
    );
    assert.equal((await f.api.call(`tasks/${f.task.id}/work-branches`, f.alice)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('配对或服务器报告不能代替本机登记确认，未登记节点不发布执行许可', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await assert.rejects(() => f.enableBranch(p.p), code('WORK_BRANCH_NOT_BOUND'));
    assert.equal(
      f.api.store.db.prepare('SELECT count(*) AS n FROM node_execution_policies').get()!.n,
      0,
    );
    assert.equal((await f.read()).branches[0]!.workspace?.state, 'prepared');
  } finally {
    await f.close();
  }
});
test('现场验证从实际Git树复核文件清单，不能只相信自洽的本机日志', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const p = await f.prepare();
    const c = await f.pairBranch(p.p),
      home = p.p.git!.nodeState!;
    const origin = readBranchOrigin(home),
      bytes = Buffer.from('different content under the same declared start');
    await writeFile(join(p.target, 'README.md'), bytes);
    const entry = origin.plan.entries.find((e) => e.path === 'README.md')!;
    entry.objectId = objectHash(origin.ticket.manifest.objectFormat, 'blob', bytes);
    entry.bytes = bytes.length;
    const fd = openSync(join(p.target, 'README.md'), 'r');
    try {
      origin.entries = origin.entries.map((e) =>
        e.path === 'README.md' ? ownedEntry(e.path, 'file', fd) : e,
      );
    } finally {
      closeSync(fd);
    }
    await writeFile(join(home, 'branch-origin.json'), JSON.stringify(origin));
    // Simulate an internally self-consistent but semantically wrong producer record.
    await assert.rejects(
      () =>
        verifyBranchOrigin(home, c, c.directories[0]!, {
          branchId: origin.ticket.branchId,
          groupId: origin.ticket.groupId,
          operationId: origin.ticket.id,
          startHash: origin.ticket.startHash,
          originHash: branchOriginHash(origin),
          commit: origin.ticket.manifest.commit,
        }),
      code('WORK_BRANCH_PLAN_CHANGED'),
    );
  } finally {
    await f.close();
  }
});
test('固定共同说明加本次要求超出命令预算时整次拒绝，不保存不可执行的Run', async () => {
  const f = await branchWorkspaceFixture('sha1', true);
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const n = await f.enableBranch(p.p);
    const r = await f.runBranch(0, n, 'X'.repeat(6000));
    assert.equal(r.reply.statusCode, 400, r.reply.body);
    assert.equal((await f.read()).branches[0]!.runId, null);
    assert.equal(f.api.store.db.prepare('SELECT count(*) AS n FROM node_dispatches').get()!.n, 0);
  } finally {
    await f.close();
  }
});
test('迁移28保留已有定义和历史，不补造现场/Run，普通Task约束仍保留', async () => {
  const f = await branchWorkspaceFixture();
  try {
    const path = join(f.dir, 'old-branch-schema.sqlite');
    f.api.store.db.prepare('VACUUM INTO ?').run(path);
    const old = new DatabaseSync(path);
    old.exec(
      "DROP TABLE work_branch_workspaces; DROP INDEX one_pending_branch_dispatch; DROP INDEX one_pending_task_dispatch; CREATE UNIQUE INDEX one_pending_task_dispatch ON node_dispatches(task_id) WHERE stage!='terminal'; DELETE FROM schema_migrations WHERE version=28;",
    );
    old.close();
    const upgraded = new Store(path, undefined, { team: true });
    try {
      upgraded.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        assert.deepEqual(new WorkBranchStore(upgraded).get(f.task.id, f.view.group.id), f.view),
      );
      assert.equal(
        upgraded.db.prepare('SELECT count(*) AS n FROM work_branch_workspaces').get()!.n,
        0,
      );
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert(
        upgraded.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='one_pending_task_dispatch'")
          .get(),
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await f.close();
  }
});
