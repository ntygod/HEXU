import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextInput } from '../packages/contracts/src/next-input.js';
import {
  branchContinuationContext,
  parseBranchRunSelection,
  parseBranchExecutionBinding,
} from '../packages/contracts/src/work-branch-workspaces.js';
import { NextInputs } from '../packages/db/src/next-inputs.js';
import { ResultFeedbackInputs } from '../packages/db/src/result-feedback-inputs.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { NodeExecution, executionHash } from '../packages/db/src/node-execution.js';
import type { ExecutionPolicy, ExecutionEvent } from '../packages/contracts/src/node-execution.js';
import { NodeRegistry } from '../packages/db/src/nodes.js';
import { branchContinuationFixture } from './helpers/branch-continuation.js';

type Fixture = Awaited<ReturnType<typeof branchContinuationFixture>>;
function note(f: Fixture, body = 'EDITED_SELECTED_NOTE'): NextInput {
  return f.as(() => {
    const feedback = f.api.store.addMessage(
      f.task.id,
      'RAW_FEEDBACK_NEVER_IN_PROMPT',
      f.saved.resultId,
      randomUUID(),
      f.saved.revisionId,
    );
    return new ResultFeedbackInputs(f.api.store).create(
      f.saved.resultId,
      f.saved.revisionId,
      feedback.id,
      { body },
      randomUUID(),
    );
  });
}
async function bodyWith(f: Fixture, inputs: Pick<NextInput, 'id' | 'revision'>[]) {
  const body = await f.body();
  return {
    ...body,
    workBranch: {
      ...body.workBranch,
      continueFrom: {
        ...body.workBranch.continueFrom!,
        inputs: inputs.map(({ id, revision }) => ({ id, revision })),
      },
    },
  };
}
const snapshot = (f: Fixture) =>
  [
    'runs',
    'tasks',
    'node_dispatches',
    'work_branches',
    'work_branch_events',
    'task_next_inputs',
    'outbox',
    'idempotency_records',
  ].map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
async function accept(f: Fixture) {
  const c = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection })).command!;
  await f.protocol(0, 'execution-event', {
    dispatchId: c.id,
    generation: c.generation,
    event: { sequence: 1, kind: 'accepted', text: '', result: null, terminationConfirmed: false },
  });
  return c;
}

