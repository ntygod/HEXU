import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { branchContinuationFixture } from './helpers/branch-continuation.js';
import { parseNodeRun } from '../packages/contracts/src/node-execution.js';
import { parseBranchRunSelection } from '../packages/contracts/src/work-branch-workspaces.js';
import { Store } from '../packages/db/src/store.js';
import { NodeExecution } from '../packages/db/src/node-execution.js';
import { NodeRegistry } from '../packages/db/src/nodes.js';

test('方案继续只接受明确版本/选择/来源，不接受目录、伪造代码和会话参数', () => {
  const selection = {
    branchId: randomUUID(),
    expectedRevision: 3,
    startHash: 'a'.repeat(64),
    continueFrom: {
      sourceRunId: randomUUID(),
      expectedRunRevision: 5,
      resultRevisionId: randomUUID(),
      expectedSelectionRevision: 1,
    },
  };
  assert.equal(parseBranchRunSelection(selection).continueFrom!.expectedSelectionRevision, 1);
  for (const extra of [
    { commit: 'b'.repeat(40) },
    { mode: 'current-dirty' },
    { expectedSelectionRevision: 0 },
    { sourceRunId: '../source' },
  ])
    assert.throws(() =>
      parseBranchRunSelection({
        ...selection,
        continueFrom: { ...selection.continueFrom, ...extra },
      }),
    );
});

test('从固定版本新建Run保持来源和选择，材料不夹带其他方案/后来输出/反馈，重复回执不重跑', async () => {
  const f = await branchContinuationFixture(undefined, true);
  try {
    const peer = f.peer!;
    await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: 'LATER_FEEDBACK_NOT_SELECTED',
      resultId: f.saved.resultId,
      resultRevisionId: f.saved.revisionId,
    });
    const sourceBefore = f.as(() => f.api.store.run(f.source.run.id)),
      choiceBefore = f.read().selection;
    const body = await f.body(),
      key = randomUUID();
    const reply = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(reply.statusCode, 201, reply.body);
    const run = reply.json();
    assert.notEqual(run.id, f.source.run.id);
    assert.equal(run.previousRunId, f.source.run.id);
    assert.equal(run.node.workBranch.continueFrom.resultRevisionId, f.saved.revisionId);
    assert.equal(run.node.workBranch.continueFrom.code.commit, f.target.commit);
    assert.equal(run.node.workBranch.commit, f.base.commit);
    assert.deepEqual(
      f.as(() => f.api.store.run(f.source.run.id)),
      sourceBefore,
    );
    assert.deepEqual(f.read().selection, choiceBefore);
    assert.equal(
      (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).json().id,
      run.id,
    );
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body)).statusCode, 409);
    const c = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection }))
      .command!;
    assert(c.context.includes(f.saved.body.body));
    assert(c.context.includes('CONTINUED_PROMPT_ONLY'));
    assert(c.context.includes(f.target.commit));
    assert(!c.context.includes('UNSELECTED_RUN_OUTPUT'));
    assert(!c.context.includes('LATER_FEEDBACK_NOT_SELECTED'));
    assert(!c.context.includes('后台异步导出'));
    await f.protocol(0, 'execution-event', {
      dispatchId: c.id,
      generation: c.generation,
      event: { sequence: 1, kind: 'accepted', text: '', result: null, terminationConfirmed: false },
    });
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
    await f.api.call(f.choicePath, f.alice, {
      expectedSelectionRevision: 1,
      branchId: null,
      resultRevisionId: null,
      note: '修改选择不停止已启动执行',
    });
    await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection });
    assert.equal(f.as(() => f.api.store.run(run.id)).state, 'running');
    await f.api.call(`runs/${run.id}/stop`, f.alice, {});
    assert.equal(f.as(() => f.api.store.run(run.id)).state, 'stopping');
    assert.equal(f.as(() => f.api.store.run(peer.run.id)).state, 'running');
    assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'in_progress');
    await f.protocol(0, 'execution-event', {
      dispatchId: c.id,
      generation: c.generation,
      event: {
        sequence: 3,
        kind: 'terminal',
        text: '停止后保留已有内容',
        result: 'cancelled',
        terminationConfirmed: true,
      },
    });
    const saved = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '接续后的部分成果',
    });
    assert.equal(saved.statusCode, 201, saved.body);
    const version = (await f.api.call(`results/${saved.json().resultId}`, f.alice)).json().version;
    assert.equal(version.source.run.id, run.id);
    assert.equal(version.source.run.continueFrom.resultRevisionId, f.saved.revisionId);
    assert.equal(version.source.run.continueFrom.code.commit, f.target.commit);
    assert.equal(version.source.run.state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('选择更换/错误来源/来源修订/混用普通接续和恢复均拒绝，未创建半个Run', async () => {
  const f = await branchContinuationFixture();
  try {
    const body = await f.body(),
      from = body.workBranch.continueFrom!;
    for (const extra of [
      { sourceRunId: randomUUID() },
      { expectedRunRevision: from.expectedRunRevision - 1 },
      { resultRevisionId: randomUUID() },
      { expectedSelectionRevision: from.expectedSelectionRevision + 1 },
    ]) {
      const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, {
        ...body,
        workBranch: { ...body.workBranch, continueFrom: { ...from, ...extra } },
      });
      assert([404, 409].includes(r.statusCode), r.body);
    }
    for (const extra of [
      { sessionMode: 'resume' },
      { projectMaterials: [] },
      {
        continuation: {
          sourceRunId: from.sourceRunId,
          expectedContextHash: 'a'.repeat(64),
          inputs: [],
        },
      },
    ])
      assert.throws(() => parseNodeRun({ ...body, ...extra }));
    assert.equal(
      (
        await f.api.call(
          `tasks/${f.task.id}/node-continuation-preview?sourceRunId=${from.sourceRunId}`,
          f.alice,
        )
      ).statusCode,
      409,
    );
    await f.api.call(f.choicePath, f.alice, {
      expectedSelectionRevision: 1,
      branchId: null,
      resultRevisionId: null,
      note: '',
    });
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body)).statusCode, 409);
    assert.equal(f.as(() => f.api.store.runs(f.task.id)).length, 1);
  } finally {
    await f.close();
  }
});

