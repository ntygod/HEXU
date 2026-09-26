import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, type Run } from '../packages/contracts/src/index.js';
import { parseProjectLifecycle } from '../packages/contracts/src/project-lifecycle.js';
import { parseNativeRunCreate, type NativeRunConfig } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { openCodex } from '../apps/runner/src/codex-host.js';
import { teamFixture } from './helpers/team.js';

const key = () => randomUUID();
const code = (value: string) => (e: unknown) => e instanceof DomainError && e.code === value;
const archive = (
  store: Store,
  id: string,
  activeRunAction: 'keep' | 'stop' = 'keep',
  idem = key(),
) =>
  store.projectLifecycle.change(
    id,
    { action: 'archive', expectedRevision: store.project(id).revision, activeRunAction },
    idem,
  );
const restore = (store: Store, id: string) =>
  store.projectLifecycle.change(
    id,
    { action: 'restore', expectedRevision: store.project(id).revision },
    key(),
  );
function basic(store: Store) {
  const project = store.createProject({ name: '归档测试', description: '保留项目目标' }, key());
  const task = store.createTask(
    { title: '原任务', description: '原说明', projectId: project.id },
    key(),
  );
  const input = {
    provider: 'mock' as const,
    requestedTool: 'claude-code' as const,
    scenario: 'success' as const,
    prompt: '',
    expectedRevision: task.revision,
    reopenTask: false,
  };
  return { project, task, input };
}
function native(store: Store) {
  const f = basic(store);
  const copy = store.registerWorkingCopy({
    id: key(),
    name: 'fixture',
    root: '/fixture/isolated-project',
    createdAt: new Date().toISOString(),
  });
  const input = parseNativeRunCreate({
    provider: 'native',
    requestedTool: 'claude-code',
    workingCopyId: copy.id,
    prompt: 'fixture',
    confirmExecution: true,
    expectedRevision: f.task.revision,
  });
  const config: NativeRunConfig = {
    workingCopyId: copy.id,
    mode: 'read-only',
    model: null,
    maxTurns: 8,
    maxBudgetUsd: 1,
    timeoutSeconds: 30,
    toolVersion: 'fixture',
    contextText: 'fixture',
    contextHash: 'fixture',
  };
  const run = store.createNativeRun(f.task.id, input, config, key());
  const opInput = parseContinuation({
    ...input,
    model: '',
    confirmExecution: true,
    expectedRevision: store.getTask(f.task.id).revision,
    sourceRunId: run.id,
    requestedTool: 'claude-code',
    onActiveRun: 'wait',
    prompt: '保留的下一轮要求',
  });
  return { ...f, copy, run, config, opInput };
}

