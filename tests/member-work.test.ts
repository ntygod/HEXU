import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, Task, User } from '../packages/contracts/src/index.js';
import { taskStatuses } from '../packages/contracts/src/index.js';
import { projectMemberWork } from '../apps/web/src/member-work-projection.js';

const members: User[] = [
  { id: 'member-b', name: '同名成员', initial: '同', color: 'cyan' },
  { id: 'member-a', name: '同名成员', initial: '同', color: 'blue' },
  { id: 'member-empty', name: '暂无任务成员', initial: '暂', color: 'green' },
];

function task(id: string, values: Partial<Task> = {}): Task {
  return {
    id,
    shortId: `HX-${id}`,
    spaceId: 'space',
    projectId: null,
    visibility: 'private',
    title: `任务 ${id}`,
    description: '',
    ownerUserId: 'member-a',
    status: 'todo',
    revision: 1,
    attention: null,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    ...values,
  };
}

function project(id: string, values: Partial<Project> = {}): Project {
  return {
    id,
    spaceId: 'space',
    name: `项目 ${id}`,
    description: '',
    color: 'cyan',
    revision: 1,
    ...values,
  };
}

test('member work unions responsibility and explicit participation once in source order', () => {
  const tasks = [
    task('participating', { ownerUserId: 'member-b', participantUserIds: ['member-a'] }),
    task('unrelated', { ownerUserId: 'member-b', participantUserIds: ['member-b'] }),
    task('both', { participantUserIds: ['member-a', 'member-a'] }),
    task('responsible', { participantUserIds: [] }),
  ];
  const view = projectMemberWork({ members, tasks, projects: [] }, 'member-a');
  assert.equal(view.kind, 'member');
  if (view.kind !== 'member') return;
  assert.deepEqual(
    view.tasks.map(({ task, responsible, participant }) => [task.id, responsible, participant]),
    [
      ['participating', false, true],
      ['both', true, true],
      ['responsible', true, false],
    ],
  );
  assert.equal(view.tasks[0]?.task, tasks[0]);
  assert.equal(view.tasks[1]?.task, tasks[2]);
  assert.equal(view.tasks[2]?.task, tasks[3]);
  const repeated = projectMemberWork(
    { members, tasks: [...tasks, tasks[0]!], projects: [] },
    'member-a',
  );
  assert.deepEqual(repeated, view);
});

test('selection uses exact current member IDs, preserving same-name members and directory order', () => {
  const tasks = [task('a'), task('b', { ownerUserId: 'member-b' })];
  const data = { members, tasks, projects: [] };
  assert.deepEqual(projectMemberWork(data), { kind: 'directory' });
  for (const [memberId, expected] of [
    ['member-a', 'a'],
    ['member-b', 'b'],
  ]) {
    const view = projectMemberWork(data, memberId);
    assert.equal(view.kind, 'member');
    if (view.kind !== 'member') continue;
    assert.equal(
      view.member,
      members.find((member) => member.id === memberId),
    );
    assert.deepEqual(
      view.tasks.map(({ task }) => task.id),
      [expected],
    );
  }
  assert.deepEqual(
    members.map((member) => member.id),
    ['member-b', 'member-a', 'member-empty'],
  );
  assert.deepEqual(projectMemberWork(data, '同名成员'), { kind: 'unavailable' });
  assert.deepEqual(projectMemberWork(data, ''), { kind: 'unavailable' });
  assert.deepEqual(projectMemberWork(data, 'member-a-extra'), { kind: 'unavailable' });
});

test('missing participation is never inferred from responsibility, creation, operation or visibility', () => {
  const tasks = [
    task('responsible'),
    task('creator', { ownerUserId: 'member-b', createdByUserId: 'member-a' }),
    task('operator', { ownerUserId: 'member-b', operatorUserId: 'member-a' }),
    task('project-visible', { ownerUserId: 'member-b', visibility: 'project' }),
    task('other-participants', { ownerUserId: 'member-b', participantUserIds: ['member-b'] }),
  ];
  const view = projectMemberWork({ members, tasks, projects: [] }, 'member-a');
  assert.equal(view.kind, 'member');
  if (view.kind !== 'member') return;
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0]?.task.id, 'responsible');
  assert.equal(view.tasks[0]?.responsible, true);
  assert.equal(view.tasks[0]?.participant, false);
});

