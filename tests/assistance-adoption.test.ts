import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../packages/contracts/src/index.js';
import {
  parseAssistanceAdoption,
  selectedAssistanceSuggestion,
  type AssistanceAdoptionPreview,
  type AssistanceAdoptionInput,
} from '../packages/contracts/src/assistance-adoption.js';
import { teamFixture } from './helpers/team.js';
import { aiStoreFixture } from './helpers/ai-store.js';
import { Store } from '../packages/db/src/store.js';
import { executionHash } from '../packages/db/src/node-execution.js';
const code = (v: string) => (e: unknown) => e instanceof DomainError && e.code === v;
const suggestion = '建议甲\r\n不要采用这段🙂\r\n建议乙';
const ranges = [
  { start: 0, end: 3 },
  { start: suggestion.lastIndexOf('建议乙'), end: suggestion.length },
];
const page = { limit: 20, cursor: null };
function body(p: AssistanceAdoptionPreview): AssistanceAdoptionInput {
  return {
    replyId: p.source.reply.id,
    expectedAssistanceRevision: p.source.assistanceRevision,
    expectedSnapshotHash: p.source.snapshotHash,
    expectedReplyHash: p.source.replyHash,
    expectedTaskRevision: p.target.revision,
    ranges,
    mode: 'append',
  };
}
function local() {
  const f = aiStoreFixture();
  const m = f.as(() => f.store.addMessage(f.task.id, '所选问题\n未选材料', null, randomUUID()));
  const p = f.as(() => f.store.assistance.preview(f.task.id, m.id));
  const a = f.as(() =>
    f.store.assistance.create(
      f.task.id,
      {
        sourceMessageId: m.id,
        expectedSourceHash: p.sourceHash,
        expectedTaskRevision: p.taskRevision,
        range: { start: 0, end: 4 },
        recipientId: f.bob.id,
        question: '帮忙分析',
        shareConfirmed: true,
      },
      randomUUID(),
    ),
  );
  const r = f.as(
    () =>
      f.store.assistance.reply(
        a.assistance.id,
        { expectedRevision: 1, body: suggestion },
        randomUUID(),
      ),
    f.bob,
  );
  const preview = () =>
    f.as(() => f.store.assistanceAdoptions.preview(f.task.id, a.assistance.id, r.replies[0]!.id));
  const adopt = (data: unknown = body(preview()), key: string = randomUUID()) =>
    f.as(() => f.store.assistanceAdoptions.adopt(f.task.id, a.assistance.id, data, key));
  return { ...f, m, a, r, preview, adopt };
}
async function http(privateTask = false) {
  const f = await teamFixture();
  const { alice, bob } = await f.pair();
  const project = privateTask ? null : await f.project(alice);
  const task = await f.task(alice, project?.id ?? null, '不分享的任务标题');
  await f.call(
    `tasks/${task.id}`,
    alice,
    { expectedRevision: 1, description: '不分享的完整说明' },
    randomUUID(),
    'PATCH',
  );
  const message = (
    await f.call(`tasks/${task.id}/messages`, alice, { body: '报错\n未选秘密' })
  ).json();
  const source = (
    await f.call(`tasks/${task.id}/messages/${message.id}/assistance-preview`, alice)
  ).json();
  const a = (
    await f.call(`tasks/${task.id}/assistances`, alice, {
      sourceMessageId: message.id,
      expectedSourceHash: source.sourceHash,
      expectedTaskRevision: source.taskRevision,
      range: { start: 0, end: 2 },
      recipientId: bob.user.id,
      question: '如何处理',
      shareConfirmed: true,
    })
  ).json();
  const replied = (
    await f.call(`assistances/${a.assistance.id}/replies`, bob, {
      expectedRevision: 1,
      body: suggestion,
    })
  ).json();
  const id = a.assistance.id as string,
    replyId = replied.replies[0].id as string;
  const path = `tasks/${task.id}/assistances/${id}`;
  const response = await f.call(path + `/replies/${replyId}/adoption-preview`, alice);
  assert.equal(response.statusCode, 200, response.body);
  return {
    ...f,
    alice,
    bob,
    task,
    project,
    id,
    replyId,
    path,
    preview: response.json() as AssistanceAdoptionPreview,
  };
}

