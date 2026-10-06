import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  Project,
  Result,
  Task,
  TaskDetail,
  Workbench,
} from '../../packages/contracts/src/index.js';
import type { ResultDetail } from '../../packages/contracts/src/results.js';

const query = '尾段 👩🏽‍💻 <b>核对</b>';
const body =
  '开头说明没有检索关键词。' +
  '普通背景材料。'.repeat(80) +
  `第一处检查 ${query} 原始记录。` +
  '两处之间的背景材料。'.repeat(70) +
  `第二处检查 ${query} 保留原文。`;
const projectFilter = (page: Page) => page.getByLabel('成果项目筛选', { exact: true });
const search = (page: Page) => page.getByLabel('搜索成果', { exact: true });
const clear = (page: Page) => page.getByRole('button', { name: '清除成果筛选', exact: true });
const count = (page: Page) => page.getByRole('status', { name: '成果筛选计数', exact: true });
const cards = (page: Page) => page.locator('.work-result-grid > a.work-result-card');
const card = (page: Page, result: Result) =>
  page.locator(`.work-result-grid > a.work-result-card[href="/results/${result.id}"]`);
const snippets = (container: Page | Locator) =>
  container.getByLabel('成果正文匹配片段', { exact: true });
const fixedLink = (page: Page) =>
  page.getByRole('link', { name: '打开此版本固定链接', exact: true });
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

