import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, type Message, type Task } from '../packages/contracts/src/index.js';
import {
  composeDraftAdoption,
  parseDraftAdoption,
  parseDraftCreate,
  parseDraftEdit,
  parseDraftPageQuery,
  selectedDraftText,
  type AiDraft,
} from '../packages/contracts/src/ai-drafts.js';
import { parseNativeRunCreate } from '../packages/contracts/src/native.js';
import { parseContinuation } from '../packages/contracts/src/continuation.js';
import { Store } from '../packages/db/src/store.js';
import { ContinuationStore } from '../packages/db/src/continuations.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';
const code = (name: string) => (cause: unknown) =>
  cause instanceof DomainError && cause.code === name;
const pageQuery = { limit: 50, cursor: null };
function agent(store: Store, taskId: string, body = '采用第一段\n保留第二段\n采用第三段') {
  const message: Message = {
    id: randomUUID(),
    taskId,
    actorType: 'agent',
    actorName: '协议测试 AI 建议',
    body,
    resultId: null,
    createdAt: new Date().toISOString(),
  };
  store.db
    .prepare('INSERT INTO messages VALUES(?,?,?)')
    .run(message.id, taskId, JSON.stringify(message));
  return message;
}
function setup(store: Store, projectId: string | null = store.projects()[0]!.id) {
  const task = store.createTask(
    { title: '草稿采用', description: '原任务说明', projectId },
    randomUUID(),
  );
  const message = agent(store, task.id);
  const input = {
    sourceMessageId: message.id,
    expectedSourceHash: store.aiDrafts.preview(task.id, message.id).origin.hash,
    title: '待决定的 AI 说明',
    content: message.body,
  };
  const draft = store.aiDrafts.create(task.id, input, randomUUID());
  return { task, message, input, draft };
}
function adopt(draft: AiDraft, task: Task) {
  return {
    expectedRevision: draft.revision,
    ranges: [
      { start: 0, end: 5 },
      { start: 12, end: 17 },
    ],
    mode: 'append',
    target: { kind: 'task', id: task.id, expectedRevision: task.revision },
  };
}

test('草稿严格契约拒绝权限/来源注入、越界重叠与拆开字符，采用预算保留全部所选片段', () => {
  const input = {
    sourceMessageId: 'message',
    expectedSourceHash: 'a'.repeat(64),
    title: '说明',
    content: '  原文\n',
  };
  assert.equal(parseDraftCreate(input).content, input.content);
  for (const change of [
    { sourceTaskId: 'foreign' },
    { origin: {} },
    { status: 'published' },
    { createdByUserId: 'other' },
    { content: 'x'.repeat(12001) },
    { content: '' },
    { expectedSourceHash: 'fake' },
  ])
    assert.throws(() => parseDraftCreate({ ...input, ...change }), code('INVALID_INPUT'));
  assert.throws(
    () => parseDraftEdit({ title: 'x', content: 'y', expectedRevision: 1, taskId: 'other' }),
    code('INVALID_INPUT'),
  );
  const request = {
    expectedRevision: 1,
    ranges: [{ start: 0, end: 2 }],
    mode: 'append',
    target: { kind: 'task', id: 'task', expectedRevision: 1 },
  };
  for (const ranges of [
    [],
    [{ start: -1, end: 2 }],
    [{ start: 0, end: 0 }],
    [{ start: 0, end: 12001 }],
    [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ],
    Array.from({ length: 17 }, (_, i) => ({ start: i, end: i + 1 })),
  ])
    assert.throws(() => parseDraftAdoption({ ...request, ranges }), code('INVALID_INPUT'));
  assert.throws(
    () => parseDraftAdoption({ ...request, target: { ...request.target, projectId: 'foreign' } }),
    code('INVALID_INPUT'),
  );
  assert.throws(
    () => selectedDraftText('🙂好', [{ start: 1, end: 3 }]),
    code('DRAFT_RANGE_CHANGED'),
  );
  assert.throws(() => selectedDraftText('  ', [{ start: 0, end: 2 }]), code('INVALID_INPUT'));
  assert.equal(
    selectedDraftText('一二三四', [
      { start: 3, end: 4 },
      { start: 0, end: 1 },
    ]),
    '一\n\n四',
  );
  assert.throws(
    () =>
      composeDraftAdoption(
        { kind: 'task', id: 't', title: 't', content: 'old', revision: 1, limit: 4 },
        'new',
        'append',
      ),
    code('DRAFT_TARGET_LIMIT'),
  );
  for (const query of [{ limit: '51' }, { limit: ['2'] }, { projectId: 'outside' }])
    assert.throws(() => parseDraftPageQuery(query), code('INVALID_INPUT'));
});