/** A third, ordinarily paired directory on the same Task, through the existing HTTP protocol. */
async function ordinarySource(f: Fixture) {
  const token = randomBytes(32).toString('base64url'),
    workspace = randomUUID(),
    connectionId = randomUUID();
  const pairing = f.as(() => f.nodes.createPairing(f.project.id, randomUUID()));
  const node = f.nodes.pair({
    code: pairing.code!,
    nodeToken: token,
    clientId: randomUUID(),
    projectId: f.project.id,
    name: '普通接续协议节点',
    platform: 'linux',
    arch: 'x64',
    workspaces: [{ id: workspace, name: '未绑定方案的协议目录' }],
  });
  const protocol = async (path: string, body: unknown) => {
    const r = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/' + path,
      headers: { 'x-hexu-runner': '1', authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  await protocol('hello', { protocol: 1, connectionId });
  const capturedAt = new Date().toISOString();
  await protocol('sync', {
    connectionId,
    sequence: 1,
    snapshot: {
      capturedAt,
      workspaces: [
        {
          id: workspace,
          state: 'available',
          capturedAt,
          staged: 0,
          modified: 0,
          untracked: 0,
          conflicts: 0,
        },
      ],
    },
  });
  const policy: ExecutionPolicy = {
    grantId: randomUUID(),
    tool: 'claude-code',
    model: null,
    mode: 'edit',
    workspaceIds: [workspace],
    timeoutSeconds: 30,
    maxTurns: 8,
    maxBudgetUsd: 1,
    toolVersion: 'protocol fixture only',
  };
  await protocol('execution-policy', { connectionId, policy });
  const body = () => ({
    provider: 'node',
    nodeId: node.nodeId,
    workingCopyId: workspace,
    policyHash: executionHash(policy),
    mode: 'edit',
    prompt: 'ORDINARY_REQUEST',
    expectedRevision: f.as(() => f.api.store.getTask(f.task.id)).revision,
    confirmExecution: true,
  });
  const first = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body());
  assert.equal(first.statusCode, 201, first.body);
  const c = (await protocol('execution-poll', { connectionId })).command!;
  let sequence = 0;
  const send = (kind: ExecutionEvent['kind'], result: ExecutionEvent['result'] = null) =>
    protocol('execution-event', {
      dispatchId: c.id,
      generation: c.generation,
      event: {
        sequence: ++sequence,
        kind,
        result,
        text: '',
        terminationConfirmed: kind === 'terminal',
      },
    });
  await send('accepted');
  assert(
    (
      await protocol('execution-permit', {
        connectionId,
        dispatchId: c.id,
        generation: c.generation,
      })
    ).allowed,
  );
  await send('running');
  await send('terminal', 'succeeded');
  return { run: first.json(), body };
}

test('分支选择严格接受最多6条唯一修订，精确材料预览保留旧文本与预算', () => {
  const from = {
    sourceRunId: randomUUID(),
    expectedRunRevision: 1,
    resultRevisionId: randomUUID(),
    expectedSelectionRevision: 1,
  };
  const base = {
    branchId: randomUUID(),
    expectedRevision: 1,
    startHash: 'a'.repeat(64),
    continueFrom: from,
  };
  const refs = Array.from({ length: 6 }, () => ({ id: randomUUID(), revision: 1 }));
  assert.equal(
    parseBranchRunSelection({ ...base, continueFrom: { ...from, inputs: refs } }).continueFrom!
      .inputs!.length,
    6,
  );
  for (const inputs of [
    [...refs, { id: randomUUID(), revision: 1 }],
    [refs[0], refs[0]],
    [{ id: refs[0]!.id, revision: 0 }],
    [{ id: refs[0]!.id, revision: 1, body: 'spoof' }],
    null,
  ])
    assert.throws(() => parseBranchRunSelection({ ...base, continueFrom: { ...from, inputs } }));
  assert.equal(
    branchContinuationContext('BASE', 'PROMPT'),
    'BASE\n\n# 本次要求\nPROMPT\n\n只使用已授权文件工具。不得执行 Shell、MCP 或仓库脚本；缺少能力时如实说明。',
  );
  assert.throws(
    () =>
      branchContinuationContext(
        'BASE',
        'PROMPT',
        Array.from({ length: 3 }, () => ({ body: 'a'.repeat(2000), authorName: '甲' })),
      ),
    { code: 'MATERIAL_LIMIT' },
  );
  assert.throws(() => branchContinuationContext('a'.repeat(19999), 'PROMPT', []), {
    code: 'MATERIAL_LIMIT',
  });
});

test('显式队列选择精确进入已有分支dispatch，原反馈/未选要求不夹带，同键只绑定一次', async () => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f),
      unselected = note(f, 'UNSELECTED_NOTE');
    const options = await f.api.call(
      `tasks/${f.task.id}/node-options?workBranchId=${f.view.branches[0]!.id}&continueSelected=true`,
      f.alice,
    );
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().branchContinuation.inputOptions.length, 2);
    const body = await bodyWith(f, [selected]),
      key = randomUUID();
    const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(r.statusCode, 201, r.body);
    const run = r.json();
    assert.deepEqual(run.node.continuationInputIds, [selected.id]);
    assert.deepEqual(run.node.workBranch.continueFrom.inputs, [{ id: selected.id, revision: 1 }]);
    const c = await accept(f);
    assert.deepEqual(parseBranchExecutionBinding(c.workBranch), c.workBranch);
    assert.equal(
      c.context,
      branchContinuationContext(options.json().branchContinuation.contextText, body.prompt, [
        selected,
      ]),
    );
    assert(c.context.includes('EDITED_SELECTED_NOTE'));
    assert(!c.context.includes('RAW_FEEDBACK_NEVER_IN_PROMPT'));
    assert(!c.context.includes('UNSELECTED_NOTE'));
    const list = () => f.as(() => new NextInputs(f.api.store).list(f.task.id));
    assert.equal(list().find((i) => i.id === selected.id)!.state, 'attached');
    assert.deepEqual(
      list().find((i) => i.id === unselected.id),
      unselected,
    );
    const before = snapshot(f);
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).json().id,
      run.id,
    );
    assert.deepEqual(snapshot(f), before);
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body)).statusCode, 409);
    assert.throws(
      () => f.as(() => new NextInputs(f.api.store).edit(selected.id, 2, 'late edit', randomUUID())),
      { code: 'INPUT_BOUND' },
    );
    assert(
      (
        await f.protocol(0, 'execution-permit', {
          connectionId: f.ns[0]!.connection,
          dispatchId: c.id,
          generation: c.generation,
        })
      ).allowed,
    );
    await f.protocol(0, 'execution-event', {
      dispatchId: c.id,
      generation: c.generation,
      event: { sequence: 2, kind: 'running', text: '', result: null, terminationConfirmed: false },
    });
    assert.equal(list().find((i) => i.id === selected.id)!.state, 'started');
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).json().id,
      run.id,
    );
  } finally {
    await f.close();
  }
});