async function createFixture(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('hexu-theme')) localStorage.setItem('hexu-theme', 'dark');
  });
  const projects: Project[] = [];
  for (const name of ['成果检索甲项目', '成果检索乙项目', '尚无成果的项目'])
    projects.push(
      await post<Project>(page, 'spaces/space-demo/projects', {
        name,
        description: '使用普通文字成果核对当前成果库检索。',
      }),
    );
  const [a, b, empty] = projects as [Project, Project, Project];
  const entries: { task: Task; result: Result }[] = [];
  async function create(
    projectId: string | null,
    title: string,
    resultTitle: string,
    text: string,
    cancelled = false,
  ) {
    let task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId,
      title,
      description: '仅说明字段中的 DescriptionOnly 不作为成果关键词。',
    });
    const result = await post<Result>(page, `tasks/${task.id}/results`, {
      title: resultTitle,
      body: text,
    });
    if (cancelled) {
      const current = await get<TaskDetail>(page, `tasks/${task.id}`);
      task = await post<Task>(page, `tasks/${task.id}/cancel`, {
        expectedRevision: current.task.revision,
        activeRunAction: 'keep',
      });
    }
    const entry = { task, result };
    entries.push(entry);
    return entry;
  }
  const tail = await create(a.id, '核对原始长正文', '长正文中的验收说明', body);
  const title = await create(a.id, '整理发布摘要', '发布汇总 Lantern', 'Lantern 保留原成果正文。');
  const taskTitle = await create(
    b.id,
    'TaskBeacon 对应的源任务',
    '项目乙交付说明',
    body + ' TaskBeacon',
  );
  const cancelled = await create(a.id, '已取消任务保留成果', '取消后的记录', body, true);
  const personal = await create(null, '个人任务原记录', '个人结果说明', body);
  expect(cancelled.task.status).toBe('cancelled');
  expect(personal.task).toMatchObject({ projectId: null, visibility: 'private' });
  const taskIds = new Set(entries.map((entry) => entry.task.id));
  const resultIds = new Set(entries.map((entry) => entry.result.id));
  const projectIds = new Set(projects.map((project) => project.id));
  const visible = await get<Workbench>(page, 'workbench');
  const results = visible.results.filter((result) => resultIds.has(result.id));
  expect(results.map((result) => result.id).sort()).toEqual([...resultIds].sort());
  expect(visible.tasks.filter((task) => taskIds.has(task.id))).toHaveLength(entries.length);
  const beforeTasks = await Promise.all(
    entries.map(({ task }) => get<TaskDetail>(page, `tasks/${task.id}`)),
  );
  const beforeResults = await Promise.all(
    entries.map(({ result }) => get<ResultDetail>(page, `results/${result.id}`)),
  );
  expect(beforeTasks.every((detail) => detail.runs.length === 0)).toBe(true);
  for (const detail of beforeResults) {
    expect(detail.version.source).toEqual({ kind: 'member' });
    expect(detail.version.id).toBeTruthy();
    expect(detail.revisions).toHaveLength(1);
  }
  const browserWrites: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const pattern = '**/api/v1/workbench';
  let capturing = true;
  const pending = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];
  const handler = (route: Route) => {
    const operation = (async () => {
      if (!capturing) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const current = (await response.json()) as Workbench;
      // Isolate only real ordinary HTTP fixtures. Preserve server order, current
      // bodies and Task/project relations; every detail read remains unmodified.
      await route.fulfill({
        response,
        json: {
          ...current,
          projects: current.projects.filter((project) => projectIds.has(project.id)),
          tasks: current.tasks.filter((task) => taskIds.has(task.id)),
          results: current.results.filter((result) => resultIds.has(result.id)),
        },
      });
    })();
    pending.add(operation);
    // Observe rejection immediately, including handlers that settle before
    // teardown starts. Keep the original promise tracked until it settles.
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        cleanupErrors.push(error);
        pending.delete(operation);
      },
    );
    return operation;
  };
  await page.route(pattern, handler);
  return {
    a,
    b,
    empty,
    entries,
    results,
    tail,
    title,
    taskTitle,
    cancelled,
    personal,
    beforeResults,
    async verifyUnchanged() {
      expect(
        await Promise.all(entries.map(({ task }) => get<TaskDetail>(page, `tasks/${task.id}`))),
      ).toEqual(beforeTasks);
      expect(
        await Promise.all(
          entries.map(({ result }) => get<ResultDetail>(page, `results/${result.id}`)),
        ),
      ).toEqual(beforeResults);
      expect(browserWrites).toEqual([]);
    },
    async stop(testFailed: boolean) {
      capturing = false;
      // Let each captured fetch/fulfill finish while its interceptor is still
      // installed; unregister this exact handler only after the drain.
      while (pending.size) await Promise.allSettled([...pending]);
      try {
        await page.unroute(pattern, handler);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!cleanupErrors.length) return;
      if (testFailed) {
        for (const error of cleanupErrors)
          test.info().annotations.push({
            type: 'cleanup-error',
            description: error instanceof Error ? error.message : String(error),
          });
      } else throw new AggregateError(cleanupErrors, '成果库读取夹具清理失败');
    },
  };
}

type Library = Awaited<ReturnType<typeof createFixture>>;
const test = base.extend<{ library: Library }>({
  library: async ({ page }, use) => {
    const library = await createFixture(page);
    let failed = false;
    try {
      await use(library);
      if (test.info().status === test.info().expectedStatus) await library.verifyUnchanged();
      else failed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await library.stop(failed || test.info().status !== test.info().expectedStatus);
    }
  },
});

function ordered(f: Library, selected: Result[]) {
  const ids = new Set(selected.map((result) => result.id));
  return f.results.filter((result) => ids.has(result.id));
}

