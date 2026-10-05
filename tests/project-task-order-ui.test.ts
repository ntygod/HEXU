import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../packages/contracts/src/index.js';
import type {
  ProjectTaskMove,
  ProjectTaskOrder,
} from '../packages/contracts/src/project-task-order.js';
import {
  isCurrentProjectTaskOrder,
  isProjectTaskMoveReceipt,
  orderedProjectTasks,
  projectMoveAnchors,
} from '../apps/web/src/project-task-order-model.js';

const tasks: Task[] = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id,
  shortId: `HX-${index + 1}`,
  spaceId: 'space',
  projectId: 'project',
  visibility: 'project',
  title: id,
  description: '',
  ownerUserId: 'owner',
  status: index === 2 ? 'in_progress' : index === 3 ? 'cancelled' : 'todo',
  revision: 7,
  attention: null,
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
}));
const order: ProjectTaskOrder = {
  projectId: 'project',
  revision: 2,
  baseline: 'a'.repeat(64),
  taskIds: ['c', 'b', 'a', 'd'],
};

test('current project order requires the complete same-project ID set and a usable independent baseline', () => {
  assert.equal(isCurrentProjectTaskOrder(order, 'project', tasks), true);
  for (const invalid of [
    null,
    {},
    { ...order, projectId: 'another' },
    { ...order, taskIds: ['c', 'b', 'a'] },
    { ...order, taskIds: ['c', 'b', 'a', 'a'] },
    { ...order, taskIds: ['c', 'b', 'a', 'foreign'] },
    { ...order, revision: 0 },
    { ...order, revision: 1.5 },
    { ...order, baseline: '' },
    { ...order, baseline: 'stale' },
  ])
    assert.equal(isCurrentProjectTaskOrder(invalid, 'project', tasks), false);
  assert.equal(
    isCurrentProjectTaskOrder(order, 'project', [...tasks, { ...tasks[0]!, id: 'new' }]),
    false,
  );
  assert.equal(
    isCurrentProjectTaskOrder(order, 'project', [
      { ...tasks[0]!, projectId: 'another' },
      ...tasks.slice(1),
    ]),
    false,
  );
  assert.equal(isCurrentProjectTaskOrder({ ...order, taskIds: [] }, 'project', []), true);
});

test('project rendering consumes rank order without mutating Task content, state or source order', () => {
  const original = structuredClone(tasks);
  const ordered = orderedProjectTasks(tasks, order);
  assert.deepEqual(
    ordered.map((task) => task.id),
    ['c', 'b', 'a', 'd'],
  );
  assert.equal(ordered[0], tasks[2]);
  assert.deepEqual(
    ordered.filter((task) => ['a', 'c'].includes(task.id)).map((task) => task.id),
    ['c', 'a'],
  );
  assert.deepEqual(tasks, original);
});

test('movement anchors are visible, same-project and non-cancelled; board anchors also share the actual status', () => {
  const visible = [
    tasks[0]!,
    tasks[1]!,
    tasks[2]!,
    tasks[3]!,
    { ...tasks[1]!, id: 'foreign', projectId: 'another' },
  ];
  assert.deepEqual(
    projectMoveAnchors(visible, tasks[0]!, 'list').map((task) => task.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    projectMoveAnchors(visible, tasks[0]!, 'board').map((task) => task.id),
    ['b'],
  );
  assert.deepEqual(projectMoveAnchors([tasks[0]!, tasks[2]!], tasks[0]!, 'board'), []);
});

test('only a matching immutable move ACK permits GET-only recovery', () => {
  const body: ProjectTaskMove = {
    taskId: 'a',
    anchorTaskId: 'b',
    placement: 'after',
    expectedRevision: 2,
    expectedBaseline: 'a'.repeat(64),
  };
  const receipt = {
    projectId: 'project',
    taskId: 'a',
    anchorTaskId: 'b',
    placement: 'after',
    revision: 3,
    baseline: 'b'.repeat(64),
    changed: true,
  };
  assert.equal(isProjectTaskMoveReceipt(receipt, 'project', body), true);
  // A full-rank move can preserve this reader's authorized relative sequence.
  assert.equal(
    isProjectTaskMoveReceipt({ ...receipt, baseline: body.expectedBaseline }, 'project', body),
    true,
  );
  assert.equal(
    isProjectTaskMoveReceipt(
      { ...receipt, revision: 2, baseline: body.expectedBaseline, changed: false },
      'project',
      body,
    ),
    true,
  );
  for (const invalid of [
    null,
    { ...receipt, projectId: 'another' },
    { ...receipt, taskId: 'c' },
    { ...receipt, anchorTaskId: 'c' },
    { ...receipt, placement: 'before' },
    { ...receipt, revision: 4 },
    { ...receipt, revision: 2 },
    { ...receipt, changed: false },
    { ...receipt, baseline: 'broken' },
  ])
    assert.equal(isProjectTaskMoveReceipt(invalid, 'project', body), false);
});