test('已有 AI 回复明确保存草稿，人工修订独立且不改原消息、任务或执行，来源变化不能伪造', () => {
  const store = new Store();
  try {
    const f = setup(store),
      before = {
        task: store.getTask(f.task.id),
        messages: store.messages(f.task.id),
        runs: store.runs(f.task.id),
      };
    const edited = store.aiDrafts.edit(
      f.task.id,
      f.draft.id,
      { expectedRevision: 1, title: '改写建议', content: '  新建议\n' },
      'edit',
    );
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.origin, f.draft.origin);
    assert.deepEqual(
      {
        task: store.getTask(f.task.id),
        messages: store.messages(f.task.id),
        runs: store.runs(f.task.id),
      },
      before,
    );
    assert.deepEqual(
      store.aiDrafts
        .history(f.task.id, f.draft.id, { before: null, limit: 50 })
        .items.map((v) => v.revision),
      [2, 1],
    );
    assert.throws(
      () =>
        store.aiDrafts.edit(
          f.task.id,
          f.draft.id,
          { expectedRevision: 1, title: '过期', content: '失效' },
          'stale',
        ),
      code('REVISION_CONFLICT'),
    );
    const human = store.addMessage(f.task.id, '人说的话', null, 'human');
    assert.throws(
      () => store.aiDrafts.preview(f.task.id, human.id),
      code('DRAFT_SOURCE_UNSUPPORTED'),
    );
    store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.message, body: '改变的来源' }), f.message.id);
    assert.throws(
      () => store.aiDrafts.create(f.task.id, f.input, 'changed-source'),
      code('DRAFT_SOURCE_CHANGED'),
    );
    const other = setup(store);
    assert.throws(() => store.aiDrafts.preview(f.task.id, other.message.id), code('NOT_FOUND'));
    const long = agent(store, f.task.id, '甲'.repeat(11999) + '🙂结尾');
    const prefix = store.aiDrafts.preview(f.task.id, long.id);
    assert.equal(prefix.initialContent.length, 11999);
    assert.equal(prefix.contentTruncated, true);
  } finally {
    store.close();
  }
});

test('局部采用仅修改明确目标、记录原文与修订，后续草稿编辑和旧回执不反向修改任务', () => {
  const store = new Store();
  try {
    const f = setup(store),
      input = adopt(f.draft, f.task);
    const first = store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'adopt');
    assert.equal(first.selectedText, '采用第一段\n\n采用第三段');
    const task = store.getTask(f.task.id);
    assert.equal(task.description, '原任务说明\n\n采用第一段\n\n采用第三段');
    assert.equal(task.status, f.task.status);
    assert.equal(task.ownerUserId, f.task.ownerUserId);
    assert.equal(task.revision, 2);
    assert.deepEqual(store.aiDrafts.get(f.task.id, f.draft.id), f.draft);
    assert.equal(first.target.beforeContent, f.task.description);
    assert.equal(first.target.afterContent, task.description);
    assert.equal(first.createdByUserId, store.actorId);
    assert.throws(
      () => store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'second'),
      code('REVISION_CONFLICT'),
    );
    store.aiDrafts.edit(
      f.task.id,
      f.draft.id,
      { expectedRevision: 1, title: f.draft.title, content: '不同草稿' },
      'edit',
    );
    assert.deepEqual(store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'adopt'), first);
    assert.deepEqual(store.getTask(f.task.id), task);
    assert.equal(store.aiDrafts.adoptions(f.task.id, f.draft.id, pageQuery).items.length, 1);
    assert.equal(store.runs(f.task.id).length, 0);
    assert.equal(
      store.projectAgreements.list(f.task.projectId!, {
        state: 'all',
        q: '',
        cursor: null,
        limit: 50,
      }).items.length,
      0,
    );
  } finally {
    store.close();
  }
});