async function expectResults(page: Page, results: Result[]) {
  await expect(cards(page)).toHaveCount(results.length);
  await expect
    .poll(() => cards(page).evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    .toEqual(results.map((result) => `/results/${result.id}`));
}

async function expectSnippet(link: Locator) {
  const snippet = snippets(link);
  await expect(snippet).toHaveCount(1);
  await expect(snippet.locator('mark')).toHaveText(query);
  await expect(snippet).toContainText('第一处检查');
  await expect(snippet).not.toContainText('第二处检查');
  await expect(snippet).not.toContainText('开头说明');
  await expect(snippet.locator('b, script, img')).toHaveCount(0);
  expect(Array.from((await snippet.textContent())!).length).toBeLessThanOrEqual(160);
}

async function expectContext(page: Page, entry: Library['tail'], projectName: string) {
  const context = card(page, entry.result).locator('.result-library-context');
  await expect(context).toContainText(projectName);
  await expect(context).toContainText(`${entry.task.shortId} · ${entry.task.title}`);
}

test('当前成果字段与项目交集准确，个人和取消任务成果保持可见且正文片段为有界原文', async ({
  page,
  library: f,
}) => {
  await page.goto('/results');
  await expectResults(page, f.results);
  await expect(count(page)).toHaveText('全部项目与个人工作 · 5 项成果');
  await expect(projectFilter(page)).toHaveValue('');
  await expect(projectFilter(page).locator('option')).toHaveCount(4);
  for (const name of ['全部项目与个人工作', f.a.name, f.b.name, f.empty.name])
    await expect(projectFilter(page).getByRole('option', { name, exact: true })).toHaveCount(1);
  await expect(snippets(page)).toHaveCount(0);
  await expectContext(page, f.personal, '个人工作');
  await expectContext(page, f.cancelled, f.a.name);
  await expect(card(page, f.tail.result).locator(':scope > p')).toHaveText(body);
  for (const [q, entry] of [
    ['  lAnTeRn  ', f.title],
    ['taskbeacon', f.taskTitle],
    [f.tail.task.shortId.toLowerCase(), f.tail],
  ] as const) {
    await search(page).fill(q);
    await expectResults(page, [entry.result]);
    await expect(count(page)).toHaveText('全部项目与个人工作 · 匹配 1 / 5 项成果');
    await expect(snippets(page)).toHaveCount(0);
    await expect(card(page, entry.result).locator(':scope > p')).toHaveText(entry.result.body);
  }
  await search(page).fill(query);
  await expectResults(
    page,
    ordered(f, [f.tail.result, f.taskTitle.result, f.cancelled.result, f.personal.result]),
  );
  await expect(count(page)).toHaveText('全部项目与个人工作 · 匹配 4 / 5 项成果');
  await expectSnippet(card(page, f.tail.result));
  await projectFilter(page).focus();
  await projectFilter(page).selectOption(f.a.id);
  await expect(projectFilter(page)).toBeFocused();
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  await expect(count(page)).toHaveText(`${f.a.name} · 匹配 2 / 3 项成果`);
  await projectFilter(page).selectOption(f.b.id);
  await expectResults(page, [f.taskTitle.result]);
  await expectSnippet(card(page, f.taskTitle.result));
  await expectContext(page, f.taskTitle, f.b.name);
  await search(page).fill('DescriptionOnly');
  await expectResults(page, []);
  await expect(count(page)).toHaveText(`${f.b.name} · 匹配 0 / 1 项成果`);
  await expect(page.getByRole('heading', { name: '没有匹配的成果', exact: true })).toBeVisible();
});

test('直接链接、刷新、项目切换和历史导航保留条件，清除只移除成果筛选', async ({
  page,
  library: f,
}) => {
  const link = `/results?keep=one&keep=two&q=${encodeURIComponent(query)}#saved-filter`;
  await page.goto(link);
  const allUrl = page.url();
  const allMatches = ordered(f, [
    f.tail.result,
    f.taskTitle.result,
    f.cancelled.result,
    f.personal.result,
  ]);
  await expectResults(page, allMatches);
  await expect(search(page)).toHaveValue(query);
  await projectFilter(page).selectOption(f.a.id);
  const projectUrl = page.url();
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  await page.reload();
  await expect(search(page)).toHaveValue(query);
  await expect(projectFilter(page)).toHaveValue(f.a.id);
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  await page.goBack();
  await expect(page).toHaveURL(allUrl);
  await expectResults(page, allMatches);
  await expect(projectFilter(page)).toHaveValue('');
  await page.goForward();
  await expect(page).toHaveURL(projectUrl);
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  // Typing replaces this entry; project selection above supplies the history boundary.
  await search(page).fill('Lantern');
  await expectResults(page, [f.title.result]);
  const typedUrl = page.url();
  await clear(page).click();
  await expectResults(page, f.results);
  await expect(search(page)).toHaveValue('');
  await expect(projectFilter(page)).toHaveValue('');
  await expect(search(page)).toBeFocused();
  const cleared = new URL(page.url());
  expect([...cleared.searchParams]).toEqual([
    ['keep', 'one'],
    ['keep', 'two'],
  ]);
  expect(cleared.hash).toBe('#saved-filter');
  await page.goBack();
  await expect(page).toHaveURL(typedUrl);
  await expect(search(page)).toHaveValue('Lantern');
  await expect(projectFilter(page)).toHaveValue(f.a.id);
  await expectResults(page, [f.title.result]);
  await page.goForward();
  await expect(page).toHaveURL(cleared.href);
  await expectResults(page, f.results);
  // A copied URL is independently reopenable, with both filters restored.
  await page.goto(typedUrl);
  await expect(search(page)).toHaveValue('Lantern');
  await expect(projectFilter(page)).toHaveValue(f.a.id);
  await expectResults(page, [f.title.result]);
});

test('无成果的真实项目与未知、重复、超长及损坏链接分别显示明确状态', async ({
  page,
  library: f,
}) => {
  await page.goto(`/results?projectId=${f.empty.id}`);
  await expectResults(page, []);
  await expect(count(page)).toHaveText(`${f.empty.name} · 0 项成果`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '这个项目还没有可见成果', exact: true }),
  ).toBeVisible();
  for (const parameters of [
    'projectId=unknown-project',
    'projectId=',
    'q=Lantern&q=Lantern',
    `projectId=${f.a.id}&projectId=${f.b.id}`,
    `q=${'x'.repeat(161)}`,
    'q=%E0%A4%A',
  ]) {
    await page.goto(`/results?${parameters}&keep=stable#invalid-link`);
    await expectResults(page, []);
    await expect(count(page)).toHaveText('当前筛选无效 · 0 项成果');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '无法应用成果筛选', exact: true }),
    ).toBeVisible();
    if (parameters === 'q=%E0%A4%A') {
      await projectFilter(page).selectOption(f.a.id);
      expect(new URL(page.url()).search).toContain('q=%E0%A4%A');
      await expectResults(page, []);
      await expect(count(page)).toHaveText('当前筛选无效 · 0 项成果');
      await expect(page.getByRole('alert')).toBeVisible();
    }
    await clear(page).click();
    await expectResults(page, f.results);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('?keep=stable');
    expect(new URL(page.url()).hash).toBe('#invalid-link');
  }
});

