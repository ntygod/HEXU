import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Project, Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskSearchPage } from '../../packages/contracts/src/task-search.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: '搜索与快捷操作', exact: true });
const search = (page: Page) => dialog(page).getByRole('textbox', { name: '全局搜索', exact: true });
const results = (page: Page) => dialog(page).getByLabel('任务搜索结果', { exact: true });
const rows = (page: Page) => results(page).getByRole('button');
const status = (page: Page) =>
  dialog(page).getByRole('status', { name: '任务搜索分页状态', exact: true });
const more = (page: Page) =>
  dialog(page).getByRole('button', { name: '加载更多任务', exact: true });
const restart = (page: Page) => dialog(page).getByRole('button', { name: '重新搜索', exact: true });
const row = (page: Page, task: Task) => results(page).locator(`button[data-task-id="${task.id}"]`);
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

// Every intercepted read is observed immediately. Teardown stops captures,
// releases all held real responses, drains, and only then removes exact handlers.
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
      } else throw new AggregateError(errors, '任务搜索读取夹具清理失败');
    },
  };
}

async function fixture(page: Page, taskCount: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const query = `PageBeacon-${randomUUID().slice(0, 8)}`;
  const alternateQuery = `${query}-唯一项`;
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: `普通任务分页 ${query}`,
    description: '只通过普通 HTTP 创建当前 Task，搜索不得修改任务。',
  });
  const tasks: Task[] = [];
  for (let index = 0; index < taskCount; index++)
    tasks.push(
      await post<Task>(page, 'spaces/space-demo/tasks', {
        projectId: project.id,
        title: index === 0 ? '仅在说明命中的早期工作' : `${query} 第 ${index + 1} 项工作`,
        description:
          `普通任务说明中的 ${query}，保持当前任务原文。` +
          (index === taskCount - 1 ? ` ${alternateQuery}` : ''),
      }),
    );
  const expected = new Map(
    await Promise.all(
      tasks.map(
        async (task) => [task.id, await get<TaskDetail>(page, `tasks/${task.id}`)] as const,
      ),
    ),
  );
  expect([...expected.values()].every((detail) => detail.runs.length === 0)).toBe(true);
  const ids = new Set(tasks.map((task) => task.id));
  async function ordered() {
    const workbench = await get<Workbench>(page, 'workbench');
    // Use the real current feed's original ordering, independently of /search.
    const matching = workbench.tasks.filter((task) =>
      `${task.title} ${task.description} ${task.shortId}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    expect(matching.map((task) => task.id).sort()).toEqual([...ids].sort());
    return matching;
  }
  const originalOrder = await ordered();
  const browserWrites: string[] = [];
  const requests: { q: string; cursor: string | null }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'GET' && url.pathname === '/api/v1/search')
      requests.push({ q: url.searchParams.get('q')!, cursor: url.searchParams.get('cursor') });
  });
  const routes = readRoutes(page);
  return {
    query,
    alternateQuery,
    alternateTask: tasks.at(-1)!,
    tasks,
    originalOrder,
    ordered,
    requests,
    routes,
    async edit(task: Task, changes: { title?: string; description?: string; attention?: string }) {
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
      // The PATCH receipt is the stored Task; detail reads also retain the
      // unchanged participant projection. No other detail field may change.
      const after = { ...before, task: { ...saved, participantUserIds } };
      expect(await get<TaskDetail>(page, `tasks/${task.id}`)).toEqual(after);
      expected.set(task.id, after);
      return after.task;
    },
    async verifyUnchanged() {
      expect(
        await Promise.all(tasks.map((task) => get<TaskDetail>(page, `tasks/${task.id}`))),
      ).toEqual(tasks.map((task) => expected.get(task.id)));
      expect(browserWrites).toEqual([]);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ searchTasks: Fixture; taskCount: number }>({
  taskCount: [31, { option: true }],
  searchTasks: async ({ page, taskCount }, use) => {
    const f = await fixture(page, taskCount);
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
  if (q !== undefined) await search(page).fill(q);
}

async function expectRows(page: Page, tasks: Task[]) {
  await expect(rows(page)).toHaveCount(tasks.length);
  await expect
    .poll(() => rows(page).locator('small').allTextContents())
    .toEqual(tasks.map((task) => task.shortId));
  await expect
    .poll(() => rows(page).locator('strong').allTextContents())
    .toEqual(tasks.map((task) => task.title));
}

async function expectCount(page: Page, count: number, terminal = false) {
  await expect(status(page)).toHaveText(
    `已显示 ${count} 项任务，${terminal ? '已加载全部结果' : '可继续加载'}`,
  );
  if (terminal) await expect(more(page)).toHaveCount(0);
  else await expect(more(page)).toBeEnabled();
}

async function append(page: Page, expected: Task[], keyboard = false) {
  const before = await rows(page).count();
  if (keyboard) {
    await more(page).focus();
    await expect(more(page)).toBeFocused();
    await more(page).press('Enter');
  } else await more(page).click();
  await expectRows(page, expected);
  await expect(row(page, expected[before]!)).toBeFocused();
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

async function capture(page: Page, task: Task, path: string, mobile: boolean, terminal: boolean) {
  const target = row(page, task);
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
  );
  // The modal's own results area scrolls; inspect its measured bounds rather
  // than assuming a page footer or the underlying topbar shares this viewport.
  expect(
    await target.evaluate((element) => {
      const scroller = element.closest('.command-results');
      if (!scroller) throw new Error('缺少任务搜索滚动容器');
      const content = scroller.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return (
        scroller.scrollTop > 0 &&
        scroller.scrollHeight > scroller.clientHeight &&
        row.top >= content.top - 1 &&
        row.bottom <= content.bottom + 1
      );
    }),
  ).toBe(true);
  for (const visible of [
    dialog(page).locator('.dialog-heading'),
    search(page),
    target,
    status(page),
  ])
    await expect(visible).toBeInViewport({ ratio: 1 });
  for (const control of [
    search(page),
    target,
    dialog(page).getByRole('button', { name: '关闭', exact: true }),
  ])
    await hitTarget(control, mobile ? 44 : 32);
  if (!terminal) await hitTarget(more(page), mobile ? 44 : 32);
  else await expect(status(page)).toContainText('已加载全部结果');
  for (const content of [dialog(page), results(page), target]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // Recheck after individual reachability checks before taking the evidence.
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect(status(page)).toBeInViewport({ ratio: 1 });
  if (!terminal) await expect(more(page)).toBeInViewport({ ratio: 1 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

test.describe('真实三页任务搜索与截图', () => {
  test.use({ taskCount: 61, hasTouch: true });
  test('61 项按当前原顺序逐页加载，明暗窄屏计数与任务导航支持键盘和触控', async ({
    page,
    searchTasks: f,
  }) => {
    await page.goto('/');
    await openSearch(page);
    await expect(rows(page)).toHaveCount(0);
    for (const name of ['新建任务', '打开工作台', '查看项目', '查看成果', '资源与设置'])
      await expect(dialog(page).getByRole('button', { name, exact: true })).toBeVisible();
    expect(f.requests).toEqual([]);
    await search(page).fill(`  ${f.query.toUpperCase()}  `);
    await expectRows(page, f.originalOrder.slice(0, 30));
    await expectCount(page, 30);
    await append(page, f.originalOrder.slice(0, 60), true);
    await expectCount(page, 60);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(
      page,
      f.originalOrder[30]!,
      'artifacts/236-task-search-pagination-dark.png',
      false,
      false,
    );
    await append(page, f.originalOrder);
    await expectCount(page, 61, true);
    await expect.poll(() => f.requests.length).toBe(3);
    await expect
      .poll(() => f.requests.map((request) => Boolean(request.cursor)))
      .toEqual([false, true, true]);
    await expect
      .poll(() => new Set(f.requests.slice(1).map((request) => request.cursor)).size)
      .toBe(2);

    const finalTask = f.originalOrder.at(-1)!;
    expect(finalTask.title.toLocaleLowerCase()).not.toContain(f.query.toLocaleLowerCase());
    expect(finalTask.description).toContain(f.query);
    await search(page).fill(`${f.query}-没有此项`);
    await expectRows(page, []);
    await expect(status(page)).toHaveText('没有找到匹配的任务。');
    await expect(more(page)).toHaveCount(0);
    await search(page).fill(finalTask.shortId);
    await expectRows(page, [finalTask]);
    await expectCount(page, 1, true);
    await row(page, finalTask).focus();
    await row(page, finalTask).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${finalTask.id}$`));
    await expect(page.getByRole('heading', { name: finalTask.title, exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openSearch(page, f.query);
    await expectRows(page, f.originalOrder.slice(0, 30));
    await more(page).tap();
    await expectRows(page, f.originalOrder.slice(0, 60));
    await expect(row(page, f.originalOrder[30]!)).toBeFocused();
    await more(page).tap();
    await expectRows(page, f.originalOrder);
    await expectCount(page, 61, true);
    await expect(row(page, finalTask)).toBeFocused();
    await capture(
      page,
      finalTask,
      'artifacts/237-task-search-pagination-mobile-light.png',
      true,
      true,
    );
    await row(page, finalTask).tap();
    await expect(page).toHaveURL(new RegExp(`/tasks/${finalTask.id}$`));
    await expect(page.getByRole('heading', { name: finalTask.title, exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await openSearch(page, '查看项目');
    await dialog(page).getByRole('button', { name: '查看项目', exact: true }).press('Enter');
    await expect(page).toHaveURL(/\/projects$/);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test('真实第二页回应被暂留时，重复加载只发出一次请求并保持原批次', async ({
  page,
  searchTasks: f,
}) => {
  const gate = f.routes.gate();
  await f.routes.install(async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      gate.captured = (await response.json()) as TaskSearchPage;
      await gate.wait;
      await route.fulfill({ response });
      gate.settled = true;
    } else await route.fulfill({ response });
  });
  await page.goto('/');
  await openSearch(page, f.query);
  await expectRows(page, f.originalOrder.slice(0, 30));
  // Synchronous native clicks exercise the in-flight guard before a render can
  // disable the button; the response stays held through the assertions below.
  await more(page).evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
    button.click();
  });
  await expect.poll(() => gate.captured).not.toBeNull();
  expect(gate.captured!.items.map((task) => task.id)).toEqual([f.originalOrder[30]!.id]);
  await expect(dialog(page).getByRole('button', { name: '加载中…', exact: true })).toBeDisabled();
  await expectRows(page, f.originalOrder.slice(0, 30));
  await expect(status(page)).toHaveText('已显示 30 项任务，正在加载更多…');
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(1);
  gate.release();
  await expect.poll(() => gate.settled).toBe(true);
  await expectRows(page, f.originalOrder);
  await expectCount(page, 31, true);
  await expect(row(page, f.originalOrder[30]!)).toBeFocused();
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(1);
});

test('快速改查询及关闭重开后，旧首批和旧追加的真实成功回应不混入当前结果', async ({
  page,
  searchTasks: f,
}) => {
  const first = f.routes.gate();
  const later = f.routes.gate();
  let holdFirst = true;
  let holdMore = true;
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const q = url.searchParams.get('q')!.toLocaleLowerCase();
    const cursor = url.searchParams.has('cursor');
    const gate =
      q === f.query.toLocaleLowerCase()
        ? !cursor && holdFirst
          ? first
          : cursor && holdMore
            ? later
            : null
        : null;
    if (gate) {
      if (gate === first) holdFirst = false;
      else holdMore = false;
      gate.captured = (await response.json()) as TaskSearchPage;
      await gate.wait;
      await route.fulfill({ response });
      gate.settled = true;
    } else await route.fulfill({ response });
  });
  await page.goto('/');
  await openSearch(page, f.query);
  await expect.poll(() => first.captured).not.toBeNull();
  await search(page).fill(f.alternateQuery);
  await expectRows(page, [f.alternateTask]);
  await expectCount(page, 1, true);
  first.release();
  await expect.poll(() => first.settled).toBe(true);
  await expectRows(page, [f.alternateTask]);
  await expect(search(page)).toHaveValue(f.alternateQuery);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);

  await search(page).fill(f.query);
  await expectRows(page, f.originalOrder.slice(0, 30));
  await more(page).click();
  await expect.poll(() => later.captured).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await openSearch(page, f.query);
  await expectRows(page, f.originalOrder.slice(0, 30));
  later.release();
  await expect.poll(() => later.settled).toBe(true);
  await expectRows(page, f.originalOrder.slice(0, 30));
  await expectCount(page, 30);
  await expect(search(page)).toHaveValue(f.query);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await append(page, f.originalOrder);
  await expectCount(page, 31, true);
});

