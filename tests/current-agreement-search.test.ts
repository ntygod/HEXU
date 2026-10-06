import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/control/src/app.js';
import type { Project, Result, Task, Workbench } from '../packages/contracts/src/index.js';
import type {
  AgreementSearchHit,
  AgreementSearchPage,
} from '../packages/contracts/src/agreement-search.js';
import type {
  AgreementPreview,
  ProjectAgreement,
} from '../packages/contracts/src/project-agreements.js';
import { parseSearchType } from '../packages/contracts/src/result-search.js';
import { parseTaskSearchQuery } from '../packages/contracts/src/task-search.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import { matchesAgreementSearchQuery } from '../packages/domain/src/agreement-search.js';
import { Store } from '../packages/db/src/store.js';
import { pageTaskSearch } from '../packages/db/src/task-search.js';
import { pageResultSearch } from '../packages/db/src/result-search.js';

type App = Awaited<ReturnType<typeof createApp>>;
type SearchInput = {
  type?: string;
  q?: string;
  scope?: string;
  projectId?: string;
  cursor?: string | null;
};
const keyword = '当前约定';
const sameTime = '2026-01-02T03:04:05.000Z';
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });

function searchUrl(input: SearchInput = {}) {
  const query = new URLSearchParams({ type: input.type ?? 'agreement', q: input.q ?? keyword });
  for (const field of ['scope', 'projectId', 'cursor'] as const) {
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

async function publish(
  app: App,
  task: Task,
  title: string,
  content = '当前正文',
  replaces: { id: string; expectedRevision: number } | null = null,
) {
  const message = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/messages`,
    headers: headers(),
    payload: { body: '仅原讨论秘密词，https://discussion.invalid/example' },
  });
  assert.equal(message.statusCode, 201, message.body);
  const preview = await app.inject(
    `/api/v1/tasks/${task.id}/messages/${message.json().id}/agreement-preview`,
  );
  assert.equal(preview.statusCode, 200, preview.body);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${task.projectId}/agreements`,
    headers: headers(),
    payload: {
      title,
      content,
      sourceTaskId: task.id,
      sourceMessageId: message.json().id,
      expectedSourceHash: preview.json<AgreementPreview>().origin.hash,
      replaces,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<ProjectAgreement>();
}

async function edit(app: App, agreement: ProjectAgreement, title: string, content: string) {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${agreement.projectId}/agreements/${agreement.id}`,
    headers: headers(),
    payload: { expectedRevision: agreement.revision, title, content },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<ProjectAgreement>();
}

async function lifecycle(
  app: App,
  agreement: ProjectAgreement,
  action: 'deactivate' | 'reactivate',
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${agreement.projectId}/agreements/${agreement.id}/lifecycle`,
    headers: headers(),
    payload: { expectedRevision: agreement.revision, action, reason: '普通维护' },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<ProjectAgreement>();
}

async function fixture(t: TestContext, count = 65, otherCount = 7) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-current-agreement-search-'));
  const store = new Store(join(dir, 'preview.sqlite'));
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject({ name: '选定项目', description: '' }, randomUUID());
  const otherProject = store.createProject({ name: '其他项目', description: '' }, randomUUID());
  const task = store.createTask(
    { title: '仅原任务标题', description: '仅原任务说明', projectId: project.id },
    randomUUID(),
  );
  const otherTask = store.createTask(
    { title: '第二项目讨论', description: '', projectId: otherProject.id },
    randomUUID(),
  );
  const agreements: ProjectAgreement[] = [];
  for (let index = 0; index < Math.max(count, otherCount); index++) {
    if (index < count) agreements.push(await publish(app, task, `${keyword} ${index}`));
    if (index < otherCount)
      agreements.push(await publish(app, otherTask, `${keyword}其他 ${index}`));
  }
  for (const agreement of agreements) {
    // Equal timestamps ensure insertion order, not timestamps or random IDs, governs every page.
    agreement.createdAt = sameTime;
    agreement.updatedAt = sameTime;
    store.db
      .prepare('UPDATE project_agreements SET body=? WHERE id=?')
      .run(JSON.stringify(agreement), agreement.id);
  }
  return { app, store, project, otherProject, task, otherTask, agreements };
}

async function page(app: App, input: SearchInput = {}) {
  const response = await app.inject(searchUrl(input));
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<AgreementSearchPage>();
  assert.deepEqual(Object.keys(result).sort(), ['items', 'nextCursor']);
  assert.ok(result.items.length <= 30);
  return result;
}

async function collect(app: App, input: SearchInput = {}) {
  const items: AgreementSearchHit[] = [];
  const lengths: number[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(app, { ...input, cursor });
    items.push(...result.items);
    lengths.push(result.items.length);
    cursor = result.nextCursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor));
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(new Set(ids(items)).size, items.length);
  return { items, lengths };
}

async function error(app: App, url: string, code: string, status = 400) {
  const response = await app.inject(url);
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code, url);
  assert.equal(response.json().items, undefined);
}

