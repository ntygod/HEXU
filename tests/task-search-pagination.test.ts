import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/control/src/app.js';
import type { Task } from '../packages/contracts/src/index.js';
import {
  normalizeTaskSearchQuery,
  parseTaskSearchQuery,
  type TaskSearchPage,
} from '../packages/contracts/src/task-search.js';
import { matchesTaskSearchQuery } from '../packages/domain/src/task-search.js';
import { Store } from '../packages/db/src/store.js';
import { pageTaskSearch } from '../packages/db/src/task-search.js';

type App = Awaited<ReturnType<typeof createApp>>;
const keyword = '分页检索';
const sameTime = '2026-01-02T03:04:05.000Z';
const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const searchUrl = (q: string, cursor?: string | null) => {
  const query = new URLSearchParams({ q });
  if (cursor !== undefined && cursor !== null) query.set('cursor', cursor);
  return `/api/v1/search?${query}`;
};

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

async function fixture(t: TestContext, count = 65) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-task-search-'));
  const store = new Store(join(dir, 'preview.sqlite'));
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const created: Task[] = [];
  for (let i = 0; i < count; i++) {
    const task = store.createTask(
      { title: `${keyword} ${i}`, description: `当前说明 ${i}`, projectId: null },
      randomUUID(),
    );
    // Equal timestamps deliberately leave ordering to the original Store.tasks feed.
    task.createdAt = sameTime;
    task.updatedAt = sameTime;
    store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
    created.push(task);
  }
  return { store, app, created };
}

async function page(app: App, q = keyword, cursor?: string | null): Promise<TaskSearchPage> {
  const response = await app.inject(searchUrl(q, cursor));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<TaskSearchPage>();
  assert.deepEqual(Object.keys(result).sort(), ['items', 'nextCursor']);
  assert.ok(Array.isArray(result.items));
  assert.ok(result.nextCursor === null || typeof result.nextCursor === 'string');
  return result;
}

async function collect(app: App, q = keyword) {
  const tasks: Task[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(app, q, cursor);
    assert.ok(result.items.length <= 30);
    tasks.push(...result.items);
    cursor = result.nextCursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor), 'pagination must progress');
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(new Set(ids(tasks)).size, tasks.length);
  return tasks;
}

test('preview HTTP pages all 65 matching Tasks in original equal-timestamp order without writes', async (t) => {
  const { app, store } = await fixture(t);
  const expected = store.tasks().filter((task) => task.title.includes(keyword));
  assert.equal(expected.length, 65);
  assert.equal(new Set(expected.map((task) => task.createdAt)).size, 1);
  const before = snapshot(store);
  const first = await page(app);
  assert.deepEqual(first.items, expected.slice(0, 30));
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 1024);
  const second = await page(app, keyword, first.nextCursor);
  assert.deepEqual(second.items, expected.slice(30, 60));
  assert.ok(second.nextCursor);
  assert.deepEqual(await page(app, keyword, first.nextCursor), second);
  const third = await page(app, keyword, second.nextCursor);
  assert.deepEqual(third.items, expected.slice(60));
  assert.equal(third.nextCursor, null);
  assert.deepEqual(await collect(app), expected);
  assert.deepEqual(await page(app, '不存在的搜索词'), { items: [], nextCursor: null });
  assert.deepEqual(snapshot(store), before);
});

test('pure pager preserves supplied order, exact page boundaries and DTO content', async (t) => {
  const { store } = await fixture(t);
  const tasks = store
    .tasks()
    .filter((task) => task.title.includes(keyword))
    .map((task, index) => ({ ...task, id: `task-${100 - index}` }))
    .reverse();
  const query = parseTaskSearchQuery({ q: keyword });
  for (const count of [0, 1, 29, 30, 31, 60, 61, 65]) {
    const source = tasks.slice(0, count);
    const before = structuredClone(source);
    const first = pageTaskSearch(source, query);
    assert.deepEqual(first.items, source.slice(0, 30));
    assert.equal(first.nextCursor === null, count <= 30);
    if (first.nextCursor) {
      const second = pageTaskSearch(source, { ...query, cursor: first.nextCursor });
      assert.deepEqual(second.items, source.slice(30, 60));
      assert.equal(second.nextCursor === null, count <= 60);
      assert.throws(
        () => pageTaskSearch([...source].reverse(), { ...query, cursor: first.nextCursor }),
        { code: 'SEARCH_RESULTS_CHANGED', status: 409 },
      );
    }
    assert.deepEqual(source, before);
  }
});

