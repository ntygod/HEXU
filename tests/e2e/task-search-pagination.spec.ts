import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskSearchPage } from '../../packages/contracts/src/task-search.js';
import { teamFixture, type Account } from '../helpers/team.js';

const origin = 'http://127.0.0.1:4344';
const endpoint = `${origin}/api/v1/search`;
const pattern = `${endpoint}?*`;
const query = '任务分页';
const dialog = (page: Page) => page.getByRole('dialog', { name: '搜索与快捷操作', exact: true });
const input = (page: Page) => dialog(page).getByRole('textbox', { name: '全局搜索', exact: true });
const rows = (page: Page) => dialog(page).locator('.command-results > button[data-task-id]');
const row = (page: Page, task: Task) =>
  dialog(page).locator(`.command-results > button[data-task-id="${task.id}"]`);
const more = (page: Page) =>
  dialog(page).getByRole('button', { name: '加载更多任务', exact: true });
const refresh = (page: Page) => dialog(page).getByRole('button', { name: '重新搜索', exact: true });
const retry = (page: Page) => dialog(page).getByRole('button', { name: '重试', exact: true });
const ids = (page: Page) =>
  rows(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-task-id')),
  );

async function fixture(count = 1) {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const grant = async (role: 'view' | null) => {
      const response = await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
        role,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await grant('view');
    const tasks: Task[] = [];
    for (let index = 1; index <= count; index++)
      tasks.push(await api.task(alice, project.id, `${query} · ${String(index).padStart(2, '0')}`));
    const create = async (
      title: string,
      description = '',
      projectId: string | null = project.id,
    ) => {
      const response = await api.call(`spaces/${alice.spaceId}/tasks`, alice, {
        title,
        description,
        projectId,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as Task;
    };
    const list = async (q = query, cursor: string | null = null, account: Account = bob) => {
      const response = await api.call(
        `search?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        account,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as TaskSearchPage;
    };
    const patch = async (task: Task, change: { title?: string; description?: string }) => {
      const response = await api.call(
        `tasks/${task.id}`,
        alice,
        { expectedRevision: task.revision, ...change },
        randomUUID(),
        'PATCH',
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as Task;
    };
    return { api, alice, bob, project, tasks, create, grant, list, patch };
  } catch (error) {
    try {
      await api.close();
    } catch (cleanup) {
      test.info().annotations.push({ type: 'cleanup failure', description: String(cleanup) });
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4344, host: '127.0.0.1' });
  await page.context().addCookies(
    f.bob.cookie.split('; ').map((cookie) => {
      const index = cookie.indexOf('=');
      return {
        name: cookie.slice(0, index),
        value: cookie.slice(index + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
  await page.addInitScript(
    ({ userId, spaceId }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', 'dark');
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId },
  );
  await page.goto(origin);
  await expect(page.locator('.workbench-connection')).toHaveAttribute('title', '任务事件已连接');
  await openSearch(page);
}
async function openSearch(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}
async function completeSearchAfterAbort(page: Page) {
  // Model a transport that finishes after cancellation. Native fetch otherwise
  // rejects immediately on abort, which would exercise AbortError rather than
  // late success/error/finally. All non-search requests keep native signals.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let completedBodies = 0;
    Object.defineProperty(window, 'hexuCompletedSearchBodies', { get: () => completedBodies });
    window.fetch = async (resource, init) => {
      const url = new URL(
        resource instanceof Request ? resource.url : String(resource),
        location.href,
      );
      const method = init?.method ?? (resource instanceof Request ? resource.method : 'GET');
      if (url.pathname !== '/api/v1/search' || method.toUpperCase() !== 'GET')
        return nativeFetch(resource, init);
      const response = await nativeFetch(resource, {
        ...init,
        signal: new AbortController().signal,
      });
      const json = response.json.bind(response);
      response.json = async () => {
        try {
          return await json();
        } finally {
          completedBodies += 1;
        }
      };
      return response;
    };
  });
}
const completedSearchBodies = (page: Page) =>
  page.evaluate(() => Number(Reflect.get(window, 'hexuCompletedSearchBodies')));
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type HeldReads = Awaited<ReturnType<typeof hold>>;
async function hold(
  page: Page,
  matches: (url: URL) => boolean,
  payload: TaskSearchPage,
  status = 200,
) {
  const released = gate(),
    reached = gate();
  const pending: Promise<PromiseSettledResult<void>>[] = [];
  let capturing = true;
  let removed = false;
  const handler = async (route: Route) => {
    if (
      !capturing ||
      route.request().method() !== 'GET' ||
      !matches(new URL(route.request().url()))
    )
      return route.fallback();
    // Capture the whole old search session, including any replacement GET, until
    // its query/dialog/visibility boundary has actually changed.
    const work = released.promise.then(() =>
      route.fulfill({
        status,
        json:
          status === 200
            ? payload
            : {
                error: {
                  code: status === 403 ? 'FORBIDDEN' : 'READ_FAILED',
                  message: '旧搜索读取已失败',
                },
              },
      }),
    );
    // Observe every rejection immediately; cleanup must still reach api.close().
    pending.push(
      work.then(
        () => ({ status: 'fulfilled', value: undefined }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    );
    reached.resolve();
    await work;
  };
  await page.route(pattern, handler);
  return {
    reached: reached.promise,
    get count() {
      return pending.length;
    },
    stop() {
      capturing = false;
    },
    release() {
      released.resolve();
    },
    async drain() {
      const settled = await Promise.all(pending);
      const failures = settled.filter((item) => item.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((item) => item.reason),
          '搜索读取未排空',
        );
    },
    async unroute() {
      if (!removed) {
        await page.unroute(pattern, handler);
        removed = true;
      }
    },
  };
}
async function release(held: HeldReads) {
  held.stop();
  held.release();
  await held.drain();
  await held.unroute();
}
async function close(page: Page, f: Fixture, held: HeldReads[], primaryFailure: boolean) {
  const errors: unknown[] = [];
  // Stop capture, release and drain all retained routes before removing any
  // interceptor. A timed-out/closed page must never prevent fixture shutdown.
  for (const session of held) session.stop();
  for (const session of held) session.release();
  for (const cleanup of [
    ...held.map((session) => () => session.drain()),
    ...held.map((session) => () => session.unroute()),
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.context().close(),
    () => f.api.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;
  if (!primaryFailure) throw new AggregateError(errors, '任务搜索浏览器夹具清理失败');
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
async function targetIsUsable(target: Locator, minimumWidth = 44, minimumHeight = 44) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimumWidth);
  expect(box!.height).toBeGreaterThanOrEqual(minimumHeight);
  expect(
    await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && element.contains(hit);
    }),
  ).toBe(true);
}

test('只读成员按真实30条分页找到旧任务，深色已加载页与390px浅色末页可点击并支持键盘', async ({
  page,
}) => {
  const f = await fixture(65);
  let failed = false;
  try {
    const descriptionOnly = await f.create('说明字段匹配', 'OnlyDescriptionNeedle');
    const unicodeQuery = 'İ'.repeat(160);
    const unicode = await f.create(unicodeQuery);
    const hidden = await f.create(`${query} PRIVATE_ROW`, '', null);
    const snapshot = () =>
      f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        [...f.tasks, descriptionOnly, unicode, hidden].map((task) => ({
          task: f.api.store.getTask(task.id),
          runs: f.api.store.runs(task.id),
        })),
      );
    const before = snapshot();
    const first = await f.list(),
      second = await f.list(query, first.nextCursor),
      third = await f.list(query, second.nextCursor);
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(third.items).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    const writes: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url());
    });
    await open(page, f);
    await input(page).fill(`  ${query}  `);
    await expect(rows(page)).toHaveCount(30);
    expect(await ids(page)).toEqual(first.items.map((task) => task.id));
    await expect(row(page, hidden)).toHaveCount(0);
    await targetIsUsable(more(page), 44, 32);
    await more(page).focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(60);
    expect(await ids(page)).toEqual([...first.items, ...second.items].map((task) => task.id));
    await rows(page).last().scrollIntoViewIfNeeded();
    await targetIsUsable(more(page), 44, 32);
    await expect(rows(page).last()).toBeInViewport();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/195-task-search-loaded-pages-dark.png' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await targetIsUsable(more(page));
    await more(page).click();
    await expect(rows(page)).toHaveCount(65);
    expect(await ids(page)).toEqual(
      [...first.items, ...second.items, ...third.items].map((task) => task.id),
    );
    await expect(more(page)).toHaveCount(0);
    const oldest = third.items.at(-1)!;
    await targetIsUsable(row(page, oldest), 280);
    const end = dialog(page).getByText('已显示全部匹配任务', { exact: true });
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport();
    await targetIsUsable(refresh(page));
    await expect(row(page, oldest)).toBeInViewport();
    await expect(end).toBeInViewport();
    expect(
      await dialog(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/196-task-search-older-mobile-light.png' });
    await row(page, oldest).focus();
    await expect(row(page, oldest)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(row(page, third.items.at(-2)!)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row(page, oldest)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/tasks/${oldest.id}`);
    await expect(page.getByRole('heading', { name: oldest.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();

    await openSearch(page);
    await input(page).fill('onlydescriptionneedle');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, descriptionOnly)).toBeVisible();
    await input(page).fill(oldest.shortId.toLowerCase());
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, oldest)).toBeVisible();
    const unicodeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        request.url().startsWith(endpoint) &&
        new URL(request.url()).searchParams.get('q') === unicodeQuery,
    );
    await input(page).fill(unicodeQuery);
    expect(new URL((await unicodeRequest).url()).searchParams.get('q')).toHaveLength(160);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, unicode)).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: '清空搜索', exact: true }).click();
    await expect(input(page)).toHaveValue('');
    await expect(input(page)).toBeFocused();
    await expect(rows(page)).toHaveCount(0);
    await expect(more(page)).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('已显示全部匹配任务');
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
    expect(snapshot()).toEqual(before);
    for (const item of before) expect(item.runs).toHaveLength(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, [], failed);
  }
});

