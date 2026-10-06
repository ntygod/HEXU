import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Project, Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskSearchPage } from '../../packages/contracts/src/task-search.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: '搜索与快捷操作', exact: true });
const search = (page: Page) => dialog(page).getByRole('textbox', { name: '全局搜索', exact: true });
const scope = (page: Page) =>
  dialog(page).getByRole('combobox', { name: '任务搜索范围', exact: true });
const results = (page: Page) =>
  dialog(page).getByRole('region', { name: '任务搜索结果', exact: true });
const rows = (page: Page) => results(page).getByRole('button');
const row = (page: Page, task: Task) => results(page).locator(`button[data-task-id="${task.id}"]`);
const status = (page: Page) =>
  dialog(page).getByRole('status', { name: '任务搜索分页状态', exact: true });
const more = (page: Page) =>
  dialog(page).getByRole('button', { name: '加载更多任务', exact: true });
const snippet = (target: Locator) => target.getByLabel('任务说明匹配片段', { exact: true });
const projectScope = (project: Project) => `project:${project.id}`;
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api/v1/' + path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Keep exact handler ownership. Observe every rejection immediately, then stop
// captures, release held real reads and drain before removing any route.
function readRoutes(page: Page) {
  let capturing = true;
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const releases: (() => void)[] = [];
  const handlers: { pattern: string; handler: (route: Route) => Promise<void> }[] = [];
  return {
    gate() {
      const release = deferred();
      releases.push(release.resolve);
      return {
        release: release.resolve,
        wait: release.promise,
        captured: null as TaskSearchPage | null,
        settled: false,
      };
    },
    async install(run: (route: Route) => Promise<void>) {
      const pattern = '**/api/v1/search?*';
      const handler = (route: Route) => {
        const operation = (async () => {
          if (!capturing) return route.continue();
          await run(route);
        })();
        pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          (error: unknown) => {
            errors.push(error);
            pending.delete(operation);
          },
        );
        return operation;
      };
      await page.route(pattern, handler);
      handlers.push({ pattern, handler });
    },
    async stop(failed: boolean) {
      capturing = false;
      for (const release of releases) release();
      while (pending.size) await Promise.allSettled([...pending]);
      for (const { pattern, handler } of handlers) {
        try {
          await page.unroute(pattern, handler);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!errors.length) return;
      if (failed) {
        for (const error of errors)
          base.info().annotations.push({
            type: 'cleanup-error',
            description: error instanceof Error ? error.message : String(error),
          });
      } else throw new AggregateError(errors, '任务搜索范围读取夹具清理失败');
    },
  };
}

