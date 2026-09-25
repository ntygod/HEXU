import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import {
  parseContinuation,
  type ContinuationOperation,
} from '../packages/contracts/src/continuation.js';
import {
  parseNativeRunCreate,
  type NativeRunConfig,
  type NativeOverview,
} from '../packages/contracts/src/native.js';
import { DomainError, type Run } from '../packages/contracts/src/index.js';
import { NativeRuntime } from '../apps/runner/src/runtime.js';
import { ContinuationCoordinator } from '../apps/runner/src/continuations.js';
import { createApp } from '../apps/control/src/app.js';

const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await pause();
  }
  throw new Error('Protocol-fixture operation did not settle');
}
function example(store: Store) {
  const task = store.createTask(
    { title: 'Operation fixture', description: '', projectId: null },
    randomUUID(),
  );
  const copy = store.registerWorkingCopy({
    id: randomUUID(),
    name: 'fixture',
    root: '/fixture/isolated-repository',
    createdAt: new Date().toISOString(),
  });
  const initial = parseNativeRunCreate({
    provider: 'native',
    requestedTool: 'claude-code',
    workingCopyId: copy.id,
    prompt: 'fixture',
    confirmExecution: true,
    expectedRevision: task.revision,
  });
  const config: NativeRunConfig = {
    workingCopyId: copy.id,
    mode: 'read-only',
    model: null,
    maxTurns: 8,
    maxBudgetUsd: 1,
    timeoutSeconds: 300,
    toolVersion: 'fixture',
    contextText: 'fixture',
    contextHash: 'fixture',
  };
  const source = store.createNativeRun(task.id, initial, config, randomUUID());
  store.finishNativeRun(source.id, 'succeeded', 'fixture completion; no process or model', true);
  const body = {
    ...initial,
    model: '',
    requestedTool: 'codex',
    sourceRunId: source.id,
    confirmExecution: true,
    expectedRevision: store.getTask(task.id).revision,
    onActiveRun: 'wait',
    prompt: 'retained follow-up',
  };
  return { task, copy, source, config, body, input: parseContinuation(body) };
}

test('接续必须有来源、明确停止策略与费用授权', () => {
  const store = new Store();
  try {
    const f = example(store);
    for (const change of [
      { sourceRunId: null },
      { onActiveRun: undefined },
      { confirmExecution: false },
    ])
      assert.throws(() => parseContinuation({ ...f.body, ...change }), DomainError);
  } finally {
    store.close();
  }
});

test('重复提交返回同一接续的最新状态，同键不同内容冲突', () => {
  const store = new Store();
  try {
    const f = example(store),
      records = new ContinuationStore(store),
      key = randomUUID();
    const op = records.create(f.task.id, f.input, key);
    records.cancel(op.id, op.revision, 'cancel');
    const replay = records.create(f.task.id, f.input, key);
    assert.equal(replay.id, op.id);
    assert.equal(replay.state, 'cancelled');
    assert.throws(
      () =>
        records.create(
          f.task.id,
          { ...f.input, run: { ...f.input.run, prompt: 'different' } },
          key,
        ),
      /相同操作标识/,
    );
    assert.equal(records.list(f.task.id).length, 1);
  } finally {
    store.close();
  }
});

test('待接续预约阻止重复、模拟启动和其他任务抢占同一目录', () => {
  const store = new Store();
  try {
    const f = example(store),
      records = new ContinuationStore(store);
    records.create(f.task.id, f.input, 'first');
    assert.throws(() => records.create(f.task.id, f.input, 'second'), /已有待接续/);
    assert.throws(
      () =>
        store.createRun(
          f.task.id,
          {
            provider: 'mock',
            requestedTool: 'codex',
            scenario: 'success',
            prompt: '',
            expectedRevision: store.getTask(f.task.id).revision,
            reopenTask: false,
          },
          'mock',
        ),
      /已有待接续/,
    );
    const other = store.createTask({ title: 'other', description: '', projectId: null }, 'other');
    assert.throws(
      () =>
        store.createNativeRun(
          other.id,
          { ...f.input.run, sourceRunId: null, expectedRevision: other.revision },
          f.config,
          'other-run',
        ),
      /已有待接续/,
    );
  } finally {
    store.close();
  }
});