test('首读失败可重试，分页故障保留已读页和原游标，重复行去重且失效游标须重新搜索', async ({
  page,
}) => {
  const f = await fixture(31);
  let failed = false;
  try {
    const first = await f.list(),
      second = await f.list(query, first.nextCursor);
    let mode: 'initial-error' | 'page-error' | 'duplicate' | 'invalid' | 'real' = 'initial-error';
    const cursors: string[] = [];
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor && mode === 'initial-error')
        return route.fulfill({
          status: 503,
          json: { error: { code: 'READ_FAILED', message: '首读暂不可用' } },
        });
      if (!cursor) return route.continue();
      cursors.push(cursor);
      if (mode === 'page-error')
        return route.fulfill({
          status: 503,
          json: { error: { code: 'READ_FAILED', message: '分页暂不可用' } },
        });
      if (mode === 'duplicate')
        return route.fulfill({
          json: {
            items: [first.items.at(-1)!, ...second.items, ...second.items],
            nextCursor: null,
          } satisfies TaskSearchPage,
        });
      if (mode === 'invalid')
        return route.fulfill({
          status: 409,
          json: { error: { code: 'INVALID_CURSOR', message: '搜索位置已无效，请重新搜索' } },
        });
      return route.continue();
    });
    await open(page, f);
    await input(page).fill(query);
    await expect(dialog(page).getByRole('alert')).toContainText('首读暂不可用');
    await expect(rows(page)).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('没有找到匹配的任务');
    mode = 'page-error';
    await retry(page).click();
    await expect(rows(page)).toHaveCount(30);
    await more(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('分页暂不可用');
    expect(await ids(page)).toEqual(first.items.map((task) => task.id));
    mode = 'duplicate';
    await retry(page).click();
    await expect(rows(page)).toHaveCount(31);
    expect(await ids(page)).toEqual([...first.items, ...second.items].map((task) => task.id));
    expect(cursors).toEqual([first.nextCursor, first.nextCursor]);
    await expect(dialog(page).getByText('已显示全部匹配任务', { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await expect(more(page)).toHaveCount(0);
    mode = 'invalid';
    await refresh(page).click();
    await expect(rows(page)).toHaveCount(30);
    await more(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('搜索结果已变化，请重新搜索。');
    await expect(more(page)).toHaveCount(0);
    await expect(retry(page)).toHaveCount(0);
    mode = 'real';
    await refresh(page).click();
    await expect(rows(page)).toHaveCount(30);
    await more(page).click();
    await expect(rows(page)).toHaveCount(31);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, [], failed);
  }
});

test('加载旧页期间SSE新增匹配任务不重排已读页或取消游标，明确重新搜索才包含新任务', async ({
  page,
}) => {
  const f = await fixture(31),
    held: HeldReads[] = [];
  let failed = false;
  try {
    const first = await f.list(),
      second = await f.list(query, first.nextCursor);
    await open(page, f);
    await input(page).fill(query);
    await expect(rows(page)).toHaveCount(30);
    const oldPage = await hold(
      page,
      (url) => url.searchParams.get('cursor') === first.nextCursor,
      second,
    );
    held.push(oldPage);
    await more(page).scrollIntoViewIfNeeded();
    await expect(more(page)).toBeEnabled();
    await more(page).evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await oldPage.reached;
    await expect(more(page)).toBeDisabled();
    expect(oldPage.count).toBe(1);
    const title = `${query} · 搜索开始之后创建`;
    const refreshed = page.waitForResponse(async (response) => {
      if (response.url() !== `${origin}/api/v1/workbench` || response.status() !== 200)
        return false;
      return ((await response.json()) as Workbench).tasks.some((task) => task.title === title);
    });
    const created = await f.create(title);
    await (await refreshed).finished();
    // A real Workbench row is visible behind the modal, proving React applied
    // the SSE update before checking that search retained its own read position.
    await expect(page.locator(`a.context-task[href="/tasks/${created.id}"]`)).toHaveCount(1);
    expect(await ids(page)).toEqual(first.items.map((task) => task.id));
    await expect(row(page, created)).toHaveCount(0);
    await expect(dialog(page).getByText('正在加载更多…', { exact: true })).toBeVisible();
    await expect(more(page)).toBeDisabled();
    expect(oldPage.count).toBe(1);
    await expect(dialog(page)).not.toContainText('当前可见任务已变化，请重新搜索。');
    await release(oldPage);
    await expect(rows(page)).toHaveCount(31);
    expect(await ids(page)).toEqual([...first.items, ...second.items].map((task) => task.id));
    await expect(row(page, created)).toHaveCount(0);
    await expect(dialog(page).getByText('已显示全部匹配任务', { exact: true })).toBeVisible();
    await refresh(page).click();
    await expect(rows(page)).toHaveCount(30);
    await expect(row(page, created)).toBeVisible();
    await expect(more(page)).toBeEnabled();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, held, failed);
  }
});

