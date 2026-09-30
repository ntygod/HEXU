import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../packages/contracts/src/index.js';
import type { NextInput } from '../packages/contracts/src/next-input.js';
import type { ResultRevision } from '../packages/contracts/src/results.js';
import { parseResultFeedbackInput } from '../packages/contracts/src/result-feedback-inputs.js';
import { ResultFeedbackInputs } from '../packages/db/src/result-feedback-inputs.js';
import { NextInputs } from '../packages/db/src/next-inputs.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { branchContinuationFixture } from './helpers/branch-continuation.js';
import { codeFeedbackFixture } from './helpers/code-feedback.js';

const path = (result: string, version: string, message: string) =>
  `results/${result}/versions/${version}/feedback/${message}`;
const snapshots = (store: Store, tables: string[]) =>
  tables.map((table) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()));
async function fixture() {
  const f = await branchContinuationFixture();
  const source = f.as(() =>
    f.api.store.addMessage(
      f.task.id,
      'ORIGINAL_FEEDBACK_ONLY',
      f.saved.resultId,
      randomUUID(),
      f.saved.revisionId,
    ),
  );
  return {
    ...f,
    feedback: source,
    inputPath: path(f.saved.resultId, f.saved.revisionId, source.id),
  };
}

test('反馈整理仅接受2000字符以内的独立正文，禁止伪造来源与作者', () => {
  assert.deepEqual(parseResultFeedbackInput({ body: '  编辑后的要求  ' }), {
    body: '编辑后的要求',
  });
  assert.equal(parseResultFeedbackInput({ body: 'a'.repeat(2000) }).body.length, 2000);
  for (const value of [null, [], {}, { body: '' }, { body: 1 }, { body: 'a'.repeat(2001) }])
    assert.throws(() => parseResultFeedbackInput(value), { code: 'INVALID_INPUT' });
  for (const key of [
    'origin',
    'sourceRunId',
    'taskId',
    'resultId',
    'resultRevisionId',
    'messageId',
    'authorId',
    'codeAnchor',
    'state',
    'targetRunId',
  ])
    assert.throws(() => parseResultFeedbackInput({ body: '明确要求', [key]: 'spoof' }), {
      code: 'INVALID_INPUT',
    });
});

test('保存单队列保留原反馈与独立编辑正文，重复和重开保持来源，不创建Run或改方案', async () => {
  const f = await fixture();
  try {
    const tables = [
      'tasks',
      'runs',
      'node_dispatches',
      'work_branches',
      'work_branch_choices',
      'result_revisions',
      'messages',
    ];
    const before = snapshots(f.api.store, tables);
    const preview = await f.api.call(f.inputPath + '/next-input-preview', f.alice);
    assert.equal(preview.statusCode, 200, preview.body);
    assert(preview.json().available);
    const origin = preview.json().origin;
    assert.equal(origin.body, f.feedback.body);
    assert.equal(origin.bodyHash, createHash('sha256').update(f.feedback.body).digest('hex'));
    assert.equal(origin.authorId, undefined);
    assert.equal(origin.sourceRunId, f.source.run.id);
    assert.equal(origin.branchName, f.view.branches[0]!.name);
    const key = randomUUID(),
      input = { body: 'EDITED_REQUIREMENT_ONLY' };
    const responses = await Promise.all([
      f.api.call(f.inputPath + '/next-inputs', f.alice, input, key),
      f.api.call(f.inputPath + '/next-inputs', f.alice, input, key),
    ]);
    responses.forEach((r) => assert.equal(r.statusCode, 201, r.body));
    assert.deepEqual(responses[0]!.json(), responses[1]!.json());
    const note = responses[0]!.json<NextInput>();
    assert.equal(note.body, input.body);
    assert.equal(note.state, 'queued');
    assert.equal(note.targetRunId, null);
    assert.equal(note.authorId, f.alice.user.id);
    assert.deepEqual(note.origin, origin);
    assert.deepEqual(snapshots(f.api.store, tables), before);
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: 'different' }, key))
        .statusCode,
      409,
    );
    const edited = f.as(() =>
      new NextInputs(f.api.store).edit(note.id, 1, 'NEW_EDITED_BODY', randomUUID()),
    );
    assert.deepEqual(edited.origin, origin);
    assert.deepEqual(
      (await f.api.call(f.inputPath + '/next-inputs', f.alice, input, key)).json(),
      edited,
    );
    const cancelled = f.as(() => new NextInputs(f.api.store).edit(note.id, 2, null, randomUUID()));
    assert.deepEqual(cancelled.origin, origin);
    const db = new Store(f.api.dbPath, undefined, { team: true });
    try {
      db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        assert.deepEqual(new NextInputs(db).list(f.task.id), [cancelled]);
        assert.deepEqual(
          new ResultFeedbackInputs(db).create(
            f.saved.resultId,
            f.saved.revisionId,
            f.feedback.id,
            input,
            key,
          ),
          cancelled,
        );
      });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('真人回复继承代码位置，保存来源为所选回复本人原文而非父反馈', async () => {
  const f = await codeFeedbackFixture();
  try {
    const original = (await f.api.call(f.feedbackPath, f.alice, f.input)).json<Message>();
    const reply = await f.api.call(
      path(f.saved.resultId, f.saved.revisionId, original.id) + '/replies',
      f.alice,
      { body: 'REPLY_ORIGINAL' },
    );
    assert.equal(reply.statusCode, 201, reply.body);
    const response = await f.api.call(
      path(f.saved.resultId, f.saved.revisionId, reply.json().id) + '/next-inputs',
      f.alice,
      { body: 'EDITED_REPLY_REQUIREMENT' },
    );
    assert.equal(response.statusCode, 201, response.body);
    const note = response.json<NextInput>();
    assert.equal(note.origin!.messageId, reply.json().id);
    assert.equal(note.origin!.body, 'REPLY_ORIGINAL');
    assert.equal(note.origin!.authorId, f.alice.user.id);
    assert.deepEqual(note.origin!.codeAnchor, original.codeAnchor);
  } finally {
    await f.close();
  }
});

