import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/control/src/app.js';
import type { Task } from '../packages/contracts/src/index.js';
import {
  parseTaskSearchQuery,
  type TaskSearchPage,
  type TaskSearchScope,
} from '../packages/contracts/src/task-search.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import {
  matchesTaskSearchQuery,
  matchesTaskSearchScope,
} from '../packages/domain/src/task-search.js';
import { Store } from '../packages/db/src/store.js';

type App = Awaited<ReturnType<typeof createApp>>;
type SearchInput = { scope?: string; projectId?: string; q?: string; cursor?: string | null };
const keyword = '范围检索';
const sameTime = '2026-01-02T03:04:05.000Z';
const all: TaskSearchScope = { scope: 'all', projectId: null };
const personal: TaskSearchScope = { scope: 'personal', projectId: null };
const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function searchUrl(input: SearchInput = {}) {
  const query = new URLSearchParams({ q: input.q ?? keyword });
  if (input.scope !== undefined) query.set('scope', input.scope);
  if (input.projectId !== undefined) query.set('projectId', input.projectId);
  if (input.cursor !== undefined && input.cursor !== null) query.set('cursor', input.cursor);
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

async function fixture(t: TestContext, count = 65) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-task-search-scope-'));
  const store = new Store(join(dir, 'preview.sqlite'));
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const selectedProject = store.createProject({ name: '选定项目', description: '' }, randomUUID());
  const otherProject = store.createProject({ name: '其他项目', description: '' }, randomUUID());
  const selected: TaskSearchScope = { scope: 'project', projectId: selectedProject.id };
  const other: TaskSearchScope = { scope: 'project', projectId: otherProject.id };
  for (let i = 0; i < count; i++) {
    for (const projectId of [selectedProject.id, null, otherProject.id]) {
      const task = store.createTask(
        { title: `${keyword} ${i}`, description: `当前说明 ${i}`, projectId },
        randomUUID(),
      );
      // Equal timestamps keep the original rowid order observable within each scope.
      task.createdAt = sameTime;
      task.updatedAt = sameTime;
      store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
    }
  }
  // More than a full global page precedes every selected-project and personal Task.
  for (let i = 0; i < 35; i++) {
    store.createTask(
      { title: `${keyword} 最近其他项目 ${i}`, description: '', projectId: otherProject.id },
      randomUUID(),
    );
  }
  return { app, store, selected, other };
}

function inputFor(scope: TaskSearchScope): SearchInput {
  return scope.scope === 'project'
    ? { scope: scope.scope, projectId: scope.projectId }
    : { scope: scope.scope };
}

function expectedTasks(store: Store, scope: TaskSearchScope, q = keyword) {
  return store
    .tasks()
    .filter((task) => matchesTaskSearchScope(task, scope) && matchesTaskSearchQuery(task, q));
}

async function page(app: App, input: SearchInput = {}): Promise<TaskSearchPage> {
  const response = await app.inject(searchUrl(input));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<TaskSearchPage>();
  assert.deepEqual(Object.keys(result).sort(), ['items', 'nextCursor']);
  return result;
}