test('首批与追加读取失败可重试，游标失效清空旧批次并从当前首批重新搜索', async ({
  page,
  searchTasks: f,
}) => {
  let failure: 'first' | 'more' | 'INVALID_CURSOR' | 'SEARCH_RESULTS_CHANGED' | null = 'first';
  await f.routes.install(async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const hasCursor = new URL(route.request().url()).searchParams.has('cursor');
    const code = failure;
    const inject = code && (code === 'first' ? !hasCursor : hasCursor);
    if (inject) {
      failure = null;
      await route.fulfill({
        response,
        status: code === 'INVALID_CURSOR' ? 400 : code === 'SEARCH_RESULTS_CHANGED' ? 409 : 500,
        json: {
          error: {
            code: code === 'first' || code === 'more' ? 'TEMPORARY_FAILURE' : code,
            message:
              code === 'first' || code === 'more' ? '搜索暂时不可用' : '搜索结果已失效，请重新搜索',
          },
        },
      });
    } else await route.fulfill({ response });
  });
  await page.goto('/');
  await openSearch(page, f.query);
  await expect(dialog(page).getByRole('alert')).toHaveText('搜索暂时不可用');
  await expectRows(page, []);
  await expect(more(page)).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '重试搜索', exact: true }).click();
  await expectRows(page, f.originalOrder.slice(0, 30));
  await expectCount(page, 30);
  await expect
    .poll(() => f.requests.slice(0, 2).map((request) => request.cursor))
    .toEqual([null, null]);

  failure = 'more';
  await more(page).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('搜索暂时不可用');
  await expectRows(page, f.originalOrder.slice(0, 30));
  await expect(status(page)).toHaveText('已显示 30 项任务，可重试加载更多');
  const failedCursor = f.requests.at(-1)!.cursor;
  expect(failedCursor).toBeTruthy();
  await dialog(page).getByRole('button', { name: '重试加载更多', exact: true }).click();
  await expectRows(page, f.originalOrder);
  await expectCount(page, 31, true);
  expect(f.requests.at(-1)!.cursor).toBe(failedCursor);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);

  for (const code of ['INVALID_CURSOR', 'SEARCH_RESULTS_CHANGED'] as const) {
    await search(page).fill(f.alternateQuery);
    await expectRows(page, [f.alternateTask]);
    await search(page).fill(f.query);
    await expectRows(page, f.originalOrder.slice(0, 30));
    failure = code;
    await more(page).click();
    await expect(restart(page)).toBeFocused();
    await expectRows(page, []);
    await expect(status(page)).toHaveText('搜索结果已失效，请重新搜索。');
    await expect(more(page)).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: '重试加载更多', exact: true }),
    ).toHaveCount(0);
    await expect(search(page)).toHaveValue(f.query);
    await restart(page).press('Enter');
    await expectRows(page, f.originalOrder.slice(0, 30));
    expect(f.requests.at(-1)!.cursor).toBeNull();
    await expectCount(page, 30);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await append(page, f.originalOrder);
    await expectCount(page, 31, true);
  }
});

