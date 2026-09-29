import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseHandoffAcceptance,
  parseHandoffNodeCommand,
} from '../packages/contracts/src/handoff-acceptance.js';
import { HandoffAcceptanceStore } from '../packages/db/src/handoff-acceptance.js';
import { Store } from '../packages/db/src/store.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import {
  acceptLocalHandoff,
  assertHandoffEvidenceSettled,
} from '../apps/runner/src/agent/handoff-acceptance.js';
import { nodeRequest } from '../apps/runner/src/agent/connection.js';
import { AgentStorage } from '../apps/runner/src/agent/storage.js';
import { handoffAcceptanceFixture } from './helpers/handoff-acceptance.js';
import { noAsk, silent } from './helpers/checkpoint-transfer.js';

const code = (expected: string) => (e: unknown) => e instanceof DomainError && e.code === expected;
test('接手确认契约不接受浏览器路径、账号、原生会话或伪造终态', () => {
  const body = {
    expectedHandoffRevision: 1,
    expectedTaskRevision: 1,
    contextHash: 'a'.repeat(64),
    transferOwner: false,
  };
  for (const key of [
    'path',
    'target',
    'operatorUserId',
    'nodeId',
    'proof',
    'state',
    'sessionId',
    'apiKey',
  ])
    assert.throws(() => parseHandoffAcceptance({ ...body, [key]: 'injected' }));
  assert.throws(() => parseHandoffAcceptance({ ...body, transferOwner: 'yes' }));
  assert.throws(() =>
    parseHandoffNodeCommand({
      action: 'fail',
      operationId: randomUUID(),
      requestHash: 'a'.repeat(64),
      reason: ['files_changed'],
    }),
  );
  assert.throws(() =>
    parseHandoffNodeCommand({
      action: 'commit',
      operationId: randomUUID(),
      requestHash: 'a'.repeat(64),
      proof: { path: '/private' },
    }),
  );
  assert.throws(() =>
    parseHandoffNodeCommand({
      action: 'fail',
      operationId: randomUUID(),
      requestHash: 'a'.repeat(64),
      reason: '/private/error',
    }),
  );
});

for (const transferOwner of [false, true])
  test(`真实文件核验后接受接手，负责人移交=${transferOwner}，事务不创建Run或转交目录权限`, async () => {
    const f = await handoffAcceptanceFixture(true);
    try {
      const originalHead = await readFile(join(f.root, '.git/HEAD'));
      const credentials = await readFile(join(f.receiverHome, 'credentials.json'));
      const { op, body, key } = await f.start(transferOwner);
      assert.equal(op.state, 'waiting_local');
      const done = await f.confirm(op);
      assert.equal(done.state, 'succeeded');
      assert.equal(done.proof?.snapshotHash, f.handoff.material.snapshotHash);
      const detail = (await f.api.call(`tasks/${f.task.id}`, f.bob)).json();
      assert.equal(detail.task.operatorUserId, f.bob.user.id);
      assert.equal(detail.task.ownerUserId, transferOwner ? f.bob.user.id : f.alice.user.id);
      assert.equal(detail.task.createdByUserId, f.alice.user.id);
      assert.equal(detail.task.status, f.task.status);
      assert.equal(detail.task.revision, 2);
      assert.equal(detail.runs.length, 0);
      assert.equal(detail.task.participantUserIds?.length ?? 0, 0);
      const savedTask = f.api.store.db
        .prepare('SELECT body FROM tasks WHERE id=?')
        .get(f.task.id) as { body: string };
      assert(!Object.hasOwn(JSON.parse(savedTask.body), 'participantUserIds'));
      assert.equal((await f.api.call(f.handoffPath, f.alice)).json().handoff.state, 'accepted');
      assert.equal(
        (await f.api.call(f.handoffPath + '/accept', f.bob, body, key)).json().state,
        'succeeded',
      );
      const assignment = f.api.store.db
        .prepare('SELECT COUNT(*) AS n FROM task_assignment_events WHERE task_id=?')
        .get(f.task.id)!;
      assert.equal(assignment.n, transferOwner ? 1 : 0);
      assert.deepEqual(await readFile(join(f.root, '.git/HEAD')), originalHead);
      assert.deepEqual(await readFile(join(f.receiverHome, 'credentials.json')), credentials);
      assert(!existsSync(join(f.target, '.git')));
      const forbidden = await f.api.call(
        `tasks/${f.task.id}`,
        f.bob,
        { expectedRevision: 2, operatorUserId: f.alice.user.id },
        randomUUID(),
        'PATCH',
      );
      assert.equal(forbidden.statusCode, 400);
      assertHandoffEvidenceSettled(f.receiverHome);
    } finally {
      await f.close();
    }
  });

