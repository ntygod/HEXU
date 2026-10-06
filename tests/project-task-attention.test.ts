import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  matchesProjectTaskAttention,
  parseProjectTaskAttention,
} from '../apps/web/src/project-task-attention.js';
import {
  matchesProjectTaskStatus,
  parseProjectTaskStatus,
} from '../apps/web/src/project-task-status.js';

const tasks: readonly Readonly<{ id: string; attention?: string | null }>[] = Object.freeze([
  Object.freeze({ id: 'missing' }),
  Object.freeze({ id: 'null', attention: null }),
  Object.freeze({ id: 'empty', attention: '' }),
  Object.freeze({ id: 'spaces', attention: ' \t\r\n\u3000\u00a0' }),
  Object.freeze({ id: 'text', attention: '  等待确认下一步\n' }),
  Object.freeze({ id: 'arbitrary', attention: '0' }),
  Object.freeze({ id: 'waiting', attention: 'waiting_feedback' }),
  Object.freeze({ id: 'blocked', attention: 'blocked' }),
  Object.freeze({ id: 'paused', attention: 'paused' }),
]);

function selectedIds(search: string) {
  const selection = parseProjectTaskAttention(new URLSearchParams(search));
  return tasks
    .filter((task) => matchesProjectTaskAttention(task, selection))
    .map((task) => task.id);
}

test('an omitted attention filter preserves every current Task regardless of its attention text', () => {
  const query = new URLSearchParams('q=waiting_feedback&status=done&view=list');
  assert.deepEqual(parseProjectTaskAttention(query), { kind: 'default' });
  assert.deepEqual(
    selectedIds(query.toString()),
    tasks.map((task) => task.id),
  );
});

test('attention present means any non-whitespace text, without classifying its meaning', () => {
  assert.deepEqual(parseProjectTaskAttention(new URLSearchParams('attention=present')), {
    kind: 'attention',
    attention: 'present',
  });
  assert.deepEqual(selectedIds('attention=present'), [
    'text',
    'arbitrary',
    'waiting',
    'blocked',
    'paused',
  ]);
});

test('attention absent includes missing, null, empty and whitespace-only fields', () => {
  assert.deepEqual(parseProjectTaskAttention(new URLSearchParams('attention=absent')), {
    kind: 'attention',
    attention: 'absent',
  });
  assert.deepEqual(selectedIds('attention=absent'), ['missing', 'null', 'empty', 'spaces']);
});

test('unknown, empty, whitespace and duplicate attention values fail closed', () => {
  for (const search of [
    'attention',
    'attention=',
    'attention=all',
    'attention=unknown',
    'attention=waiting_feedback',
    'attention=blocked',
    'attention=paused',
    'attention=PRESENT',
    'attention=Absent',
    'attention=+',
    'attention=%09',
    'attention=+present',
    'attention=present+',
    'attention=absent%0A',
    'attention=present&attention=absent',
    'attention=present&attention=present',
    'attention=absent&attention=absent',
    'attention=present&attention=',
    'attention=&attention=absent',
    'attention=unknown&attention=present',
  ]) {
    assert.deepEqual(
      parseProjectTaskAttention(new URLSearchParams(search)),
      { kind: 'invalid' },
      search,
    );
    assert.deepEqual(selectedIds(search), [], search);
  }
});

test('attention composes with default and each explicit status without reviving cancelled Tasks', () => {
  const statuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
  const current = statuses.flatMap((status) => [
    { id: `${status}-present`, status, attention: '关注内容' },
    { id: `${status}-absent`, status, attention: null },
  ]);
  for (const status of ['', ...statuses]) {
    for (const attention of ['', 'present', 'absent']) {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (attention) query.set('attention', attention);
      const statusSelection = parseProjectTaskStatus(query);
      const attentionSelection = parseProjectTaskAttention(query);
      const actual = current
        .filter(
          (task) =>
            matchesProjectTaskStatus(task, statusSelection) &&
            matchesProjectTaskAttention(task, attentionSelection),
        )
        .map((task) => task.id);
      const selectedStatuses = status ? [status] : ['todo', 'in_progress', 'done'];
      const selectedAttention = attention ? [attention] : ['present', 'absent'];
      assert.deepEqual(
        actual,
        selectedStatuses.flatMap((state) => selectedAttention.map((value) => `${state}-${value}`)),
        query.toString(),
      );
    }
  }
});

test('invalid status or attention prevents either combined filter from broadening results', () => {
  const task = { status: 'todo' as const, attention: '关注内容' };
  for (const search of [
    'status=todo&attention=invalid',
    'status=invalid&attention=present',
    'status=invalid&attention=invalid',
  ]) {
    const query = new URLSearchParams(search);
    assert.equal(
      matchesProjectTaskStatus(task, parseProjectTaskStatus(query)) &&
        matchesProjectTaskAttention(task, parseProjectTaskAttention(query)),
      false,
      search,
    );
  }
});

test('matching uses the current attention field after ordinary Task content changes', () => {
  const task: { attention: string | null } = { attention: null };
  const present = parseProjectTaskAttention(new URLSearchParams('attention=present'));
  const absent = parseProjectTaskAttention(new URLSearchParams('attention=absent'));
  assert.equal(matchesProjectTaskAttention(task, present), false);
  assert.equal(matchesProjectTaskAttention(task, absent), true);
  task.attention = '  请确认范围  ';
  assert.equal(matchesProjectTaskAttention(task, present), true);
  assert.equal(matchesProjectTaskAttention(task, absent), false);
  task.attention = '\t\n';
  assert.equal(matchesProjectTaskAttention(task, present), false);
  assert.equal(matchesProjectTaskAttention(task, absent), true);
});

test('parsing and matching preserve URL parameters, source text and the selection', () => {
  const url = new URL(
    'https://hexu.example/projects/project-a?view=list&ownerUserId=owner-a&participantUserId=member-b&q=plan&status=cancelled&attention=present&source=source-c&extra=one&extra=two#keep-anchor',
  );
  const beforeUrl = url.href;
  const beforeTasks = JSON.stringify(tasks);
  const selection = Object.freeze(parseProjectTaskAttention(url.searchParams));
  for (const task of tasks) matchesProjectTaskAttention(task, selection);
  assert.equal(url.href, beforeUrl);
  assert.equal(JSON.stringify(tasks), beforeTasks);
  assert.deepEqual(selection, { kind: 'attention', attention: 'present' });
});
