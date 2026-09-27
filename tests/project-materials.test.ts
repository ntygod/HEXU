import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainError } from '../packages/contracts/src/index.js';
import { parseNativeRunCreate, type NativeRunConfig } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import {
  appendProjectMaterials,
  parseProjectMaterialRefs,
  parseProjectMaterialPreview,
  parseProjectMaterialQuery,
  parseProjectMaterialSelection,
  type ProjectMaterialRef,
  type ProjectMaterialSnapshot,
} from '../packages/contracts/src/project-materials.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore, humanContextHash } from '../packages/db/src/continuations.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const code = (expected: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === expected;
function setup(store: Store) {
  const project = store.projects()[0]!,
    task = store.createTask(
      { projectId: project.id, title: '选材任务', description: '原任务说明' },
      randomUUID(),
    );
  const source = store.projectSources.create(
    project.id,
    { kind: 'text', title: '接口资料', content: '🙂\n当前接口说明\n' },
    randomUUID(),
  );
  const message = store.addMessage(task.id, '保留用户确认的规则', null, randomUUID()),
    preview = store.projectAgreements.preview(task.id, message.id);
  const agreement = store.projectAgreements.create(
    project.id,
    {
      title: '项目规则',
      content: '不改动旧接口',
      sourceTaskId: task.id,
      sourceMessageId: message.id,
      expectedSourceHash: preview.origin.hash,
    },
    randomUUID(),
  );
  const refs = parseProjectMaterialRefs([
    { kind: 'source', id: source.id, revision: 1, contentHash: source.contentHash },
    { kind: 'agreement', id: agreement.id, revision: 1, contentHash: agreement.contentHash },
  ]);
  const snapshot = store.projectMaterials.preview(task.id, refs),
    selection = { items: refs, expectedHash: snapshot.hash };
  const copy = store.registerWorkingCopy({
    id: randomUUID(),
    name: '无进程材料测试目录',
    root: '/fictional/materials/' + task.id,
    createdAt: new Date().toISOString(),
  });
  const body = {
    provider: 'native',
    requestedTool: 'claude-code',
    workingCopyId: copy.id,
    mode: 'read-only',
    prompt: '按所选材料处理',
    confirmExecution: true,
    expectedRevision: task.revision,
    expectedTaskContextHash: humanContextHash(store, task.id),
    projectMaterials: selection,
  };
  return { project, task, source, agreement, refs, snapshot, selection, copy, body };
}
function config(snapshot?: ProjectMaterialSnapshot, copy = 'test-copy'): NativeRunConfig {
  const contextText = appendProjectMaterials('原任务内容\n本次要求', snapshot);
  return {
    workingCopyId: copy,
    mode: 'read-only',
    model: null,
    maxTurns: 8,
    maxBudgetUsd: 1,
    timeoutSeconds: 30,
    toolVersion: 'no-process fixture',
    contextText,
    contextHash: createHash('sha256').update(contextText).digest('hex'),
  };
}

test('选材契约严格限定引用、版本、指纹和摘录，重复/过量/伪造正文与执行字段被拒绝', () => {
  const ref = { kind: 'source', id: 'source-a', revision: 1, contentHash: 'a'.repeat(64) };
  assert.deepEqual(parseProjectMaterialRefs([ref]), [{ ...ref, maxChars: 8000 }]);
  for (const value of [
    null,
    {},
    [ref, ref],
    Array.from({ length: 17 }, (_, n) => ({ ...ref, id: String(n) })),
    [{ ...ref, kind: 'file' }],
    [{ ...ref, revision: '1' }],
    [{ ...ref, contentHash: 'bad' }],
    [{ ...ref, maxChars: 0 }],
    [{ ...ref, maxChars: 1.5 }],
    [{ ...ref, maxChars: 8001 }],
    [{ ...ref, body: 'injected' }],
    [{ ...ref, projectId: 'foreign' }],
  ])
    assert.throws(() => parseProjectMaterialRefs(value), DomainError);
  assert.throws(
    () => parseProjectMaterialPreview({ items: [ref], root: '/etc' }),
    code('INVALID_INPUT'),
  );
  assert.throws(
    () =>
      parseProjectMaterialSelection({
        items: [ref],
        expectedHash: 'a'.repeat(64),
        context: 'fake',
      }),
    code('INVALID_INPUT'),
  );
  for (const query of [
    { limit: '51' },
    { limit: ['1'] },
    { cursor: ['foreign'] },
    { kind: 'native' },
    { q: 'x'.repeat(161) },
    { spaceId: 'other' },
  ])
    assert.throws(() => parseProjectMaterialQuery(query), code('INVALID_INPUT'));
});

test('预览确定性排序、真实版本、显式截断和已知密钥遮盖，链接只作引用且资料不被修改', () => {
  const store = new Store();
  try {
    const f = setup(store),
      snapshot = store.projectMaterials.preview(f.task.id, [...f.refs].reverse());
    assert.deepEqual(snapshot, f.snapshot);
    assert.equal(snapshot.items[0]!.reference.kind, 'agreement');
    assert.equal(snapshot.totalChars, snapshot.text.length);
    const one = store.projectMaterials.preview(f.task.id, [
      { ...f.refs.find((ref) => ref.kind === 'source')!, maxChars: 1 },
    ]);
    assert.equal(one.items[0]!.content, '');
    assert.equal(one.items[0]!.omittedChars, f.source.content.length);
    assert.ok(!one.text.includes('\uD83D'));
    const url = store.projectSources.create(
      f.project.id,
      {
        kind: 'link',
        title: '参考地址',
        url: 'https://example.invalid/doc',
        content: '密钥样例 sk-test-do-not-use-123456789012345',
      },
      'link',
    );
    const link = store.projectMaterials.preview(
      f.task.id,
      parseProjectMaterialRefs([
        { kind: 'source', id: url.id, revision: 1, contentHash: url.contentHash },
      ]),
    );
    assert.ok(link.text.includes('参考链接：https://example.invalid/doc'));
    assert.ok(link.text.includes('[REDACTED]'));
    assert.equal(link.items[0]!.redacted, true);
    assert.equal(store.projectSources.get(f.project.id, url.id).content, url.content);
    assert.equal(store.getTask(f.task.id).revision, f.task.revision);
    assert.equal(store.projectMaterials.prepare(f.task.id, f.selection)?.hash, f.snapshot.hash);
    assert.throws(
      () =>
        store.projectMaterials.prepare(f.task.id, { ...f.selection, expectedHash: 'a'.repeat(64) }),
      code('PROJECT_MATERIAL_CHANGED'),
    );
    const big = store.projectSources.create(
      f.project.id,
      { kind: 'text', title: '大资料', content: '字'.repeat(8000) },
      'big',
    );
    const another = store.projectSources.create(
      f.project.id,
      { kind: 'text', title: '大资料二', content: '另'.repeat(8000) },
      'big2',
    );
    const large = parseProjectMaterialRefs(
      [big, another].map((source) => ({
        kind: 'source',
        id: source.id,
        revision: source.revision,
        contentHash: source.contentHash,
      })),
    );
    assert.throws(() => store.projectMaterials.preview(f.task.id, large), code('MATERIAL_LIMIT'));
    const bounded = store.projectMaterials.preview(
      f.task.id,
      large.map((ref) => ({ ...ref, maxChars: 1000 })),
    );
    assert.ok(bounded.items.every((item) => item.omittedChars === 7000));
    assert.throws(() => appendProjectMaterials('x'.repeat(60000), bounded), code('MATERIAL_LIMIT'));
  } finally {
    store.close();
  }
});

test('原生 Run 原子绑定实际输入与快照；旧请求和资料编辑不回写记录，启动确认单独保存', () => {
  const store = new Store();
  try {
    const f = setup(store),
      input = parseNativeRunCreate(f.body),
      cfg = config(f.snapshot, f.copy.id),
      run = store.createNativeRun(f.task.id, input, cfg, 'run', undefined, f.snapshot);
    assert.ok(run.materialBundleId);
    const bundle = store.projectMaterials.runView(run.id);
    assert.equal(bundle.state, 'fixed');
    assert.equal(bundle.bundle!.snapshot.hash, f.snapshot.hash);
    assert.equal(bundle.bundle!.contextText, cfg.contextText);
    assert.equal(bundle.bundle!.startedAt, null);
    store.projectSources.edit(
      f.project.id,
      f.source.id,
      { expectedRevision: 1, title: f.source.title, content: '资料已更新', url: null },
      'edit',
    );
    assert.equal(
      store.createNativeRun(f.task.id, input, cfg, 'run', undefined, f.snapshot).id,
      run.id,
    );
    assert.deepEqual(store.projectMaterials.runView(run.id), bundle);
    assert.throws(
      () => store.projectMaterials.validateRun(run.id),
      code('PROJECT_MATERIAL_CHANGED'),
    );
    store.markMaterialsStarted(run.id);
    const observed = store.projectMaterials.runView(run.id);
    assert.equal(observed.state, 'started');
    assert.ok(observed.bundle!.startedAt);
    assert.deepEqual(observed.bundle!.snapshot, bundle.bundle!.snapshot);
    assert.equal(store.nativeLock(f.copy.id), run.id); // A record update is not termination evidence.
  } finally {
    store.close();
  }
});

test('原生运行的材料/锁/任务/回执失败共同回滚，未固定快照和陈旧人工材料不创建执行', () => {
  for (const stage of ['context_bundles', 'native_workspace_locks', 'idempotency_records']) {
    const store = new Store();
    try {
      const f = setup(store),
        input = parseNativeRunCreate(f.body),
        cfg = config(f.snapshot, f.copy.id),
        before = store.getTask(f.task.id),
        events = store.db.prepare('SELECT * FROM outbox').all();
      assert.throws(
        () => store.createNativeRun(f.task.id, input, cfg, 'missing'),
        code('MATERIAL_SNAPSHOT_INVALID'),
      );
      store.db.exec(
        `CREATE TRIGGER failure BEFORE INSERT ON ${stage} BEGIN SELECT RAISE(ABORT,'material fixture rollback'); END;`,
      );
      assert.throws(
        () => store.createNativeRun(f.task.id, input, cfg, 'retry', undefined, f.snapshot),
        /material fixture rollback/,
      );
      assert.equal(store.runs(f.task.id).length, 0);
      assert.equal(store.nativeLock(f.copy.id), null);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM context_bundles').get()!.n, 0);
      assert.deepEqual(store.getTask(f.task.id), before);
      assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), events);
      store.db.exec('DROP TRIGGER failure');
      store.addMessage(f.task.id, '新的人工要求', null, 'new-message');
      assert.throws(
        () => store.createNativeRun(f.task.id, input, cfg, 'retry', undefined, f.snapshot),
        code('CONTEXT_CHANGED'),
      );
      assert.equal(store.runs(f.task.id).length, 0);
      const updated = { ...input, expectedTaskContextHash: humanContextHash(store, f.task.id) };
      assert.ok(
        store.createNativeRun(f.task.id, updated, cfg, 'retry', undefined, f.snapshot)
          .materialBundleId,
      );
    } finally {
      store.close();
    }
  }
});