test('选择在排队/接单后变化会取消未许可派发，未知原Run不能继续', async () => {
  const f = await branchContinuationFixture();
  try {
    const body = await f.body(),
      reply = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body);
    assert.equal(reply.statusCode, 201, reply.body);
    const c = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection }))
      .command!;
    await f.protocol(0, 'execution-event', {
      dispatchId: c.id,
      generation: c.generation,
      event: { sequence: 1, kind: 'accepted', text: '', result: null, terminationConfirmed: false },
    });
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
    assert.equal(f.as(() => f.api.store.run(reply.json().id)).state, 'cancelled');
    await f.api.call(f.choicePath, f.alice, { ...f.choice, expectedSelectionRevision: 2 });
    const next = await f.body();
    assert.equal(next.workBranch.continueFrom!.sourceRunId, reply.json().id);
    const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, next);
    assert.equal(r.statusCode, 201, r.body);
    const d = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection }))
      .command!;
    await f.protocol(0, 'execution-event', {
      dispatchId: d.id,
      generation: d.generation,
      event: {
        sequence: 1,
        kind: 'unknown',
        text: '现场未知',
        result: null,
        terminationConfirmed: false,
      },
    });
    assert.equal(
      (
        await f.api.call(
          `tasks/${f.task.id}/node-options?workBranchId=${f.view.branches[0]!.id}&continueSelected=true`,
          f.alice,
        )
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('新Run、分支、任务重开、历史和回执共同回滚，之后明确重试保留原成果', async () => {
  const f = await branchContinuationFixture();
  try {
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    const body = await f.body(),
      key = randomUUID();
    assert(body.reopenTask);
    const tables = [
      'runs',
      'tasks',
      'work_branches',
      'work_branch_events',
      'node_dispatches',
      'outbox',
      'idempotency_records',
    ];
    const snapshot = () =>
      tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_followup BEFORE INSERT ON work_branch_events WHEN json_extract(NEW.body,'$.action')='run_created' BEGIN SELECT RAISE(ABORT,'fixture followup failure'); END;",
    );
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).statusCode, 500);
    assert.deepEqual(snapshot(), before);
    f.api.store.db.exec('DROP TRIGGER fail_followup');
    const saved = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'todo');
    assert.equal(f.read().selection!.resultRevisionId, f.saved.revisionId);
    assert.equal(
      (await f.api.call(`results/${f.saved.resultId}/versions/${f.saved.revisionId}`, f.alice))
        .statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test('重开数据库不重放付费派发，旧回执仍受本人节点与项目当前权限保护', async () => {
  const f = await branchContinuationFixture();
  try {
    const body = await f.body(),
      key = randomUUID();
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.bob, body)).statusCode, 403);
    const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
    assert.equal(r.statusCode, 201, r.body);
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      new NodeExecution(reopened, new NodeRegistry(reopened));
      assert.equal(
        reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
          reopened.run(r.json().id),
        ).state,
        'cancelled',
      );
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 2);
    } finally {
      reopened.close();
    }
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal((await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).statusCode, 409);
  } finally {
    await f.close();
  }
});