async function workbench(app: App) {
  const response = await app.inject('/api/v1/workbench');
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Workbench>();
}

function currentHit(agreement: ProjectAgreement, project: Project): AgreementSearchHit {
  return {
    id: agreement.id,
    projectId: agreement.projectId,
    title: agreement.title,
    content: agreement.content,
    revision: agreement.revision,
    state: agreement.state,
    updatedAt: agreement.updatedAt,
    project: {
      id: project.id,
      name: project.name,
      ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
    },
  };
}

test('current agreement HTTP search covers all rows in global rowid order and scopes before 30-item pages', async (t) => {
  const { app, store, project, otherProject, agreements } = await fixture(t);
  const before = snapshot(store);
  const expected = [...agreements]
    .reverse()
    .map((agreement) =>
      currentHit(agreement, agreement.projectId === project.id ? project : otherProject),
    );
  const all = await collect(app);
  assert.deepEqual(all.lengths, [30, 30, 12]);
  assert.deepEqual(all.items, expected);
  const selected = await collect(app, { scope: 'project', projectId: project.id });
  assert.deepEqual(selected.lengths, [30, 30, 5]);
  assert.deepEqual(
    selected.items,
    expected.filter((agreement) => agreement.projectId === project.id),
  );
  assert.deepEqual(
    (await collect(app, { scope: 'project', projectId: otherProject.id })).items,
    expected.filter((agreement) => agreement.projectId === otherProject.id),
  );
  assert.deepEqual(await page(app, { scope: 'project', projectId: 'unknown-project' }), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(await page(app, { q: '不存在的约定词' }), { items: [], nextCursor: null });
  await workbench(app);
  assert.deepEqual(
    snapshot(store),
    before,
    'all successful search and workbench reads are read-only',
  );
});

test('search matches only current title/content, keeps all explicit states and excludes origins and old revisions', async (t) => {
  const { app, store, project, task } = await fixture(t, 0, 0);
  const old = await publish(app, task, '旧版标题独有', '旧版正文独有');
  const active = await edit(app, old, `${keyword} 大小写MiXeD`, '  原样正文\n后缀内容');
  const inactive = await lifecycle(app, await publish(app, task, `${keyword}停用`), 'deactivate');
  const predecessor = await publish(app, task, `${keyword}旧规则`);
  const successor = await publish(app, task, `${keyword}新规则`, '新规则正文', {
    id: predecessor.id,
    expectedRevision: predecessor.revision,
  });
  const superseded = store.projectAgreements.get(project.id, predecessor.id);
  const crossing = await publish(app, task, '跨字段', '边界正文与100%_字符');
  const before = snapshot(store);
  assert.deepEqual(
    (await collect(app)).items,
    [successor, superseded, inactive, active].map((a) => currentHit(a, project)),
  );
  assert.deepEqual(ids((await page(app, { q: 'mixed' })).items), [active.id]);
  assert.deepEqual(ids((await page(app, { q: '后缀内容' })).items), [active.id]);
  assert.deepEqual(ids((await page(app, { q: '跨字段 边界' })).items), [crossing.id]);
  assert.deepEqual(ids((await page(app, { q: '100%_' })).items), [crossing.id]);
  for (const q of [
    '旧版标题独有',
    '旧版正文独有',
    '仅原讨论秘密词',
    'discussion.invalid',
    '仅原任务标题',
    '仅原任务说明',
    task.shortId,
    project.name,
  ])
    assert.deepEqual((await page(app, { q })).items, [], q);
  for (const hit of (await collect(app)).items) {
    assert.deepEqual(Object.keys(hit).sort(), [
      'content',
      'id',
      'project',
      'projectId',
      'revision',
      'state',
      'title',
      'updatedAt',
    ]);
    assert.deepEqual(Object.keys(hit.project).sort(), ['id', 'name']);
  }
  assert.equal(
    matchesAgreementSearchQuery({ title: 'MiXeD中文', content: '文本' }, 'mixed中文 文'),
    true,
  );
  assert.equal(matchesAgreementSearchQuery({ title: '甲', content: '乙' }, '甲乙'), false);
  assert.deepEqual(snapshot(store), before);
});

test('agreement cursor binds type, normalized query, scope and selected project with strict invalid inputs', async (t) => {
  const { app, store, project, otherProject } = await fixture(t, 35, 2);
  const input = { scope: 'project', projectId: project.id };
  const first = await page(app, input);
  assert.ok(first.nextCursor);
  const bookmark = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(bookmark).sort(), [
    'afterAgreementId',
    'queryHash',
    'sequenceHash',
    'v',
  ]);
  assert.equal(
    bookmark.queryHash,
    hash(canonicalJson({ type: 'agreement', q: keyword, ...input })),
  );
  const before = snapshot(store);
  assert.deepEqual(
    await page(app, { ...input, q: ` ${keyword} `, cursor: first.nextCursor }),
    await page(app, { ...input, cursor: first.nextCursor }),
  );
  for (const target of [
    { scope: 'all' },
    { scope: 'project', projectId: otherProject.id },
    { ...input, q: '不同关键词' },
    { ...input, type: 'task' },
    { ...input, type: 'result' },
  ])
    await error(app, searchUrl({ ...target, cursor: first.nextCursor }), 'INVALID_CURSOR');
  for (const cursor of [
    '',
    ' ',
    '%bad',
    'x'.repeat(1025),
    encode('not a cursor'),
    encode(null),
    encode([]),
    encode({}),
    encode({ ...bookmark, v: 2 }),
    encode({ ...bookmark, extra: true }),
    encode({ ...bookmark, queryHash: [] }),
    encode({ ...bookmark, sequenceHash: 'invalid' }),
    encode({ ...bookmark, afterAgreementId: '' }),
    encode({ ...bookmark, afterAgreementId: 'x'.repeat(151) }),
    encode({ ...bookmark, afterAgreementId: 'missing-agreement' }),
    encode({
      v: 1,
      queryHash: bookmark.queryHash,
      sequenceHash: bookmark.sequenceHash,
      afterTaskId: bookmark.afterAgreementId,
    }),
    encode({
      v: 1,
      queryHash: bookmark.queryHash,
      sequenceHash: bookmark.sequenceHash,
      afterResultId: bookmark.afterAgreementId,
    }),
    first.nextCursor + '=',
  ])
    await error(app, searchUrl({ ...input, cursor }), 'INVALID_CURSOR');
  for (const invalid of [
    { scope: 'personal' },
    { scope: 'personal', cursor: first.nextCursor },
    { q: '' },
    { q: ' \t ' },
    { q: '字'.repeat(161) },
    { scope: '' },
    { scope: 'unknown' },
    { scope: 'project' },
    { scope: 'project', projectId: '' },
    { scope: 'project', projectId: ' bad' },
    { scope: 'project', projectId: 'x'.repeat(151) },
    { scope: 'all', projectId: project.id },
    { type: 'AGREEMENT' },
    { type: 'agreements' },
  ])
    await error(app, searchUrl(invalid), 'INVALID_INPUT');
  for (const suffix of [
    'q=one&q=two',
    'type=agreement&type=agreement',
    'scope=all&scope=all',
    'scope=project&projectId=one&projectId=two',
  ])
    await error(app, `${searchUrl()}&${suffix}`, 'INVALID_INPUT');
  await error(
    app,
    `${searchUrl(input)}&cursor=${first.nextCursor}&cursor=another`,
    'INVALID_CURSOR',
  );
  await error(app, '/api/v1/search?type=agreement', 'INVALID_INPUT');
  assert.equal(parseSearchType({ type: 'agreement' }), 'agreement');
  assert.deepEqual(
    snapshot(store),
    before,
    'invalid reads do not create receipts or alter stored state',
  );
});

