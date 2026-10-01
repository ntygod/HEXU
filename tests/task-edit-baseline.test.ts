import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { parseProjectMaterialRefs } from '../packages/contracts/src/project-materials.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { NextInputs } from '../packages/db/src/next-inputs.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const headers = (key: string = randomUUID()) => ({
  'content-type': 'application/json',
  'x-hexu-client': 'web',
  'idempotency-key': key,
});
function task(store: Store) {
  return store.createTask(
    { title: '编辑基线', description: '原说明', projectId: store.projects()[0]!.id },
    randomUUID(),
  );
}
function snapshot(store: Store, except: string[] = []) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables
      .filter(({ name }) => !except.includes(name))
      .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
  );
}

test('任务内容编辑只写Task、通知和原回执，保留执行、等待接续、材料及下一轮要求', () => {
  const store = new Store();
  try {
    const original = task(store);
    store.addMessage(original.id, '原讨论', null, 'message');
    store.createResult(original.id, '原成果', '固定成果内容', 'result');
    const source = store.projectSources.create(
      original.projectId!,
      { kind: 'text', title: '原资料', content: '已确认的固定材料' },
      'source',
    );
    const refs = parseProjectMaterialRefs([
      { kind: 'source', id: source.id, revision: source.revision, contentHash: source.contentHash },
    ]);
    const materials = store.projectMaterials.preview(original.id, refs);
    const copy = store.registerWorkingCopy({
      id: randomUUID(),
      name: '无进程编辑测试目录',
      root: '/fictional/task-edit',
      createdAt: new Date().toISOString(),
    });
    const input = {
      provider: 'native',
      requestedTool: 'claude-code',
      workingCopyId: copy.id,
      prompt: '原执行输入',
      confirmExecution: true,
      expectedRevision: original.revision,
      projectMaterials: { items: refs, expectedHash: materials.hash },
    };
    const run = store.createNativeRun(
      original.id,
      parseNativeRunCreate(input),
      {
        workingCopyId: copy.id,
        mode: 'read-only',
        model: null,
        maxTurns: 8,
        maxBudgetUsd: 1,
        timeoutSeconds: 30,
        toolVersion: 'no-process fixture',
        contextText: '原说明和冻结材料',
        contextHash: 'fixture',
      },
      'run',
      undefined,
      materials,
    );
    const operations = new ContinuationStore(store);
    const operation = operations.create(
      original.id,
      parseContinuation({
        ...input,
        sourceRunId: run.id,
        expectedRevision: store.getTask(original.id).revision,
        onActiveRun: 'wait',
        prompt: '已确认的下一轮输入',
      }),
      'operation',
      () => materials,
    );
    assert.ok(operation.materialBundleId);
    const nextInputs = new NextInputs(store);
    store.atomic(() => nextInputs.insertQueued(original.id, run.id, '保留待用要求'));
    const before = store.getTask(original.id);
    const unaffected = snapshot(store, ['tasks', 'outbox', 'idempotency_records']);
    const events = store.events(0).cursor;
    const next = store.patchTask(
      original.id,
      {
        expectedRevision: before.revision,
        title: '新标题',
        description: '新说明',
        attention: '等反馈',
      },
      'edit',
    );
    assert.deepEqual(
      {
        ...next,
        title: before.title,
        description: before.description,
        attention: before.attention,
        revision: before.revision,
        updatedAt: before.updatedAt,
      },
      before,
    );
    assert.equal(next.revision, before.revision + 1);
    assert.equal(next.title, '新标题');
    assert.equal(next.description, '新说明');
    assert.equal(next.attention, '等反馈');
    assert.deepEqual(snapshot(store, ['tasks', 'outbox', 'idempotency_records']), unaffected);
    assert.deepEqual(
      store.events(events).events.map((event) => [event.taskId, event.kind]),
      [[original.id, 'task.updated']],
    );
    assert.deepEqual(
      JSON.parse(
        store.db.prepare("SELECT result FROM idempotency_records WHERE key='edit'").get()!
          .result as string,
      ),
      next,
    );
  } finally {
    store.close();
  }
});