test('ordinary search keeps Chinese, case, ID, description and cross-field matching semantics', async (t) => {
  const { app, store } = await fixture(t, 0);
  const task = store.createTask(
    { title: '边界标题 Ending', description: 'Beginning 中文描述 NeedleZ', projectId: null },
    randomUUID(),
  );
  const before = snapshot(store);
  for (const q of [
    '边界标题',
    '中文描述',
    ' needleZ ',
    task.shortId.toLocaleLowerCase(),
    'Ending Beginning',
    `NeedleZ ${task.shortId}`,
    ' Ending Beginning 中文描述 ',
  ]) {
    const normalized = normalizeTaskSearchQuery(q);
    const expected = store
      .tasks()
      .filter((current) =>
        (current.title + ' ' + current.description + ' ' + current.shortId)
          .toLocaleLowerCase()
          .includes(normalized),
      );
    assert.deepEqual(await collect(app, q), expected, q);
    assert.ok(matchesTaskSearchQuery(task, normalized), q);
    assert.ok(
      expected.some((current) => current.id === task.id),
      q,
    );
  }
  for (const q of [`Ending ${task.shortId}`, `${task.shortId} Beginning`, 'Ending  Beginning']) {
    assert.equal(matchesTaskSearchQuery(task, normalizeTaskSearchQuery(q)), false, q);
    assert.deepEqual(await collect(app, q), []);
  }
  assert.deepEqual(snapshot(store), before);
});

test('invalid queries retain existing validation; malformed and foreign cursors fail explicitly', async (t) => {
  const { app, store } = await fixture(t);
  const first = await page(app);
  assert.ok(first.nextCursor);
  const bookmark = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  const before = snapshot(store);
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
    encode({ ...bookmark, afterTaskId: '' }),
    encode({ ...bookmark, afterTaskId: 'x'.repeat(151) }),
    encode({ ...bookmark, afterTaskId: 'unknown-task' }),
    first.nextCursor + '=',
  ]) {
    const response = await app.inject(searchUrl(keyword, cursor));
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'INVALID_CURSOR');
    assert.equal(response.json().items, undefined);
  }
  const duplicated = await app.inject(`${searchUrl(keyword, first.nextCursor)}&cursor=second`);
  assert.equal(duplicated.statusCode, 400);
  assert.equal(duplicated.json().error.code, 'INVALID_CURSOR');
  const foreign = await app.inject(searchUrl('different query', first.nextCursor));
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.json().error.code, 'INVALID_CURSOR');
  assert.deepEqual(
    await page(app, ` ${keyword} `, first.nextCursor),
    await page(app, keyword, first.nextCursor),
  );
  for (const q of ['', ' \t ', '字'.repeat(161)]) {
    const response = await app.inject(searchUrl(q));
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_INPUT');
  }
  for (const url of ['/api/v1/search', '/api/v1/search?q=one&q=two']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_INPUT');
  }
  assert.equal(normalizeTaskSearchQuery('字'.repeat(160)).length, 160);
  assert.throws(() => parseTaskSearchQuery({ q: keyword, cursor: null }), {
    code: 'INVALID_CURSOR',
  });
  assert.deepEqual(snapshot(store), before);
});

test('matching insert, deletion and edits expire old pages; explicit restart returns current unique Tasks', async (t) => {
  for (const change of [
    'insert',
    'delete-anchor',
    'edit-description',
    'edit-attention',
    'leave-search',
  ] as const) {
    await t.test(change, async (t) => {
      const { app, store } = await fixture(t);
      const first = await page(app);
      assert.ok(first.nextCursor);
      const matches = store.tasks().filter((task) => task.title.includes(keyword));
      const target = matches.at(-1)!;
      if (change === 'insert') {
        store.createTask(
          { title: `${keyword} 新增`, description: '', projectId: null },
          randomUUID(),
        );
      } else if (change === 'delete-anchor') {
        // Delete only this disposable fixture's Task, without introducing a product delete API.
        store.db.prepare('DELETE FROM tasks WHERE id=?').run(first.items.at(-1)!.id);
      } else {
        store.patchTask(
          target.id,
          {
            expectedRevision: target.revision,
            ...(change === 'edit-description'
              ? { description: '后来更新的说明' }
              : change === 'edit-attention'
                ? { attention: '后来更新的关注事项' }
                : { title: '已离开本次关键词' }),
          },
          randomUUID(),
        );
      }
      const beforeRead = snapshot(store);
      const stale = await app.inject(searchUrl(keyword, first.nextCursor));
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().error.code, 'SEARCH_RESULTS_CHANGED');
      assert.equal(stale.json().items, undefined);
      const expected = store.tasks().filter((task) => matchesTaskSearchQuery(task, keyword));
      assert.deepEqual(await collect(app), expected);
      assert.deepEqual(snapshot(store), beforeRead);
    });
  }
});

test('changes outside the current matching sequence do not expire its bookmark', async (t) => {
  const { app, store } = await fixture(t);
  const first = await page(app);
  const expected = await page(app, keyword, first.nextCursor);
  const unrelated = store.createTask(
    { title: '无关任务', description: '', projectId: null },
    randomUUID(),
  );
  store.patchTask(
    unrelated.id,
    { expectedRevision: unrelated.revision, description: '仍然无关' },
    randomUUID(),
  );
  const before = snapshot(store);
  assert.deepEqual(await page(app, keyword, first.nextCursor), expected);
  assert.deepEqual(snapshot(store), before);
});
