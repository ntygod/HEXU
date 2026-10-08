import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTaskTargetDateOverdue,
  localCalendarDate,
  matchesProjectTaskTargetDate,
  millisecondsUntilNextLocalDay,
  parseProjectTaskTargetDate,
} from '../apps/web/src/project-task-target-date.js';
import {
  matchesProjectTaskAttention,
  parseProjectTaskAttention,
} from '../apps/web/src/project-task-attention.js';
import {
  matchesProjectTaskStatus,
  parseProjectTaskStatus,
} from '../apps/web/src/project-task-status.js';
import { parseProjectTaskLabel } from '../apps/web/src/project-task-label.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import type { Task, TaskStatus } from '../packages/contracts/src/index.js';

const today = '2026-10-08';
const statuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const tasks = Object.freeze(
  statuses.flatMap((status) =>
    [
      { id: `${status}-missing`, status },
      { id: `${status}-null`, status, targetDate: null },
      { id: `${status}-past`, status, targetDate: '2026-10-07' },
      { id: `${status}-today`, status, targetDate: today },
      { id: `${status}-future`, status, targetDate: '2026-10-09' },
    ].map((task) => Object.freeze(task)),
  ),
);

function selectedIds(search: string, currentDay = today) {
  const selection = parseProjectTaskTargetDate(new URLSearchParams(search));
  return tasks
    .filter((task) => matchesProjectTaskTargetDate(task, selection, currentDay))
    .map((task) => task.id);
}

test('omitted target date selection preserves every currently visible Task', () => {
  const query = new URLSearchParams('q=plan&status=done&attention=present&label=研发&view=list');
  assert.deepEqual(parseProjectTaskTargetDate(query), { kind: 'default' });
  assert.deepEqual(
    selectedIds(query.toString()),
    tasks.map((task) => task.id),
  );
});

test('present and absent date selections retain terminal tasks and legacy unset dates', () => {
  assert.deepEqual(
    selectedIds('targetDate=present'),
    statuses.flatMap((status) => ['past', 'today', 'future'].map((date) => `${status}-${date}`)),
  );
  assert.deepEqual(
    selectedIds('targetDate=absent'),
    statuses.flatMap((status) => ['missing', 'null'].map((date) => `${status}-${date}`)),
  );
  for (const targetDate of ['present', 'absent', 'today', 'overdue']) {
    assert.deepEqual(parseProjectTaskTargetDate(new URLSearchParams({ targetDate })), {
      kind: 'targetDate',
      targetDate,
    });
  }
});

test('today includes any status with the exact current local date; overdue excludes terminal states', () => {
  assert.deepEqual(
    selectedIds('targetDate=today'),
    statuses.map((status) => `${status}-today`),
  );
  assert.deepEqual(selectedIds('targetDate=overdue'), ['todo-past', 'in_progress-past']);
  for (const status of statuses) {
    assert.equal(
      isTaskTargetDateOverdue({ status, targetDate: '2026-10-07' }, today),
      status === 'todo' || status === 'in_progress',
    );
    assert.equal(isTaskTargetDateOverdue({ status, targetDate: today }, today), false);
    assert.equal(isTaskTargetDateOverdue({ status, targetDate: '2026-10-09' }, today), false);
  }
});

test('blank, duplicate, whitespace, unknown, and calendar-value URL modes fail closed', () => {
  for (const search of [
    'targetDate',
    'targetDate=',
    'targetDate=all',
    'targetDate=2026-10-08',
    'targetDate=invalid',
    'targetDate=TODAY',
    'targetDate=+',
    'targetDate=%09',
    'targetDate=+present',
    'targetDate=present+',
    'targetDate=absent%0A',
    'targetDate=%E3%80%80today',
    'targetDate=present&targetDate=absent',
    'targetDate=present&targetDate=present',
    'targetDate=today&targetDate=',
    'targetDate=&targetDate=overdue',
    'targetDate=invalid&targetDate=overdue',
  ]) {
    assert.deepEqual(
      parseProjectTaskTargetDate(new URLSearchParams(search)),
      { kind: 'invalid' },
      search,
    );
    assert.deepEqual(selectedIds(search), [], search);
  }
});