test('准备期间取消后，最后一次原子检查阻止创建 Run', () => {
  const store = new Store();
  try {
    const f = example(store),
      records = new ContinuationStore(store);
    const op = records.create(f.task.id, f.input, 'first');
    const preparing = records.transition(op.id, 'preparing');
    records.cancel(op.id, preparing.revision, 'cancel');
    assert.throws(
      () => store.createNativeRun(f.task.id, f.input.run, f.config, 'next', op.id),
      /已取消或状态改变/,
    );
    assert.equal(store.runs(f.task.id).length, 1);
    assert.equal(store.nativeLock(f.copy.id), null);
  } finally {
    store.close();
  }
});

test('Run、目录锁、幂等记录和 Operation 关联在故障下共同回滚', () => {
  const store = new Store();
  try {
    const f = example(store),
      records = new ContinuationStore(store);
    const op = records.create(f.task.id, f.input, 'first');
    records.transition(op.id, 'preparing');
    store.db.exec(
      "CREATE TRIGGER fixture_link_failure BEFORE UPDATE ON continuation_operations WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'fixture link failure'); END;",
    );
    assert.throws(
      () => store.createNativeRun(f.task.id, f.input.run, f.config, 'next', op.id),
      /fixture link failure/,
    );
    assert.equal(store.runs(f.task.id).length, 1);
    assert.equal(store.nativeLock(f.copy.id), null);
    assert.equal(records.get(op.id).state, 'preparing');
    store.db.exec('DROP TRIGGER fixture_link_failure;');
    const run = store.createNativeRun(f.task.id, f.input.run, f.config, 'next', op.id);
    assert.equal(records.get(op.id).runId, run.id);
    assert.equal(records.get(op.id).state, 'succeeded');
    assert.equal(store.replayNativeRun(f.task.id, f.input.run, 'next')?.id, run.id);
    assert.throws(
      () => records.cancel(op.id, records.get(op.id).revision, 'cancel'),
      /新执行已经创建/,
    );
  } finally {
    store.close();
  }
});

test('真正启动前再次核对任务修订、人工讨论与取消状态', () => {
  for (const change of ['task', 'discussion'] as const) {
    const store = new Store();
    try {
      const f = example(store),
        records = new ContinuationStore(store);
      const op = records.create(f.task.id, f.input, 'first');
      records.transition(op.id, 'preparing');
      if (change === 'task')
        store.patchTask(
          f.task.id,
          { expectedRevision: store.getTask(f.task.id).revision, description: 'new requirements' },
          'edit',
        );
      else store.addMessage(f.task.id, 'new human requirement', null, 'message');
      assert.throws(
        () => store.createNativeRun(f.task.id, f.input.run, f.config, 'next', op.id),
        DomainError,
      );
      assert.equal(store.runs(f.task.id).length, 1);
    } finally {
      store.close();
    }
  }
});