test('归档契约要求明确的运行处理方式，恢复不接收停止或启动参数', () => {
  for (const body of [
    null,
    [],
    {},
    { action: 'archive', expectedRevision: 1 },
    { action: 'archive', expectedRevision: 1, activeRunAction: ['keep'] },
    { action: 'restore', expectedRevision: 1, activeRunAction: 'stop' },
    { action: 'archive', expectedRevision: 0, activeRunAction: 'keep' },
    { action: 'restore', expectedRevision: 1, force: true },
    { action: 'delete', expectedRevision: 1 },
  ])
    assert.throws(() => parseProjectLifecycle(body), code('INVALID_INPUT'));
  assert.deepEqual(
    parseProjectLifecycle({ action: 'archive', expectedRevision: 1, activeRunAction: 'keep' }),
    { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
  );
  assert.deepEqual(parseProjectLifecycle({ action: 'restore', expectedRevision: 2 }), {
    action: 'restore',
    expectedRevision: 2,
  });
});

test('归档恢复沿用修订，保留任务讨论成果；旧回执和无变化请求不重做副作用', () => {
  const store = new Store();
  try {
    const f = basic(store);
    store.addMessage(f.task.id, '已有讨论', null, key());
    store.createResult(f.task.id, '已有成果', '历史保留', key());
    const before = store.detail(f.task.id);
    const input = {
      action: 'archive',
      expectedRevision: f.project.revision,
      activeRunAction: 'stop',
    };
    const idem = key();
    const saved = store.projectLifecycle.change(f.project.id, input, idem);
    assert.ok(saved.project.archivedAt);
    assert.equal(saved.project.archivedBy, store.actorId);
    assert.deepEqual(store.detail(f.task.id), before);
    assert.throws(
      () => store.projectSettings.patch(f.project.id, { expectedRevision: 1, name: '覆盖' }, key()),
      code('REVISION_CONFLICT'),
    );
    assert.equal(archive(store, f.project.id).project.revision, 2);
    assert.equal(restore(store, f.project.id).project.revision, 3);
    assert.deepEqual(store.projectLifecycle.change(f.project.id, input, idem), saved);
    assert.equal(store.project(f.project.id).archivedAt, null);
    assert.equal(store.project(f.project.id).revision, 3);
    const history = store.projectSettings.history(f.project.id, { limit: 50, before: null });
    assert.deepEqual(
      history.items.map((item) => !!item.archivedAt),
      [false, true, false],
    );
    assert.equal(history.items[1]!.actorId, store.actorId);
    assert.equal(restore(store, f.project.id).project.revision, 3);
  } finally {
    store.close();
  }
});

test('归档阻止模拟/原生的新启动和旧创建回执，人工讨论和完成不被强制冻结', () => {
  const store = new Store();
  try {
    const f = basic(store),
      idem = key();
    const run = store.createRun(f.task.id, f.input, idem);
    archive(store, f.project.id);
    assert.equal(store.run(run.id).state, 'cancelled');
    for (const k of [idem, key()])
      assert.throws(() => store.createRun(f.task.id, f.input, k), code('PROJECT_ARCHIVED'));
    const n = native(store);
    archive(store, n.project.id);
    assert.throws(
      () => store.createNativeRun(n.task.id, n.opInput.run, n.config, key()),
      code('PROJECT_ARCHIVED'),
    );
    assert.throws(
      () => store.replayNativeRun(n.task.id, n.opInput.run, key()),
      code('PROJECT_ARCHIVED'),
    );
    assert.throws(
      () => new ContinuationStore(store).create(n.task.id, n.opInput, key()),
      code('PROJECT_ARCHIVED'),
    );
    assert.equal(store.run(n.run.id).state, 'stopping');
    assert.equal(store.nativeLock(n.copy.id), n.run.id);
    assert.equal(store.getTask(f.task.id).status, 'in_progress');
    assert.doesNotThrow(() => store.addMessage(f.task.id, '归档后补充讨论', null, key()));
    assert.equal(
      store.changeTask(f.task.id, 'done', store.getTask(f.task.id).revision, 'keep', key()).status,
      'done',
    );
  } finally {
    store.close();
  }
});

test('归档立即暂停 preview 等待安排，快速恢复或最终提交检查均不能复活旧安排', () => {
  const store = new Store();
  try {
    const f = native(store),
      records = new ContinuationStore(store);
    store.stepRun(f.run.id, 'preparing');
    store.stepRun(f.run.id, 'running');
    const op = records.create(f.task.id, f.opInput, key());
    records.transition(op.id, 'preparing');
    const frozen = records.get(op.id).input;
    archive(store, f.project.id, 'keep');
    assert.equal(store.run(f.run.id).state, 'running');
    assert.equal(records.get(op.id).state, 'needs_attention');
    assert.equal(records.get(op.id).blockers[0]!.code, 'PROJECT_ARCHIVED');
    restore(store, f.project.id);
    assert.deepEqual(records.get(op.id).input, frozen);
    assert.throws(
      () => records.assertStart(op.id, f.task.id, f.opInput.run),
      code('CONTINUATION_INACTIVE'),
    );
    store.finishNativeRun(f.run.id, 'succeeded', 'fixture', true);
    assert.equal(store.runs(f.task.id).length, 1);
    assert.equal(records.get(op.id).state, 'needs_attention');
  } finally {
    store.close();
  }
});

test('项目状态、历史、等待安排、运行状态和回执故障原子回滚', () => {
  for (const table of [
    'project_revisions',
    'continuation_operations',
    'runs',
    'outbox',
    'idempotency_records',
  ]) {
    const store = new Store();
    try {
      const f = native(store),
        records = new ContinuationStore(store);
      const op = records.create(f.task.id, f.opInput, key());
      const before = {
        project: store.project(f.project.id),
        run: store.run(f.run.id),
        op: records.get(op.id),
      };
      const event = ['continuation_operations', 'runs'].includes(table) ? 'UPDATE' : 'INSERT';
      store.db.exec(
        `CREATE TRIGGER fail_archive BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`,
      );
      const idem = key();
      assert.throws(() => archive(store, f.project.id, 'stop', idem), /fixture rollback/);
      assert.deepEqual(
        { project: store.project(f.project.id), run: store.run(f.run.id), op: records.get(op.id) },
        before,
      );
      assert.equal(store.nativeLock(f.copy.id), f.run.id);
      store.db.exec('DROP TRIGGER fail_archive');
      assert.ok(archive(store, f.project.id, 'stop', idem).project.archivedAt);
    } finally {
      store.close();
    }
  }
});

test('归档及未知执行跨 SQLite 重启保留；恢复项目不清除现场锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-archive-test-')),
    path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    const f = native(store),
      records = new ContinuationStore(store);
    store.stepRun(f.run.id, 'preparing');
    store.stepRun(f.run.id, 'running');
    const op = records.create(f.task.id, f.opInput, key());
    archive(store, f.project.id, 'stop');
    store.close();
    store = new Store(path);
    store.recoverNativeRuns();
    assert.equal(store.run(f.run.id).observation, 'unknown');
    assert.ok(store.project(f.project.id).archivedAt);
    assert.equal(new ContinuationStore(store).get(op.id).state, 'needs_attention');
    restore(store, f.project.id);
    assert.equal(store.nativeLock(f.copy.id), f.run.id);
    assert.equal(store.run(f.run.id).state, 'stopping');
    assert.equal(store.runs(f.task.id).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex 异步目录准备后在 spawn 前重新检查取消，拒绝时不启动任何进程', async () => {
  let spawns = 0;
  await assert.rejects(
    openCodex({
      executable: '/must-not-start',
      root: '/fixture',
      apiKey: 'fake-never-authenticated',
      beforeSpawn() {
        throw new Error('fixture cancelled before spawn');
      },
      onSpawn() {
        spawns++;
      },
      onEvent() {},
      onReferences() {},
    }),
    /fixture cancelled before spawn/,
  );
  assert.equal(spawns, 0);
});

