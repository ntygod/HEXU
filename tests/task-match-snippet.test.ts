import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../packages/contracts/src/index.js';
import { matchesTaskPeopleFilters } from '../packages/domain/src/index.js';
import {
  taskDescriptionMatchSnippet,
  TASK_MATCH_SNIPPET_LIMIT,
  type TaskMatchSnippet,
} from '../apps/web/src/task-match-snippet.js';
import {
  matchesProjectTaskStatus,
  parseProjectTaskStatus,
} from '../apps/web/src/project-task-status.js';
import {
  matchesProjectTaskAttention,
  parseProjectTaskAttention,
} from '../apps/web/src/project-task-attention.js';

const task: Readonly<Task> = Object.freeze({
  id: 'task-a',
  shortId: 'HX-123',
  title: 'Plan launch',
  description: 'Describe the Needle here.',
  spaceId: 'space-a',
  projectId: 'project-a',
  visibility: 'project',
  ownerUserId: 'owner-a',
  participantUserIds: ['member-b'],
  status: 'todo',
  revision: 1,
  attention: 'Check delivery',
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
});

function snippet(description: string, q: string) {
  const result = taskDescriptionMatchSnippet({ ...task, description }, q);
  assert.ok(result, `Expected a snippet for ${JSON.stringify(q)}`);
  assert.ok(result.match.length > 0);
  assert.ok(Array.from(text(result)).length <= TASK_MATCH_SNIPPET_LIMIT);
  return result;
}

function text(result: TaskMatchSnippet) {
  return result.before + result.match + result.after;
}

test('blank queries, title/ID hits and missing description hits preserve existing display', () => {
  for (const query of [
    undefined,
    '',
    ' \t\n\u3000',
    ' PLAN ',
    'hx-123',
    'launch HX-123',
    'missing',
  ])
    assert.equal(taskDescriptionMatchSnippet(task, query), null);
  assert.equal(taskDescriptionMatchSnippet({ ...task, description: '' }, 'needle'), null);
  assert.equal(taskDescriptionMatchSnippet({ ...task, title: 'Needle' }, 'needle'), null);
  assert.equal(taskDescriptionMatchSnippet({ ...task, shortId: 'NEEDLE-1' }, 'needle'), null);
  assert.deepEqual(taskDescriptionMatchSnippet(task, '  nEEdLe  '), {
    before: 'Describe the ',
    match: 'Needle',
    after: ' here.',
  });
});

test('the first description hit is shown with bounded surrounding context and original casing', () => {
  const description = `${'opening '.repeat(90)}First NEEDLE ${'middle '.repeat(60)}second needle`;
  const result = snippet(description, 'needle');
  assert.equal(result.match, 'NEEDLE');
  assert.ok(result.before.startsWith('…'));
  assert.ok(result.before.endsWith('First '));
  assert.ok(result.after.startsWith(' middle '));
  assert.ok(result.after.endsWith('…'));
  assert.equal(Array.from(text(result)).length, TASK_MATCH_SNIPPET_LIMIT);
  assert.equal(text(result).includes('second needle'), false);
});

test('start, end and short full-description matches only ellipsize omitted content', () => {
  const start = snippet(`Needle ${'tail '.repeat(80)}`, 'needle');
  assert.equal(start.before, '');
  assert.equal(start.after.endsWith('…'), true);
  const end = snippet(`${'opening '.repeat(80)}Needle`, 'needle');
  assert.equal(end.before.startsWith('…'), true);
  assert.equal(end.after, '');
  assert.deepEqual(snippet('Needle', 'needle'), { before: '', match: 'Needle', after: '' });
  assert.deepEqual(snippet('读 <img src=x onerror=alert(1)> 后的说明', '<IMG SRC=X'), {
    before: '读 ',
    match: '<img src=x',
    after: ' onerror=alert(1)> 后的说明',
  });
});

test('locale expansion before and within a hit maps to original text rather than folded offsets', () => {
  const result = snippet(`${'İ'.repeat(200)} NEEDLE and later needle`, 'needle');
  assert.equal(result.match, 'NEEDLE');
  assert.equal(result.before.endsWith('İ '), true);
  assert.equal(result.after, ' and later needle');
  assert.deepEqual(snippet('İstanbul', 'i'), { before: '', match: 'İ', after: 'stanbul' });
  assert.deepEqual(snippet('prefix İ suffix', 'i\u0307'), {
    before: 'prefix ',
    match: 'İ',
    after: ' suffix',
  });
  assert.deepEqual(snippet('İ', '\u0307'), { before: '', match: 'İ', after: '' });
});

test('Greek final-sigma search uses whole-description casing, including its original match location', () => {
  assert.deepEqual(snippet('ΟΣ ΟΣΑ', 'ς'), { before: 'Ο', match: 'Σ', after: ' ΟΣΑ' });
  assert.deepEqual(snippet('ΟΣ ΟΣΑ', 'σ'), { before: 'ΟΣ Ο', match: 'Σ', after: 'Α' });
  assert.deepEqual(snippet('ΟΣ ΟΣΑ', 'ΟΣ'), { before: '', match: 'ΟΣ', after: ' ΟΣΑ' });
  assert.equal(taskDescriptionMatchSnippet({ ...task, description: 'ΟΣ' }, 'οσ'), null);
});