test('同修订并发只接受一次，重复/旧回执保持原Task内容和修订，不回写较新的编辑', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const original = task(store);
    const path = `/api/v1/tasks/${original.id}`;
    const patch = (title: string, expectedRevision: number, key: string) =>
      app.inject({
        method: 'PATCH',
        url: path,
        headers: headers(key),
        payload: { title, expectedRevision },
      });
    const replies = await Promise.all([patch('第一份', 1, 'a'), patch('第二份', 1, 'b')]);
    assert.deepEqual(replies.map((reply) => reply.statusCode).sort(), [200, 409]);
    const winnerIndex = replies.findIndex((reply) => reply.statusCode === 200);
    const receipt = replies[winnerIndex]!.json();
    const key = winnerIndex === 0 ? 'a' : 'b';
    const afterSave = snapshot(store);
    assert.deepEqual((await patch(receipt.title, 1, key)).json(), receipt);
    assert.deepEqual(snapshot(store), afterSave);
    assert.equal((await patch('第三份', 2, 'c')).statusCode, 200);
    const afterLaterEdit = snapshot(store);
    assert.deepEqual((await patch(receipt.title, 1, key)).json(), receipt);
    assert.equal((await patch('不同内容', 1, key)).json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await patch('旧基线', 1, 'stale')).json().error.code, 'REVISION_CONFLICT');
    assert.deepEqual(snapshot(store), afterLaterEdit);
    assert.equal(store.getTask(original.id).title, '第三份');
  } finally {
    await app.close();
  }
});

test('内容、通知或回执任一步故障全部回滚，原标识可安全重试', () => {
  for (const [table, operation] of [
    ['tasks', 'UPDATE'],
    ['outbox', 'INSERT'],
    ['idempotency_records', 'INSERT'],
  ]) {
    const store = new Store();
    try {
      const original = task(store);
      const before = snapshot(store);
      const payload = { expectedRevision: original.revision, title: '完整保存' };
      store.db.exec(
        `CREATE TRIGGER break_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`,
      );
      assert.throws(() => store.patchTask(original.id, payload, 'retry'), /fixture rollback/);
      assert.deepEqual(snapshot(store), before);
      store.db.exec('DROP TRIGGER break_write');
      assert.equal(store.patchTask(original.id, payload, 'retry').revision, 2);
    } finally {
      store.close();
    }
  }
});

test('SQLite重启后仍返回原内容回执，归档项目允许人工编辑且不恢复执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-task-edit-'));
  const path = join(dir, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const original = task(store);
    const project = store.project(original.projectId!);
    store.projectLifecycle.change(
      project.id,
      {
        action: 'archive',
        expectedRevision: project.revision,
        activeRunAction: 'keep',
      },
      'archive',
    );
    const payload = {
      expectedRevision: original.revision,
      description: '归档后的人工作业',
      attention: '',
    };
    const receipt = store.patchTask(original.id, payload, 'original');
    store.patchTask(
      original.id,
      { expectedRevision: receipt.revision, description: '', attention: null },
      'later',
    );
    store.close();
    store = new Store(path);
    const before = snapshot(store);
    assert.deepEqual(store.patchTask(original.id, payload, 'original'), receipt);
    assert.deepEqual(snapshot(store), before);
    assert.equal(store.getTask(original.id).description, '');
    assert.equal(store.getTask(original.id).attention, null);
    assert.ok(store.project(project.id).archivedAt);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP严格限制编辑字段、类型、修订和字符长度，拒绝时不产生任何写入', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const original = task(store);
    const payloads = [
      null,
      [],
      {},
      { expectedRevision: '1' },
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { expectedRevision: 1, title: '' },
      { expectedRevision: 1, title: '字'.repeat(161) },
      { expectedRevision: 1, description: '字'.repeat(12001) },
      { expectedRevision: 1, attention: '字'.repeat(301) },
      { expectedRevision: 1, title: null },
      { expectedRevision: 1, description: null },
      { expectedRevision: 1, attention: 2 },
      ...[
        'id',
        'spaceId',
        'projectId',
        'visibility',
        'ownerUserId',
        'createdByUserId',
        'status',
        'access',
        'participantUserIds',
        'run',
        'operation',
        'command',
        'revision',
        'updatedAt',
      ].map((field) => ({ expectedRevision: 1, title: '不可写入', [field]: 'forged' })),
    ];
    const before = snapshot(store);
    for (const payload of payloads) {
      const reply = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${original.id}`,
        headers: headers(),
        payload: JSON.stringify(payload),
      });
      assert.equal(reply.statusCode, 400, reply.body);
      assert.deepEqual(snapshot(store), before);
    }
    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${original.id}`,
      headers: headers(),
      payload: { expectedRevision: 1, title: ' 新标题 ', description: '  ', attention: null },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().title, '新标题');
    assert.equal(saved.json().description, '');
    assert.equal(saved.json().attention, null);
  } finally {
    await app.close();
  }
});

