import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../packages/contracts/src/index.js';
import {
  matchesWorkbenchTaskScope,
  type WorkbenchTaskScope,
} from '../apps/web/src/workbench-task-scope.js';

type ScopeTask = Pick<Task, 'ownerUserId' | 'participantUserIds' | 'visibility'>;

const currentUser = 'member-current';
const otherUser = 'member-other';
const cases: { name: string; task: ScopeTask; scopes: WorkbenchTaskScope[] }[] = [
  {
    name: 'ownership without participation',
    task: { ownerUserId: currentUser, participantUserIds: [], visibility: 'project' },
    scopes: ['mine', 'team'],
  },
  {
    name: 'participation without ownership',
    task: { ownerUserId: otherUser, participantUserIds: [currentUser], visibility: 'project' },
    scopes: ['participating', 'team'],
  },
  {
    name: 'ownership and participation',
    task: { ownerUserId: currentUser, participantUserIds: [currentUser], visibility: 'project' },
    scopes: ['mine', 'participating', 'team'],
  },
  {
    name: 'another person is the only participant',
    task: { ownerUserId: otherUser, participantUserIds: [otherUser], visibility: 'project' },
    scopes: ['team'],
  },
  {
    name: 'missing participant projection',
    task: { ownerUserId: currentUser, visibility: 'project' },
    scopes: ['mine', 'team'],
  },
  {
    name: 'private owner task',
    task: { ownerUserId: currentUser, participantUserIds: [], visibility: 'private' },
    scopes: ['mine'],
  },
  {
    name: 'another visible private task is not team work',
    task: { ownerUserId: otherUser, visibility: 'private' },
    scopes: [],
  },
];

test('Workbench scopes distinguish current participation from responsibility and project visibility', () => {
  for (const { name, task, scopes } of cases) {
    const before = structuredClone(task);
    if (task.participantUserIds) Object.freeze(task.participantUserIds);
    Object.freeze(task);
    for (const scope of ['mine', 'participating', 'team'] as const)
      assert.equal(
        matchesWorkbenchTaskScope(task, scope, currentUser),
        scopes.includes(scope),
        `${name}: ${scope}`,
      );
    assert.deepEqual(task, before);
  }
});

test('the current user and current projection determine participation on each read', () => {
  const task: ScopeTask = { ownerUserId: otherUser, visibility: 'project' };
  assert.equal(matchesWorkbenchTaskScope(task, 'participating', currentUser), false);
  const joined = { ...task, participantUserIds: [otherUser, currentUser] };
  assert.equal(matchesWorkbenchTaskScope(joined, 'participating', currentUser), true);
  assert.equal(matchesWorkbenchTaskScope(joined, 'participating', 'member-current-extra'), false);
  const left = { ...task, participantUserIds: [otherUser] };
  assert.equal(matchesWorkbenchTaskScope(left, 'participating', currentUser), false);
  assert.equal(matchesWorkbenchTaskScope(left, 'participating', otherUser), true);
  assert.equal(matchesWorkbenchTaskScope(task, 'participating', currentUser), false);
});

test('scope selection preserves source order and references without changing the task collection', () => {
  const tasks = cases.map(({ task }, index) => Object.freeze({ ...task, id: `task-${index}` }));
  const before = structuredClone(tasks);
  Object.freeze(tasks);
  const selected = tasks.filter((task) =>
    matchesWorkbenchTaskScope(task, 'participating', currentUser),
  );
  assert.deepEqual(
    selected.map((task) => task.id),
    ['task-1', 'task-2'],
  );
  assert.equal(selected[0], tasks[1]);
  assert.equal(selected[1], tasks[2]);
  assert.deepEqual(tasks, before);
});