for (const boundary of ['query', 'dialog', 'refresh'] as const)
  for (const status of [200, 503])
    test(`${boundary === 'query' ? '切换查询' : boundary === 'dialog' ? '关闭重开' : '明确重新搜索'}后旧搜索${status === 200 ? '成功' : '失败'}与finally不改变新会话加载状态`, async ({
      page,
    }) => {
      const f = await fixture(31),
        held: HeldReads[] = [];
      let failed = false;
      try {
        const newer = await f.create('独立新查询');
        const first = await f.list();
        const currentQuery = boundary === 'query' ? newer.title : query;
        const currentPage = await f.list(currentQuery);
        await completeSearchAfterAbort(page);
        await open(page, f);
        const old = await hold(page, (url) => url.searchParams.get('q') === query, first, status);
        held.push(old);
        await input(page).fill(query);
        await old.reached;
        await expect(dialog(page).getByText('正在搜索…', { exact: true })).toBeVisible();
        if (boundary === 'dialog') {
          await page.keyboard.press('Escape');
          await expect(dialog(page)).toHaveCount(0);
          await openSearch(page);
          await expect(input(page)).toHaveValue('');
        }
        const current = await hold(
          page,
          (url) => url.searchParams.get('q') === currentQuery,
          currentPage,
        );
        held.push(current);
        if (boundary === 'refresh') await refresh(page).click();
        else await input(page).fill(currentQuery);
        await current.reached;
        const completedBeforeOld = await completedSearchBodies(page);
        await release(old);
        await expect.poll(() => completedSearchBodies(page)).toBeGreaterThan(completedBeforeOld);
        await expect(input(page)).toHaveValue(currentQuery);
        await expect(rows(page)).toHaveCount(0);
        await expect(dialog(page).getByRole('alert')).toHaveCount(0);
        await expect(dialog(page).getByText('正在搜索…', { exact: true })).toBeVisible();
        await expect(dialog(page)).not.toContainText('旧搜索读取已失败');
        await release(current);
        await expect(rows(page)).toHaveCount(currentPage.items.length);
        expect(await ids(page)).toEqual(currentPage.items.map((task) => task.id));
        await expect(dialog(page).getByText('正在搜索…', { exact: true })).toHaveCount(0);
        await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await close(page, f, held, failed);
      }
    });