test('invalid persisted values are never interpreted as a date or silently called unset', () => {
  for (const targetDate of [
    '',
    ' ',
    '2026-1-01',
    '2026-10-08 ',
    '2026-10-08T00:00:00Z',
    '0000-01-01',
    '10000-01-01',
    '2025-02-29',
    '2026-04-31',
  ]) {
    const task = { status: 'todo' as const, targetDate };
    for (const mode of ['present', 'absent', 'today', 'overdue']) {
      assert.equal(
        matchesProjectTaskTargetDate(
          task,
          parseProjectTaskTargetDate(new URLSearchParams({ targetDate: mode })),
          today,
        ),
        false,
        `${mode}: ${targetDate}`,
      );
    }
    assert.equal(isTaskTargetDateOverdue(task, today), false);
  }
});

test('date comparisons preserve four-digit years, leap days, and month/year boundaries', () => {
  for (const [targetDate, currentDay, overdue] of [
    ['0001-01-01', '0001-01-02', true],
    ['0099-12-31', '0100-01-01', true],
    ['2000-02-29', '2000-03-01', true],
    ['2024-02-29', '2024-02-29', false],
    ['2026-12-31', '2027-01-01', true],
    ['9999-12-31', '9999-12-30', false],
  ] as const) {
    assert.equal(isTaskTargetDateOverdue({ status: 'todo', targetDate }, currentDay), overdue);
  }
  assert.equal(isTaskTargetDateOverdue({ status: 'todo', targetDate: today }, 'invalid'), false);
});

test('day changes and current Task updates recompute results without mutating their source', () => {
  assert.deepEqual(
    selectedIds('targetDate=today', '2026-10-09'),
    statuses.map((status) => `${status}-future`),
  );
  assert.deepEqual(selectedIds('targetDate=overdue', '2026-10-09'), [
    'todo-past',
    'todo-today',
    'in_progress-past',
    'in_progress-today',
  ]);
  const task: { status: TaskStatus; targetDate?: string | null } = {
    status: 'todo',
    targetDate: today,
  };
  const selection = parseProjectTaskTargetDate(new URLSearchParams('targetDate=overdue'));
  assert.equal(matchesProjectTaskTargetDate(task, selection, today), false);
  task.targetDate = '2026-10-07';
  assert.equal(matchesProjectTaskTargetDate(task, selection, today), true);
  task.status = 'done';
  assert.equal(matchesProjectTaskTargetDate(task, selection, today), false);
  task.status = 'todo';
  assert.equal(matchesProjectTaskTargetDate(task, selection, today), true);
  task.targetDate = null;
  assert.equal(matchesProjectTaskTargetDate(task, selection, today), false);
});

test('date and attention selections intersect and either invalid selection yields no match', () => {
  const task = {
    status: 'in_progress' as const,
    targetDate: '2026-10-07',
    attention: '请确认',
  };
  for (const [search, matches] of [
    ['targetDate=overdue&attention=present', true],
    ['targetDate=today&attention=present', false],
    ['targetDate=overdue&attention=absent', false],
    ['targetDate=invalid&attention=present', false],
    ['targetDate=overdue&attention=invalid', false],
  ] as const) {
    const query = new URLSearchParams(search);
    assert.equal(
      matchesProjectTaskAttention(task, parseProjectTaskAttention(query)) &&
        matchesProjectTaskTargetDate(task, parseProjectTaskTargetDate(query), today),
      matches,
      search,
    );
  }
});

test('date modes intersect every explicit status and preserve the default cancelled exclusion', () => {
  for (const status of ['', ...statuses]) {
    for (const targetDate of ['', 'present', 'absent', 'today', 'overdue']) {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (targetDate) query.set('targetDate', targetDate);
      const actual = tasks
        .filter(
          (task) =>
            matchesProjectTaskStatus(task, parseProjectTaskStatus(query)) &&
            matchesProjectTaskTargetDate(task, parseProjectTaskTargetDate(query), today),
        )
        .map((task) => task.id);
      const expectedStatuses = status ? [status] : ['todo', 'in_progress', 'done'];
      const expected = tasks
        .filter((task) => {
          if (!expectedStatuses.includes(task.status)) return false;
          if (!targetDate) return true;
          if (targetDate === 'absent') return task.targetDate == null;
          if (targetDate === 'present') return task.targetDate != null;
          if (targetDate === 'today') return task.id.endsWith('-today');
          return (
            (task.status === 'todo' || task.status === 'in_progress') && task.id.endsWith('-past')
          );
        })
        .map((task) => task.id);
      assert.deepEqual(actual, expected, query.toString());
    }
  }
});

