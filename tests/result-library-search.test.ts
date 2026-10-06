import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, Result, Task } from '../packages/contracts/src/index.js';
import {
  RESULT_LIBRARY_QUERY_LIMIT,
  filterResultLibrary,
  parseResultLibraryFilters,
  resultBodyMatchSnippet,
  resultLibraryUrl,
} from '../apps/web/src/result-library-filters.js';
import { TEXT_MATCH_SNIPPET_LIMIT, textMatchSnippet } from '../apps/web/src/text-match-snippet.js';
import { taskDescriptionMatchSnippet } from '../apps/web/src/task-match-snippet.js';

const projects = Object.freeze([
  Object.freeze({ id: 'project-a' }),
  Object.freeze({ id: 'project-b', archivedAt: '2026-10-01T00:00:00.000Z' }),
  Object.freeze({ id: 'project-empty' }),
]);
const task = (id: string, changes: Partial<Task> = {}): Task =>
  Object.freeze({
    id,
    shortId: `HX-${id}`,
    spaceId: 'space-a',
    projectId: 'project-a',
    visibility: 'project',
    title: 'Current TaskBeacon',
    description: 'ExcludedDescription',
    ownerUserId: 'ExcludedOwner',
    status: 'todo',
    revision: 1,
    attention: 'ExcludedAttention',
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    ...changes,
  });
const result = (id: string, taskId: string, changes: Partial<Result> = {}): Result =>
  Object.freeze({
    id,
    taskId,
    title: 'Current Lantern',
    body: 'First BodyNeedle and later bodyneedle.',
    kind: 'text',
    revision: 1,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    ...changes,
  });
const tasks = Object.freeze([
  task('101'),
  task('102', { projectId: 'project-b', title: 'Other task' }),
  task('103', { projectId: null, visibility: 'private', title: 'Personal task' }),
  task('104', { status: 'cancelled', title: 'Cancelled task' }),
]);
const results = Object.freeze([
  result('result-b', '102', { title: 'Second result' }),
  result('result-private', '103', { title: 'Personal result' }),
  result('result-a', '101'),
  result('result-cancelled', '104', { title: 'Cancelled result' }),
]);
const filters = (search = '', available: readonly Pick<Project, 'id'>[] = projects) =>
  parseResultLibraryFilters(search, available);
const find = (search = '') => filterResultLibrary(results, tasks, filters(search));

test('default and blank keyword retain every supplied current Result in server order', () => {
  assert.deepEqual(filters('?keep=one&keep=two#ignored'), {
    q: '',
    projectId: '',
    error: null,
    active: false,
  });
  for (const search of ['', '?q=', '?q=+%09%20', '?keep=one&keep=two']) {
    assert.deepEqual(find(search), results, search);
  }
  assert.equal(filters('?q=').active, true);
  assert.ok(find().includes(results[1]!));
  assert.ok(find().includes(results[3]!));
});

test('keyword searches only current Result title/body and associated Task title/short ID', () => {
  assert.deepEqual(find('?q=+lAnTeRn+'), [results[2]]);
  assert.deepEqual(find('?q=BODYNEEDLE'), results);
  assert.deepEqual(find('?q=TaskBeacon'), [results[2]]);
  assert.deepEqual(find('?q=hx-101'), [results[2]]);
  for (const excluded of [
    'ExcludedDescription',
    'ExcludedOwner',
    'ExcludedAttention',
    'result-a',
    'Lantern First',
    'TaskBeacon HX-101',
  ])
    assert.deepEqual(find(`?q=${encodeURIComponent(excluded)}`), [], excluded);
});

test('project and keyword intersect through the current Task relation without a status filter', () => {
  assert.deepEqual(find('?projectId=project-a'), [results[2], results[3]]);
  assert.deepEqual(find('?projectId=project-a&q=bodyneedle'), [results[2], results[3]]);
  assert.deepEqual(find('?projectId=project-b&q=bodyneedle'), [results[0]]);
  assert.deepEqual(find('?projectId=project-b&q=Lantern'), []);
  assert.deepEqual(find('?projectId=project-empty'), []);
  assert.equal(filters('?projectId=project-empty').error, null);
  assert.equal(filters('?projectId=project-b').error, null);
  assert.ok(filters('?projectId=personal').error);
});