test('不选择保持原材料和队列；修改/撤回/跨Task/跨方案/普通Run/错成果版本不得携带', async () => {
  const f = await branchContinuationFixture(undefined, true);
  try {
    const selected = note(f),
      queue = new NextInputs(f.api.store);
    const other = f.as(() => queue.create(f.peer!.run.id, 'OTHER_BRANCH_NOTE', randomUUID()));
    let r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await bodyWith(f, [other]));
    assert.equal(r.statusCode, 409, r.body);
    const foreign = await f.api.task(f.alice, f.project.id);
    const ordinaryId = randomUUID(),
      original = f.as(() => f.api.store.run(f.source.run.id));
    f.api.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(
      ordinaryId,
      f.task.id,
      JSON.stringify({
        ...original,
        id: ordinaryId,
        node: { ...original.node, workBranch: undefined },
      }),
    );
    const ordinary = f.as(() => queue.create(ordinaryId, 'ORDINARY_NOTE', randomUUID()));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await bodyWith(f, [ordinary])))
        .statusCode,
      409,
    );
    f.api.store.db.prepare('DELETE FROM runs WHERE id=?').run(ordinaryId);
    const foreignNote = { ...selected, id: randomUUID(), taskId: foreign.id };
    f.api.store.db
      .prepare('INSERT INTO task_next_inputs VALUES(?,?,?,?,?)')
      .run(foreignNote.id, foreign.id, 'queued', null, JSON.stringify(foreignNote));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await bodyWith(f, [foreignNote])))
        .statusCode,
      409,
    );
    const wrongVersion = {
      ...selected,
      id: randomUUID(),
      origin: { ...selected.origin!, resultRevisionId: randomUUID() },
    };
    f.api.store.db
      .prepare('INSERT INTO task_next_inputs VALUES(?,?,?,?,?)')
      .run(wrongVersion.id, f.task.id, 'queued', null, JSON.stringify(wrongVersion));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await bodyWith(f, [wrongVersion])))
        .statusCode,
      409,
    );
    const edited = f.as(() => queue.edit(selected.id, 1, 'CHANGED_NOTE', randomUUID()));
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await bodyWith(f, [selected])))
        .statusCode,
      409,
    );
    const staleBody = await bodyWith(f, [edited]);
    f.as(() => queue.edit(edited.id, 2, null, randomUUID()));
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, staleBody)).statusCode, 409);
    const kept = note(f, 'STILL_QUEUED');
    const body = await f.body();
    r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body);
    assert.equal(r.statusCode, 201, r.body);
    const c = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection }))
      .command!;
    assert(!c.context.includes('STILL_QUEUED'));
    assert(!c.context.includes('# 明确选择的下一轮要求'));
    assert.deepEqual(
      f.as(() => queue.list(f.task.id)).find((i) => i.id === kept.id),
      kept,
    );
  } finally {
    await f.close();
  }
});

test('原反馈Run可不同于最新前驱，明确未许可取消归还队列', async () => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f),
      queue = new NextInputs(f.api.store);
    const first = await f.api.call(
      `tasks/${f.task.id}/runs`,
      f.alice,
      await bodyWith(f, [selected]),
    );
    assert.equal(first.statusCode, 201, first.body);
    await f.api.call(`runs/${first.json().id}/stop`, f.alice, {});
    const restored = f.as(() => queue.list(f.task.id)).find((i) => i.id === selected.id)!;
    assert.equal(restored.state, 'queued');
    assert.equal(restored.targetRunId, null);
    assert.deepEqual(restored.origin, selected.origin);
    const secondBody = await bodyWith(f, [restored]);
    assert.equal(secondBody.workBranch.continueFrom.sourceRunId, first.json().id);
    assert.notEqual(restored.sourceRunId, first.json().id);
    const second = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, secondBody);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().previousRunId, first.json().id);
    assert.equal(
      f.as(() => queue.list(f.task.id)).find((i) => i.id === selected.id)!.targetRunId,
      second.json().id,
    );
  } finally {
    await f.close();
  }
});

