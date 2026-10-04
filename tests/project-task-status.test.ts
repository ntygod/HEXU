import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  matchesProjectTaskStatus,
  parseProjectTaskStatus,
  projectTaskStatusColumns,
} from '../apps/web/src/project-task-status.js';

const statuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const tasks = Object.freeze(
  statuses.map((status) => Object.freeze({ id: `task-${status}`, status })),
);

test('project Task status defaults to the three non-cancelled states', () => {
  const selection = parseProjectTaskStatus(new URLSearchParams('q=cancelled&view=list'));
  assert.deepEqual(selection, { kind: 'default' });
  assert.deepEqual(
    tasks.filter((task) => matchesProjectTaskStatus(task, selection)).map((task) => task.status),
    ['todo', 'in_progress', 'done'],
  );
  assert.deepEqual(projectTaskStatusColumns(selection), ['todo', 'in_progress', 'done']);
});

for (const status of statuses) {
  test(`project Task status ${status} selects only that state and its board column`, () => {
    const selection = parseProjectTaskStatus(new URLSearchParams({ status }));
    assert.deepEqual(selection, { kind: 'status', status });
    assert.deepEqual(
      tasks.filter((task) => matchesProjectTaskStatus(task, selection)),
      [tasks.find((task) => task.status === status)],
    );
    assert.deepEqual(projectTaskStatusColumns(selection), [status]);
  });
}

test('invalid, empty, whitespace and duplicate status values never broaden results', () => {
  for (const search of [
    'status',
    'status=',
    'status=unknown',
    'status=all',
    'status=DONE',
    'status=+',
    'status=%09',
    'status=+done',
    'status=done+',
    'status=done%0A',
    'status=todo&status=done',
    'status=cancelled&status=cancelled',
    'status=done&status=',
    'status=unknown&status=todo',
  ]) {
    const selection = parseProjectTaskStatus(new URLSearchParams(search));
    assert.deepEqual(selection, { kind: 'invalid' }, search);
    assert.deepEqual(
      tasks.filter((task) => matchesProjectTaskStatus(task, selection)),
      [],
      search,
    );
    assert.deepEqual(projectTaskStatusColumns(selection), [], search);
  }
});

test('status parsing and matching leave the URL, Task data and selection unchanged', () => {
  const url = new URL(
    'https://hexu.example/projects/project-a?view=list&ownerUserId=owner-a&participantUserId=member-b&q=plan&status=cancelled&source=source-c&extra=one&extra=two#keep-anchor',
  );
  const beforeUrl = url.href;
  const beforeTasks = JSON.stringify(tasks);
  const selection = Object.freeze(parseProjectTaskStatus(url.searchParams));
  for (const task of tasks) matchesProjectTaskStatus(task, selection);
  projectTaskStatusColumns(selection);
  assert.equal(url.href, beforeUrl);
  assert.equal(JSON.stringify(tasks), beforeTasks);
  assert.deepEqual(selection, { kind: 'status', status: 'cancelled' });
});