test('项目成果原集合保留，查找入口预设项目，普通详情和真实固定版本返回后还原查询', async ({
  page,
  library: f,
}) => {
  await page.goto(`/projects/${f.a.id}?tab=results`);
  // The existing project tab excludes cancelled Tasks; the global library has
  // always included their visible Results and must not inherit that exclusion.
  await expectResults(page, ordered(f, [f.tail.result, f.title.result]));
  const projectEntry = page.getByRole('link', { name: '在成果库中查找', exact: true });
  await expect(projectEntry).toHaveAttribute('href', `/results?projectId=${f.a.id}`);
  await projectEntry.click();
  await expect(projectFilter(page)).toHaveValue(f.a.id);
  await expectResults(page, ordered(f, [f.tail.result, f.title.result, f.cancelled.result]));
  await search(page).fill(query);
  const libraryUrl = page.url();
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  const ordinary = `/results/${f.tail.result.id}`;
  const before = f.beforeResults.find((detail) => detail.result.id === f.tail.result.id)!;
  const fixed = `${ordinary}/versions/${before.version.id}`;
  await card(page, f.tail.result).click();
  await expect(page).toHaveURL(new URL(ordinary, page.url()).href);
  await expect(page.getByRole('combobox', { name: '查看固定版本', exact: true })).toHaveValue(
    before.version.id,
  );
  await expect(fixedLink(page)).toHaveAttribute('href', fixed);
  await expect(page.locator('.written-result .text-block')).toHaveText(f.tail.result.body);
  await fixedLink(page).click();
  await expect(page).toHaveURL(new URL(fixed, page.url()).href);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '查看固定版本', exact: true })).toHaveValue(
    before.version.id,
  );
  expect(await get<ResultDetail>(page, fixed.slice(1))).toEqual(before);
  await page.goBack();
  await expect(page).toHaveURL(new URL(ordinary, page.url()).href);
  await page.goBack();
  await expect(page).toHaveURL(libraryUrl);
  await expect(projectFilter(page)).toHaveValue(f.a.id);
  await expect(search(page)).toHaveValue(query);
  await expectResults(page, ordered(f, [f.tail.result, f.cancelled.result]));
  await expectSnippet(card(page, f.tail.result));
});