test('没有双方明确同意不能转移负责人，只有指定接收者能创建确认', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const p = (await f.api.call(f.handoffPath + '/acceptance-preview', f.bob)).json();
    const body = {
      expectedHandoffRevision: p.handoffRevision,
      expectedTaskRevision: p.taskRevision,
      contextHash: p.contextHash,
      transferOwner: true,
    };
    assert.equal((await f.api.call(f.handoffPath + '/accept', f.bob, body)).statusCode, 409);
    assert.equal(
      (await f.api.call(f.handoffPath + '/accept', f.alice, { ...body, transferOwner: false }))
        .statusCode,
      403,
    );
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM handoff_acceptances').get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('接手任务预约阻止新的节点Run，取消按原回执对账且不改变已有任务', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op, body } = await f.start();
    const request = {
      provider: 'node',
      nodeId: f.receiver.nodeId,
      workingCopyId: f.receiverCredentials.directories[0]!.id,
      policyHash: 'a'.repeat(64),
      mode: 'edit',
      prompt: 'Do not spawn',
      expectedRevision: 1,
      confirmExecution: true,
    };
    const run = await f.api.call(`tasks/${f.task.id}/runs`, f.bob, request);
    assert.equal(run.statusCode, 409, run.body);
    assert.equal(run.json().error.code, 'HANDOFF_PENDING');
    assert.equal((await f.api.call(f.handoffPath + '/accept', f.bob, body)).statusCode, 409);
    const path = `${f.handoffPath}/acceptances/${op.ticket.id}/cancel`,
      key = randomUUID();
    const cancelled = await f.api.call(path, f.alice, { expectedRevision: 1 }, key);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().state, 'cancelled');
    assert.equal(
      (await f.api.call(path, f.alice, { expectedRevision: 1 }, key)).json().revision,
      2,
    );
    const later = await f.confirm(op, noAsk);
    assert.equal(later.state, 'cancelled');
    assert.equal((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().runs.length, 0);
  } finally {
    await f.close();
  }
});

test('原任务或讨论改变即暂停接手，不用旧预检、旧回执或服务重启接受', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    await f.api.call(`tasks/${f.task.id}/messages`, f.alice, { body: '新增必须确认的人类要求' });
    const changed = await f.confirm(op, noAsk);
    assert.equal(changed.state, 'needs_attention');
    const next = await f.start();
    new HandoffAcceptanceStore(f.api.store).sweep(true);
    assert.equal((await f.confirm(next.op, noAsk)).state, 'needs_attention');
    const third = await f.start();
    const lateClock = Date.parse(third.op.ticket.expiresAt) + 1;
    new HandoffAcceptanceStore(f.api.store, () => lateClock).sweep();
    assert.equal((await f.confirm(third.op, noAsk)).state, 'needs_attention');
    const task = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    assert.equal(task.operatorUserId, undefined);
    assert.equal(task.revision, 1);
  } finally {
    await f.close();
  }
});

test('撤回邀请与取消确认同事务，节点不能晚到后再提交', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    const r = await f.api.call(f.handoffPath + '/withdraw', f.alice, { expectedRevision: 1 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await f.api.call(`${f.handoffPath}/acceptances/${op.ticket.id}`, f.bob)).json().state,
      'cancelled',
    );
    assert.equal((await f.confirm(op, noAsk)).state, 'cancelled');
  } finally {
    await f.close();
  }
});