test('协助采用严格限定来源、原任务和片段；拒绝伪造文本/身份/目标以及断开的字符和换行', () => {
  const f = local();
  try {
    const input = body(f.preview());
    for (const change of [
      { target: { kind: 'source', id: 'other' } },
      { taskId: 'other' },
      { selectedText: '伪造' },
      { runId: 'new' },
      { createdByUserId: 'other' },
      { expectedTaskRevision: '1' },
      { expectedSnapshotHash: 'x' },
      {
        ranges: [
          { start: 0, end: 4 },
          { start: 2, end: 6 },
        ],
      },
      { ranges: [] },
      { ranges: [{ start: 0, end: 12001 }] },
    ])
      assert.throws(() => parseAssistanceAdoption({ ...input, ...change }), code('INVALID_INPUT'));
    assert.equal(selectedAssistanceSuggestion(suggestion, ranges), '建议甲\n\n建议乙');
    for (const [text, r] of [
      ['🙂好', { start: 1, end: 3 }],
      ['甲\r\n乙', { start: 0, end: 2 }],
    ] as const)
      assert.throws(
        () => selectedAssistanceSuggestion(text, [r]),
        code('ASSISTANCE_RANGE_CHANGED'),
      );
    assert.throws(
      () => selectedAssistanceSuggestion('a', [{ start: 0, end: 2 }]),
      code('ASSISTANCE_RANGE_CHANGED'),
    );
  } finally {
    f.close();
  }
});

test('真实 HTTP 局部采用保留来源与完整前后记录，有限接收者不能读目标或采用历史', async () => {
  const f = await http();
  try {
    const before = (await f.call(`tasks/${f.task.id}`, f.alice)).json();
    const saved = await f.call(f.path + '/adoptions', f.alice, body(f.preview), 'adopt-once');
    assert.equal(saved.statusCode, 201, saved.body);
    const record = saved.json();
    assert.equal(record.selectedText, '建议甲\n\n建议乙');
    assert.equal(record.source.reply.author.id, f.bob.user.id);
    assert.equal(record.source.reply.body, suggestion);
    assert.equal(record.target.beforeContent, '不分享的完整说明');
    assert.equal(record.target.afterContent, '不分享的完整说明\n\n建议甲\n\n建议乙');
    const after = (await f.call(`tasks/${f.task.id}`, f.alice)).json();
    assert.equal(after.task.description, record.target.afterContent);
    assert.equal(after.task.revision, before.task.revision + 1);
    assert.equal(after.task.ownerUserId, before.task.ownerUserId);
    assert.equal(after.task.status, before.task.status);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.runs, before.runs);
    const recipient = await f.call(`assistances/${f.id}`, f.bob);
    assert.equal(recipient.json().assistance.canAdopt, false);
    assert.equal(recipient.json().assistance.canEditTask, false);
    assert.equal(recipient.json().replies[0].body, suggestion);
    for (const secret of ['不分享的完整说明', f.task.id, f.preview.target.title, record.id])
      assert.equal(recipient.body.includes(secret), false);
    assert.equal((await f.call(f.path + '/adoptions', f.bob)).statusCode, 404);
    assert.equal(
      (await f.call(f.path + '/adoptions', f.bob, body(f.preview), 'adopt-once')).statusCode,
      404,
    );
    assert.equal(
      (await f.call(f.path + `/replies/${f.replyId}/adoption-preview`, f.bob)).statusCode,
      404,
    );
    const history = (await f.call(f.path + '/adoptions', f.alice)).json();
    assert.deepEqual(history.items, [record]);
    const bobEvents = f.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () =>
      f.store.events(0),
    );
    assert.equal(JSON.stringify(bobEvents).includes('assistance.adopted'), false);
  } finally {
    await f.close();
  }
});