test('重启保留接续要求，但不自动重试待启动的付费执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-operation-restart-'));
  let store = new Store(join(dir, 'preview.sqlite'));
  try {
    const f = example(store),
      records = new ContinuationStore(store);
    const op = records.create(f.task.id, f.input, 'first');
    records.transition(op.id, 'preparing');
    store.close();
    store = new Store(join(dir, 'preview.sqlite'));
    const reopened = new ContinuationStore(store);
    reopened.recover();
    assert.equal(reopened.get(op.id).state, 'needs_attention');
    assert.equal(reopened.get(op.id).blockers[0]?.code, 'SERVICE_RESTARTED');
    assert.equal(reopened.get(op.id).input.run.prompt, 'retained follow-up');
    assert.equal(reopened.pending().length, 0);
    assert.equal(store.runs(f.task.id).length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('过期接续不会启动，允许显式重新配置', async () => {
  const store = new Store(),
    native = new NativeRuntime(store);
  const coordinator = new ContinuationCoordinator(store, native, false);
  try {
    const f = example(store);
    const op = coordinator.create(f.task.id, f.input, 'first');
    store.db
      .prepare('UPDATE continuation_operations SET body=? WHERE id=?')
      .run(JSON.stringify({ ...op, expiresAt: '2000-01-01T00:00:00.000Z' }), op.id);
    await coordinator.tick();
    assert.equal(coordinator.records.get(op.id).blockers[0]?.code, 'CONTINUATION_EXPIRED');
    assert.equal(store.runs(f.task.id).length, 1);
    assert.notEqual(coordinator.create(f.task.id, f.input, 'retry').id, op.id);
  } finally {
    await coordinator.close();
    store.close();
  }
});

async function environment(disableCodex = false) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-continuation-api-')),
    root = join(dir, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'fictional operation fixture\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'init',
  ]);
  const executable = async (name: string, file: string) => {
    const path = join(dir, name);
    await writeFile(
      path,
      `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/' + file + '.js')).href)});\n`,
    );
    await chmod(path, 0o700);
    return path;
  };
  const store = new Store(join(dir, 'preview.sqlite'));
  const app = await createApp({
    store,
    native: {
      enabled: true,
      roots: [root],
      claudeExecutable: await executable('claude-fixture', 'native-tool'),
      apiKey: 'sk-ant-protocol-fixture-not-a-real-key',
      codexExecutable: disableCodex
        ? join(dir, 'missing-codex')
        : await executable('codex-fixture', 'codex-tool'),
      codexApiKey: 'sk-openai-protocol-fixture-not-a-real-key',
    },
  });
  const overview = (await app.inject({ url: '/api/v1/native' })).json() as NativeOverview;
  const task = store.createTask(
    { title: 'Stop then continue fixture', description: '', projectId: null },
    randomUUID(),
  );
  const body = (tool = 'claude-code', prompt = 'FIXTURE_HANG') => ({
    provider: 'native',
    requestedTool: tool,
    prompt,
    workingCopyId: overview.workspaces[0]!.id,
    mode: 'edit',
    confirmExecution: true,
    expectedRevision: store.getTask(task.id).revision,
  });
  const post = (path: string, payload: unknown, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/' + path,
      headers: { 'x-hexu-client': 'web', 'idempotency-key': key },
      payload: payload as Record<string, unknown>,
    });
  const getOp = async (id: string) =>
    (await app.inject({ url: `/api/v1/operations/${id}` })).json() as ContinuationOperation;
  const waitOp = (id: string) =>
    until(
      () => getOp(id),
      (o) => !['waiting_for_stop', 'preparing'].includes(o.state),
    );
  const start = async (prompt = 'FIXTURE_HANG') => {
    const response = await post(`tasks/${task.id}/runs`, body('claude-code', prompt));
    assert.equal(response.statusCode, 201);
    return until(
      () => store.run(response.json().id),
      (r) => r.state === 'running',
    );
  };
  return {
    store,
    app,
    task,
    root,
    body,
    post,
    start,
    getOp,
    waitOp,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('202 接续实际停止 Claude fixture 后启动 Codex，保留文件且重放不重复调用', async () => {
  const f = await environment();
  try {
    const source = await f.start();
    await writeFile(join(f.root, 'native-output.txt'), 'retained dirty file\n');
    const input = {
      ...f.body('codex', 'CODEX_WRITE'),
      sourceRunId: source.id,
      onActiveRun: 'request_stop',
    };
    const key = randomUUID();
    const response = await f.post(`tasks/${f.task.id}/continuations`, input, key);
    assert.equal(response.statusCode, 202);
    assert.equal(response.headers.location, `/api/v1/operations/${response.json().id}`);
    const op = await f.waitOp(response.json().id);
    assert.equal(op.state, 'succeeded', JSON.stringify(op.blockers));
    const target = await until(
      () => f.store.run(op.runId!),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state),
    );
    assert.equal(target.state, 'succeeded');
    const stopped = f.store.run(source.id);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.native?.terminationConfirmed, true);
    assert.ok(target.createdAt >= stopped.updatedAt);
    assert.equal(target.previousRunId, source.id);
    assert.equal(target.native?.workingCopyId, source.native?.workingCopyId);
    assert.equal(
      await readFile(join(f.root, 'codex-output.txt'), 'utf8'),
      'fixture continued\nretained dirty file\n',
    );
    const replay = await f.post(`tasks/${f.task.id}/continuations`, input, key);
    assert.equal(replay.json().id, op.id);
    assert.equal(replay.json().runId, target.id);
    assert.equal(replay.json().state, 'succeeded');
    assert.equal(await readFile(join(f.root, 'codex-count.txt'), 'utf8'), 'one invocation\n');
    assert.equal(
      (await f.app.inject({ url: `/api/v1/tasks/${f.task.id}/continuations` })).json().items[0].id,
      op.id,
    );
    const cancelled = await f.post(`operations/${op.id}/cancel`, { expectedRevision: op.revision });
    assert.equal(cancelled.statusCode, 409);
  } finally {
    await f.close();
  }
});