for (const change of ['bytes', 'extra', 'link', 'parent'] as const)
  test(`接手重新核验现场，拒绝${change}变化并保留用户文件`, async () => {
    const f = await handoffAcceptanceFixture();
    try {
      const { op } = await f.start();
      if (change === 'bytes') await writeFile(join(f.target, 'src/binary.dat'), 'changed by user');
      if (change === 'extra') await writeFile(join(f.target, 'user-work.txt'), 'Never delete');
      if (change === 'link') {
        await rename(join(f.target, 'README.md'), join(f.dir, 'original-readme'));
        await symlink(join(f.dir, 'original-readme'), join(f.target, 'README.md'));
      }
      if (change === 'parent') {
        await rename(f.target, f.target + '-moved');
        await symlink(f.target + '-moved', f.target);
      }
      await assert.rejects(() => f.confirm(op));
      assert.equal(
        (await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.operatorUserId,
        undefined,
      );
      assert.equal(
        (await f.api.call(`${f.handoffPath}/acceptances/${op.ticket.id}`, f.bob)).json().state,
        'needs_attention',
      );
      if (change === 'extra')
        assert.equal(await readFile(join(f.target, 'user-work.txt'), 'utf8'), 'Never delete');
      if (change === 'bytes')
        assert.equal(await readFile(join(f.target, 'src/binary.dat'), 'utf8'), 'changed by user');
    } finally {
      await f.close();
    }
  });

test('未知本机写入锁不会被接手释放；旧Run未知状态阻止创建确认', async () => {
  const f = await handoffAcceptanceFixture();
  const lease = new WorkspaceLease(f.target, 'fixture-unknown-model-writer');
  try {
    const { op } = await f.start();
    await assert.rejects(() => f.confirm(op), code('LOCAL_WORKSPACE_BUSY'));
    assert.throws(
      () => new WorkspaceLease(f.target, 'another-fixture'),
      code('LOCAL_WORKSPACE_BUSY'),
    );
    const before = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    const id = randomUUID();
    f.api.store.db.prepare('INSERT INTO runs(id,task_id,body) VALUES(?,?,?)').run(
      id,
      f.task.id,
      JSON.stringify({
        id,
        taskId: f.task.id,
        provider: 'node',
        state: 'failed',
        observation: 'unknown',
        revision: 1,
      }),
    );
    const p = await f.api.call(f.handoffPath + '/acceptance-preview', f.bob);
    assert.equal(p.statusCode, 409);
    assert.equal(p.json().error.code, 'HANDOFF_WRITER_ACTIVE');
    assert.deepEqual((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task, before);
  } finally {
    lease.release();
    await f.close();
  }
});

test('接受事务失败回滚操作者、负责人、邀请与回执；固定核验包可对账一次', async () => {
  const f = await handoffAcceptanceFixture(true);
  try {
    const { op } = await f.start(true);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_accept BEFORE INSERT ON outbox WHEN NEW.kind='handoff.accepted' BEGIN SELECT RAISE(ABORT,'fixture transaction fault'); END;",
    );
    await assert.rejects(() => f.confirm(op));
    const detail = (await f.api.call(`tasks/${f.task.id}`, f.bob)).json();
    assert.equal(detail.task.operatorUserId, undefined);
    assert.equal(detail.task.ownerUserId, f.alice.user.id);
    assert.equal((await f.api.call(f.handoffPath, f.bob)).json().handoff.state, 'offered');
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM task_assignment_events').get()!.n,
      0,
    );
    assert.throws(() => assertHandoffEvidenceSettled(f.receiverHome), code('HANDOFF_UNSETTLED'));
    f.api.store.db.exec('DROP TRIGGER fail_accept;');
    assert.equal((await f.confirm(op, noAsk)).state, 'succeeded');
    assert.equal((await f.confirm(op, noAsk)).state, 'succeeded');
    assert.equal((await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.revision, 2);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM task_assignment_events').get()!.n,
      1,
    );
    assertHandoffEvidenceSettled(f.receiverHome);
  } finally {
    await f.close();
  }
});

test('丢失成功回执保持原核验包；后续文件修改不重新恢复或重复改变操作者', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    f.dropNext('/runner/v1/handoff-acceptance', 'commit');
    await assert.rejects(() => f.confirm(op));
    const db = new DatabaseSync(join(f.receiverHome, 'handoff-acceptances/journal.sqlite'), {
      readOnly: true,
    });
    const packet = db.prepare('SELECT packet FROM handoff_confirmations').get()!.packet;
    db.close();
    await writeFile(join(f.target, 'README.md'), 'User work after acceptance');
    assert.equal((await f.confirm(op, noAsk)).state, 'succeeded');
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'User work after acceptance');
    const after = new DatabaseSync(join(f.receiverHome, 'handoff-acceptances/journal.sqlite'), {
      readOnly: true,
    });
    assert.equal(after.prepare('SELECT packet FROM handoff_confirmations').get()!.packet, packet);
    after.close();
    assert.equal((await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.revision, 2);
  } finally {
    await f.close();
  }
});