test('协助/回复/任务三类旧基线均拒绝，新追问不能成为建议；已结束可采用但撤销阻止新采用', () => {
  const f = local();
  try {
    const data = body(f.preview());
    assert.throws(
      () => f.adopt({ ...data, expectedReplyHash: 'a'.repeat(64) }),
      code('ASSISTANCE_SUGGESTION_CHANGED'),
    );
    assert.throws(
      () => f.adopt({ ...data, expectedSnapshotHash: 'a'.repeat(64) }),
      code('ASSISTANCE_SUGGESTION_CHANGED'),
    );
    f.as(() =>
      f.store.patchTask(f.task.id, { expectedRevision: 1, description: '外部更新' }, 'external'),
    );
    assert.throws(() => f.adopt(data), code('REVISION_CONFLICT'));
    const follow = f.as(() =>
      f.store.assistance.reply(
        f.a.assistance.id,
        { expectedRevision: 2, body: '我的追问' },
        'follow',
      ),
    );
    assert.throws(() => f.adopt({ ...data, expectedTaskRevision: 2 }), code('REVISION_CONFLICT'));
    assert.throws(
      () =>
        f.as(() =>
          f.store.assistanceAdoptions.preview(
            f.task.id,
            f.a.assistance.id,
            follow.replies.at(-1)!.id,
          ),
        ),
      code('ASSISTANCE_NOT_SUGGESTION'),
    );
    f.as(() =>
      f.store.assistance.change(
        f.a.assistance.id,
        { expectedRevision: 3, action: 'close' },
        'close',
      ),
    );
    const saved = f.adopt();
    assert.equal(saved.target.beforeContent, '外部更新');
    f.as(() =>
      f.store.assistance.change(
        f.a.assistance.id,
        { expectedRevision: 4, action: 'cancel' },
        'cancel',
      ),
    );
    assert.throws(() => f.adopt(), code('ASSISTANCE_ADOPTION_REVOKED'));
    assert.equal(
      f.as(() => f.store.assistanceAdoptions.list(f.task.id, f.a.assistance.id, page)).items.length,
      1,
    );
  } finally {
    f.close();
  }
});

test('采用幂等回执只返回不可变记录，不反转后续任务与撤销；分页稳定且新键并发仅成功一次', async () => {
  const f = await http();
  try {
    const data = body(f.preview);
    const results = await Promise.all(
      ['first', 'second'].map((key) => f.call(f.path + '/adoptions', f.alice, data, key)),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    const ok = results.findIndex((r) => r.statusCode === 201),
      key = ['first', 'second'][ok]!;
    const record = results[ok]!.json();
    await f.call(
      `tasks/${f.task.id}`,
      f.alice,
      { expectedRevision: record.target.afterRevision, description: '后来人工修改' },
      'later',
      'PATCH',
    );
    await f.call(`assistances/${f.id}/state`, f.alice, { expectedRevision: 2, action: 'cancel' });
    const replay = await f.call(f.path + '/adoptions', f.alice, data, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), record);
    assert.equal(
      (await f.call(`tasks/${f.task.id}`, f.alice)).json().task.description,
      '后来人工修改',
    );
    assert.equal(
      (await f.call(f.path + '/adoptions', f.alice, { ...data, mode: 'replace' }, key)).statusCode,
      409,
    );
    assert.equal((await f.call(f.path + '/adoptions', f.alice, data, 'new')).statusCode, 409);
    assert.equal((await f.call(f.path + '/adoptions?cursor=foreign', f.alice)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('私有任务只可由所有者采用；项目编辑者可采用但降权/移除后原回执也不可写', async () => {
  for (const isPrivate of [true, false]) {
    const f = await http(isPrivate);
    try {
      const data = body(f.preview);
      if (isPrivate) {
        assert.equal((await f.call(f.path + '/adoptions', f.bob, data)).statusCode, 404);
        assert.equal((await f.call(f.path + '/adoptions', f.alice, data)).statusCode, 201);
      } else {
        await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
          role: 'edit',
        });
        const adopted = await f.call(f.path + '/adoptions', f.bob, data, 'by-editor');
        assert.equal(adopted.statusCode, 201, adopted.body);
        await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
          role: 'view',
        });
        assert.equal((await f.call(f.path + '/adoptions', f.bob)).statusCode, 200);
        assert.equal(
          (await f.call(f.path + '/adoptions', f.bob, data, 'by-editor')).statusCode,
          403,
        );
        await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
        await f.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
          role: 'edit',
        });
        assert.equal(
          (await f.call(f.path + '/adoptions', f.bob, data, 'by-editor')).statusCode,
          404,
        );
        assert.equal((await f.call(f.path + '/adoptions', f.bob)).statusCode, 404);
      }
      const other = (
        await f.call(`spaces/${f.alice.spaceId}/tasks`, f.alice, {
          title: '另一个任务',
          projectId: f.project?.id ?? null,
        })
      ).json();
      assert.equal(
        (await f.call(`tasks/${other.id}/assistances/${f.id}/adoptions`, f.alice, data)).statusCode,
        404,
      );
      assert.equal(
        (
          await f.call(f.path + '/adoptions', {
            ...f.alice,
            spaceId: `personal-${f.alice.user.id}`,
          })
        ).statusCode,
        404,
      );
    } finally {
      await f.close();
    }
  }
});
function plans(f: ReturnType<typeof local>) {
  f.store.db
    .prepare('INSERT INTO native_workspaces VALUES(?,?,?)')
    .run('copy', '/fictional/adoption', '{}');
  f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(
    'unknown',
    f.task.id,
    JSON.stringify({
      id: 'unknown',
      taskId: f.task.id,
      state: 'running',
      observation: 'unknown',
    }),
  );
  f.store.db.prepare('INSERT INTO native_workspace_locks VALUES(?,?)').run('copy', 'unknown');
  const data = {
    taskId: f.task.id,
    state: 'waiting_for_stop',
    revision: 1,
    input: { prompt: '原要求' },
    contextSnapshot: { text: '原固定材料' },
    stopRequested: true,
  };
  f.store.db
    .prepare('INSERT INTO continuation_operations VALUES(?,?,?,?,?)')
    .run(
      'preview-op',
      f.task.id,
      'copy',
      'waiting_for_stop',
      JSON.stringify({ ...data, id: 'preview-op' }),
    );
  f.store.db
    .prepare('INSERT INTO node_continuation_operations VALUES(?,?,?,?,?)')
    .run(
      'node-op',
      f.task.id,
      f.n.nodeId,
      'waiting_for_stop',
      JSON.stringify({ ...data, id: 'node-op' }),
    );
}
test('采用任务说明共用暂停规则，保留双类等待材料、原停止请求、执行与未知目录锁', () => {
  const f = local();
  try {
    plans(f);
    const protectedTables = [
      'runs',
      'native_workspace_locks',
      'assistances',
      'assistance_replies',
      'assistance_grants',
    ];
    const snapshot = () =>
      protectedTables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot();
    f.adopt();
    assert.deepEqual(snapshot(), before);
    for (const t of ['continuation_operations', 'node_continuation_operations']) {
      const r = f.store.db.prepare(`SELECT state,body FROM ${t}`).get()!;
      assert.equal(r.state, 'needs_attention');
      const b = JSON.parse(r.body as string);
      assert.equal(b.revision, 2);
      assert.equal(b.stopRequested, true);
      assert.equal(b.input.prompt, '原要求');
      assert.equal(b.contextSnapshot.text, '原固定材料');
    }
    assert.equal(f.as(() => f.store.getTask(f.task.id)).status, 'todo');
  } finally {
    f.close();
  }
});