test('错任务/成果/版本、未固定或非真人反馈拒绝；无真实方案来源明确不可用', async () => {
  const f = await fixture();
  try {
    const versions = new ResultRevisions(f.api.store);
    for (const changed of [
      { actorType: 'agent' },
      { actorType: 'system' },
      { resultId: null },
      { resultRevisionId: undefined },
      { taskId: randomUUID() },
      { id: randomUUID() },
    ]) {
      f.api.store.db
        .prepare('UPDATE messages SET body=? WHERE id=?')
        .run(JSON.stringify({ ...f.feedback, ...changed }), f.feedback.id);
      assert.equal(
        (await f.api.call(f.inputPath + '/next-input-preview', f.alice)).statusCode,
        404,
      );
      assert.equal(
        (await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: '要求' })).statusCode,
        404,
      );
    }
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify(f.feedback), f.feedback.id);
    const version = f.as(() => versions.get(f.saved.resultId, f.saved.revisionId));
    assert(version.source.kind === 'work_branch');
    let nextRevision = version.revision;
    for (const source of [
      { kind: 'member' },
      { kind: 'legacy' },
      ...['id', 'nodeId', 'workingCopyId', 'dispatchId'].map((field) => ({
        ...version.source,
        run: {
          ...(version.source.kind === 'work_branch' ? version.source.run : {}),
          [field]: randomUUID(),
        },
      })),
      { ...version.source, branchId: f.view.branches[1]!.id },
      { ...version.source, groupId: randomUUID() },
    ] as ResultRevision['source'][]) {
      const unavailableVersion = f.as(() =>
        f.api.store.atomic(() =>
          versions.append(
            { ...f.api.store.result(f.saved.resultId), revision: ++nextRevision },
            source,
          ),
        ),
      );
      const feedback = f.as(() =>
        f.api.store.addMessage(
          f.task.id,
          '无来源反馈',
          f.saved.resultId,
          randomUUID(),
          unavailableVersion.id,
        ),
      );
      const unavailablePath = path(f.saved.resultId, unavailableVersion.id, feedback.id);
      const preview = await f.api.call(unavailablePath + '/next-input-preview', f.alice);
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().available, false);
      const saved = await f.api.call(unavailablePath + '/next-inputs', f.alice, { body: '要求' });
      assert.equal(saved.statusCode, 422, saved.body);
      assert.equal(saved.json().error.code, 'CAPABILITY_UNAVAILABLE');
    }
    for (const extra of ['origin', 'sourceRunId', 'codeAnchor'])
      assert.equal(
        (await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: '要求', [extra]: {} }))
          .statusCode,
        400,
      );
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: '要求' }, '')).statusCode,
      400,
    );
    assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM task_next_inputs').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('当前编辑权保护预览/新保存/旧回执，事务开始后降权也不能返回旧回执', async (t) => {
  const f = await fixture();
  try {
    const memberPath = `projects/${f.project.id}/members/${f.bob.user.id}`,
      input = { body: '要求' },
      key = randomUUID();
    await f.api.call(memberPath, f.alice, { role: 'edit' });
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.bob, input, key)).statusCode,
      201,
    );
    await f.api.call(memberPath, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.inputPath + '/next-input-preview', f.bob)).statusCode, 403);
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.bob, input, key)).statusCode,
      403,
    );
    const original = f.api.store.mutate.bind(f.api.store);
    t.mock.method(
      f.api.store,
      'mutate',
      <T>(
        scope: string,
        k: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
      ): T => {
        f.api.store.db
          .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
          .run(f.project.id, f.bob.user.id);
        return original(scope, k, payload, action, beforeReplay);
      },
    );
    const before = snapshots(f.api.store, ['task_next_inputs', 'outbox', 'idempotency_records']);
    for (const k of [key, randomUUID()]) {
      f.api.store.db
        .prepare("UPDATE collab_project_members SET role='edit' WHERE project_id=? AND user_id=?")
        .run(f.project.id, f.bob.user.id);
      const r = await f.api.call(f.inputPath + '/next-inputs', f.bob, input, k);
      assert.equal(r.statusCode, 403, r.body);
      assert.deepEqual(
        snapshots(f.api.store, ['task_next_inputs', 'outbox', 'idempotency_records']),
        before,
      );
    }
    t.mock.restoreAll();
    await f.api.call(memberPath, f.alice, { role: null });
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.bob, input, key)).statusCode,
      404,
    );
    assert.equal((await f.api.call(f.inputPath + '/next-input-preview', null)).statusCode, 401);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('原来源事务内换版阻止旧回执；队列/outbox/回执任一步故障整体回滚', async (t) => {
  const f = await fixture();
  try {
    const input = { body: '要求' },
      key = randomUUID();
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.alice, input, key)).statusCode,
      201,
    );
    const original = f.api.store.mutate.bind(f.api.store);
    t.mock.method(
      f.api.store,
      'mutate',
      <T>(
        scope: string,
        k: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
      ): T => {
        f.api.store.db
          .prepare('UPDATE messages SET body=? WHERE id=?')
          .run(JSON.stringify({ ...f.feedback, resultRevisionId: randomUUID() }), f.feedback.id);
        return original(scope, k, payload, action, beforeReplay);
      },
    );
    for (const k of [key, randomUUID()]) {
      f.api.store.db
        .prepare('UPDATE messages SET body=? WHERE id=?')
        .run(JSON.stringify(f.feedback), f.feedback.id);
      assert.equal(
        (await f.api.call(f.inputPath + '/next-inputs', f.alice, input, k)).statusCode,
        404,
      );
    }
    t.mock.restoreAll();
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify(f.feedback), f.feedback.id);
    for (const table of ['task_next_inputs', 'outbox', 'idempotency_records']) {
      const before = snapshots(f.api.store, [
        'task_next_inputs',
        'outbox',
        'idempotency_records',
        'runs',
        'node_dispatches',
        'tasks',
      ]);
      f.api.store.db.exec(
        `CREATE TRIGGER fail_feedback_input BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
      );
      assert.equal(
        (await f.api.call(f.inputPath + '/next-inputs', f.alice, input)).statusCode,
        500,
      );
      f.api.store.db.exec('DROP TRIGGER fail_feedback_input');
      assert.deepEqual(
        snapshots(f.api.store, [
          'task_next_inputs',
          'outbox',
          'idempotency_records',
          'runs',
          'node_dispatches',
          'tasks',
        ]),
        before,
      );
    }
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('反馈整理和原队列共用20条上限，撤回后可保存；原文预算明确拒绝', async () => {
  const f = await fixture();
  try {
    const queue = new NextInputs(f.api.store);
    const notes = f.as(() =>
      Array.from({ length: 20 }, () => queue.create(f.source.run.id, '普通要求', randomUUID())),
    );
    const r = await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: '整理要求' });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error.code, 'INPUT_QUEUE_FULL');
    f.as(() => queue.edit(notes[0]!.id, 1, null, randomUUID()));
    assert.equal(
      (await f.api.call(f.inputPath + '/next-inputs', f.alice, { body: '整理要求' })).statusCode,
      201,
    );
    f.api.store.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.feedback, body: 'a'.repeat(12001) }), f.feedback.id);
    assert.equal(
      (await f.api.call(f.inputPath + '/next-input-preview', f.alice)).json().available,
      false,
    );
  } finally {
    await f.close();
  }
});