test('ordinary current agreement and project changes invalidate matching bookmarks while unrelated writes do not', async (t) => {
  const { app, store, project, otherProject, task, otherTask } = await fixture(t, 35, 1);
  const input = { scope: 'project', projectId: project.id };
  let first = await page(app, input);
  assert.ok(first.nextCursor);
  const next = await page(app, { ...input, cursor: first.nextCursor });
  const irrelevant = await publish(app, task, '无关标题', '无关正文');
  await edit(app, irrelevant, '仍然无关标题', '仍然无关正文');
  await publish(app, otherTask, `${keyword}其他项目新增`);
  store.projectSettings.patch(
    otherProject.id,
    { expectedRevision: otherProject.revision, name: '其他项目更名' },
    randomUUID(),
  );
  store.projectSettings.patch(
    project.id,
    { expectedRevision: project.revision, description: '不属于搜索DTO' },
    randomUUID(),
  );
  store.patchTask(
    task.id,
    { expectedRevision: task.revision, title: '源任务更名', description: '源任务说明更新' },
    randomUUID(),
  );
  assert.deepEqual(await page(app, { ...input, cursor: first.nextCursor }), next);
  const changes: Array<() => Promise<unknown>> = [
    async () => publish(app, task, `${keyword}新记录`),
    async () => {
      const current = store.projectAgreements.get(project.id, first.items[0]!.id);
      return edit(app, current, `${current.title}更新`, '改后正文');
    },
    async () =>
      lifecycle(app, store.projectAgreements.get(project.id, first.items[0]!.id), 'deactivate'),
    async () =>
      lifecycle(app, store.projectAgreements.get(project.id, first.items[0]!.id), 'reactivate'),
    async () =>
      publish(app, task, `${keyword}替代规则`, '替代正文', {
        id: first.items[0]!.id,
        expectedRevision: first.items[0]!.revision,
      }),
    async () =>
      edit(
        app,
        store.projectAgreements.get(project.id, first.items[0]!.id),
        '不再命中',
        '不再命中的正文',
      ),
    async () =>
      store.projectSettings.patch(
        project.id,
        { expectedRevision: store.project(project.id).revision, name: '当前项目新名称' },
        randomUUID(),
      ),
    async () =>
      store.projectLifecycle.change(
        project.id,
        {
          expectedRevision: store.project(project.id).revision,
          action: 'archive',
          activeRunAction: 'keep',
        },
        randomUUID(),
      ),
  ];
  for (const change of changes) {
    await change();
    await error(
      app,
      searchUrl({ ...input, cursor: first.nextCursor }),
      'SEARCH_RESULTS_CHANGED',
      409,
    );
    first = await page(app, input);
    assert.ok(first.nextCursor);
    const found = await collect(app, input);
    assert.equal(found.items.length, new Set(ids(found.items)).size);
  }
  assert.ok(
    first.items.every((item) => item.project.name === '当前项目新名称' && item.project.archivedAt),
  );
});

