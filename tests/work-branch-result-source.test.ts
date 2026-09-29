import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Run } from '../packages/contracts/src/index.js';
import type { ExecutionEvent } from '../packages/contracts/src/node-execution.js';
import type { WorkBranchResultSource } from '../packages/contracts/src/work-branch-result-source.js';
import { branchWorkspaceFixture } from './helpers/branch-workspace.js';

const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
type EventRow = { dispatch_id: string; sequence: number; event_hash: string; body: string };

test('真实节点方案的成果来源预览与记录边界', async (t) => {
  const f = await branchWorkspaceFixture();
  try {
    const prepared = await f.prepare();
    await f.pairBranch(prepared.p);
    await f.bindBranch(prepared.p);
    const node = await f.enableBranch(prepared.p);
    const created = await f.runBranch(0, node);
    assert.equal(created.reply.statusCode, 201, created.reply.body);
    const path = prepared.path + '/result-source';
    const read = () => f.api.call(path, f.alice);
    assert.equal((await read()).statusCode, 409);
    for (let i = 0; i < 120; i++) {
      await f.tick();
      if ((await f.read()).branches[0]!.run?.state === 'succeeded') break;
      await pause();
    }
    const branch = (await f.read()).branches[0]!;
    assert.equal(branch.run?.state, 'succeeded');
    const db = f.api.store.db;
    const tables = [
      'tasks',
      'runs',
      'results',
      'work_branches',
      'work_branch_events',
      'node_dispatches',
      'node_run_events',
      'idempotency_records',
      'outbox',
    ];
    const before = tables.map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()));
    const response = await read();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    const source = response.json() as WorkBranchResultSource;
    assert.equal(source.run.id, created.run.id);
    assert.equal(source.branchId, branch.id);
    assert.equal(source.run.state, 'succeeded');
    assert.equal(source.evidence.toolReportedSuccess, true);
    assert.equal(source.code.status, 'not_captured');
    assert.equal(source.startHash, f.view.group.startHash);
    assert.match(source.input.context, /COMMON_BRANCH_INPUT/);
    assert.match(source.input.context, /ALPHA_ONLY/);
    assert.doesNotMatch(source.input.context, /BETA_ONLY/);
    assert.match(source.sourceHash, /^[a-f0-9]{64}$/);
    assert(!('nativeSession' in source.run));
    assert(!('generation' in source));
    assert.equal((await read()).json().sourceHash, source.sourceHash);
    assert.deepEqual(
      tables.map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())),
      before,
    );
    assert.equal((await f.read()).branches[0]!.resultId, null);
    assert.equal((await f.read()).branches[0]!.state, 'active');

    await t.test('后续任务说明不会替换共同输入，未执行方案与跨任务ID拒绝', async () => {
      const detail = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json();
      const patch = await f.api.call(
        `tasks/${f.task.id}`,
        f.alice,
        { expectedRevision: detail.task.revision, description: 'AFTER_SOURCE_NOT_INPUT' },
        randomUUID(),
        'PATCH',
      );
      assert.equal(patch.statusCode, 200, patch.body);
      assert.equal((await read()).json().sourceHash, source.sourceHash);
      const second = f.view.branches[1]!;
      const missing = await f.api.call(
        `tasks/${f.task.id}/work-branches/${second.id}/result-source`,
        f.alice,
      );
      assert.equal(missing.statusCode, 409);
      assert.equal(missing.json().error.code, 'WORK_BRANCH_RESULT_NO_RUN');
      const other = await f.api.task(f.alice, f.project.id);
      const otherReply = await f.api.call(
        `tasks/${other.id}/work-branches/${branch.id}/result-source`,
        f.alice,
      );
      assert.equal(otherReply.statusCode, 404);
    });

    const savedRun = db.prepare('SELECT body FROM runs WHERE id=?').get(created.run.id) as {
      body: string;
    };
    const runBody = savedRun.body;
    const run = JSON.parse(runBody) as Run;
    const dispatchId = run.node!.dispatchId;
    await t.test('活动、未知、未确认终止和其他方案来源均拒绝', async () => {
      try {
        for (const changed of [
          { ...run, state: 'running' },
          { ...run, observation: 'unknown' },
          { ...run, node: { ...run.node!, terminationConfirmed: false } },
          { ...run, node: { ...run.node!, phase: 'unknown' } },
          {
            ...run,
            node: {
              ...run.node!,
              workBranch: { ...run.node!.workBranch!, branchId: randomUUID() },
            },
          },
        ]) {
          db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(changed), run.id);
          assert.equal((await read()).statusCode, 409);
        }
      } finally {
        db.prepare('UPDATE runs SET body=? WHERE id=?').run(runBody, run.id);
      }
      const row = db.prepare('SELECT command FROM node_dispatches WHERE id=?').get(dispatchId) as {
        command: string;
      };
      try {
        const command = JSON.parse(row.command);
        command.runId = randomUUID();
        db.prepare('UPDATE node_dispatches SET command=? WHERE id=?').run(
          JSON.stringify(command),
          dispatchId,
        );
        assert.equal((await read()).statusCode, 409);
      } finally {
        db.prepare('UPDATE node_dispatches SET command=? WHERE id=?').run(row.command, dispatchId);
      }
    });

    const originalEvents = db
      .prepare('SELECT * FROM node_run_events WHERE dispatch_id=? ORDER BY sequence')
      .all(dispatchId) as EventRow[];
    const sequenceRow = db
      .prepare('SELECT last_sequence FROM node_dispatches WHERE id=?')
      .get(dispatchId) as { last_sequence: number };
    const originalSequence = sequenceRow.last_sequence;
    const replaceEvents = (events: ExecutionEvent[]) => {
      db.prepare('DELETE FROM node_run_events WHERE dispatch_id=?').run(dispatchId);
      for (const event of events)
        db.prepare('INSERT INTO node_run_events VALUES(?,?,?,?)').run(
          dispatchId,
          event.sequence,
          'fixture-hash',
          JSON.stringify(event),
        );
      db.prepare('UPDATE node_dispatches SET last_sequence=? WHERE id=?').run(
        events.length,
        dispatchId,
      );
    };
    const restoreEvents = () => {
      db.prepare('DELETE FROM node_run_events WHERE dispatch_id=?').run(dispatchId);
      for (const row of originalEvents)
        db.prepare('INSERT INTO node_run_events VALUES(?,?,?,?)').run(
          row.dispatch_id,
          row.sequence,
          row.event_hash,
          row.body,
        );
      db.prepare('UPDATE node_dispatches SET last_sequence=? WHERE id=?').run(
        originalSequence,
        dispatchId,
      );
      db.prepare('UPDATE runs SET body=? WHERE id=?').run(runBody, run.id);
    };
    const outputEvent = (sequence: number, text: string): ExecutionEvent => ({
      sequence,
      kind: 'output',
      text,
      result: null,
      terminationConfirmed: false,
    });
    const terminalEvent = (sequence: number): ExecutionEvent => ({
      sequence,
      kind: 'terminal',
      text: 'fixture settled',
      result: 'succeeded',
      terminationConfirmed: true,
    });
    await t.test('输出截取的摘要覆盖尾部，终态后的迟到输出不混入成果', async () => {
      try {
        const events = [
          outputEvent(1, '中'.repeat(6000)),
          outputEvent(2, '尾'.repeat(6000)),
          terminalEvent(3),
        ];
        replaceEvents(events);
        const firstResponse = await read();
        assert.equal(firstResponse.statusCode, 200, firstResponse.body);
        const first = firstResponse.json() as WorkBranchResultSource;
        assert.equal(first.output.retainedBytes, 24 * 1024 - 1);
        assert.equal(first.output.truncated, true);
        events[1] = outputEvent(2, '尾'.repeat(5999) + '变');
        replaceEvents(events);
        const second = (await read()).json() as WorkBranchResultSource;
        assert.equal(second.output.text, first.output.text);
        assert.notEqual(second.output.digest, first.output.digest);
        assert.notEqual(second.sourceHash, first.sourceHash);
        replaceEvents([...events, outputEvent(4, 'LATE_OUTPUT_MUST_NOT_APPEAR')]);
        const late = (await read()).json() as WorkBranchResultSource;
        assert.equal(late.output.digest, second.output.digest);
        assert.equal(late.evidence.receivedThroughSequence, 4);
        assert.equal(late.evidence.includedThroughSequence, 3);
        assert.equal(late.evidence.ignoredAfterTerminal, 1);
        assert.doesNotMatch(late.output.text, /LATE_OUTPUT/);
      } finally {
        restoreEvents();
      }
    });
    await t.test('失败终态保留有用输出但不标工具成功，缺失事件不伪造完整记录', async () => {
      try {
        replaceEvents([
          outputEvent(1, 'useful partial output'),
          { ...terminalEvent(2), result: 'failed' },
        ]);
        db.prepare('UPDATE runs SET body=? WHERE id=?').run(
          JSON.stringify({ ...run, state: 'failed' }),
          run.id,
        );
        const failedResponse = await read();
        assert.equal(failedResponse.statusCode, 200, failedResponse.body);
        const failed = failedResponse.json() as WorkBranchResultSource;
        assert.equal(failed.run.state, 'failed');
        assert.equal(failed.output.text, 'useful partial output');
        assert.equal(failed.evidence.toolReportedSuccess, false);
        const deletion = db.prepare(
          'DELETE FROM node_run_events WHERE dispatch_id=? AND sequence=1',
        );
        deletion.run(dispatchId);
        assert.equal((await read()).statusCode, 409);
      } finally {
        restoreEvents();
      }
    });
    await t.test('当前项目读取权限覆盖来源预览，撤权后旧URL不可继续读取', async () => {
      const invitation = await f.api.invite(f.alice);
      const bob = await f.api.joinAccount(invitation.token);
      assert.equal((await f.api.call(path, bob)).statusCode, 404);
      await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, {
        role: 'view',
      });
      assert.equal((await f.api.call(path, bob)).statusCode, 200);
      await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, { role: null });
      assert.equal((await f.api.call(path, bob)).statusCode, 404);
    });
  } finally {
    await f.close();
  }
});