test('等待不打断原执行；刷新读取、取消和重复取消均不会启动目标', async () => {
  const f = await environment();
  try {
    const source = await f.start();
    const response = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'CODEX_WRITE'),
      sourceRunId: source.id,
      onActiveRun: 'wait',
    });
    await pause(300);
    const op = await f.getOp(response.json().id);
    assert.equal(op.state, 'waiting_for_stop');
    assert.equal(f.store.run(source.id).state, 'running');
    const conflict = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'other'),
      sourceRunId: source.id,
      onActiveRun: 'wait',
    });
    assert.equal(conflict.statusCode, 409);
    const key = randomUUID();
    assert.equal(
      (await f.post(`operations/${op.id}/cancel`, { expectedRevision: op.revision }, key)).json()
        .state,
      'cancelled',
    );
    assert.equal(
      (await f.post(`operations/${op.id}/cancel`, { expectedRevision: op.revision }, key)).json()
        .state,
      'cancelled',
    );
    await f.post(`runs/${source.id}/stop`, {});
    await until(
      () => f.store.run(source.id),
      (r) => r.state === 'cancelled',
    );
    await pause(250);
    assert.equal(f.store.runs(f.task.id).length, 1);
  } finally {
    await f.close();
  }
});

test('等待期间新增人工要求转为需要处理，不自动发送变化材料', async () => {
  const f = await environment();
  try {
    const source = await f.start();
    const response = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'keep this request'),
      sourceRunId: source.id,
      onActiveRun: 'wait',
    });
    f.store.addMessage(f.task.id, 'changed human requirement', null, randomUUID());
    const op = await f.waitOp(response.json().id);
    assert.equal(op.state, 'needs_attention');
    assert.equal(op.blockers[0]?.code, 'CONTEXT_CHANGED');
    assert.equal(op.input.run.prompt, 'keep this request');
    assert.equal(f.store.run(source.id).state, 'running');
    assert.equal(f.store.runs(f.task.id).length, 1);
  } finally {
    await f.close();
  }
});

test('目标工具不可用时不先停止原执行，也不静默切换工具', async () => {
  const f = await environment(true);
  try {
    const source = await f.start();
    const response = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'continue'),
      sourceRunId: source.id,
      onActiveRun: 'request_stop',
    });
    const op = await f.waitOp(response.json().id);
    assert.equal(op.state, 'needs_attention');
    assert.equal(op.blockers[0]?.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(f.store.run(source.id).state, 'running');
    assert.equal(f.store.runs(f.task.id).length, 1);
  } finally {
    await f.close();
  }
});

test('未知原进程状态保持实际目录锁，不发停止信号或启动目标', async () => {
  const store = new Store(),
    native = new NativeRuntime(store);
  const coordinator = new ContinuationCoordinator(store, native, false);
  try {
    const f = example(store);
    const old = store.run(f.source.id);
    store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(
      JSON.stringify({
        ...old,
        state: 'stopping',
        observation: 'unknown',
        native: { ...old.native, terminationConfirmed: false, recoveryRequired: true },
      }),
      old.id,
    );
    store.db.prepare('INSERT INTO native_workspace_locks VALUES(?,?)').run(f.copy.id, old.id);
    const op = coordinator.create(f.task.id, f.input, 'first');
    await coordinator.tick();
    assert.equal(coordinator.records.get(op.id).blockers[0]?.code, 'SOURCE_STATE_UNKNOWN');
    assert.equal(store.nativeLock(f.copy.id), old.id);
    assert.equal(store.runs(f.task.id).length, 1);
  } finally {
    await coordinator.close();
    store.close();
  }
});

test('自然结束策略不发停止请求，原执行成功后接续且不改任务完成状态', async () => {
  const f = await environment();
  try {
    const source = await f.start('FIXTURE_DELAY');
    const response = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'CODEX_WRITE'),
      sourceRunId: source.id,
      onActiveRun: 'wait',
    });
    assert.equal(response.statusCode, 202);
    assert.equal((await f.getOp(response.json().id)).state, 'waiting_for_stop');
    const op = await f.waitOp(response.json().id);
    assert.equal(op.state, 'succeeded', JSON.stringify(op.blockers));
    const original = f.store.run(source.id);
    assert.equal(original.state, 'succeeded');
    assert.equal(original.native?.terminationConfirmed, true);
    const target = await until(
      () => f.store.run(op.runId!),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state),
    );
    assert.equal(target.state, 'succeeded');
    assert.ok(target.createdAt >= original.updatedAt);
    assert.equal(f.store.getTask(f.task.id).status, 'in_progress');
  } finally {
    await f.close();
  }
});