test('unknown owners and participants cannot become selectable members or expose their task rows', () => {
  const tasks = [
    task('unknown-owner', { ownerUserId: 'missing-member' }),
    task('unknown-participant', { participantUserIds: ['missing-member'] }),
  ];
  const data = { members, tasks, projects: [] };
  assert.deepEqual(projectMemberWork(data, 'missing-member'), { kind: 'unavailable' });
  const empty = projectMemberWork(data, 'member-empty');
  assert.equal(empty.kind, 'member');
  if (empty.kind !== 'member') return;
  assert.deepEqual(empty.tasks, []);
});

test('project sources distinguish personal work, unavailable projects and real archived projects', () => {
  const live = project('live', { name: '真实项目名称' });
  const archived = project('archived', { archivedAt: '2026-10-04T00:00:00Z' });
  const tasks = [
    task('personal'),
    task('missing', { projectId: 'missing' }),
    task('empty-source', { projectId: '' }),
    task('live-source', { projectId: live.id }),
    task('archived-source', { projectId: archived.id }),
  ];
  const view = projectMemberWork({ members, tasks, projects: [live, archived] }, 'member-a');
  assert.equal(view.kind, 'member');
  if (view.kind !== 'member') return;
  assert.deepEqual(
    view.tasks.map(({ source }) => source.kind),
    ['personal', 'unavailable', 'unavailable', 'project', 'project'],
  );
  const liveSource = view.tasks[3]?.source;
  const archivedSource = view.tasks[4]?.source;
  assert.equal(liveSource?.kind === 'project' ? liveSource.project : null, live);
  assert.equal(archivedSource?.kind === 'project' ? archivedSource.project : null, archived);
});

test('all current task states remain visible in their original order, including done and cancelled', () => {
  const tasks = taskStatuses.map((status) => task(status, { status }));
  const view = projectMemberWork({ members, tasks, projects: [] }, 'member-a');
  assert.equal(view.kind, 'member');
  if (view.kind !== 'member') return;
  assert.deepEqual(
    view.tasks.map(({ task }) => task.status),
    taskStatuses,
  );
});

test('fresh member, responsibility, participation and project projections immediately replace old results', () => {
  const initial = {
    members,
    tasks: [
      task('responsible'),
      task('participant', { ownerUserId: 'member-b', participantUserIds: ['member-a'] }),
    ],
    projects: [],
  };
  const before = projectMemberWork(initial, 'member-a');
  assert.equal(before.kind === 'member' ? before.tasks.length : 0, 2);
  const after = projectMemberWork(
    {
      ...initial,
      tasks: [
        task('responsible', { ownerUserId: 'member-b' }),
        task('participant', { ownerUserId: 'member-b', participantUserIds: [] }),
      ],
    },
    'member-a',
  );
  assert.equal(after.kind, 'member');
  if (after.kind === 'member') assert.deepEqual(after.tasks, []);
  assert.deepEqual(
    projectMemberWork(
      { ...initial, members: members.filter((member) => member.id !== 'member-a') },
      'member-a',
    ),
    { kind: 'unavailable' },
  );
  const goneProject = projectMemberWork(
    { members, tasks: [task('source', { projectId: 'removed-project' })], projects: [] },
    'member-a',
  );
  assert.equal(
    goneProject.kind === 'member' ? goneProject.tasks[0]?.source.kind : null,
    'unavailable',
  );
});

test('projection leaves deeply frozen input unchanged, including member and task order', () => {
  const data = {
    members: structuredClone(members),
    tasks: [
      task('later', { participantUserIds: ['member-b', 'member-a'], projectId: 'project' }),
      task('earlier', { ownerUserId: 'member-b', participantUserIds: ['member-a'] }),
    ],
    projects: [project('project')],
  };
  const before = structuredClone(data);
  for (const member of data.members) Object.freeze(member);
  for (const task of data.tasks) {
    if (task.participantUserIds) Object.freeze(task.participantUserIds);
    Object.freeze(task);
  }
  for (const project of data.projects) Object.freeze(project);
  Object.freeze(data.members);
  Object.freeze(data.tasks);
  Object.freeze(data.projects);
  Object.freeze(data);
  for (const id of [undefined, 'member-a', 'member-b', 'member-empty', 'missing']) {
    projectMemberWork(data, id);
  }
  assert.deepEqual(data, before);
});