test('采用项目资料正文复用修订规则，私有/其他任务/跨项目/删除目标和超限明确拒绝', () => {
  const store = new Store();
  try {
    const f = setup(store),
      source = store.projectSources.create(
        f.task.projectId!,
        {
          kind: 'link',
          title: '保留的标题',
          content: '原链接说明',
          url: 'https://example.invalid/reference',
        },
        'source',
      );
    const body = {
      ...adopt(f.draft, f.task),
      mode: 'replace',
      target: { kind: 'source', id: source.id, expectedRevision: 1 },
    };
    const result = store.aiDrafts.adopt(f.task.id, f.draft.id, body, 'source-adoption');
    const changed = store.projectSources.get(f.task.projectId!, source.id);
    assert.equal(changed.revision, 2);
    assert.equal(changed.url, source.url);
    assert.equal(changed.title, source.title);
    assert.equal(changed.content, result.selectedText);
    assert.notEqual(changed.contentHash, source.contentHash);
    assert.deepEqual(store.getTask(f.task.id), f.task);
    assert.equal(
      store.projectSources.history(f.task.projectId!, source.id, { before: null, limit: 50 }).items
        .length,
      2,
    );
    const privateDraft = setup(store, null);
    assert.throws(
      () =>
        store.aiDrafts.adopt(privateDraft.task.id, privateDraft.draft.id, body, 'private-source'),
      code('DRAFT_TARGET_PRIVATE'),
    );
    assert.throws(
      () =>
        store.aiDrafts.adopt(
          f.task.id,
          f.draft.id,
          { ...body, target: { kind: 'task', id: privateDraft.task.id, expectedRevision: 1 } },
          'other-task',
        ),
      code('DRAFT_TARGET_SCOPE'),
    );
    const foreign = store.projectSources.create(
      store.projects()[1]!.id,
      { kind: 'text', title: '另一个项目', content: 'foreign' },
      'foreign',
    );
    assert.throws(
      () =>
        store.aiDrafts.adopt(
          f.task.id,
          f.draft.id,
          { ...body, target: { ...body.target, id: foreign.id } },
          'foreign-target',
        ),
      code('NOT_FOUND'),
    );
    const big = store.aiDrafts.edit(
      f.task.id,
      f.draft.id,
      { expectedRevision: 1, title: '大建议', content: '甲'.repeat(8001) },
      'large',
    );
    assert.throws(
      () =>
        store.aiDrafts.adopt(
          f.task.id,
          big.id,
          {
            ...body,
            expectedRevision: 2,
            ranges: [{ start: 0, end: 8001 }],
            target: { ...body.target, expectedRevision: 2 },
          },
          'too-big',
        ),
      code('DRAFT_TARGET_LIMIT'),
    );
    store.projectSources.lifecycle(
      f.task.projectId!,
      source.id,
      { expectedRevision: 2, action: 'delete' },
      'delete',
    );
    assert.throws(
      () =>
        store.aiDrafts.adopt(
          f.task.id,
          f.draft.id,
          { ...body, expectedRevision: 2, target: { ...body.target, expectedRevision: 3 } },
          'deleted',
        ),
      code('SOURCE_DELETED'),
    );
    assert.equal(
      store.aiDrafts.adopt(f.task.id, f.draft.id, body, 'source-adoption').id,
      result.id,
    );
    assert.equal(store.projectSources.get(f.task.projectId!, source.id).revision, 3);
  } finally {
    store.close();
  }
});

test('采用任务说明原子暂停等待计划，保留冻结材料和未知目录锁，不停止源执行', () => {
  const store = new Store();
  try {
    const f = setup(store),
      copy = store.registerWorkingCopy({
        id: randomUUID(),
        name: '草稿协议夹具',
        root: '/fictional/draft-adoption',
        createdAt: new Date().toISOString(),
      });
    const body = {
      provider: 'native',
      requestedTool: 'claude-code',
      workingCopyId: copy.id,
      prompt: '原要求',
      confirmExecution: true,
      expectedRevision: f.task.revision,
    };
    const run = store.createNativeRun(
      f.task.id,
      parseNativeRunCreate(body),
      {
        workingCopyId: copy.id,
        mode: 'read-only',
        model: null,
        maxTurns: 8,
        maxBudgetUsd: 1,
        timeoutSeconds: 30,
        toolVersion: 'protocol fixture only',
        contextText: '原固定材料',
        contextHash: 'fixture',
      },
      'native',
    );
    const ops = new ContinuationStore(store),
      op = ops.create(
        f.task.id,
        parseContinuation({
          ...body,
          sourceRunId: run.id,
          onActiveRun: 'wait',
          expectedRevision: store.getTask(f.task.id).revision,
        }),
        'op',
      );
    const before = store.run(run.id),
      locks = store.db.prepare('SELECT * FROM native_workspace_locks').all();
    store.aiDrafts.adopt(f.task.id, f.draft.id, adopt(f.draft, store.getTask(f.task.id)), 'adopt');
    const paused = ops.get(op.id);
    assert.equal(paused.state, 'needs_attention');
    assert.deepEqual(paused.input, op.input);
    assert.deepEqual(store.run(run.id), before);
    assert.deepEqual(store.db.prepare('SELECT * FROM native_workspace_locks').all(), locks);
  } finally {
    store.close();
  }
});

