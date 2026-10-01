import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearProjectTaskFilterSearch,
  projectTaskFilterKeys,
  readProjectTaskFilterState,
  updateProjectTaskFilterSearch,
} from '../apps/web/src/project-task-filter-state.js';

const routing = 'tab=tasks&view=list&source=source-1&agreement=agreement-1&resultsCursor=result-1';

test('project URL shares normalized people, text, status, and attention filters', () => {
  const query = new URLSearchParams(routing);
  query.set('q', ' 退款 Alpha ');
  query.set('ownerUserId', ' owner-1 ');
  query.set('participantUserId', 'participant-1');
  query.set('status', 'in_progress');
  query.set('attention', 'present');
  const state = readProjectTaskFilterState(query.toString());
  assert.equal(state.error, null);
  assert.equal(state.view, 'list');
  assert.equal(state.hasFilters, true);
  assert.equal(state.values.q, ' 退款 Alpha ');
  assert.deepEqual(state.filters, {
    q: '退款 Alpha',
    ownerUserId: 'owner-1',
    participantUserId: 'participant-1',
    status: 'in_progress',
    attention: 'present',
  });
  assert.deepEqual(readProjectTaskFilterState('').filters, {
    q: undefined,
    ownerUserId: undefined,
    participantUserId: undefined,
  });
  assert.equal(readProjectTaskFilterState('').hasFilters, false);
  assert.equal(readProjectTaskFilterState('').view, 'board');
});

test('all supported task states and attention presence values survive URL parsing', () => {
  for (const status of ['todo', 'in_progress', 'done', 'cancelled']) {
    for (const attention of ['present', 'absent']) {
      const state = readProjectTaskFilterState(`status=${status}&attention=${attention}`);
      assert.equal(state.error, null);
      assert.equal(state.filters?.status, status);
      assert.equal(state.filters?.attention, attention);
    }
  }
});

test('invalid enums and lengths retain their raw selections without a usable task filter', () => {
  for (const [key, value] of [
    ['status', 'paused'],
    ['status', ' cancelled '],
    ['status', ''],
    ['attention', 'waiting'],
    ['attention', ''],
    ['q', 'q'.repeat(161)],
    ['q', ' '.repeat(161)],
    ['ownerUserId', 'u'.repeat(101)],
    ['participantUserId', 'u'.repeat(101)],
  ] as const) {
    const query = new URLSearchParams({ [key]: value });
    const state = readProjectTaskFilterState(query.toString());
    assert.ok(state.error, `${key}=${value} must be invalid`);
    assert.equal(state.filters, null);
    assert.equal(state.values[key], value);
    assert.equal(state.hasFilters, true);
  }
});

test('unknown and repeated filters or routing parameters never broaden project results', () => {
  for (const search of [
    'statuz=cancelled',
    'projectId=other-project',
    'cursor=20',
    'view=calendar',
    'view=',
    ...projectTaskFilterKeys.map((key) => `${key}=todo&${key}=done`),
    'view=list&view=board',
    'tab=tasks&tab=overview',
    'source=one&source=two',
    'agreement=one&agreement=two',
    'resultsCursor=one&resultsCursor=two',
  ]) {
    const state = readProjectTaskFilterState(search);
    assert.ok(state.error, search);
    assert.equal(state.filters, null, search);
    assert.equal(state.hasFilters, true, search);
  }
});

test('changing one selection preserves other filters, routing, and unrelated invalid input', () => {
  const initial = `${routing}&status=todo&status=done&attention=present&q=alpha&unknown=retain`;
  const updated = updateProjectTaskFilterSearch(initial, 'status', 'cancelled');
  const query = new URLSearchParams(updated);
  assert.deepEqual(query.getAll('status'), ['cancelled']);
  assert.equal(query.get('q'), 'alpha');
  assert.equal(query.get('attention'), 'present');
  assert.equal(query.get('unknown'), 'retain');
  for (const key of ['view', 'tab', 'source', 'agreement', 'resultsCursor'])
    assert.equal(query.get(key), new URLSearchParams(routing).get(key));
  assert.equal(readProjectTaskFilterState(updated).filters, null);
  const defaultStatus = updateProjectTaskFilterSearch(updated, 'status', '');
  assert.equal(new URLSearchParams(defaultStatus).has('status'), false);
  const board = updateProjectTaskFilterSearch(defaultStatus, 'view', 'board');
  assert.equal(new URLSearchParams(board).has('view'), false);
});

test('clear repairs invalid filters and unknown keys without losing valid view or routing', () => {
  const search = `${routing}&status=bad&status=done&attention=&ownerUserId=owner&q=${'x'.repeat(161)}&unknown=value`;
  const cleared = clearProjectTaskFilterSearch(search);
  assert.equal(cleared, routing);
  assert.equal(readProjectTaskFilterState(cleared).error, null);
  assert.equal(readProjectTaskFilterState(cleared).hasFilters, false);
  assert.equal(clearProjectTaskFilterSearch('status=cancelled&attention=absent'), '');
  assert.equal(
    clearProjectTaskFilterSearch('view=wrong&view=list&tab=tasks&tab=overview&source=one'),
    'view=list&tab=tasks&source=one',
  );
});