test('真实账号归档权限、旧回执重放与项目活动列表都遵守当前访问范围', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice);
    await f.task(alice, project.id);
    const path = `projects/${project.id}/lifecycle`,
      idem = key();
    const body = { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' };
    for (const role of ['view', 'edit']) {
      await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role });
      const res = await f.call(path, bob, body);
      assert.equal(res.statusCode, 403);
    }
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'manage' });
    const res = await f.call(path, bob, body, idem);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().archivedAt);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    assert.equal((await f.call(path, bob, body, idem)).statusCode, 403);
    assert.equal((await f.call(`projects/${project.id}/activity`, bob)).statusCode, 200);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null });
    assert.equal((await f.call(path, bob, body, idem)).statusCode, 404);
    assert.equal((await f.call(`projects/${project.id}/activity`, bob)).statusCode, 404);
    const restored = await f.call(path, alice, { action: 'restore', expectedRevision: 2 });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().archivedAt, null);
    // Even a space owner needs project manage permission.
    f.store.db
      .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
      .run(project.id, alice.user.id);
    assert.equal(
      (
        await f.call(path, alice, {
          action: 'archive',
          expectedRevision: 3,
          activeRunAction: 'keep',
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('归档活动摘要不泄露他人的私有任务，项目管理者不能借归档停止私有执行', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const task = await f.task(bob, project.id, '私有任务原文不可共享');
    // Persisted visibility fixture: no agent or credentials are used by this test.
    f.store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...task, visibility: 'private' }), task.id);
    const at = new Date().toISOString();
    const run: Run = {
      id: key(),
      taskId: task.id,
      state: 'running',
      observation: 'unknown',
      provider: 'native',
      requestedTool: 'claude-code',
      scenario: 'success',
      previousRunId: null,
      prompt: '私有运行材料',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, task.id, JSON.stringify(run));
    const activity = await f.call(`projects/${project.id}/activity`, alice);
    assert.equal(activity.statusCode, 200);
    assert.deepEqual(activity.json().activeRuns, []);
    assert.equal(activity.json().pendingContinuations, 0);
    assert.ok(!activity.body.includes(task.id) && !activity.body.includes(run.prompt));
    const res = await f.call(`projects/${project.id}/lifecycle`, alice, {
      action: 'archive',
      expectedRevision: 1,
      activeRunAction: 'stop',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await f.call(`tasks/${task.id}`, alice)).statusCode, 404);
    const own = await f.call(`tasks/${task.id}`, bob);
    assert.deepEqual(own.json().runs[0], run);
    assert.throws(
      () =>
        f.store.as({ user: bob.user, spaceId: bob.spaceId }, () =>
          f.store.projectLifecycle.assertExecution(task.id),
        ),
      code('PROJECT_ARCHIVED'),
    );
    await f.call(`projects/${project.id}/lifecycle`, alice, {
      action: 'restore',
      expectedRevision: 2,
    });
    assert.deepEqual((await f.call(`tasks/${task.id}`, bob)).json().runs[0], run);
  } finally {
    await f.close();
  }
});