async function fixture(page: Page, projectTaskCount: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const token = randomUUID().slice(0, 8);
  const query = `Scope-${token} 🧭 <b>核对</b>`;
  const alternateQuery = `${query} 唯一项`;
  const projects: Project[] = [];
  for (const name of ['范围项目', '较新项目', '空项目'])
    projects.push(
      await post<Project>(page, 'spaces/space-demo/projects', {
        name: `${name} ${token}`,
        description: '只通过普通 HTTP 建立当前任务搜索范围。',
      }),
    );
  const [project, otherProject, emptyProject] = projects as [Project, Project, Project];
  const tasks: Task[] = [];
  async function create(projectId: string | null, title: string, description: string) {
    const task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId,
      title,
      description,
    });
    tasks.push(task);
    return task;
  }
  const body =
    '开头背景不包含检索词。' +
    '普通背景与下一步说明。'.repeat(65) +
    `第一处检查 ${query} 首次命中后的当前说明。` +
    '两处之间的普通背景。'.repeat(35) +
    `第二处检查 ${query} 末尾说明。`;
  for (let index = 0; index < projectTaskCount; index++)
    await create(
      project.id,
      index === 0 || index === Math.floor(projectTaskCount / 2)
        ? `只在说明命中的第 ${index + 1} 项工作`
        : `${query} 第 ${index + 1} 项工作`,
      body + (index === projectTaskCount - 1 ? ` ${alternateQuery}` : ''),
    );
  const alternateTask = tasks.at(-1)!;
  // These 31 newer matching tasks occupy an entire unscoped first page. A
  // client-side filter after pagination cannot produce the selected first 30.
  for (let index = 0; index < 31; index++)
    await create(otherProject.id, `${query} 较新的第 ${index + 1} 项`, '其他项目的当前说明。');
  for (let index = 0; index < 2; index++)
    await create(null, `${query} 个人第 ${index + 1} 项`, '没有项目的当前个人任务。');

  const expected = new Map(
    await Promise.all(
      tasks.map(
        async (task) => [task.id, await get<TaskDetail>(page, `tasks/${task.id}`)] as const,
      ),
    ),
  );
  expect([...expected.values()].every((detail) => detail.runs.length === 0)).toBe(true);
  async function edit(
    task: Task,
    changes: { title?: string; description?: string; attention?: string },
  ) {
    const before = expected.get(task.id)!;
    const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
      headers: headers(),
      data: { expectedRevision: before.task.revision, ...changes },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const saved = (await response.json()) as Task;
    const { participantUserIds, ...storedBefore } = before.task;
    expect(saved).toEqual({
      ...storedBefore,
      ...changes,
      revision: before.task.revision + 1,
      updatedAt: saved.updatedAt,
    });
    expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true);
    const after = { ...before, task: { ...saved, participantUserIds } };
    expect(await get<TaskDetail>(page, `tasks/${task.id}`)).toEqual(after);
    expected.set(task.id, after);
    return after.task;
  }
  // Give both later-page body hits a real revision above one before the UI
  // baseline, so a hardcoded revision label cannot satisfy screenshot checks.
  for (const task of tasks.filter(
    (task) => task.projectId === project.id && !task.title.includes(query),
  ))
    await edit(task, { attention: '保留已有任务修订' });

  const ids = new Set(tasks.map((task) => task.id));
  async function ordered() {
    const workbench = await get<Workbench>(page, 'workbench');
    // Derive the expected order from the real current feed, never /search.
    const matching = workbench.tasks.filter((task) =>
      `${task.title} ${task.description} ${task.shortId}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    expect(matching.map((task) => task.id).sort()).toEqual([...ids].sort());
    return matching;
  }
  const originalOrder = await ordered();
  const selected = originalOrder.filter((task) => task.projectId === project.id);
  const other = originalOrder.filter((task) => task.projectId === otherProject.id);
  const personal = originalOrder.filter((task) => task.projectId === null);
  expect(originalOrder.slice(0, 30).every((task) => task.projectId !== project.id)).toBe(true);
  const browserWrites: string[] = [];
  const requests: {
    q: string;
    scope: string | null;
    projectId: string | null;
    cursor: string | null;
  }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'GET' && url.pathname === '/api/v1/search')
      requests.push({
        q: url.searchParams.get('q')!,
        scope: url.searchParams.get('scope'),
        projectId: url.searchParams.get('projectId'),
        cursor: url.searchParams.get('cursor'),
      });
  });
  return {
    query,
    alternateQuery,
    alternateTask,
    project,
    otherProject,
    emptyProject,
    tasks,
    originalOrder,
    selected,
    other,
    personal,
    ordered,
    edit,
    requests,
    routes: readRoutes(page),
    async verifyUnchanged() {
      expect(
        await Promise.all(tasks.map((task) => get<TaskDetail>(page, `tasks/${task.id}`))),
      ).toEqual(tasks.map((task) => expected.get(task.id)));
      expect(browserWrites).toEqual([]);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ scopedTasks: Fixture; projectTaskCount: number }>({
  projectTaskCount: [31, { option: true }],
  scopedTasks: async ({ page, projectTaskCount }, use) => {
    const f = await fixture(page, projectTaskCount);
    let failed = false;
    try {
      await use(f);
      if (test.info().status === test.info().expectedStatus) await f.verifyUnchanged();
      else failed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.routes.stop(failed || test.info().status !== test.info().expectedStatus);
    }
  },
});

async function openSearch(page: Page, q?: string) {
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await expect(search(page)).toBeFocused();
  await expect(scope(page)).toHaveValue('all');
  if (q !== undefined) await search(page).fill(q);
}

async function expectRows(page: Page, tasks: Task[]) {
  await expect(rows(page)).toHaveCount(tasks.length);
  await expect
    .poll(() =>
      rows(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-task-id'))),
    )
    .toEqual(tasks.map((task) => task.id));
  await expect
    .poll(() => rows(page).locator('small').allTextContents())
    .toEqual(tasks.map((task) => task.shortId));
  await expect
    .poll(() => rows(page).locator('strong').allTextContents())
    .toEqual(tasks.map((task) => task.title));
  await expect
    .poll(() => rows(page).locator('.command-task-revision').allTextContents())
    .toEqual(tasks.map((task) => `修订 ${task.revision}`));
  expect(
    new Set(
      await rows(page).evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-task-id')),
      ),
    ).size,
  ).toBe(tasks.length);
}

async function expectCount(page: Page, count: number, terminal = false) {
  await expect(status(page)).toHaveText(
    `已显示 ${count} 项任务，${terminal ? '已加载全部结果' : '可继续加载'}`,
  );
  if (terminal) await expect(more(page)).toHaveCount(0);
  else await expect(more(page)).toBeEnabled();
}

async function append(page: Page, expected: Task[], touch = false) {
  const before = await rows(page).count();
  if (touch) await more(page).tap();
  else {
    await more(page).focus();
    await more(page).press('Enter');
  }
  await expectRows(page, expected);
  await expect(row(page, expected[before]!)).toBeFocused();
}

async function expectMetadata(page: Page, task: Task, source: string) {
  await expect(row(page, task).locator('.command-task-source')).toHaveText(source);
  await expect(row(page, task).locator('.command-task-revision')).toHaveText(
    `修订 ${task.revision}`,
  );
}

async function expectBodyHit(page: Page, task: Task, query: string) {
  expect(task.title).not.toContain(query);
  const match = snippet(row(page, task));
  await expect(match).toHaveCount(1);
  await expect(match.locator('mark')).toHaveText(query);
  await expect(match).toContainText('第一处检查');
  await expect(match).not.toContainText('开头背景');
  await expect(match).not.toContainText('第二处检查');
  await expect(match.locator('b')).toHaveCount(0);
  expect(Array.from((await match.textContent())!).length).toBeLessThanOrEqual(160);
}

async function hitTarget(target: Locator, minHeight: number) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(minHeight);
  expect(
    await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    }),
  ).toBe(true);
}

async function capture(
  page: Page,
  f: Fixture,
  task: Task,
  path: string,
  mobile: boolean,
  terminal: boolean,
) {
  const target = row(page, task);
  await expect(scope(page)).toHaveValue(projectScope(f.project));
  await expectMetadata(page, task, f.project.name);
  await expectBodyHit(page, task, f.query);
  // Position within the measured results viewport; no assumption that every
  // row is visible or the modal footer sits at a fixed page coordinate.
  const geometry = await target.evaluate((element) => {
    const scroller = element.closest('.command-results');
    if (!scroller) throw new Error('缺少任务搜索滚动容器');
    const content = scroller.getBoundingClientRect();
    const initial = element.getBoundingClientRect();
    scroller.scrollTop += initial.top - content.top - (scroller.clientHeight - initial.height) / 2;
    const row = element.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      content: { top: content.top, bottom: content.bottom },
      row: { top: row.top, bottom: row.bottom },
    };
  });
  expect(geometry.scrollTop, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.scrollHeight, JSON.stringify(geometry)).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.row.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry.content.top - 1,
  );
  expect(geometry.row.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.content.bottom + 1,
  );
  for (const visible of [
    dialog(page).locator('.dialog-heading'),
    search(page),
    scope(page),
    target,
    snippet(target),
    status(page),
  ])
    await expect(visible, JSON.stringify(geometry)).toBeInViewport({ ratio: 1 });
  for (const control of [
    search(page),
    scope(page),
    target,
    dialog(page).getByRole('button', { name: '关闭', exact: true }),
  ])
    await hitTarget(control, mobile ? 44 : 32);
  if (!terminal) await hitTarget(more(page), mobile ? 44 : 32);
  else await expect(status(page)).toContainText('已加载全部结果');
  for (const content of [dialog(page), results(page), target, snippet(target)]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  for (const visible of [
    scope(page),
    target,
    snippet(target),
    target.locator('.command-task-source'),
    target.locator('.command-task-revision'),
    status(page),
  ])
    await expect(visible).toBeInViewport({ ratio: 1 });
  if (!terminal) await expect(more(page)).toBeInViewport({ ratio: 1 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

test.describe('真实项目范围三批与来源截图', () => {
  test.use({ projectTaskCount: 61, hasTouch: true });
  test('全部默认保留原顺序，项目先筛选再分页，三批来源修订与明暗窄屏任务导航', async ({
    page,
    scopedTasks: f,
  }) => {
    await page.goto(`/projects/${f.project.id}`);
    await openSearch(page);
    await expect(rows(page)).toHaveCount(0);
    expect(f.requests).toEqual([]);
    await search(page).fill(`  ${f.query.toUpperCase()}  `);
    await expectRows(page, f.originalOrder.slice(0, 30));
    await expectCount(page, 30);
    await expectMetadata(page, f.personal[0]!, '个人任务');
    await expectMetadata(page, f.other[0]!, f.otherProject.name);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ scope: null, projectId: null, cursor: null });

    await scope(page).selectOption(projectScope(f.project));
    await expectRows(page, f.selected.slice(0, 30));
    await expectCount(page, 30);
    await expect(snippet(row(page, f.selected[0]!))).toHaveCount(0);
    await expectMetadata(page, f.selected[0]!, f.project.name);
    await append(page, f.selected.slice(0, 60));
    await expectCount(page, 60);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(
      page,
      f,
      f.selected[30]!,
      'artifacts/238-task-search-scope-dark.png',
      false,
      false,
    );
    await append(page, f.selected);
    await expectCount(page, 61, true);
    const selectedReads = f.requests.filter((request) => request.scope === 'project');
    expect(selectedReads.map((request) => request.projectId)).toEqual(Array(3).fill(f.project.id));
    expect(selectedReads.map((request) => Boolean(request.cursor))).toEqual([false, true, true]);
    expect(new Set(selectedReads.slice(1).map((request) => request.cursor)).size).toBe(2);
    const finalTask = f.selected.at(-1)!;
    await expectMetadata(page, finalTask, f.project.name);
    await expectBodyHit(page, finalTask, f.query);
    await row(page, finalTask).focus();
    await row(page, finalTask).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${finalTask.id}$`));
    await expect(page.getByRole('heading', { name: finalTask.title, exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    await page.goto(`/projects/${f.project.id}`);
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openSearch(page);
    await scope(page).selectOption(projectScope(f.project));
    await search(page).fill(f.query);
    await expectRows(page, f.selected.slice(0, 30));
    await append(page, f.selected.slice(0, 60), true);
    await append(page, f.selected, true);
    await expectCount(page, 61, true);
    await capture(
      page,
      f,
      finalTask,
      'artifacts/239-task-search-scope-mobile-light.png',
      true,
      true,
    );
    await row(page, finalTask).tap();
    await expect(page).toHaveURL(new RegExp(`/tasks/${finalTask.id}$`));
    await expect(page.getByRole('heading', { name: finalTask.title, exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  });
});

test('个人与空项目范围不混入其他项目，同一查询和编号搜索始终携带当前范围', async ({
  page,
  scopedTasks: f,
}) => {
  await page.goto('/');
  await openSearch(page);
  await scope(page).selectOption('personal');
  await expect(rows(page)).toHaveCount(0);
  expect(f.requests).toEqual([]);
  await search(page).fill(f.query);
  await expectRows(page, f.personal);
  await expectCount(page, 2, true);
  for (const task of f.personal) await expectMetadata(page, task, '个人任务');
  expect(f.requests.at(-1)).toMatchObject({ scope: 'personal', projectId: null, cursor: null });
  await search(page).fill(f.alternateQuery);
  await expectRows(page, []);
  await expect(status(page)).toHaveText('没有找到匹配的任务。');
  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, [f.alternateTask]);
  await expectCount(page, 1, true);
  expect(f.requests.at(-1)).toMatchObject({
    q: f.alternateQuery,
    scope: 'project',
    projectId: f.project.id,
    cursor: null,
  });

  await search(page).fill(f.query);
  await expectRows(page, f.selected.slice(0, 30));
  await scope(page).selectOption(projectScope(f.emptyProject));
  await expectRows(page, []);
  await expect(status(page)).toHaveText('没有找到匹配的任务。');
  await expect(more(page)).toHaveCount(0);
  await expect(search(page)).toHaveValue(f.query);
  expect(f.requests.at(-1)).toMatchObject({
    scope: 'project',
    projectId: f.emptyProject.id,
    cursor: null,
  });
  await scope(page).selectOption('all');
  await expectRows(page, f.originalOrder.slice(0, 30));
  expect(f.requests.at(-1)).toMatchObject({ scope: null, projectId: null, cursor: null });
  await scope(page).selectOption('personal');
  await expectRows(page, f.personal);
  await search(page).fill(f.personal[0]!.shortId);
  await expectRows(page, [f.personal[0]!]);
  await expectCount(page, 1, true);
  expect(f.requests.at(-1)).toMatchObject({
    q: f.personal[0]!.shortId,
    scope: 'personal',
    projectId: null,
    cursor: null,
  });
  await row(page, f.personal[0]!).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${f.personal[0]!.id}$`));
  await expect(
    page.getByRole('heading', { name: f.personal[0]!.title, exact: true }),
  ).toBeVisible();
});

test('切换范围后暂留的真实首批和追加成功回应不混入新结果，重复加载仍只有一个请求', async ({
  page,
  scopedTasks: f,
}) => {
  const initial = f.routes.gate();
  const later = f.routes.gate();
  let holdInitial = true;
  let holdLater = true;
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const selected =
      url.searchParams.get('scope') === 'project' &&
      url.searchParams.get('projectId') === f.project.id;
    const cursor = url.searchParams.has('cursor');
    const gate = selected
      ? !cursor && holdInitial
        ? initial
        : cursor && holdLater
          ? later
          : null
      : null;
    if (gate) {
      if (gate === initial) holdInitial = false;
      else holdLater = false;
      gate.captured = (await response.json()) as TaskSearchPage;
      await gate.wait;
      await route.fulfill({ response });
      gate.settled = true;
    } else await route.fulfill({ response });
  });
  await page.goto('/');
  await openSearch(page);
  await scope(page).selectOption(projectScope(f.project));
  await search(page).fill(f.query);
  await expect.poll(() => initial.captured).not.toBeNull();
  expect(initial.captured!.items.map((task) => task.id)).toEqual(
    f.selected.slice(0, 30).map((task) => task.id),
  );
  await scope(page).selectOption('personal');
  await expectRows(page, f.personal);
  await expectCount(page, 2, true);
  initial.release();
  await expect.poll(() => initial.settled).toBe(true);
  await expectRows(page, f.personal);
  await expect(scope(page)).toHaveValue('personal');
  await expect(search(page)).toHaveValue(f.query);

  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, f.selected.slice(0, 30));
  await more(page).evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
    button.click();
  });
  await expect.poll(() => later.captured).not.toBeNull();
  expect(later.captured!.items.map((task) => task.id)).toEqual(
    f.selected.slice(30).map((task) => task.id),
  );
  await expect(dialog(page).getByRole('button', { name: '加载中…', exact: true })).toBeDisabled();
  await expectRows(page, f.selected.slice(0, 30));
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(1);
  await scope(page).selectOption('all');
  await expectRows(page, f.originalOrder.slice(0, 30));
  later.release();
  await expect.poll(() => later.settled).toBe(true);
  await expectRows(page, f.originalOrder.slice(0, 30));
  await expectCount(page, 30);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  expect(f.requests.at(-1)).toMatchObject({ scope: null, projectId: null, cursor: null });
  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, f.selected.slice(0, 30));
  await append(page, f.selected);
  await expectCount(page, 31, true);
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(2);
  expect(
    f.requests
      .filter((request) => request.cursor)
      .every((request) => request.scope === 'project' && request.projectId === f.project.id),
  ).toBe(true);
});

test('所选项目的当前任务修订经 SSE 重置批次，其他项目的匹配任务更新保留原页与焦点', async ({
  page,
  scopedTasks: f,
}) => {
  await page.goto('/');
  await expect(page.locator('.workbench-connection')).toHaveAttribute('title', '任务事件已连接');
  await openSearch(page);
  await scope(page).selectOption(projectScope(f.project));
  await search(page).fill(f.query);
  await expectRows(page, f.selected.slice(0, 30));
  await append(page, f.selected);
  await expectCount(page, 31, true);
  const finalTask = f.selected.at(-1)!;
  await expect(row(page, finalTask)).toBeFocused();
  const beforeUnrelated = f.requests.length;
  const other = f.other[0]!;
  const workbenchUpdated = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== '/api/v1/workbench' || response.status() !== 200)
      return false;
    const body = (await response.json()) as Workbench;
    return body.tasks.some(
      (task) => task.id === other.id && task.attention === '其他项目的普通更新',
    );
  });
  // Promise.all observes the response wait immediately, including if the
  // explicit fixture edit fails. No unattached rejection survives teardown.
  await Promise.all([workbenchUpdated, f.edit(other, { attention: '其他项目的普通更新' })]);
  // A mistaken reset waits 150ms after the real SSE-triggered feed response.
  await page.waitForTimeout(200);
  await expectRows(page, f.selected);
  await expectCount(page, 31, true);
  await expect(row(page, finalTask)).toBeFocused();
  expect(f.requests).toHaveLength(beforeUnrelated);

  const beforeSelected = f.requests.length;
  const updated = await f.edit(f.selected[0]!, { title: `${f.query} 已更新的当前工作` });
  const current = (await f.ordered()).filter((task) => task.projectId === f.project.id);
  await expectRows(page, current.slice(0, 30));
  await expectCount(page, 30);
  await expectMetadata(page, updated, f.project.name);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue(f.query);
  await expect(scope(page)).toHaveValue(projectScope(f.project));
  await expect
    .poll(() => f.requests.slice(beforeSelected))
    .toEqual([{ q: f.query, scope: 'project', projectId: f.project.id, cursor: null }]);
  await append(page, current);
  await expectCount(page, 31, true);
  await expectMetadata(page, finalTask, f.project.name);
  await expectBodyHit(page, finalTask, f.query);
});