test('a missing Task cannot supply project or Task text matches, but does not erase a visible Result', () => {
  const orphan = result('visible-orphan', 'currently-missing-task');
  assert.deepEqual(filterResultLibrary([orphan], [], filters()), [orphan]);
  assert.deepEqual(filterResultLibrary([orphan], [], filters('?q=bodyneedle')), [orphan]);
  assert.deepEqual(filterResultLibrary([orphan], [], filters('?q=TaskBeacon')), []);
  assert.deepEqual(filterResultLibrary([orphan], [], filters('?projectId=project-a')), []);
});

test('invalid, duplicate, damaged and unavailable project parameters fail closed', () => {
  for (const search of [
    '?q=Lantern&q=Lantern',
    '?q=&q=',
    '?q=Lantern&%71=bodyneedle',
    '?projectId=project-a&projectId=project-b',
    '?projectId=project-a&projectId=project-a',
    '?projectId',
    '?projectId=',
    '?projectId=+',
    '?projectId=+project-a',
    '?projectId=project-a%20',
    '?projectId=unknown-project',
    '?q=%',
    '?q=%GG',
    '?q=%E0%A4%A',
    '?projectId=%C0%AF',
    `?q=${'x'.repeat(RESULT_LIBRARY_QUERY_LIMIT + 1)}`,
    `?projectId=${'x'.repeat(RESULT_LIBRARY_QUERY_LIMIT + 1)}`,
  ]) {
    const parsed = filters(search);
    assert.ok(parsed.error, search);
    assert.equal(parsed.active, true, search);
    assert.deepEqual(filterResultLibrary(results, tasks, parsed), [], search);
  }
  const missingCurrentProject = filters('?projectId=project-a', [{ id: 'project-b' }]);
  assert.ok(missingCurrentProject.error);
  assert.deepEqual(filterResultLibrary(results, tasks, missingCurrentProject), []);
  // Malformed values owned by another URL consumer are not library filters.
  assert.equal(filters('?keep=%GG&q=Lantern').error, null);
});

test('query limit accepts its exact UTF-16 boundary and rejects longer decoded input', () => {
  assert.equal(RESULT_LIBRARY_QUERY_LIMIT, 160);
  const boundary = '👩'.repeat(RESULT_LIBRARY_QUERY_LIMIT / 2);
  const parsed = filters(`?q=${encodeURIComponent(boundary)}`);
  assert.equal(parsed.q, boundary);
  assert.equal(parsed.error, null);
  const tooLong = filters(`?q=${encodeURIComponent(boundary + 'x')}`);
  assert.ok(tooLong.error);
  assert.equal(tooLong.q.length, RESULT_LIBRARY_QUERY_LIMIT);
  assert.deepEqual(filterResultLibrary(results, tasks, tooLong), []);
  const crossingSurrogate = filters(`?q=${encodeURIComponent('a'.repeat(159) + '😀')}`);
  assert.ok(crossingSurrogate.error);
  assert.equal(crossingSurrogate.q, 'a'.repeat(159));
  assert.deepEqual(filterResultLibrary(results, tasks, crossingSurrogate), []);
});

test('only the supplied current projection is searched, not prior-only version text', () => {
  // Earlier versions are deliberately not passed to a current-library helper.
  const priorOnlyBody = 'EarlierOnlyKeyword';
  const current = result('current-v2', '101', {
    revision: 2,
    title: 'CurrentVersionTitle',
    body: 'CurrentVersionBody',
  });
  for (const q of ['currentversiontitle', 'currentversionbody', 'TaskBeacon'])
    assert.deepEqual(filterResultLibrary([current], tasks, filters(`?q=${q}`)), [current]);
  assert.deepEqual(filterResultLibrary([current], tasks, filters(`?q=${priorOnlyBody}`)), []);
  assert.equal(resultBodyMatchSnippet(current, tasks[0], priorOnlyBody), null);
});