test('任务/等待计划/采用记录/事件/回执任一步故障全部回滚，复用原请求可安全重试', () => {
  const tables = [
    'tasks',
    'continuation_operations',
    'node_continuation_operations',
    'assistance_adoptions',
    'outbox',
    'idempotency_records',
  ];
  for (const target of tables) {
    const f = local();
    try {
      plans(f);
      const data = body(f.preview());
      const snapshot = () => tables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all());
      const before = snapshot();
      f.store.db.exec(
        `CREATE TRIGGER fail_adopt BEFORE ${['tasks', 'continuation_operations', 'node_continuation_operations'].includes(target) ? 'UPDATE' : 'INSERT'} ON ${target} BEGIN SELECT RAISE(ABORT,'adoption rollback'); END`,
      );
      assert.throws(() => f.adopt(data, 'same'), /adoption rollback/);
      assert.deepEqual(snapshot(), before, target);
      f.store.db.exec('DROP TRIGGER fail_adopt');
      const adopted = f.adopt(data, 'same');
      assert.deepEqual(f.adopt(data, 'same'), adopted);
      assert.equal(
        f.as(() => f.store.assistanceAdoptions.list(f.task.id, f.a.assistance.id, page)).items
          .length,
        1,
      );
    } finally {
      f.close();
    }
  }
});