test('date selection composes with existing owner, participant, label, query, status and attention', () => {
  const task: Task = {
    id: 'task-a',
    shortId: 'HX-42',
    spaceId: 'space-a',
    projectId: 'project-a',
    visibility: 'project',
    title: '实现日期筛选',
    description: '补充日历规划',
    ownerUserId: 'owner-a',
    participantUserIds: ['member-b'],
    labelNames: ['研发'],
    status: 'in_progress',
    revision: 1,
    attention: '请确认',
    targetDate: '2026-10-07',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const base =
    'view=list&ownerUserId=owner-a&participantUserId=member-b&q=日历&label=研发&status=in_progress&attention=present&targetDate=overdue';
  function matches(query: URLSearchParams) {
    const label = parseProjectTaskLabel(query);
    return (
      label.kind !== 'invalid' &&
      matchesTaskPeopleFilters(task, {
        ...(label.kind === 'label' ? { label: label.label } : {}),
        q: query.get('q') ?? '',
        ownerUserId: query.get('ownerUserId') ?? '',
        participantUserId: query.get('participantUserId') ?? '',
      }) &&
      matchesProjectTaskStatus(task, parseProjectTaskStatus(query)) &&
      matchesProjectTaskAttention(task, parseProjectTaskAttention(query)) &&
      matchesProjectTaskTargetDate(task, parseProjectTaskTargetDate(query), today)
    );
  }
  assert.equal(matches(new URLSearchParams(base)), true);
  for (const [key, value] of [
    ['ownerUserId', 'someone-else'],
    ['participantUserId', 'someone-else'],
    ['q', '不会命中'],
    ['label', '其他标签'],
    ['label', ''],
    ['status', 'done'],
    ['status', ''],
    ['attention', 'absent'],
    ['attention', ''],
    ['targetDate', 'today'],
    ['targetDate', ''],
  ] as const) {
    const query = new URLSearchParams(base);
    query.set(key, value);
    assert.equal(matches(query), false, `${key}=${value}`);
  }
});

test('parsing and matching preserve URL parameters, source Tasks, and selection', () => {
  const url = new URL(
    'https://hexu.example/projects/project-a?view=list&ownerUserId=owner-a&participantUserId=member-b&q=plan&status=cancelled&attention=present&label=研发&targetDate=today&extra=one&extra=two#keep-anchor',
  );
  const beforeUrl = url.href;
  const beforeTasks = JSON.stringify(tasks);
  const selection = Object.freeze(parseProjectTaskTargetDate(url.searchParams));
  for (const task of tasks) matchesProjectTaskTargetDate(task, selection, today);
  assert.equal(url.href, beforeUrl);
  assert.equal(JSON.stringify(tasks), beforeTasks);
  assert.deepEqual(selection, { kind: 'targetDate', targetDate: 'today' });
});

function inTimezone(timezone: string, action: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    action();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('local calendar formatting does not convert calendar dates through UTC', () => {
  inTimezone('America/Los_Angeles', () => {
    assert.equal(localCalendarDate(new Date('2026-10-08T02:00:00Z')), '2026-10-07');
  });
  inTimezone('Asia/Shanghai', () => {
    assert.equal(localCalendarDate(new Date('2026-10-07T20:00:00Z')), '2026-10-08');
  });
  inTimezone('UTC', () => {
    for (const year of [1, 99, 100, 9999]) {
      const date = new Date('2000-01-02T12:00:00Z');
      date.setFullYear(year);
      assert.equal(localCalendarDate(date), `${String(year).padStart(4, '0')}-01-02`);
    }
  });
});

test('the next local day clock honors DST and month/year rollovers', () => {
  inTimezone('America/Los_Angeles', () => {
    assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 2, 8)), 23 * 60 * 60 * 1000);
    assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 10, 1)), 25 * 60 * 60 * 1000);
    assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 11, 31, 23, 59, 59, 999)), 1);
    assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 0, 31, 23, 59, 30)), 30_000);
  });
});