test.describe('搜索匹配遵守服务端语言环境', () => {
  test.use({ locale: 'tr-TR' });
  test('土耳其语浏览器保留API已确认的带点I匹配，且不重新计算本地大小写', async ({ page }) => {
    const f = await fixture(0);
    let failed = false;
    try {
      const task = await f.create('İ');
      const q = 'i\u0307';
      // Establish the running API's actual match before checking the browser;
      // do not infer the server's default locale from the browser's settings.
      const actual = await f.list(q);
      expect(actual.items.map((item) => item.id)).toEqual([task.id]);
      await open(page, f);
      expect(await page.evaluate(() => navigator.language)).toBe('tr-TR');
      expect(
        await page.evaluate(
          ({ title, q }) => title.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
          {
            title: task.title,
            q,
          },
        ),
      ).toBe(false);
      await input(page).fill(q);
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, task)).toContainText(task.title);
      await expect(dialog(page).getByText('已显示全部匹配任务', { exact: true })).toBeVisible();
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, [], failed);
    }
  });
});

test('延迟搜索回应的匹配字段已被SSE修改时不借当前任务套用旧匹配，明确重搜才显示', async ({
  page,
}) => {
  const f = await fixture(1),
    held: HeldReads[] = [];
  let failed = false;
  try {
    const stale = await f.list();
    await open(page, f);
    const old = await hold(page, (url) => url.searchParams.get('q') === query, stale);
    held.push(old);
    await input(page).fill(query);
    await old.reached;
    const changed = await f.patch(f.tasks[0]!, { title: `${query} · 回应到达之前已改标题` });
    await expect(page.locator(`a.context-task[href="/tasks/${changed.id}"]`)).toHaveAttribute(
      'title',
      changed.title,
    );
    await expect(dialog(page).getByText('正在搜索…', { exact: true })).toBeVisible();
    await release(old);
    await expect(rows(page)).toHaveCount(0);
    await expect(dialog(page)).toContainText('当前可见任务已变化，请重新搜索。');
    await expect(dialog(page)).not.toContainText('已显示全部匹配任务');
    await expect(dialog(page)).not.toContainText('没有找到匹配的任务');
    await expect(dialog(page)).not.toContainText(changed.title);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await expect(more(page)).toHaveCount(0);
    await refresh(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, changed)).toContainText(changed.title);
    await expect(dialog(page).getByText('已显示全部匹配任务', { exact: true })).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, held, failed);
  }
});

