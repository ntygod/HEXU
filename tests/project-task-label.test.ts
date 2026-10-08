import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectTaskLabel } from '../apps/web/src/project-task-label.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import { demoTasks } from '../packages/db/src/seed.js';

test('默认标签选择与规范化后的精确文本独立，invalid也是合法标签', () => {
  assert.deepEqual(parseProjectTaskLabel(new URLSearchParams()), { kind: 'default' });
  for (const [input, expected] of [
    [' Cafe\u0301 ', 'Café'],
    ['API', 'API'],
    ['api', 'api'],
    ['invalid', 'invalid'],
  ] as const) {
    assert.deepEqual(parseProjectTaskLabel(new URLSearchParams({ label: input })), {
      kind: 'label',
      label: expected,
    });
  }
});

test('空白、重复、控制字符和过长标签链接明确无效，不退回全部任务', () => {
  for (const value of ['', ' ', '\n', '接口\t', 'a'.repeat(33)]) {
    assert.deepEqual(parseProjectTaskLabel(new URLSearchParams({ label: value })), {
      kind: 'invalid',
    });
  }
  for (const query of ['label=a&label=a', 'label=a&label=b']) {
    assert.deepEqual(parseProjectTaskLabel(new URLSearchParams(query)), { kind: 'invalid' });
  }
});

test('精确标签与原负责人、参与者、工作说明搜索取交集，不推断参与关系', () => {
  const task = {
    ...demoTasks[0]!,
    labelNames: ['API'],
    participantUserIds: ['member'],
    description: '接口方案',
  };
  const filters = {
    label: 'API',
    ownerUserId: task.ownerUserId,
    participantUserId: 'member',
    q: '接口',
  };
  assert.equal(matchesTaskPeopleFilters(task, filters), true);
  assert.equal(matchesTaskPeopleFilters(task, { ...filters, label: 'api' }), false);
  assert.equal(matchesTaskPeopleFilters(task, { ...filters, ownerUserId: 'other' }), false);
  assert.equal(matchesTaskPeopleFilters(task, { ...filters, participantUserId: 'other' }), false);
  assert.equal(matchesTaskPeopleFilters(task, { ...filters, q: '不匹配' }), false);
  assert.equal(
    matchesTaskPeopleFilters({ ...task, participantUserIds: undefined }, filters),
    false,
  );
});