test('等待接续保存项目快照，旧回执不重新整理，所选版本变化使启动检查失败且不释放原锁', () => {
  const store = new Store();
  try {
    const f = setup(store),
      sourceInput = parseNativeRunCreate({
        ...f.body,
        projectMaterials: undefined,
        expectedTaskContextHash: undefined,
      }),
      source = store.createNativeRun(
        f.task.id,
        sourceInput,
        config(undefined, f.copy.id),
        'source',
      );
    const operations = new ContinuationStore(store),
      request = parseContinuation({
        ...f.body,
        sourceRunId: source.id,
        onActiveRun: 'wait',
        expectedRevision: store.getTask(f.task.id).revision,
        expectedTaskContextHash: humanContextHash(store, f.task.id),
      });
    let prepared = 0;
    const prepare = () => {
      prepared++;
      return store.projectMaterials.prepare(f.task.id, request.run.projectMaterials);
    };
    const op = operations.create(f.task.id, request, 'op', prepare);
    assert.ok(op.materialBundleId);
    const before = store.projectMaterials.get(f.task.id, op.materialBundleId!);
    assert.equal(before.contextText, null);
    assert.equal(before.runId, null);
    assert.equal(before.snapshot.hash, f.snapshot.hash);
    store.projectSources.create(
      f.project.id,
      { kind: 'text', title: '未选择的新资料', content: '不会悄悄加入' },
      'unselected',
    );
    operations.assertMaterials(op);
    store.projectAgreements.lifecycle(
      f.project.id,
      f.agreement.id,
      { expectedRevision: 1, action: 'deactivate' },
      'deactivate',
    );
    assert.equal(operations.create(f.task.id, request, 'op', prepare).id, op.id);
    assert.equal(prepared, 1);
    assert.throws(() => operations.assertMaterials(op), code('PROJECT_MATERIAL_CHANGED'));
    assert.deepEqual(store.projectMaterials.get(f.task.id, op.materialBundleId!), before);
    assert.equal(store.nativeLock(f.copy.id), source.id);
    assert.equal(store.runs(f.task.id).length, 1);
  } finally {
    store.close();
  }
});