test('workbench reads only current project version metadata and follows ordinary publication, edit, lifecycle and replacement', async (t) => {
  const { app, store, project, otherProject, task } = await fixture(t, 0, 0);
  const versions = async () => {
    const before = snapshot(store);
    const value = await workbench(app);
    assert.deepEqual(snapshot(store), before);
    assert.ok(value.projectAgreementVersions);
    assert.deepEqual(
      value.projectAgreementVersions.map((item) => item.projectId),
      value.projects.map((item) => item.id),
    );
    for (const item of value.projectAgreementVersions) {
      assert.deepEqual(Object.keys(item).sort(), ['projectId', 'version']);
      assert.ok(Number.isSafeInteger(item.version) && item.version >= 0);
    }
    assert.equal(
      value.projectAgreementVersions.find((item) => item.projectId === otherProject.id)!.version,
      0,
    );
    return value.projectAgreementVersions.find((item) => item.projectId === project.id)!.version;
  };
  assert.equal(await versions(), 0);
  assert.throws(() => store.projectAgreements.version('unknown-project'), { code: 'NOT_FOUND' });
  let agreement = await publish(app, task, `${keyword}第一版`);
  assert.equal(await versions(), 1);
  agreement = await edit(app, agreement, `${keyword}第二版`, '第二版正文');
  assert.equal(await versions(), 2);
  agreement = await lifecycle(app, agreement, 'deactivate');
  assert.equal(await versions(), 3);
  agreement = await lifecycle(app, agreement, 'reactivate');
  assert.equal(await versions(), 4);
  await publish(app, task, `${keyword}后继`, '后继正文', {
    id: agreement.id,
    expectedRevision: agreement.revision,
  });
  assert.equal(await versions(), 6);
  assert.equal(store.projectAgreements.notice(task.id).version, 6);
});

test('adding agreement search preserves original Task and Result bookmark bytes', () => {
  const tasks: Task[] = Array.from({ length: 31 }, (_, index) => ({
    id: `task-${index}`,
    shortId: `HX-${index}`,
    spaceId: 'space',
    projectId: 'project',
    visibility: 'project',
    title: keyword,
    description: '',
    ownerUserId: 'member',
    status: 'todo',
    revision: 1,
    attention: null,
    createdAt: sameTime,
    updatedAt: sameTime,
  }));
  const results: Result[] = tasks.map((task, index) => ({
    id: `result-${index}`,
    taskId: task.id,
    title: keyword,
    body: '当前正文',
    revision: 1,
    kind: 'text',
    createdAt: sameTime,
    updatedAt: sameTime,
  }));
  const query = parseTaskSearchQuery({ q: keyword });
  assert.equal(
    pageTaskSearch(tasks, query).nextCursor,
    encode({
      v: 1,
      queryHash: hash(canonicalJson({ q: keyword, scope: 'all', projectId: null })),
      sequenceHash: hash(canonicalJson(tasks)),
      afterTaskId: tasks[29]!.id,
    }),
  );
  const resultItems = results.map((result, index) => ({
    ...result,
    task: {
      id: tasks[index]!.id,
      title: tasks[index]!.title,
      shortId: tasks[index]!.shortId,
      projectId: tasks[index]!.projectId,
    },
  }));
  assert.equal(
    pageResultSearch(results, tasks, query).nextCursor,
    encode({
      v: 1,
      queryHash: hash(canonicalJson({ type: 'result', q: keyword, scope: 'all', projectId: null })),
      sequenceHash: hash(canonicalJson(resultItems)),
      afterResultId: results[29]!.id,
    }),
  );
});