test('AI 最终建议采用保留 Run 来源，不新调用模型；无成功终态或错执行身份不得采用', () => {
  const f = aiStoreFixture();
  try {
    f.publish();
    const m = f.as(() => f.store.addMessage(f.task.id, '固定材料', null, 'msg'));
    const p = f.as(() => f.store.assistance.preview(f.task.id, m.id));
    const a = f.as(() =>
      f.execution.createAssistance(
        f.task.id,
        {
          sourceMessageId: m.id,
          expectedSourceHash: p.sourceHash,
          expectedTaskRevision: p.taskRevision,
          range: { start: 0, end: 4 },
          question: '分析',
          nodeId: f.n.nodeId,
          policyHash: executionHash(f.policy),
          confirmMaterial: true,
          confirmExecution: true,
        },
        'ai',
      ),
    );
    const c = f.command();
    f.send(c, 1, 'accepted');
    f.execution.permit(f.token, f.connection, c.id, c.generation);
    f.send(c, 2, 'running');
    f.send(c, 3, 'terminal', 'succeeded', suggestion);
    const r = f.as(() => f.store.assistance.get(a.assistance.id)).replies[0]!;
    const preview = f.as(() =>
      f.store.assistanceAdoptions.preview(f.task.id, a.assistance.id, r.id),
    );
    const before = f.store.db.prepare('SELECT * FROM runs').all();
    const saved = f.as(() =>
      f.store.assistanceAdoptions.adopt(f.task.id, a.assistance.id, body(preview), 'adopt'),
    );
    assert.equal(saved.source.reply.runId, c.runId);
    assert.equal(saved.source.reply.actorType, 'agent');
    assert.deepEqual(f.store.db.prepare('SELECT * FROM runs').all(), before);
    const run = f.as(() => f.store.run(c.runId));
    f.store.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify({ ...run, state: 'failed' }), c.runId);
    assert.throws(
      () => f.as(() => f.store.assistanceAdoptions.preview(f.task.id, a.assistance.id, r.id)),
      code('ASSISTANCE_NOT_SUGGESTION'),
    );
    assert.equal(
      f.as(() => f.store.assistanceAdoptions.list(f.task.id, a.assistance.id, page)).items[0]!.id,
      saved.id,
    );
  } finally {
    f.close();
  }
});

test('替换与超限不丢片段，无变化不增加任务修订；采用历史跨迁移重启保存', async () => {
  const f = await http();
  try {
    const data = { ...body(f.preview), mode: 'replace' as const };
    const saved = (await f.call(f.path + '/adoptions', f.alice, data, 'replace')).json();
    assert.equal(saved.target.afterContent, '建议甲\n\n建议乙');
    const same = await f.call(
      f.path + '/adoptions',
      f.alice,
      { ...data, expectedTaskRevision: saved.target.afterRevision },
      'no-change',
    );
    assert.equal(same.statusCode, 201, same.body);
    assert.equal(same.json().target.afterRevision, saved.target.afterRevision);
    const firstPage = (await f.call(f.path + '/adoptions?limit=1', f.alice)).json();
    const secondPage = (
      await f.call(f.path + '/adoptions?limit=1&cursor=' + firstPage.nextCursor, f.alice)
    ).json();
    assert.equal(secondPage.items[0].id, saved.id);
    assert.equal(secondPage.nextCursor, null);
    await f.call(
      `tasks/${f.task.id}`,
      f.alice,
      { expectedRevision: saved.target.afterRevision, description: 'x'.repeat(12000) },
      'large',
      'PATCH',
    );
    assert.equal(
      (
        await f.call(f.path + '/adoptions', f.alice, {
          ...data,
          mode: 'append',
          expectedTaskRevision: saved.target.afterRevision + 1,
        })
      ).statusCode,
      422,
    );
    await f.app.close();
    const again = new Store(f.dbPath, undefined, { team: true });
    try {
      const records = again.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        again.assistanceAdoptions.list(f.task.id, f.id, page),
      );
      assert.equal(records.items.length, 2);
      assert.deepEqual(records.items[1], saved);
    } finally {
      again.close();
    }
    const raw = new DatabaseSync(f.dbPath);
    raw.exec('DROP TABLE assistance_adoptions; DELETE FROM schema_migrations WHERE version=19');
    raw.close();
    const migrated = new Store(f.dbPath, undefined, { team: true });
    try {
      assert.equal(
        migrated.db.prepare('SELECT count(*) AS n FROM assistance_adoptions').get()!.n,
        0,
      );
      assert.ok(
        Number(migrated.db.prepare('SELECT count(*) AS n FROM assistance_replies').get()!.n) > 0,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await f.close();
  }
});