test('body-only context uses the existing bounded plaintext grapheme helper and original first match', () => {
  const query = '👩🏽‍💻 <b>核对</b>';
  const body =
    '开头背景。'.repeat(90) +
    `第一处 ${query} 原始说明。` +
    '中间背景。'.repeat(90) +
    `第二处 ${query}。`;
  const current = result('snippet', '101', { title: 'Plain result', body });
  const snippet = resultBodyMatchSnippet(current, tasks[0], query);
  assert.ok(snippet);
  assert.deepEqual(snippet, textMatchSnippet(body, query));
  assert.deepEqual(
    snippet,
    taskDescriptionMatchSnippet({ title: '', shortId: '', description: body }, query),
  );
  assert.equal(snippet.match, query);
  const visible = snippet.before + snippet.match + snippet.after;
  assert.ok(Array.from(visible).length <= TEXT_MATCH_SNIPPET_LIMIT);
  assert.ok(visible.includes('第一处'));
  assert.equal(visible.includes('第二处'), false);
  assert.ok(snippet.before.startsWith('…'));
  assert.ok(snippet.after.endsWith('…'));
  assert.deepEqual(
    resultBodyMatchSnippet({ title: '', body: '前 👩🏽‍💻 后 e\u0301' }, undefined, '💻'),
    { before: '前 ', match: '👩🏽‍💻', after: ' 后 e\u0301' },
  );
});

test('visible title/Task matches and absent body matches preserve ordinary card text', () => {
  const current = result('suppressed', '101', { body: 'Lantern TaskBeacon HX-101 BodyNeedle' });
  for (const q of [undefined, '', '  ', ' LANTERN ', 'taskbeacon', 'hx-101', 'missing'])
    assert.equal(resultBodyMatchSnippet(current, tasks[0], q), null, q);
  assert.ok(resultBodyMatchSnippet(current, tasks[0], 'bodyneedle'));
  assert.ok(resultBodyMatchSnippet(current, undefined, 'taskbeacon'));
  assert.equal(resultBodyMatchSnippet({ title: '', body: '' }, undefined, 'missing'), null);
});

test('URL edits preserve unrelated parameters, duplicates, pathname and hash; clear removes only filters', () => {
  const source =
    'https://hexu.example/results?keep=one&keep=two&q=old&projectId=project-a&view=cards#saved-anchor';
  const keyword = new URL(resultLibraryUrl(source, { q: '尾段 <b>核对</b>' }), source);
  assert.equal(keyword.pathname, '/results');
  assert.deepEqual(keyword.searchParams.getAll('keep'), ['one', 'two']);
  assert.equal(keyword.searchParams.get('q'), '尾段 <b>核对</b>');
  assert.equal(keyword.searchParams.get('projectId'), 'project-a');
  assert.equal(keyword.hash, '#saved-anchor');
  const project = new URL(resultLibraryUrl(keyword.href, { projectId: 'project-b' }), source);
  assert.equal(project.searchParams.get('q'), '尾段 <b>核对</b>');
  assert.equal(project.searchParams.get('projectId'), 'project-b');
  const clear = new URL(resultLibraryUrl(project.href, { q: '', projectId: '' }), source);
  assert.deepEqual(
    [...clear.searchParams],
    [
      ['keep', 'one'],
      ['keep', 'two'],
      ['view', 'cards'],
    ],
  );
  assert.equal(clear.hash, '#saved-anchor');
  assert.equal(clear.pathname, '/results');
  const duplicates = new URL(
    resultLibraryUrl('https://hexu.example/results?q=one&q=two&projectId=project-a', {
      q: 'fixed',
    }),
    source,
  );
  assert.deepEqual(duplicates.searchParams.getAll('q'), ['fixed']);
  const damaged = resultLibraryUrl(
    'https://hexu.example/results?q=%E0%A4%A&keep=%20&keep=two&flag#top',
    { projectId: 'project-a' },
  );
  assert.equal(damaged, '/results?q=%E0%A4%A&keep=%20&keep=two&flag&projectId=project-a#top');
  assert.ok(filters(new URL(damaged, source).search).error);
  assert.equal(
    resultLibraryUrl(new URL(damaged, source).href, { q: '', projectId: '' }),
    '/results?keep=%20&keep=two&flag#top',
  );
});

test('parsing, filtering, snippets and URL generation leave all caller snapshots unchanged', () => {
  const source = new URL('https://hexu.example/results?q=bodyneedle&projectId=project-a#keep');
  const parsed = Object.freeze(filters(source.search));
  const before = JSON.stringify({ projects, tasks, results, parsed, url: source.href });
  const matched = filterResultLibrary(results, tasks, parsed);
  for (const current of matched) {
    assert.ok(results.includes(current));
    resultBodyMatchSnippet(
      current,
      tasks.find((entry) => entry.id === current.taskId),
      parsed.q,
    );
  }
  resultLibraryUrl(source.href, { q: '', projectId: '' });
  assert.equal(JSON.stringify({ projects, tasks, results, parsed, url: source.href }), before);
});