test('所选成果换到同方案新版本时不能隐式采用旧反馈，重新选回原版本才可用', async () => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f);
    const version = f.as(() =>
      new ResultRevisions(f.api.store).get(f.saved.resultId, f.saved.revisionId),
    );
    assert(version.source.kind === 'work_branch' && version.source.code !== 'not_captured');
    const next = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: 'ANOTHER_EXPLICIT_RESULT_VERSION',
      codeCheckpointId: version.source.code.checkpoint.id,
    });
    assert.equal(next.statusCode, 201, next.body);
    const choose = await f.api.call(f.choicePath, f.alice, {
      ...f.choice,
      expectedSelectionRevision: 1,
      resultRevisionId: next.json().revisionId,
    });
    assert.equal(choose.statusCode, 200, choose.body);
    const options = await f.api.call(
      `tasks/${f.task.id}/node-options?workBranchId=${f.view.branches[0]!.id}&continueSelected=true`,
      f.alice,
    );
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().branchContinuation.inputOptions.length, 0);
    const denied = await f.api.call(
      `tasks/${f.task.id}/runs`,
      f.alice,
      await bodyWith(f, [selected]),
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error.code, 'BRANCH_INPUT_SCOPE_CHANGED');
    await f.api.call(f.choicePath, f.alice, { ...f.choice, expectedSelectionRevision: 2 });
    const restored = await f.api.call(
      `tasks/${f.task.id}/runs`,
      f.alice,
      await bodyWith(f, [selected]),
    );
    assert.equal(restored.statusCode, 201, restored.body);
    assert.equal(restored.json().node.workBranch.continueFrom.resultRevisionId, f.saved.revisionId);
  } finally {
    await f.close();
  }
});

