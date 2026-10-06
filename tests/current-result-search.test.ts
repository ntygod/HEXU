import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/control/src/app.js';
import type { Result, Task } from '../packages/contracts/src/index.js';
import {
  parseSearchType,
  type ResultSearchHit,
  type ResultSearchPage,
} from '../packages/contracts/src/result-search.js';
import {
  normalizeTaskSearchQuery,
  parseTaskSearchQuery,
  type TaskSearchPage,
  type TaskSearchScope,
} from '../packages/contracts/src/task-search.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import {
  currentResultSearchItems,
  matchesResultSearchQuery,
} from '../packages/domain/src/result-search.js';
import { Store } from '../packages/db/src/store.js';
import { pageResultSearch } from '../packages/db/src/result-search.js';
import { pageTaskSearch } from '../packages/db/src/task-search.js';

type App = Awaited<ReturnType<typeof createApp>>;
type SearchInput = {
  type?: string;
  q?: string;
  scope?: string;
  projectId?: string;
  cursor?: string | null;
};
const keyword = '当前成果';
const sameTime = '2026-01-02T03:04:05.000Z';
const all: TaskSearchScope = { scope: 'all', projectId: null };
const personal: TaskSearchScope = { scope: 'personal', projectId: null };
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const inputFor = (scope: TaskSearchScope): SearchInput =>
  scope.scope === 'project' ? scope : { scope: scope.scope };

function searchUrl(input: SearchInput = {}) {
  const query = new URLSearchParams({ q: input.q ?? keyword });
  for (const field of ['type', 'scope', 'projectId', 'cursor'] as const) {
    const value = input[field];
    if (value !== undefined && value !== null) query.set(field, value);
  }
  return `/api/v1/search?${query}`;
}

function snapshot(store: Store) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}