test('普通当前任务说明更新经 SSE 自动重置匹配批次，其他任务更新不重置当前查询', async ({
  page,
  searchTasks: f,
}) => {
  await page.goto('/');
  await expect(page.locator('.workbench-connection')).toHaveAttribute('title', '任务事件已连接');
  await openSearch(page, f.query);
  await expectRows(page, f.originalOrder.slice(0, 30));
  await append(page, f.originalOrder);
  await expectCount(page, 31, true);
  await row(page, f.originalOrder.at(-1)!).focus();
  await expect(row(page, f.originalOrder.at(-1)!)).toBeFocused();
  const priorReads = f.requests.length;
  const updated = await f.edit(f.originalOrder[0]!, { title: `${f.query} 更新后的工作标题` });
  const current = await f.ordered();
  await expectRows(page, current.slice(0, 30));
  await expect(row(page, updated).locator('strong')).toHaveText(updated.title);
  await expectCount(page, 30);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue(f.query);
  await expect
    .poll(() => f.requests.slice(priorReads).map((request) => request.cursor))
    .toEqual([null]);
  await append(page, current);
  await expectCount(page, 31, true);

  await search(page).fill(f.alternateQuery);
  await expectRows(page, [updated]);
  await expect(search(page)).toBeFocused();
  const narrowReads = f.requests.length;
  const other = f.originalOrder.at(-1)!;
  const workbenchUpdated = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== '/api/v1/workbench' || response.status() !== 200)
      return false;
    const body = (await response.json()) as Workbench;
    return body.tasks.some((task) => task.id === other.id && task.attention === '普通说明更新');
  });
  await Promise.all([workbenchUpdated, f.edit(other, { attention: '普通说明更新' })]);
  // A mistaken reset debounces its new GET by 150ms. Observe past that window
  // after the real SSE-triggered Workbench response before asserting no read.
  await page.waitForTimeout(200);
  await expectRows(page, [updated]);
  await expectCount(page, 1, true);
  await expect(search(page)).toHaveValue(f.alternateQuery);
  await expect(search(page)).toBeFocused();
  expect(f.requests).toHaveLength(narrowReads);
});