test('选择在许可前变化归还要求，许可后未知保持绑定，重启不重放或归还未知', async () => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f),
      queue = new NextInputs(f.api.store);
    const first = await f.api.call(
      `tasks/${f.task.id}/runs`,
      f.alice,
      await bodyWith(f, [selected]),
    );
    assert.equal(first.statusCode, 201, first.body);
    const c = await accept(f);
    await f.api.call(f.choicePath, f.alice, {
      expectedSelectionRevision: 1,
      branchId: null,
      resultRevisionId: null,
      note: '',
    });
    assert.equal(
      (
        await f.protocol(0, 'execution-permit', {
          connectionId: f.ns[0]!.connection,
          dispatchId: c.id,
          generation: c.generation,
        })
      ).allowed,
      false,
    );
    const restored = f.as(() => queue.list(f.task.id))[0]!;
    assert.equal(restored.state, 'queued');
    await f.api.call(f.choicePath, f.alice, { ...f.choice, expectedSelectionRevision: 2 });
    const second = await f.api.call(
      `tasks/${f.task.id}/runs`,
      f.alice,
      await bodyWith(f, [restored]),
    );
    assert.equal(second.statusCode, 201, second.body);
    const d = await accept(f);
    assert(
      (
        await f.protocol(0, 'execution-permit', {
          connectionId: f.ns[0]!.connection,
          dispatchId: d.id,
          generation: d.generation,
        })
      ).allowed,
    );
    await f.protocol(0, 'execution-event', {
      dispatchId: d.id,
      generation: d.generation,
      event: {
        sequence: 2,
        kind: 'unknown',
        text: 'start unknown',
        result: null,
        terminationConfirmed: false,
      },
    });
    const attached = f.as(() => queue.list(f.task.id))[0]!;
    assert.equal(attached.state, 'attached');
    const db = new Store(f.api.dbPath, undefined, { team: true });
    try {
      new NodeExecution(db, new NodeRegistry(db));
      db.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () => {
        assert.deepEqual(new NextInputs(db).list(f.task.id)[0], attached);
        assert.equal(db.run(second.json().id).observation, 'unknown');
      });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('绑定与Run/重开/分支/派发/回执整体回滚，许可校验原绑定修订', async () => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f);
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    const body = await bodyWith(f, [selected]),
      key = randomUUID(),
      before = snapshot(f);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_input_attach BEFORE UPDATE ON task_next_inputs BEGIN SELECT RAISE(ABORT,'fixture binding failed'); END;",
    );
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).statusCode, 500);
    assert.deepEqual(snapshot(f), before);
    f.api.store.db.exec('DROP TRIGGER fail_input_attach');
    const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(r.statusCode, 201, r.body);
    const c = await accept(f);
    const attached = f.as(() => new NextInputs(f.api.store).list(f.task.id))[0]!;
    f.api.store.db
      .prepare('UPDATE task_next_inputs SET body=? WHERE id=?')
      .run(JSON.stringify({ ...attached, revision: attached.revision + 1 }), attached.id);
    assert.equal(
      (
        await f.protocol(0, 'execution-permit', {
          connectionId: f.ns[0]!.connection,
          dispatchId: c.id,
          generation: c.generation,
        })
      ).allowed,
      false,
    );
    assert.equal(f.as(() => f.api.store.run(r.json().id)).state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('固定反馈要求不能借同Task另一普通目录的直接接续或Operation绕过方案版本选择', async () => {
  const f = await branchContinuationFixture();
  try {
    const fixed = note(f),
      queue = new NextInputs(f.api.store);
    const ordinary = await ordinarySource(f);
    assert.equal(ordinary.run.node.workBranch, undefined);
    const preview = await f.api.call(
      `tasks/${f.task.id}/node-continuation-preview?sourceRunId=${ordinary.run.id}`,
      f.alice,
    );
    assert.equal(preview.statusCode, 200, preview.body);
    assert(preview.json().ready);
    const continuation = {
      sourceRunId: ordinary.run.id,
      expectedContextHash: preview.json().contextHash,
      inputs: [{ id: fixed.id, revision: fixed.revision }],
    };
    const body = { ...ordinary.body(), continuation };
    const waiting = await f.api.call(
      `tasks/${f.task.id}/node-continuation-preview?sourceRunId=${ordinary.run.id}&waiting=true`,
      f.alice,
    );
    assert.equal(waiting.statusCode, 200, waiting.body);
    const operationBody = {
      ...body,
      continuation: { ...continuation, expectedContextHash: waiting.json().contextHash },
    };
    const before = snapshot(f),
      operations = f.api.store.db
        .prepare('SELECT COUNT(*) AS n FROM node_continuation_operations')
        .get()!.n;
    for (const [route, input] of [
      [`tasks/${f.task.id}/runs`, body],
      [`tasks/${f.task.id}/continuations`, { ...operationBody, onActiveRun: 'wait' }],
      [`tasks/${f.task.id}/continuations`, { ...operationBody, onActiveRun: 'request_stop' }],
    ] as const) {
      const r = await f.api.call(route, f.alice, input);
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error.code, 'BRANCH_INPUT_SCOPE_CHANGED');
      assert.deepEqual(snapshot(f), before);
      assert.equal(
        f.api.store.db.prepare('SELECT COUNT(*) AS n FROM node_continuation_operations').get()!.n,
        operations,
      );
    }
    assert.throws(
      () =>
        f.as(() =>
          f.api.store.atomic(() => queue.attach(f.task.id, continuation, ordinary.run.id)),
        ),
      { code: 'BRANCH_INPUT_SCOPE_CHANGED' },
    );
    assert.deepEqual(
      f.as(() => queue.get(fixed.id)),
      fixed,
    );
    // Preserve prior task-wide semantics for manually authored notes without fixed feedback origin.
    const existing = f.as(() =>
      queue.create(f.source.run.id, 'EXISTING_TASK_NOTE_WITHOUT_ORIGIN', randomUUID()),
    );
    const compatible = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, {
      ...ordinary.body(),
      continuation: { ...continuation, inputs: [{ id: existing.id, revision: existing.revision }] },
    });
    assert.equal(compatible.statusCode, 201, compatible.body);
    assert.equal(f.as(() => queue.get(existing.id)).state, 'attached');
    assert.deepEqual(
      f.as(() => queue.get(fixed.id)),
      fixed,
    );
  } finally {
    await f.close();
  }
});

test('新/旧回执事务内重新核对权限，已绑定要求不能借撤权或非本人节点再次执行', async (t) => {
  const f = await branchContinuationFixture();
  try {
    const selected = note(f),
      body = await bodyWith(f, [selected]),
      key = randomUUID();
    const saved = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(saved.statusCode, 201, saved.body);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.bob, body, key)).statusCode, 403);
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
          .run(f.project.id, f.alice.user.id);
        return original(scope, k, payload, action, beforeReplay);
      },
    );
    const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(r.statusCode, 403, r.body);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