test('选材 API 不跨项目/私有范围；目录可读不等于可执行，快照读取始终校验父任务', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id),
      other = await f.project(bob),
      foreignTask = await f.task(bob, other.id);
    const source = (
        await f.call(`projects/${project.id}/sources`, alice, {
          kind: 'text',
          title: '当前资料',
          content: '选材内容',
        })
      ).json(),
      foreign = (
        await f.call(`projects/${other.id}/sources`, bob, {
          kind: 'text',
          title: '不应枚举的资料',
          content: '私有项目内容',
        })
      ).json();
    const ref = { kind: 'source', id: source.id, revision: 1, contentHash: source.contentHash };
    const path = `tasks/${task.id}/project-materials`;
    assert.equal((await f.call(path, bob)).statusCode, 404);
    assert.equal(
      (await f.call(`tasks/${foreignTask.id}/project-materials`, alice)).statusCode,
      404,
    );
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    assert.equal((await f.call(path, bob)).json().items.length, 1);
    assert.equal((await f.call(path + '/preview', bob, { items: [ref] })).statusCode, 403);
    assert.equal(
      (
        await f.call(path + '/preview', alice, {
          items: [{ ...ref, id: foreign.id, contentHash: foreign.contentHash }],
        })
      ).statusCode,
      404,
    );
    const privateTask = await f.task(alice);
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/project-materials`, alice)).json().items.length,
      0,
    );
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/project-materials/preview`, alice, { items: [ref] }))
        .statusCode,
      409,
    );
    const snapshot = (await f.call(path + '/preview', alice, { items: [ref] })).json();
    const bundleId = f.store.as(alice, () =>
      f.store.atomic(() =>
        f.store.projectMaterials.bindOperation(task.id, 'test-operation', snapshot),
      ),
    );
    assert.equal(
      (await f.call(`tasks/${task.id}/material-bundles/${bundleId}`, bob)).statusCode,
      200,
    );
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/material-bundles/${bundleId}`, alice)).statusCode,
      404,
    );
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null });
    assert.equal(
      (await f.call(`tasks/${task.id}/material-bundles/${bundleId}`, bob)).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('模拟入口不吞掉模型选材参数，历史未记录保持未知而非补造快照，SQLite 重启保留固定内容', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hexu-materials-')),
    path = join(directory, 'workspace.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    const f = setup(store),
      legacy = store.createNativeRun(
        f.task.id,
        parseNativeRunCreate({
          ...f.body,
          projectMaterials: undefined,
          expectedTaskContextHash: undefined,
        }),
        config(undefined, f.copy.id),
        'legacy',
      );
    assert.equal(store.projectMaterials.runView(legacy.id).state, 'unrecorded');
    store.finishNativeRun(legacy.id, 'cancelled', 'fixture no process', true);
    const body = parseNativeRunCreate({
      ...f.body,
      expectedRevision: store.getTask(f.task.id).revision,
    });
    const run = store.createNativeRun(
      f.task.id,
      body,
      config(f.snapshot, f.copy.id),
      'with-materials',
      undefined,
      f.snapshot,
    );
    const before = store.projectMaterials.runView(run.id);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.projectMaterials.runView(run.id), before);
    const app = await createApp({ store, native: { enabled: false, roots: [] } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${f.task.id}/runs`,
      headers: { 'x-hexu-client': 'web', 'idempotency-key': 'mock' },
      payload: {
        provider: 'mock',
        requestedTool: 'codex',
        scenario: 'success',
        expectedRevision: store.getTask(f.task.id).revision,
        projectMaterials: f.selection,
      },
    });
    assert.equal(response.statusCode, 422);
    await app.close();
    store = undefined;
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