async function createTextResult(app: App, taskId: string, title: string, body = '当前说明') {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/results`,
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    payload: { title, body },
  });
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json<Result>();
  assert.equal(result.taskId, taskId);
  assert.equal(result.kind, 'text');
  return result;
}

async function fixture(t: TestContext, count = 65, newerPerScope = 35) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-current-result-search-'));
  const store = new Store(join(dir, 'preview.sqlite'));
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject({ name: '选定项目', description: '' }, randomUUID());
  const otherProject = store.createProject({ name: '其他项目', description: '' }, randomUUID());
  const selected: TaskSearchScope = { scope: 'project', projectId: project.id };
  const other: TaskSearchScope = { scope: 'project', projectId: otherProject.id };
  for (let i = 0; i < count; i++) {
    const task = store.createTask(
      { title: `${keyword}任务 ${i}`, description: '不参与成果匹配', projectId: project.id },
      randomUUID(),
    );
    const result = await createTextResult(app, task.id, `${keyword} ${i}`);
    // Equal timestamps deliberately leave the fixture's original rowid order visible.
    result.createdAt = sameTime;
    result.updatedAt = sameTime;
    store.db.prepare('UPDATE results SET body=? WHERE id=?').run(JSON.stringify(result), result.id);
  }
  for (const projectId of [other.projectId, null]) {
    const task = store.createTask({ title: '较新来源', description: '', projectId }, randomUUID());
    for (let i = 0; i < newerPerScope; i++)
      await createTextResult(app, task.id, `${keyword}较新范围 ${i}`);
  }
  return { app, store, selected, other };
}

async function page(app: App, input: SearchInput = {}): Promise<ResultSearchPage> {
  const response = await app.inject(searchUrl({ type: 'result', ...input }));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<ResultSearchPage>();
  assert.deepEqual(Object.keys(result).sort(), ['items', 'nextCursor']);
  assert.ok(result.items.length <= 30);
  return result;
}

async function collect(app: App, input: SearchInput = {}) {
  const items: ResultSearchHit[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(app, { ...input, cursor });
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor) {
      assert.ok(cursor.length <= 1024);
      assert.ok(!cursors.has(cursor), 'pagination must progress');
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(new Set(ids(items)).size, items.length);
  return items;
}

async function error(app: App, url: string, code: string, status = 400) {
  const response = await app.inject(url);
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code, url);
  assert.equal(response.json().items, undefined);
}

function expectedItems(store: Store, scope: TaskSearchScope) {
  const tasks = new Map(store.tasks().map((task) => [task.id, task]));
  return store.results().flatMap((result) => {
    const task = tasks.get(result.taskId);
    if (!task || (scope.scope !== 'all' && task.projectId !== scope.projectId)) return [];
    if (
      ![result.title, result.body, task.title, task.shortId].some((value) =>
        value.toLocaleLowerCase().includes(keyword),
      )
    )
      return [];
    return [
      {
        ...result,
        task: {
          id: task.id,
          title: task.title,
          shortId: task.shortId,
          projectId: task.projectId,
        },
      },
    ];
  });
}

test('preview HTTP reads current ordinary Results in original scoped three-page order without writes', async (t) => {
  const { app, store, selected, other } = await fixture(t);
  const expected = expectedItems(store, selected);
  assert.equal(expected.length, 65);
  assert.equal(new Set(expected.map((result) => result.createdAt)).size, 1);
  assert.ok(
    store
      .results()
      .slice(0, 70)
      .every((result) => !ids(expected).includes(result.id)),
  );
  const before = snapshot(store);
  const input = inputFor(selected);
  const first = await page(app, input);
  assert.deepEqual(first.items, expected.slice(0, 30));
  assert.ok(first.nextCursor);
  const second = await page(app, { ...input, cursor: first.nextCursor });
  assert.deepEqual(second.items, expected.slice(30, 60));
  assert.ok(second.nextCursor);
  assert.deepEqual(await page(app, { ...input, cursor: first.nextCursor }), second);
  const third = await page(app, { ...input, cursor: second.nextCursor });
  assert.deepEqual(third.items, expected.slice(60));
  assert.equal(third.nextCursor, null);
  for (const scope of [all, selected, personal, other])
    assert.deepEqual(await collect(app, inputFor(scope)), expectedItems(store, scope));
  assert.deepEqual(await page(app, { ...input, q: '不存在的成果关键词' }), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(await page(app, { scope: 'project', projectId: 'unknown-project' }), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(snapshot(store), before);
});

test('default and explicit Task searches keep identical v1 bookmarks and never request Results', async (t) => {
  const { app, store, selected } = await fixture(t, 31, 0);
  const query = parseTaskSearchQuery({ q: keyword, ...inputFor(selected) });
  const expected = pageTaskSearch(store.tasks(), query);
  assert.ok(expected.nextCursor);
  const decoded = JSON.parse(Buffer.from(expected.nextCursor, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), ['afterTaskId', 'queryHash', 'sequenceHash', 'v']);
  assert.equal(decoded.queryHash, hash(canonicalJson({ q: keyword, ...selected })));
  assert.equal(decoded.afterTaskId, expected.items.at(-1)!.id);
  const before = snapshot(store);
  const originalResults = store.results;
  store.results = () => {
    throw new Error('Task search must not request Result data');
  };
  try {
    for (const type of [undefined, 'task']) {
      const response = await app.inject(searchUrl({ ...inputFor(selected), type }));
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json<TaskSearchPage>(), expected);
      const next: typeof response = await app.inject(
        searchUrl({ ...inputFor(selected), type, cursor: expected.nextCursor }),
      );
      assert.equal(next.statusCode, 200, next.body);
      assert.deepEqual(
        next.json(),
        pageTaskSearch(store.tasks(), { ...query, cursor: expected.nextCursor }),
      );
    }
  } finally {
    store.results = originalResults;
  }
  assert.deepEqual(snapshot(store), before);
});

test('Result HTTP matching uses independent current title/body and parent title/short-ID fields', async (t) => {
  const { app, store, selected } = await fixture(t, 0, 0);
  const task = store.createTask(
    { title: 'Parent Beacon', description: 'ExcludedDescription', projectId: selected.projectId },
    randomUUID(),
  );
  const result = await createTextResult(
    app,
    task.id,
    '中文标题 Ending',
    'Beginning 说明 BodyNeedle',
  );
  const before = snapshot(store);
  for (const q of [
    '中文标题',
    '  BODYneedle  ',
    '说明',
    'parent beacon',
    task.shortId.toLocaleLowerCase(),
  ]) {
    const found = await collect(app, { ...inputFor(selected), q });
    assert.deepEqual(ids(found), [result.id], q);
    assert.equal(matchesResultSearchQuery(result, task, normalizeTaskSearchQuery(q)), true);
  }
  for (const q of [
    'Ending Beginning',
    `Beacon ${task.shortId}`,
    'ExcludedDescription',
    result.id,
    task.id,
  ]) {
    assert.deepEqual(await collect(app, { ...inputFor(selected), q }), [], q);
    assert.equal(matchesResultSearchQuery(result, task, q.toLocaleLowerCase()), false);
  }
  assert.deepEqual(snapshot(store), before);
});

test('Result cursors bind type, normalized query, scope and project and reject malformed input', async (t) => {
  const { app, store, selected, other } = await fixture(t, 31, 0);
  const input = { type: 'result', ...inputFor(selected) };
  const first = await page(app, input);
  assert.ok(first.nextCursor);
  const bookmark = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(bookmark).sort(), [
    'afterResultId',
    'queryHash',
    'sequenceHash',
    'v',
  ]);
  assert.equal(
    bookmark.queryHash,
    hash(canonicalJson({ type: 'result', q: keyword, ...selected })),
  );
  const before = snapshot(store);
  assert.deepEqual(
    await page(app, { ...input, q: ` ${keyword} `, cursor: first.nextCursor }),
    await page(app, { ...input, cursor: first.nextCursor }),
  );
  for (const target of [
    inputFor(all),
    inputFor(personal),
    inputFor(other),
    { ...inputFor(selected), q: 'different' },
  ])
    await error(
      app,
      searchUrl({ type: 'result', ...target, cursor: first.nextCursor }),
      'INVALID_CURSOR',
    );
  for (const type of [undefined, 'task'])
    await error(
      app,
      searchUrl({ ...inputFor(selected), type, cursor: first.nextCursor }),
      'INVALID_CURSOR',
    );
  const tasks = await app.inject(searchUrl({ ...inputFor(selected), type: 'task' }));
  assert.equal(tasks.statusCode, 200);
  await error(
    app,
    searchUrl({ ...input, cursor: tasks.json<TaskSearchPage>().nextCursor }),
    'INVALID_CURSOR',
  );
  for (const cursor of [
    '',
    ' ',
    '%bad',
    'x'.repeat(1025),
    Buffer.from('not json').toString('base64url'),
    encode(null),
    encode([]),
    encode({}),
    encode({ ...bookmark, v: 2 }),
    encode({ ...bookmark, extra: true }),
    encode({ ...bookmark, queryHash: [] }),
    encode({ ...bookmark, sequenceHash: 'invalid' }),
    encode({ ...bookmark, afterResultId: '' }),
    encode({ ...bookmark, afterResultId: 'x'.repeat(151) }),
    encode({ ...bookmark, afterResultId: 'missing-result' }),
    first.nextCursor + '=',
  ])
    await error(app, searchUrl({ ...input, cursor }), 'INVALID_CURSOR');
  await error(
    app,
    `${searchUrl({ ...input, cursor: first.nextCursor })}&cursor=another`,
    'INVALID_CURSOR',
  );
  for (const type of ['', ' ', 'RESULT', 'results', 'result ', ' task'])
    await error(app, searchUrl({ type }), 'INVALID_INPUT');
  for (const suffix of [
    'type=result&type=result',
    'type=task&type=result',
    'type=&type=task',
    'type=result&%74ype=result',
  ])
    await error(app, `${searchUrl()}&${suffix}`, 'INVALID_INPUT');
  for (const invalid of [
    { q: '' },
    { q: ' \t ' },
    { q: '字'.repeat(161) },
    { scope: '' },
    { scope: 'unknown' },
    { scope: 'project' },
    { scope: 'project', projectId: '' },
    { scope: 'project', projectId: ' bad' },
    { scope: 'project', projectId: 'x'.repeat(151) },
    { scope: 'all', projectId: selected.projectId! },
    { scope: 'personal', projectId: selected.projectId! },
  ])
    await error(app, searchUrl({ type: 'result', ...invalid }), 'INVALID_INPUT');
  for (const suffix of [
    'q=one&q=two',
    'scope=all&scope=all',
    'scope=project&projectId=one&projectId=two',
  ])
    await error(app, `${searchUrl({ type: 'result' })}&${suffix}`, 'INVALID_INPUT');
  await error(app, '/api/v1/search?type=result', 'INVALID_INPUT');
  assert.equal(parseSearchType({}), 'task');
  assert.equal(parseSearchType({ type: 'task' }), 'task');
  assert.equal(parseSearchType({ type: 'result' }), 'result');
  for (const type of [undefined, null, 1, false, [], ['result'], {}])
    assert.throws(() => parseSearchType({ type }), { code: 'INVALID_INPUT', status: 400 });
  assert.deepEqual(snapshot(store), before);
});

function projectionFixture(count = 65) {
  const tasks: Task[] = [
    {
      id: 'parent-a',
      shortId: 'HX-100',
      spaceId: 'space',
      projectId: 'project-a',
      visibility: 'project',
      title: '当前父任务',
      description: '不参与匹配',
      ownerUserId: 'owner',
      status: 'todo',
      revision: 1,
      attention: null,
      createdAt: sameTime,
      updatedAt: sameTime,
    },
    {
      id: 'parent-b',
      shortId: 'HX-200',
      spaceId: 'space',
      projectId: null,
      visibility: 'private',
      title: '个人父任务',
      description: '',
      ownerUserId: 'owner',
      status: 'cancelled',
      revision: 1,
      attention: null,
      createdAt: sameTime,
      updatedAt: sameTime,
    },
  ];
  const results: Result[] = Array.from({ length: count }, (_, index) => ({
    id: `result-${count - index}`,
    taskId: tasks[0]!.id,
    title: `${keyword} ${index}`,
    body: '当前版本说明',
    revision: index + 2,
    kind: 'text',
    createdAt: sameTime,
    updatedAt: sameTime,
  }));
  return { tasks, results, query: parseTaskSearchQuery({ q: keyword }) };
}

test('pure Result projection keeps supplied order, exact boundaries, full current fields and no caller mutation', () => {
  const { tasks, results, query } = projectionFixture();
  const before = structuredClone({ tasks, results });
  for (const count of [0, 1, 29, 30, 31, 60, 61, 65]) {
    const source = results.slice(0, count).reverse();
    const first = pageResultSearch(source, tasks, query);
    assert.deepEqual(ids(first.items), ids(source.slice(0, 30)));
    assert.equal(first.nextCursor === null, count <= 30);
    assert.ok(
      first.items.every(
        ({ task, ...result }) => result.revision >= 2 && Object.keys(task).length === 4,
      ),
    );
    if (first.nextCursor) {
      const second = pageResultSearch(source, tasks, { ...query, cursor: first.nextCursor });
      assert.deepEqual(ids(second.items), ids(source.slice(30, 60)));
      assert.equal(second.nextCursor === null, count <= 60);
      assert.deepEqual(
        pageResultSearch(source, tasks, { ...query, cursor: first.nextCursor }),
        second,
      );
      if (second.nextCursor) {
        const third = pageResultSearch(source, tasks, { ...query, cursor: second.nextCursor });
        assert.deepEqual(ids(third.items), ids(source.slice(60)));
        assert.equal(third.nextCursor, null);
      }
    }
  }
  assert.deepEqual(currentResultSearchItems(results, tasks, { ...all, q: 'old-only-version' }), []);
  assert.deepEqual(
    currentResultSearchItems(results, tasks, { ...all, q: '当前版本说明' }).map(
      ({ task, ...result }) => result,
    ),
    results,
  );
  assert.deepEqual({ tasks, results }, before);
});

test('every current Result field and only relevant parent context expires the selected sequence', () => {
  const { tasks, results, query } = projectionFixture();
  const first = pageResultSearch(results, tasks, query);
  assert.ok(first.nextCursor);
  const nextQuery = { ...query, cursor: first.nextCursor };
  const expectChanged = (changedResults: Result[], changedTasks = tasks) =>
    assert.throws(() => pageResultSearch(changedResults, changedTasks, nextQuery), {
      code: 'SEARCH_RESULTS_CHANGED',
      status: 409,
    });
  for (const change of [
    { id: 'new-result-id' },
    { taskId: tasks[1]!.id },
    { title: `${keyword}新标题` },
    { title: '离开本次关键词' },
    { body: '较新正文' },
    { revision: 100 },
    { kind: 'demo-preview' as const },
    { createdAt: '2026-02-01T00:00:00Z' },
    { updatedAt: '2026-02-02T00:00:00Z' },
  ])
    expectChanged(
      results.map((result, index) => (index === 64 ? { ...result, ...change } : result)),
    );
  for (const change of [{ title: '新父任务标题' }, { shortId: 'HX-999' }, { projectId: null }])
    expectChanged(
      results,
      tasks.map((task, index) => (index === 0 ? { ...task, ...change } : task)),
    );
  expectChanged(
    results.map((result) => ({ ...result, taskId: 'renamed-parent' })),
    tasks.map((task, index) => (index === 0 ? { ...task, id: 'renamed-parent' } : task)),
  );
  expectChanged([...results].reverse());
  expectChanged(results.slice(1));
  expectChanged(results.filter((result) => result.id !== first.items.at(-1)!.id));
  expectChanged([{ ...results[0]!, id: 'new-result' }, ...results]);
  expectChanged(results, tasks.slice(1));
  const irrelevantParentChanges = tasks.map((task) => ({
    ...task,
    description: '父任务说明变化',
    attention: '关注变化',
    revision: 80,
    status: 'done' as const,
    updatedAt: '2026-03-01T00:00:00Z',
    participantUserIds: ['participant'],
  }));
  assert.deepEqual(
    pageResultSearch(results, irrelevantParentChanges, nextQuery),
    pageResultSearch(results, tasks, nextQuery),
  );
  const selectedQuery = parseTaskSearchQuery({
    q: keyword,
    scope: 'project',
    projectId: 'project-a',
  });
  const selectedFirst = pageResultSearch(results, tasks, selectedQuery);
  assert.throws(
    () =>
      pageResultSearch(
        results,
        tasks.map((task) => ({ ...task, projectId: null })),
        { ...selectedQuery, cursor: selectedFirst.nextCursor },
      ),
    { code: 'SEARCH_RESULTS_CHANGED', status: 409 },
  );
});

test('missing parents are skipped even in personal scope; unrelated projections preserve bookmarks', () => {
  const { tasks, results, query } = projectionFixture();
  const orphan = { ...results[0]!, id: 'orphan', taskId: 'missing-parent' };
  const other = { ...results[0]!, id: 'personal-result', taskId: tasks[1]!.id };
  for (const scope of [all, personal, { scope: 'project', projectId: 'project-a' } as const])
    assert.deepEqual(currentResultSearchItems([orphan], tasks, { ...scope, q: keyword }), []);
  assert.equal(matchesResultSearchQuery(orphan, undefined, keyword), true);
  assert.deepEqual(
    ids(currentResultSearchItems([orphan, other], tasks, { ...personal, q: keyword })),
    [other.id],
  );
  const selected = parseTaskSearchQuery({ q: keyword, scope: 'project', projectId: 'project-a' });
  const first = pageResultSearch(results, tasks, selected);
  const next = { ...selected, cursor: first.nextCursor };
  const expected = pageResultSearch(results, tasks, next);
  const unrelated = { ...results[0]!, id: 'nonmatching-result', title: '无关', body: '' };
  const changedUnrelatedTask = tasks.map((task, index) =>
    index === 1 ? { ...task, title: '无关父任务变化' } : task,
  );
  assert.deepEqual(
    pageResultSearch([orphan, other, unrelated, ...results], changedUnrelatedTask, next),
    expected,
  );
  assert.deepEqual(pageResultSearch(results, [...tasks].reverse(), next), expected);
  assert.deepEqual(
    pageResultSearch(results, tasks, query).items.map(({ task, ...result }) => result),
    results.slice(0, 30),
  );
});

test('ordinary Result insertion and current parent title edits invalidate HTTP pages and restart cleanly', async (t) => {
  const { app, store, selected } = await fixture(t, 31, 0);
  const input = inputFor(selected);
  const first = await page(app, input);
  assert.ok(first.nextCursor);
  const parent = store.tasks().find((task) => task.projectId === selected.projectId)!;
  store.patchTask(
    parent.id,
    { expectedRevision: parent.revision, title: '父任务的新标题' },
    randomUUID(),
  );
  const afterTitleWrite = snapshot(store);
  await error(
    app,
    searchUrl({ type: 'result', ...input, cursor: first.nextCursor }),
    'SEARCH_RESULTS_CHANGED',
    409,
  );
  assert.deepEqual(await collect(app, input), expectedItems(store, selected));
  assert.deepEqual(snapshot(store), afterTitleWrite);
  const restarted = await page(app, input);
  await createTextResult(app, parent.id, `${keyword} 新增`);
  const afterResultWrite = snapshot(store);
  await error(
    app,
    searchUrl({ type: 'result', ...input, cursor: restarted.nextCursor }),
    'SEARCH_RESULTS_CHANGED',
    409,
  );
  assert.deepEqual(await collect(app, input), expectedItems(store, selected));
  assert.deepEqual(snapshot(store), afterResultWrite);
});