async function capture(page: Page, f: Library, path: string, mobile: boolean) {
  const link = card(page, f.taskTitle.result);
  const snippet = snippets(link);
  await expectResults(page, [f.taskTitle.result]);
  await expectSnippet(link);
  await expectContext(page, f.taskTitle, f.b.name);
  await page.locator('.result-library-filters').evaluate((element) => {
    const topbar = document.querySelector('.workbench-topbar');
    if (!topbar) throw new Error('成果筛选截图缺少工作台顶栏');
    window.scrollTo({
      top:
        element.getBoundingClientRect().top + scrollY - topbar.getBoundingClientRect().height - 16,
      behavior: 'instant',
    });
  });
  // Require the controls and the actual matching content in this screenshot,
  // without imposing a same-viewport constraint on a distant card/footer.
  for (const visible of [
    projectFilter(page),
    search(page),
    clear(page),
    count(page),
    link.locator('h3'),
    link.locator('.result-library-context'),
    snippet,
    snippet.locator('mark'),
  ])
    await expect(visible).toBeInViewport({ ratio: 1 });
  for (const control of [projectFilter(page), search(page), clear(page)]) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 32);
    expect(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
  }
  for (const content of [page.locator('main'), link, snippet]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(
    await snippet.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

test.describe('当前成果筛选截图与触控', () => {
  test.use({ hasTouch: true });
  test('暗色与390px浅色当前匹配截图可读，键盘和触屏卡片导航可用', async ({ page, library: f }) => {
    await page.goto(`/results?projectId=${f.b.id}&q=${encodeURIComponent(query)}`);
    const libraryUrl = page.url();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(page, f, 'artifacts/234-result-library-search-dark.png', false);
    await card(page, f.taskTitle.result).focus();
    await expect(card(page, f.taskTitle.result)).toBeFocused();
    await card(page, f.taskTitle.result).press('Enter');
    await expect(page).toHaveURL(new URL(`/results/${f.taskTitle.result.id}`, page.url()).href);
    await page.goBack();
    await expect(page).toHaveURL(libraryUrl);
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await capture(page, f, 'artifacts/235-result-library-search-mobile-light.png', true);
    await card(page, f.taskTitle.result).tap();
    await expect(page).toHaveURL(new URL(`/results/${f.taskTitle.result.id}`, page.url()).href);
    await expect(page.locator('.written-result .text-block')).toHaveText(f.taskTitle.result.body);
    await page.goBack();
    await expect(page).toHaveURL(libraryUrl);
    await expect(search(page)).toHaveValue(query);
    await expect(projectFilter(page)).toHaveValue(f.b.id);
    await expectSnippet(card(page, f.taskTitle.result));
  });
});