async function collect(app: App, input: SearchInput = {}) {
  const tasks: Task[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(app, { ...input, cursor });
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

async function error(app: App, url: string, code: string, status = 400) {
  const response = await app.inject(url);
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code, url);
  assert.equal(response.json().items, undefined);
}

test('preview HTTP scopes filter before paging, preserve original order, and never write', async (t) => {
  const { app, store, selected, other } = await fixture(t);
  assert.ok(
    store
      .tasks()
      .slice(0, 30)
      .every((task) => task.projectId === other.projectId),
  );
  const before = snapshot(store);
  for (const scope of [selected, personal]) {
    const input = inputFor(scope);
    const expected = expectedTasks(store, scope);
    assert.equal(expected.length, 65);
    assert.equal(new Set(expected.map((task) => task.createdAt)).size, 1);
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
    assert.deepEqual(await collect(app, input), expected);
  }
  const expectedAll = expectedTasks(store, all);
  assert.deepEqual(await collect(app), expectedAll);
  assert.deepEqual(await collect(app, { scope: 'all' }), expectedAll);
  assert.deepEqual(await page(app), await page(app, { scope: 'all' }));
  assert.deepEqual(await collect(app, inputFor(other)), expectedTasks(store, other));
  assert.deepEqual(await page(app, { ...inputFor(selected), q: '不存在的关键词' }), {
    items: [],
    nextCursor: null,
  });
  for (const projectId of ['unknown-project', 'x'.repeat(150)]) {
    assert.deepEqual(await page(app, { scope: 'project', projectId }), {
      items: [],
      nextCursor: null,
    });
  }
  assert.deepEqual(snapshot(store), before);
});

test('scope matcher uses only exact projectId, with null identifying personal Tasks', () => {
  const project: TaskSearchScope = { scope: 'project', projectId: 'project-a' };
  for (const projectId of [null, 'project-a', 'project-b', '']) {
    assert.equal(matchesTaskSearchScope({ projectId }, all), true);
    assert.equal(matchesTaskSearchScope({ projectId }, personal), projectId === null);
    assert.equal(matchesTaskSearchScope({ projectId }, project), projectId === 'project-a');
  }
});

test('project scope retains Chinese, description, short ID, case and cross-field matching', async (t) => {
  const { app, store, selected, other } = await fixture(t, 0);
  const task = store.createTask(
    {
      title: '边界标题 Ending',
      description: 'Beginning 中文描述 NeedleZ',
      projectId: selected.projectId,
    },
    randomUUID(),
  );
  for (const projectId of [null, other.projectId]) {
    store.createTask({ title: task.title, description: task.description, projectId }, randomUUID());
  }
  const before = snapshot(store);
  for (const q of [
    '边界标题',
    '中文描述',
    ' needleZ ',
    task.shortId.toLocaleLowerCase(),
    'Ending Beginning',
    `NeedleZ ${task.shortId}`,
  ]) {
    assert.deepEqual(await collect(app, { ...inputFor(selected), q }), [task], q);
  }
  for (const q of [`Ending ${task.shortId}`, `${task.shortId} Beginning`, 'Ending  Beginning']) {
    assert.deepEqual(await collect(app, { ...inputFor(selected), q }), [], q);
  }
  assert.deepEqual(snapshot(store), before);
});

test('bookmarks bind canonical query, scope and project; old q-only bookmarks fail explicitly', async (t) => {
  const { app, store, selected, other } = await fixture(t, 31);
  const scopes = [all, personal, selected, other];
  const before = snapshot(store);
  for (const source of scopes) {
    const input = inputFor(source);
    const first = await page(app, input);
    assert.ok(first.nextCursor);
    const bookmark = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    assert.equal(bookmark.v, 1);
    assert.equal(bookmark.queryHash, hash(canonicalJson({ q: keyword, ...source })));
    assert.deepEqual(
      await page(app, { ...input, cursor: first.nextCursor, q: ` ${keyword} ` }),
      await page(app, { ...input, cursor: first.nextCursor }),
    );
    for (const target of scopes.filter((scope) => scope !== source)) {
      await error(
        app,
        searchUrl({ ...inputFor(target), cursor: first.nextCursor }),
        'INVALID_CURSOR',
      );
    }
    const legacy = Buffer.from(JSON.stringify({ ...bookmark, queryHash: hash(keyword) })).toString(
      'base64url',
    );
    await error(app, searchUrl({ ...input, cursor: legacy }), 'INVALID_CURSOR');
  }
  const first = await page(app);
  assert.ok(first.nextCursor);
  assert.deepEqual(
    await page(app, { cursor: first.nextCursor }),
    await page(app, { scope: 'all', cursor: first.nextCursor }),
  );
  assert.deepEqual(snapshot(store), before);
});

test('invalid, empty and duplicate scope/project inputs never fall back to all Tasks', async (t) => {
  const { app, store, selected } = await fixture(t, 0);
  const before = snapshot(store);
  const invalid: SearchInput[] = [
    ...['', ' ', 'unknown', 'ALL', 'project ', ' personal'].map((scope) => ({ scope })),
    { scope: 'project' },
    ...['', ' ', ' project-a', 'project-a ', '\tproject-a', 'x'.repeat(151)].map((projectId) => ({
      scope: 'project',
      projectId,
    })),
    { projectId: selected.projectId },
    { scope: 'all', projectId: selected.projectId },
    { scope: 'personal', projectId: selected.projectId },
    { scope: 'all', projectId: '' },
    { scope: 'personal', projectId: '' },
  ];
  for (const input of invalid) await error(app, searchUrl(input), 'INVALID_INPUT');
  for (const suffix of [
    'scope=all&scope=all',
    'scope=personal&scope=project',
    'scope=&scope=all',
    'scope=project&projectId=one&projectId=one',
    'scope=project&projectId=one&projectId=two',
    'scope=project&projectId=&projectId=one',
    'projectId=one&projectId=two',
  ]) {
    await error(app, `${searchUrl()}&${suffix}`, 'INVALID_INPUT');
  }
  for (const scope of [undefined, null, 1, false, [], ['all'], {}]) {
    assert.throws(() => parseTaskSearchQuery({ q: keyword, scope }), {
      code: 'INVALID_INPUT',
      status: 400,
    });
  }
  for (const projectId of [undefined, null, 1, false, [], [selected.projectId], {}]) {
    assert.throws(() => parseTaskSearchQuery({ q: keyword, scope: 'project', projectId }), {
      code: 'INVALID_INPUT',
      status: 400,
    });
    assert.throws(() => parseTaskSearchQuery({ q: keyword, scope: 'all', projectId }), {
      code: 'INVALID_INPUT',
      status: 400,
    });
  }
  assert.deepEqual(parseTaskSearchQuery({ q: ` ${keyword} ` }), {
    q: keyword,
    cursor: null,
    ...all,
  });
  assert.deepEqual(snapshot(store), before);
});

test('selected matching changes expire bookmarks; restarting returns the current scope', async (t) => {
  for (const change of [
    'insert',
    'delete-anchor',
    'description',
    'attention',
    'leave-query',
  ] as const) {
    await t.test(change, async (t) => {
      const { app, store, selected } = await fixture(t, 31);
      const input = inputFor(selected);
      const first = await page(app, input);
      assert.ok(first.nextCursor);
      const target = expectedTasks(store, selected).at(-1)!;
      if (change === 'insert') {
        store.createTask(
          { title: `${keyword} 新增`, description: '', projectId: selected.projectId },
          randomUUID(),
        );
      } else if (change === 'delete-anchor') {
        store.db.prepare('DELETE FROM tasks WHERE id=?').run(first.items.at(-1)!.id);
      } else {
        store.patchTask(
          target.id,
          {
            expectedRevision: target.revision,
            ...(change === 'description'
              ? { description: '更新说明' }
              : change === 'attention'
                ? { attention: '更新关注内容' }
                : { title: '离开关键词' }),
          },
          randomUUID(),
        );
      }
      const before = snapshot(store);
      await error(
        app,
        searchUrl({ ...input, cursor: first.nextCursor }),
        'SEARCH_RESULTS_CHANGED',
        409,
      );
      assert.deepEqual(await collect(app, input), expectedTasks(store, selected));
      assert.deepEqual(snapshot(store), before);
    });
  }
});

test('matching changes in other scopes and nonmatching selected Tasks preserve bookmarks', async (t) => {
  const { app, store, selected, other } = await fixture(t, 31);
  const input = inputFor(selected);
  const first = await page(app, input);
  assert.ok(first.nextCursor);
  const expected = await page(app, { ...input, cursor: first.nextCursor });
  for (const projectId of [other.projectId, null]) {
    const unrelated = store.createTask(
      { title: `${keyword} 范围之外`, description: '', projectId },
      randomUUID(),
    );
    store.patchTask(
      unrelated.id,
      { expectedRevision: unrelated.revision, description: '仍在其他范围' },
      randomUUID(),
    );
  }
  const unrelated = store.createTask(
    { title: '没有本次关键词', description: '', projectId: selected.projectId },
    randomUUID(),
  );
  store.patchTask(
    unrelated.id,
    { expectedRevision: unrelated.revision, attention: '不参与关键词匹配' },
    randomUUID(),
  );
  store.db.prepare('DELETE FROM tasks WHERE id=?').run(expectedTasks(store, other).at(-1)!.id);
  const before = snapshot(store);
  assert.deepEqual(await page(app, { ...input, cursor: first.nextCursor }), expected);
  assert.deepEqual(snapshot(store), before);
});