test('Chinese, emoji ZWJ and combining matches retain complete original graphemes', () => {
  assert.deepEqual(snippet('前面的说明：需要确认中文内容。', '确认中文'), {
    before: '前面的说明：需要',
    match: '确认中文',
    after: '内容。',
  });
  for (const q of ['💻', '👩', '\u200d', '🏽'])
    assert.deepEqual(snippet('before 👩🏽‍💻 after', q), {
      before: 'before ',
      match: '👩🏽‍💻',
      after: ' after',
    });
  for (const q of ['e', '\u0301', 'e\u0301'])
    assert.deepEqual(snippet('咖啡 e\u0301 味道', q), {
      before: '咖啡 ',
      match: 'e\u0301',
      after: ' 味道',
    });
  assert.equal(taskDescriptionMatchSnippet({ ...task, description: 'e\u0301' }, 'é'), null);
});

test('context and marked edges do not split graphemes at the code-point budget', () => {
  for (const cluster of ['👩🏽‍💻', '🇨🇳', 'e\u0301', '😀', '中']) {
    const description = cluster.repeat(120) + 'NEEDLE' + cluster.repeat(120);
    const result = snippet(description, 'needle');
    const original = text(result).slice(1, -1);
    const start = description.indexOf(original);
    assert.ok(start >= 0);
    const boundaries = new Set([
      ...Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(description),
        (part) => part.index,
      ),
      description.length,
    ]);
    for (const boundary of [
      start,
      start + result.before.length - 1,
      start + result.before.length - 1 + result.match.length,
      start + original.length,
    ])
      assert.ok(boundaries.has(boundary), `Split ${cluster} at ${boundary}`);
    assert.equal(result.match, 'NEEDLE');
  }
});

test('long matches show a bounded original prefix and keep every ellipsis outside the mark', () => {
  const query = '中'.repeat(160);
  const full = snippet(query, query);
  assert.equal(full.match, query);
  assert.equal(full.before + full.after, '');
  const both = snippet(`前${query}后`, query);
  assert.deepEqual(both, { before: '…', match: '中'.repeat(158), after: '…' });
  const tail = snippet(`${query}后`, query);
  assert.deepEqual(tail, { before: '', match: '中'.repeat(159), after: '…' });
  const long = '👩🏽‍💻'.repeat(300);
  const emoji = snippet(`前${long}后`, long);
  assert.equal(emoji.match, '👩🏽‍💻'.repeat(39));
  assert.equal(emoji.before, '…');
  assert.equal(emoji.after, '…');
});

test('an indivisible over-budget match falls back; giant adjacent context is omitted safely', () => {
  const giant = 'e' + '\u0301'.repeat(300);
  assert.equal(taskDescriptionMatchSnippet({ ...task, description: giant }, 'e'), null);
  assert.equal(taskDescriptionMatchSnippet({ ...task, description: giant }, '\u0301'), null);
  const result = snippet(`${giant}Needle${giant}`, 'needle');
  assert.deepEqual(result, { before: '…', match: 'Needle', after: '…' });
  const later = snippet(`Needle${giant}`, `Needle${giant}`);
  assert.deepEqual(later, { before: '', match: 'Needle', after: '…' });
});

test('the existing domain predicate keeps cross-field matching, filter intersections and Task order', () => {
  const crossField = Object.freeze({ ...task, title: 'Boundary', description: 'description' });
  for (const q of ['boundary hx-123', 'hx-123 description']) {
    assert.equal(matchesTaskPeopleFilters(crossField, { q }), true);
    assert.equal(taskDescriptionMatchSnippet(crossField, q), null);
  }
  const tasks = [
    Object.freeze({ ...task, id: 'description' }),
    Object.freeze({ ...task, id: 'title', title: 'Needle', description: 'Other text' }),
    Object.freeze({ ...task, id: 'cancelled', status: 'cancelled' as const }),
    Object.freeze({ ...task, id: 'owner', ownerUserId: 'other' }),
    Object.freeze({ ...task, id: 'participant', participantUserIds: [] }),
    Object.freeze({ ...task, id: 'attention', attention: '  ' }),
  ];
  const url = new URL(
    'https://hexu.example/projects/project-a?q=needle&ownerUserId=owner-a&participantUserId=member-b&attention=present&view=list#keep',
  );
  const originalUrl = url.href;
  const originalTasks = JSON.stringify(tasks);
  const filters = Object.freeze({
    q: 'needle',
    ownerUserId: 'owner-a',
    participantUserId: 'member-b',
  });
  const status = parseProjectTaskStatus(url.searchParams);
  const attention = parseProjectTaskAttention(url.searchParams);
  const select = () =>
    tasks.filter(
      (item) =>
        matchesTaskPeopleFilters(item, filters) &&
        matchesProjectTaskStatus(item, status) &&
        matchesProjectTaskAttention(item, attention),
    );
  const selected = select();
  assert.deepEqual(
    selected.map((item) => item.id),
    ['description', 'title'],
  );
  assert.deepEqual(
    selected.map((item) => !!taskDescriptionMatchSnippet(item, filters.q)),
    [true, false],
  );
  assert.deepEqual(select(), selected);
  assert.equal(JSON.stringify(tasks), originalTasks);
  assert.equal(url.href, originalUrl);
});