test('当前权限在旧回执前复查，非原节点与浏览器不能提交本机核验', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op, body, key } = await f.start();
    await assert.rejects(
      () =>
        nodeRequest(
          f.credentials.controlUrl,
          'handoff-acceptance',
          { action: 'inspect', operationId: op.ticket.id },
          f.token,
        ),
      code('NOT_FOUND'),
    );
    const cookie = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/handoff-acceptance',
      headers: {
        cookie: f.bob.cookie,
        authorization: `Bearer ${f.receiverToken}`,
        'x-hexu-runner': '1',
      },
      payload: { action: 'inspect', operationId: op.ticket.id },
    });
    assert.equal(cookie.statusCode, 403);
    await f.confirm(op);
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
      f.api.store.collaboration.setProjectMember(f.project.id, f.bob.user.id, 'view', randomUUID()),
    );
    assert.equal((await f.api.call(f.handoffPath + '/accept', f.bob, body, key)).statusCode, 403);
    await assert.rejects(() => f.confirm(op, noAsk));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task.operatorUserId,
      f.bob.user.id,
    );
  } finally {
    await f.close();
  }
});

test('同一原确认不能换目标，恢复日志被活动进程持有时不伪造核验成功', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    const guard = new AgentStorage(join(f.receiverHome, 'checkpoint-restores'));
    try {
      await assert.rejects(() => f.confirm(op), code('RUNNER_ALREADY_STARTED'));
    } finally {
      guard.close();
    }
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}`, f.bob)).json().task.operatorUserId,
      undefined,
    );
    await assert.rejects(
      () =>
        acceptLocalHandoff(f.receiverHome, op.ticket.id, f.receiverRoot, noAsk, { log: silent }),
      code('CHECKPOINT_SCOPE_CHANGED'),
    );
  } finally {
    await f.close();
  }
});

test('迁移26保留已有邀请、事件与未知操作者，不倒填接受状态', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const path = join(f.dir, 'migration.sqlite');
    f.api.store.db.prepare('VACUUM INTO ?').run(path);
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE handoff_acceptances; DELETE FROM schema_migrations WHERE version=26;');
    const invitation = old.prepare('SELECT body FROM handoffs').get()!.body,
      event = old.prepare('SELECT body FROM handoff_events').get()!.body;
    old.close();
    const upgraded = new Store(path, undefined, { team: true });
    try {
      assert.equal(upgraded.db.prepare('SELECT body FROM handoffs').get()!.body, invitation);
      assert.equal(upgraded.db.prepare('SELECT body FROM handoff_events').get()!.body, event);
      assert.equal(
        upgraded.db.prepare('SELECT COUNT(*) AS n FROM handoff_acceptances').get()!.n,
        0,
      );
      assert.equal(
        JSON.parse(
          String(upgraded.db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body),
        ).operatorUserId,
        undefined,
      );
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      upgraded.close();
    }
  } finally {
    await f.close();
  }
});

test('恢复日志的来源或完成计数损坏时拒绝接受，不用现存文件补造旧记录', async () => {
  const f = await handoffAcceptanceFixture();
  try {
    const { op } = await f.start();
    const db = new DatabaseSync(join(f.receiverHome, 'checkpoint-restores/journal.sqlite'));
    const row = db.prepare('SELECT id,progress FROM restores').get()!;
    const p = JSON.parse(String(row.progress));
    p.requestId = randomUUID();
    p.completedFiles = 0;
    db.prepare('UPDATE restores SET progress=? WHERE id=?').run(JSON.stringify(p), String(row.id));
    db.close();
    await assert.rejects(() => f.confirm(op), code('RESTORE_JOURNAL_INVALID'));
    const task = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    assert.equal(task.operatorUserId, undefined);
    const after = new DatabaseSync(join(f.receiverHome, 'checkpoint-restores/journal.sqlite'), {
      readOnly: true,
    });
    assert.equal(
      JSON.parse(String(after.prepare('SELECT progress FROM restores').get()!.progress))
        .completedFiles,
      0,
    );
    after.close();
  } finally {
    await f.close();
  }
});
