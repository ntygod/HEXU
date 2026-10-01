import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run } from '../packages/contracts/src/index.js';
import { activeRunStates } from '../packages/domain/src/index.js';
import {
  RESULT_TASK_ACTIVITY_PAGE_SIZE,
  summarizeResultTaskActivity,
} from '../packages/domain/src/result-task-activity.js';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    taskId: 'task-current',
    state: 'running',
    observation: 'fresh',
    provider: 'mock',
    requestedTool: 'claude-code',
    scenario: 'success',
    previousRunId: null,
    prompt: 'Private prompt must never become an activity row label',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

test('成果任务活动沿用全部六个活动状态，不把停止请求当作停止确认', () => {
  assert.equal(activeRunStates.length, 6);
  for (const state of activeRunStates) {
    const item = run(`run-${state}`, { state });
    const summary = summarizeResultTaskActivity('task-current', [item]);
    assert.equal(summary.total, 1, state);
    assert.equal(summary.unknown, 0, state);
    assert.equal(summary.stopping, state === 'stopping' ? 1 : 0, state);
    assert.equal(summary.otherActive, state === 'stopping' ? 0 : 1, state);
    assert.deepEqual(summary.rows, [item]);
  }
});

test('所有终态的连接未知仍计入；新鲜终态不计入', () => {
  for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
    const unknown = run(`${state}-unknown`, { state, observation: 'unknown' });
    const summary = summarizeResultTaskActivity('task-current', [run(state, { state }), unknown]);
    assert.equal(summary.total, 1);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.stopping, 0);
    assert.equal(summary.otherActive, 0);
    assert.deepEqual(summary.rows, [unknown]);
  }
});

test('未知优先于正在停止与其他活动，三个分类互斥且加总为精确总数', () => {
  const items = [
    run('stopping-unknown', { state: 'stopping', observation: 'unknown' }),
    run('running-unknown', { observation: 'unknown' }),
    run('failed-unknown', { state: 'failed', observation: 'unknown' }),
    run('stopping', { state: 'stopping' }),
    run('waiting', { state: 'waiting_approval' }),
    run('queued', { state: 'queued' }),
  ];
  const summary = summarizeResultTaskActivity('task-current', items);
  assert.equal(summary.total, 6);
  assert.equal(summary.unknown, 3);
  assert.equal(summary.stopping, 1);
  assert.equal(summary.otherActive, 2);
  assert.equal(summary.total, summary.unknown + summary.stopping + summary.otherActive);
});

test('普通、方案、AI协助执行全部独立计入，不筛选单个提供方或方案', () => {
  const branch = run('branch', {
    provider: 'node',
    node: {
      nodeId: 'node-1',
      nodeName: 'Node',
      workingCopyId: 'working-copy-1',
      workingCopyName: 'Working copy',
      dispatchId: 'dispatch-1',
      policyHash: 'a'.repeat(64),
      mode: 'read-only',
      model: null,
      timeoutSeconds: 60,
      maxBudgetUsd: null,
      phase: 'running',
      terminationConfirmed: false,
      workBranch: {
        branchId: 'branch-1',
        groupId: 'group-1',
        operationId: 'operation-1',
        startHash: 'b'.repeat(64),
        originHash: 'c'.repeat(64),
        commit: 'd'.repeat(40),
      },
    },
  });
  const items = [
    run('ordinary'),
    branch,
    run('assist', { provider: 'native', purpose: 'assist', assistanceId: 'assistance-1' }),
  ];
  const summary = summarizeResultTaskActivity('task-current', items);
  assert.equal(summary.total, 3);
  assert.deepEqual(
    summary.rows.map((item) => item.id),
    ['assist', 'branch', 'ordinary'],
  );
});

test('较新的终态不遮蔽同任务较早的活动或未知执行', () => {
  const older = run('older-active');
  const unknown = run('older-unknown', { state: 'cancelled', observation: 'unknown' });
  const newest = run('newest-terminal', {
    state: 'succeeded',
    createdAt: '2026-10-01T01:00:00.000Z',
    previousRunId: older.id,
  });
  const summary = summarizeResultTaskActivity('task-current', [older, unknown, newest]);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.rows, [older, unknown]);
});