for (const status of [200, 403])
  test(`工作台SSE编辑清除旧匹配，撤权和重新授权后旧分页${status === 200 ? '成功' : '拒绝'}不能复活缓存`, async ({
    page,
  }) => {
    const f = await fixture(35),
      held: HeldReads[] = [];
    let failed = false;
    try {
      const hidden = await f.create(`${query} PRIVATE_RESPONSE_TASK`, '', null);
      const first = await f.list(),
        second = await f.list(query, first.nextCursor);
      let injectHidden = true;
      await page.route(pattern, async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && injectHidden && !url.searchParams.has('cursor'))
          return route.fulfill({
            json: { ...first, items: [...first.items, hidden] } satisfies TaskSearchPage,
          });
        return route.fallback();
      });
      await completeSearchAfterAbort(page);
      await open(page, f);
      await input(page).fill(query);
      await expect(rows(page)).toHaveCount(30);
      await expect(row(page, hidden)).toHaveCount(0);
      await expect(dialog(page)).not.toContainText(hidden.title);
      await expect(dialog(page)).toContainText('当前可见任务已变化，请重新搜索。');
      await expect(dialog(page)).not.toContainText('已显示全部匹配任务');
      await expect(more(page)).toHaveCount(0);
      injectHidden = false;
      await refresh(page).click();
      await expect(rows(page)).toHaveCount(30);
      await expect(more(page)).toBeEnabled();
      // Status is current Workbench presentation, not part of search matching.
      const statusOnly = first.items[2]!;
      const completed = await f.api.call(`tasks/${statusOnly.id}/complete`, f.alice, {
        expectedRevision: statusOnly.revision,
        activeRunAction: 'keep',
      });
      expect(completed.statusCode, completed.body).toBe(200);
      await expect(row(page, statusOnly)).toContainText('已完成');
      await expect(rows(page)).toHaveCount(30);
      await expect(more(page)).toBeEnabled();
      await expect(dialog(page)).not.toContainText('当前可见任务已变化，请重新搜索。');
      const matchingEdit = await f.patch(first.items[0]!, {
        title: `${query} · 当前工作台的新标题`,
      });
      await expect(row(page, matchingEdit)).toHaveCount(0);
      await expect(rows(page)).toHaveCount(29);
      await expect(dialog(page)).toContainText('当前可见任务已变化，请重新搜索。');
      await expect(more(page)).toHaveCount(0);
      const edited = await f.patch(matchingEdit, { title: first.items[0]!.title });
      await expect(page.locator(`a.context-task[href="/tasks/${edited.id}"]`)).toHaveAttribute(
        'title',
        edited.title,
      );
      await expect(row(page, edited)).toHaveCount(0);
      await expect(rows(page)).toHaveCount(29);
      await refresh(page).click();
      await expect(rows(page)).toHaveCount(30);
      await expect(row(page, edited)).toContainText(edited.title);
      await expect(row(page, edited)).not.toContainText(matchingEdit.title);
      await expect(more(page)).toBeEnabled();
      const nonmatching = await f.patch(first.items[1]!, { title: '已经移出查询的任务' });
      await expect(row(page, nonmatching)).toHaveCount(0);
      await expect(rows(page)).toHaveCount(29);
      await expect(dialog(page)).toContainText('当前可见任务已变化，请重新搜索。');
      await expect(more(page)).toHaveCount(0);
      await refresh(page).click();
      await expect(rows(page)).toHaveCount(30);
      const current = await f.list();
      const oldPage = await hold(page, (url) => url.searchParams.has('cursor'), second, status);
      held.push(oldPage);
      await more(page).click();
      await oldPage.reached;
      await expect(dialog(page).getByText('正在加载更多…', { exact: true })).toBeVisible();

      // Observe real authorized Workbench reads, not invented permission fields.
      const omitted = page.waitForResponse(async (response) => {
        if (response.url() !== `${origin}/api/v1/workbench` || response.status() !== 200)
          return false;
        const workbench = (await response.json()) as Workbench;
        return current.items.every((task) => !workbench.tasks.some((item) => item.id === task.id));
      });
      await f.grant(null);
      await (await omitted).finished();
      await expect(rows(page)).toHaveCount(0);
      await expect(dialog(page)).not.toContainText(edited.title);
      await expect(more(page)).toHaveCount(0);
      const restored = page.waitForResponse(async (response) => {
        if (response.url() !== `${origin}/api/v1/workbench` || response.status() !== 200)
          return false;
        const workbench = (await response.json()) as Workbench;
        return workbench.tasks.some((task) => task.id === edited.id);
      });
      await f.grant('view');
      await (await restored).finished();
      await expect(page.locator(`a.context-task[href="/tasks/${edited.id}"]`)).toHaveCount(1);
      await expect(rows(page)).toHaveCount(0);
      const completedBeforeOld = await completedSearchBodies(page);
      await release(oldPage);
      await expect.poll(() => completedSearchBodies(page)).toBeGreaterThan(completedBeforeOld);
      await expect(rows(page)).toHaveCount(0);
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      await expect(dialog(page)).not.toContainText('旧搜索读取已失败');
      await expect(dialog(page).getByText('正在加载更多…', { exact: true })).toHaveCount(0);
      await expect(dialog(page)).not.toContainText(edited.title);
      await expect(dialog(page)).not.toContainText(hidden.title);
      await refresh(page).click();
      await expect(rows(page)).toHaveCount(30);
      await expect(row(page, edited)).toContainText(edited.title);
      await expect(row(page, nonmatching)).toHaveCount(0);
      await expect(row(page, hidden)).toHaveCount(0);
      await expect(more(page)).toBeEnabled();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, held, failed);
    }
  });