test('采用目标、不可变记录、修订通知与回执任一步失败整体回滚，重试最多写一次', () => {
  for (const targetKind of ['task', 'source'] as const)
    for (const table of ['ai_draft_adoptions', 'outbox', 'idempotency_records']) {
      const store = new Store();
      try {
        const f = setup(store),
          source = store.projectSources.create(
            f.task.projectId!,
            { kind: 'text', title: '资料', content: '原资料' },
            'source',
          );
        const input = {
          ...adopt(f.draft, f.task),
          target: {
            kind: targetKind,
            id: targetKind === 'task' ? f.task.id : source.id,
            expectedRevision: 1,
          },
        };
        const before = {
          task: store.getTask(f.task.id),
          source: store.projectSources.get(f.task.projectId!, source.id),
          outbox: store.db.prepare('SELECT * FROM outbox').all(),
        };
        store.db.exec(
          `CREATE TRIGGER fail_draft BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'draft atomic failure'); END`,
        );
        assert.throws(
          () => store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'retry'),
          /draft atomic failure/,
        );
        assert.deepEqual(store.getTask(f.task.id), before.task);
        assert.deepEqual(store.projectSources.get(f.task.projectId!, source.id), before.source);
        assert.deepEqual(store.db.prepare('SELECT * FROM outbox').all(), before.outbox);
        assert.equal(store.aiDrafts.adoptions(f.task.id, f.draft.id, pageQuery).items.length, 0);
        store.db.exec('DROP TRIGGER fail_draft');
        const saved = store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'retry');
        assert.deepEqual(store.aiDrafts.adopt(f.task.id, f.draft.id, input, 'retry'), saved);
        assert.equal(store.aiDrafts.adoptions(f.task.id, f.draft.id, pageQuery).items.length, 1);
      } finally {
        store.close();
      }
    }
});

test('真实团队草稿读取/采用/回执均重查父任务与目标权限，私有内容不被空间所有者越权读取', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(bob);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'edit' });
    const task = await f.task(alice, project.id),
      message = agent(f.store, task.id);
    const origin = (
      await f.call(`tasks/${task.id}/messages/${message.id}/draft-preview`, alice)
    ).json();
    const input = {
      sourceMessageId: message.id,
      expectedSourceHash: origin.origin.hash,
      title: '共享建议',
      content: message.body,
    };
    const draft = (
      await f.call(`tasks/${task.id}/ai-drafts`, alice, input, 'create')
    ).json() as AiDraft;
    const base = `tasks/${task.id}/ai-drafts/${draft.id}`;
    const body = adopt(draft, task);
    assert.equal((await f.call(base + '/adoptions', alice, body, 'adopt')).statusCode, 201);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: 'view' });
    assert.equal((await f.call(base, alice)).statusCode, 200);
    assert.equal((await f.call(base + '/adoptions', alice, body, 'adopt')).statusCode, 403);
    await f.call(`projects/${project.id}/members/${alice.user.id}`, bob, { role: null });
    for (const path of [
      base,
      base + '/revisions',
      base + '/adoptions',
      `tasks/${task.id}/ai-drafts`,
      `tasks/${task.id}/messages/${message.id}/draft-preview`,
    ])
      assert.equal((await f.call(path, alice)).statusCode, 404, path);
    assert.equal(
      (await f.call(`tasks/${task.id}/ai-drafts`, alice, input, 'create')).statusCode,
      404,
    );
    const privateTask = await f.task(bob, null),
      privateMessage = agent(f.store, privateTask.id);
    assert.equal(
      (await f.call(`tasks/${privateTask.id}/messages/${privateMessage.id}/draft-preview`, alice))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('草稿与采用历史在重启后保留，HTTP 并发版本冲突不丢内容，分页不补造旧历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-drafts-')),
    path = join(dir, 'workspace.sqlite');
  const store = new Store(path),
    app = await createApp({ store, native: { enabled: false, roots: [] } });
  let taskId = '',
    draftId = '';
  try {
    const f = setup(store);
    taskId = f.task.id;
    draftId = f.draft.id;
    const url = `/api/v1/tasks/${taskId}/ai-drafts/${draftId}`;
    const responses = await Promise.all(
      ['甲', '乙'].map((content) =>
        app.inject({
          method: 'PATCH',
          url,
          headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
          payload: { expectedRevision: 1, title: f.draft.title, content },
        }),
      ),
    );
    assert.deepEqual(responses.map((v) => v.statusCode).sort(), [200, 409]);
    const current = store.aiDrafts.get(taskId, draftId);
    store.aiDrafts.adopt(
      taskId,
      draftId,
      { ...adopt(current, f.task), ranges: [{ start: 0, end: 1 }] },
      'adopt',
    );
    const page = (await app.inject({ url: url + '/revisions?limit=1' })).json();
    assert.equal(page.items[0].revision, 2);
    assert.equal(page.nextCursor, 2);
    assert.equal(
      (await app.inject({ url: url + '/revisions?before=2' })).json().items[0].revision,
      1,
    );
    assert.equal((await app.inject({ url: url + '/adoptions' })).json().items.length, 1);
  } finally {
    await app.close();
  }
  const reopened = new Store(path);
  try {
    assert.equal(reopened.aiDrafts.get(taskId, draftId).revision, 2);
    assert.equal(reopened.aiDrafts.adoptions(taskId, draftId, pageQuery).items.length, 1);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