test('真实HTTP接受最大原文及JSON转义中文，任务PATCH使用96KiB预算且不扩大其他路由', async () => {
  const store = new Store();
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  try {
    const original = task(store);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/tasks/${original.id}`;
    for (const escaped of [false, true]) {
      const payload = {
        expectedRevision: store.getTask(original.id).revision,
        title: '题'.repeat(160),
        description: '文'.repeat(12000),
        attention: '等'.repeat(300),
      };
      const raw = JSON.stringify(payload);
      const body = escaped
        ? raw.replace(/[\u4e00-\u9fff]/g, (value) => `\\u${value.charCodeAt(0).toString(16)}`)
        : raw;
      assert.ok(Buffer.byteLength(body) > 32768);
      assert.ok(Buffer.byteLength(body) < 96 * 1024);
      const response = await fetch(origin + path, { method: 'PATCH', headers: headers(), body });
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as Record<string, unknown>;
      assert.equal(result.title, payload.title);
      assert.equal(result.description, payload.description);
      assert.equal(result.attention, payload.attention);
    }
    const body = JSON.stringify({
      expectedRevision: store.getTask(original.id).revision,
      title: '精确字节边界',
    });
    const exactLimit = body + ' '.repeat(96 * 1024 - Buffer.byteLength(body));
    assert.equal(Buffer.byteLength(exactLimit), 96 * 1024);
    const accepted = await fetch(origin + path, {
      method: 'PATCH',
      headers: headers(),
      body: exactLimit,
    });
    assert.equal(accepted.status, 200, await accepted.text());
    const before = snapshot(store);
    const rejected = await fetch(origin + path, {
      method: 'PATCH',
      headers: headers(),
      body: exactLimit + ' ',
    });
    assert.equal(rejected.status, 413, await rejected.text());
    assert.deepEqual(snapshot(store), before);
    const otherBody = JSON.stringify({ name: '正常项目' });
    const otherRoute = await fetch(`${origin}/api/v1/spaces/${store.spaceId}/projects`, {
      method: 'POST',
      headers: headers(),
      body: otherBody + ' '.repeat(32769 - Buffer.byteLength(otherBody)),
    });
    assert.equal(otherRoute.status, 413, await otherRoute.text());
    assert.deepEqual(snapshot(store), before);
  } finally {
    await app.close();
  }
});

test('当前访问权限决定新编辑和旧回执，空间所有者不继承他人的项目或私有Task', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(bob);
    const original = await f.task(bob, project.id);
    const privateTask = await f.task(bob);
    const payload = { expectedRevision: 1, title: '授权编辑' };
    const patch = (id: string, account = alice, key: string = randomUUID()) =>
      f.call(`tasks/${id}`, account, payload, key, 'PATCH');
    let before = snapshot(f.store);
    assert.equal((await patch(original.id)).statusCode, 404);
    assert.equal((await patch(privateTask.id)).statusCode, 404);
    assert.deepEqual(snapshot(f.store), before);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const receipt = await patch(original.id, alice, 'authorized');
    assert.equal(receipt.statusCode, 200, receipt.body);
    before = snapshot(f.store);
    assert.deepEqual((await patch(original.id, alice, 'authorized')).json(), receipt.json());
    assert.equal(
      (await patch(original.id, { ...alice, spaceId: `personal-${alice.user.id}` }, 'authorized'))
        .statusCode,
      404,
    );
    assert.deepEqual(snapshot(f.store), before);
    for (const [role, status] of [
      ['view', 403],
      [null, 404],
    ] as const) {
      await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role });
      before = snapshot(f.store);
      for (const key of ['authorized', randomUUID()])
        assert.equal((await patch(original.id, alice, key)).statusCode, status);
      assert.deepEqual(snapshot(f.store), before);
    }
  } finally {
    await f.close();
  }
});

test('进入事务后重新验证Task编辑权，降权或撤权均阻止新写入及旧回执', async (t) => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const original = await f.task(alice, project.id);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const payload = { expectedRevision: 1, title: '原回执内容' };
    assert.equal(
      (await f.call(`tasks/${original.id}`, bob, payload, 'original', 'PATCH')).statusCode,
      200,
    );
    const mutate = f.store.mutate.bind(f.store);
    let revoke = false;
    t.mock.method(
      f.store,
      'mutate',
      <T>(
        scope: string,
        key: string,
        data: unknown,
        action: () => T,
        beforeReplay?: () => void,
        onReplay?: (result: T) => T,
      ): T =>
        mutate(
          scope,
          key,
          data,
          action,
          () => {
            if (revoke)
              f.store.db
                .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
                .run(project.id, bob.user.id);
            else
              f.store.db
                .prepare(
                  "UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?",
                )
                .run(project.id, bob.user.id);
            beforeReplay?.();
          },
          onReplay,
        ),
    );
    const before = snapshot(f.store);
    for (const removed of [false, true]) {
      revoke = removed;
      for (const key of ['original', randomUUID()]) {
        const response = await f.call(
          `tasks/${original.id}`,
          bob,
          key === 'original' ? payload : { expectedRevision: 2, title: '不应写入' },
          key,
          'PATCH',
        );
        assert.equal(response.statusCode, removed ? 404 : 403, response.body);
        assert.deepEqual(snapshot(f.store), before);
      }
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