test('其他Task的活动和未知执行始终排除', () => {
  const current = run('current');
  const summary = summarizeResultTaskActivity('task-current', [
    run('other-active', { taskId: 'another-task' }),
    run('other-unknown', { taskId: 'another-task', state: 'failed', observation: 'unknown' }),
    current,
  ]);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.rows, [current]);
});

test('旧原生终态缺少终止字段不推断为未知，也不重写已有观察状态', () => {
  const native: NonNullable<Run['native']> = {
    workingCopyId: 'legacy-working-copy',
    mode: 'read-only',
    model: null,
    maxTurns: 1,
    maxBudgetUsd: null,
    timeoutSeconds: 60,
    toolVersion: 'fixture',
    contextText: 'Private context is unrelated to summary eligibility',
    contextHash: 'e'.repeat(64),
  };
  for (const termination of [undefined, false, true]) {
    const item = run('legacy-native', {
      provider: 'native',
      state: 'succeeded',
      native: {
        ...native,
        ...(termination === undefined ? {} : { terminationConfirmed: termination }),
      },
    });
    assert.equal(summarizeResultTaskActivity('task-current', [item]).total, 0);
    assert.equal(
      summarizeResultTaskActivity('task-current', [{ ...item, observation: 'unknown' }]).unknown,
      1,
    );
  }
});

test('超过五条按创建时间从新到旧分页，所有记录均可到达而总数不随页变化', () => {
  const items = Array.from({ length: 13 }, (_, index) =>
    run(`run-${index}`, { createdAt: `2026-10-01T00:${String(index).padStart(2, '0')}:00.000Z` }),
  );
  assert.equal(RESULT_TASK_ACTIVITY_PAGE_SIZE, 5);
  const pages = [1, 2, 3].map((page) => summarizeResultTaskActivity('task-current', items, page));
  assert.deepEqual(
    pages.map((page) => page.rows.length),
    [5, 5, 3],
  );
  for (const page of pages) {
    assert.equal(page.pageCount, 3);
    assert.equal(page.total, 13);
    assert.equal(page.otherActive, 13);
  }
  assert.deepEqual(
    pages.flatMap((page) => page.rows),
    [...items].reverse(),
  );
});

test('活动快照缩小时夹到最后有效页，全部结束时回到空的第一页', () => {
  const items = Array.from({ length: 11 }, (_, index) => run(`run-${index}`));
  assert.equal(summarizeResultTaskActivity('task-current', items, 3).page, 3);
  const smaller = summarizeResultTaskActivity('task-current', items.slice(0, 6), 3);
  assert.equal(smaller.page, 2);
  assert.equal(smaller.pageCount, 2);
  assert.equal(smaller.rows.length, 1);
  const empty = summarizeResultTaskActivity(
    'task-current',
    items.map((item) => ({ ...item, state: 'succeeded' })),
    3,
  );
  assert.deepEqual(empty, {
    total: 0,
    unknown: 0,
    stopping: 0,
    otherActive: 0,
    page: 1,
    pageCount: 1,
    rows: [],
  });
});

test('空快照与越界页保持安全且确定的分页', () => {
  assert.deepEqual(summarizeResultTaskActivity('task-current', []).rows, []);
  const items = Array.from({ length: 6 }, (_, index) => run(`run-${index}`));
  for (const page of [0, -1, NaN, Infinity, -Infinity])
    assert.equal(summarizeResultTaskActivity('task-current', items, page).page, 1);
  assert.equal(summarizeResultTaskActivity('task-current', items, 1.9).page, 1);
  assert.equal(summarizeResultTaskActivity('task-current', items, 99).page, 2);
});

test('同时间用执行ID稳定排序，不改变调用方记录或数组', () => {
  const items = Object.freeze([Object.freeze(run('run-b')), Object.freeze(run('run-a'))]);
  const before = JSON.stringify(items);
  const summary = summarizeResultTaskActivity('task-current', items);
  assert.deepEqual(
    summary.rows.map((item) => item.id),
    ['run-a', 'run-b'],
  );
  assert.equal(JSON.stringify(items), before);
  assert.equal(summary.rows[0], items[1]);
});
