import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRunTransition,
  canonicalJson,
  canReadTask,
  isActiveRun,
} from '../packages/domain/src/index.js';
import { parseRunCreate, parseTaskCreate, revision } from '../packages/contracts/src/index.js';
import { demoTasks } from '../packages/db/src/seed.js';
test('任务创建只需要简短标题', () =>
  assert.deepEqual(parseTaskCreate({ title: '  修复分页  ' }), {
    title: '修复分页',
    description: '',
    projectId: null,
  }));
test('拒绝空白或过长输入', () => {
  for (const title of ['', '   ', 'a'.repeat(161), 42])
    assert.throws(() => parseTaskCreate({ title }));
});
test('修订必须是有效整数', () => {
  for (const input of [null, 0, -1, 1.2, '1', NaN]) assert.throws(() => revision(input));
});
test('原生 Agent 不会被冒充为接通', () =>
  assert.throws(
    () => parseRunCreate({ provider: 'claude-code', expectedRevision: 1 }),
    /尚未接通/,
  ));
test('模拟协议验证工具和场景', () => {
  assert.equal(
    parseRunCreate({ provider: 'mock', requestedTool: 'codex', expectedRevision: 1 }).scenario,
    'success',
  );
  assert.throws(() =>
    parseRunCreate({ provider: 'mock', requestedTool: 'anything', expectedRevision: 1 }),
  );
});
test('停止请求不是停止确认', () => {
  assert.equal(isActiveRun('stopping'), true);
  assert.equal(isActiveRun('succeeded'), false);
  assertRunTransition('running', 'stopping');
  assertRunTransition('stopping', 'cancelled');
});
test('终态不能被迟到事件反转', () =>
  assert.throws(() => assertRunTransition('succeeded', 'running')));
test('等待输入和等待授权仍在运行生命周期中', () => {
  assertRunTransition('running', 'waiting_input');
  assertRunTransition('waiting_approval', 'running');
  assert.equal(isActiveRun('waiting_input'), true);
});
test('幂等 fingerprint 与对象字段顺序无关', () =>
  assert.equal(
    canonicalJson({ b: [1, { c: 2, a: 1 }], a: 1 }),
    canonicalJson({ a: 1, b: [1, { a: 1, c: 2 }] }),
  ));
test('私有任务不会被同空间其他用户读取', () => {
  const task = { ...demoTasks[0]!, visibility: 'private' as const };
  assert.equal(canReadTask(task, task.ownerUserId, task.spaceId), true);
  assert.equal(canReadTask(task, 'other', task.spaceId), false);
  assert.equal(canReadTask(task, task.ownerUserId, 'other-space'), false);
});
