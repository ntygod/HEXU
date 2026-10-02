import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task, TaskDetail } from '../../packages/contracts/src/index.js';
import type {
  TaskCompletionEvent,
  TaskCompletionHistory,
} from '../../packages/contracts/src/task-completion-history.js';
import { teamFixture, type Account } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const actions = { complete: '标记完成', cancel: '取消任务', reopen: '重新打开' };
type Action = keyof typeof actions;
const history = (page: Page) => page.getByRole('dialog', { name: '完成记录', exact: true });
const rows = (page: Page) => history(page).getByRole('article');
const label = (item: TaskCompletionEvent) =>
  `任务修订 ${item.taskRevision} · ${actions[item.action as Action] ?? `未知动作（${item.action}）`}`;
const row = (page: Page, item: TaskCompletionEvent) =>
  history(page).getByRole('article', { name: label(item), exact: true });
const refresh = (page: Page) =>
  history(page).getByRole('button', { name: '重新读取记录', exact: true });
const footerClose = (page: Page) =>
  history(page).locator('.dialog-footer').getByRole('button', { name: '关闭', exact: true });

async function create(page: Page, title: string) {
  const response = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title, description: '人工完成状态与执行记录分开', projectId: 'project-orders' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function detail(page: Page, task: Task) {
  const response = await page.request.get(`/api/v1/tasks/${task.id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TaskDetail;
}
async function change(page: Page, task: Task, action: Action | 'start') {
  const response = await page.request.post(`/api/v1/tasks/${task.id}/${action}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, activeRunAction: 'keep' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function readHistory(page: Page, task: Task) {
  const response = await page.request.get(`/api/v1/tasks/${task.id}/completion-history?limit=10`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TaskCompletionHistory;
}
async function go(page: Page, task: Task, origin = '') {
  await page.goto(`${origin}/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole('button', { name: '完成记录', exact: true }).click();
  await expect(history(page)).toBeVisible();
}
async function expectOrder(page: Page, items: TaskCompletionEvent[]) {
  await expect(rows(page)).toHaveCount(items.length);
  await expect
    .poll(() =>
      rows(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('aria-label'))),
    )
    .toEqual(items.map(label));
}
async function screenshot(page: Page, name: string) {
  await mkdir('artifacts', { recursive: true });
  // Callers scroll and assert the evidence first; capture the actual fixed-shell viewport.
  await page.screenshot({ path: `artifacts/${name}` });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function holdReads(page: Page, pattern: string, status: 200 | 403) {
  const held = gate(),
    reached = gate();
  const pending: Promise<PromiseSettledResult<void>>[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    if (!holding) return route.continue();
    const work = (async () => {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      reached.resolve();
      await held.promise;
      if (status === 200) await route.fulfill({ response });
      else
        await route.fulfill({
          status,
          json: { error: { code: 'FORBIDDEN', message: '较早完成记录读取的拒绝' } },
        });
    })();
    // Every matching GET belongs to the old session, including replacement reads.
    pending.push(
      work.then(
        () => ({ status: 'fulfilled', value: undefined }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    );
    await work;
  };
  await page.route(pattern, handler);
  return {
    reached: reached.promise,
    stopCapture() {
      holding = false;
    },
    async releaseAndDrain() {
      holding = false;
      held.resolve();
      const settled = await Promise.all(pending);
      const errors = settled.filter((item) => item.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((item) => item.reason),
          '延迟完成记录读取失败',
        );
    },
    async dispose(failed: boolean) {
      const errors: unknown[] = [];
      try {
        await this.releaseAndDrain();
      } catch (cause) {
        errors.push(cause);
      }
      // Never remove a route while any of its held responses still need fulfilling.
      try {
        await page.unroute(pattern, handler);
      } catch (cause) {
        errors.push(cause);
      }
      reportCleanup(errors, failed, '完成记录读取清理失败');
    },
  };
}
function reportCleanup(errors: unknown[], failed: boolean, message: string) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, message);
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
async function authenticate(page: Page, account: Account, origin: string) {
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
      const i = cookie.indexOf('=');
      return {
        name: cookie.slice(0, i),
        value: cookie.slice(i + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
  await page.addInitScript(
    ({ userId, spaceId }) => sessionStorage.setItem(`hexu-space:${userId}`, spaceId),
    { userId: account.user.id, spaceId: account.spaceId },
  );
}
async function closeFixture(page: Page, close: () => Promise<void>, failed: boolean) {
  const errors: unknown[] = [];
  for (const action of [
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.goto('about:blank'),
    () => page.context().close(),
    close,
  ]) {
    try {
      await action();
    } catch (cause) {
      errors.push(cause);
    }
  }
  reportCleanup(errors, failed, '完成记录团队服务清理失败');
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('真实完成、重开和取消按原事件排序持久化；只读、深浅手机和键盘关闭可操作', async ({ page }) => {
  let task = await create(page, '完成记录 · 订单导出');
  task = await change(page, task, 'start');
  const edited = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, description: '说明编辑不是完成动作' },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  task = (await edited.json()) as Task;
  await go(page, task);
  await open(page);
  await expect(rows(page)).toHaveCount(0);
  await expect(history(page)).toContainText('暂无已记录的完成动作。已有任务状态不补造历史。');
  await expect(refresh(page)).toBeEnabled();
  expect((await readHistory(page, task)).items).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '完成记录', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '重新打开并继续', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(page.getByRole('button', { name: '标记完成', exact: true })).toBeEnabled();
  task = await change(page, (await detail(page, task)).task, 'cancel');
  const saved = await readHistory(page, task);
  expect(saved.items.map((item) => [item.taskRevision, item.action])).toEqual([
    [6, 'cancel'],
    [5, 'reopen'],
    [4, 'complete'],
  ]);
  expect(saved.nextCursor).toBeNull();
  const before = await detail(page, task);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  await open(page);
  await expectOrder(page, saved.items);
  for (const item of saved.items) {
    await expect(row(page, item)).toContainText(item.actorName ?? '操作者当前不可见');
    await expect(row(page, item).locator('time')).toHaveAttribute('datetime', item.createdAt);
    await expect(row(page, item).locator('time')).not.toHaveText('');
  }
  await expect(
    history(page).getByRole('button', { name: /^(标记完成|取消任务|重新打开|继续)$/ }),
  ).toHaveCount(0);
  await expect(history(page)).toContainText('记录不表示执行已停止，也不代表代码已发布。');
  await row(page, saved.items[2]!).scrollIntoViewIfNeeded();
  for (const item of saved.items) {
    await expect(row(page, item).getByRole('heading')).toBeInViewport({ ratio: 1 });
    await expect(row(page, item).locator('time')).toBeInViewport({ ratio: 1 });
  }
  await expect(footerClose(page)).toBeInViewport({ ratio: 1 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await screenshot(page, '186-task-completion-history-dark.png');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '完成记录', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expectOrder(page, saved.items);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const reading = history(page).locator('.dialog-body');
  const readingBox = await reading.boundingBox();
  const recordBox = await row(page, saved.items[0]!).boundingBox();
  expect(readingBox).not.toBeNull();
  expect(recordBox).not.toBeNull();
  expect(recordBox!.width).toBeGreaterThanOrEqual(320);
  expect(recordBox!.x - readingBox!.x).toBeGreaterThanOrEqual(12);
  expect(
    await history(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await refresh(page).scrollIntoViewIfNeeded();
  await expect(refresh(page)).toBeInViewport({ ratio: 1 });
  await expect(row(page, saved.items[0]!).getByRole('heading')).toBeInViewport({ ratio: 1 });
  await expect(row(page, saved.items[0]!).locator('time')).toBeInViewport({ ratio: 1 });
  await expect(footerClose(page)).toBeInViewport({ ratio: 1 });
  const closeBox = await footerClose(page).boundingBox();
  expect(closeBox).not.toBeNull();
  expect(
    await footerClose(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    }),
  ).toBe(true);
  await screenshot(page, '187-task-completion-history-mobile-light.png');
  await refresh(page).focus();
  await page.keyboard.press('Enter');
  await expect(refresh(page)).toBeEnabled();
  await expectOrder(page, saved.items);
  await footerClose(page).click();
  await expect(history(page)).toHaveCount(0);
  await open(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '完成记录', exact: true })).toBeFocused();
  await page.reload();
  await open(page);
  await expectOrder(page, saved.items);
  expect(await readHistory(page, task)).toEqual(saved);
  const after = await detail(page, task);
  expect(after.task).toEqual(before.task);
  expect(after.runs).toEqual(before.runs);
  expect(after.runs).toHaveLength(0);
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(saved.items[0]!.id);
});

test('事件ID有界分页保留已读记录，真实SSE提示新事件；失败原页重试和明确刷新', async ({ page }) => {
  let task = await create(page, '完成记录分页');
  for (let i = 0; i < 14; i++) task = await change(page, task, i % 2 === 0 ? 'complete' : 'reopen');
  const first = await readHistory(page, task);
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).toBe(first.items[9]!.id);
  await go(page, task);
  await open(page);
  await expectOrder(page, first.items);
  task = await change(page, task, 'complete');
  await expect(history(page).getByRole('status')).toContainText('有新的完成记录');
  await expectOrder(page, first.items);
  await expect(
    history(page).getByRole('article', { name: new RegExp(`^任务修订 ${task.revision} ·`) }),
  ).toHaveCount(0);
  await refresh(page).scrollIntoViewIfNeeded();
  await expect(refresh(page)).toBeInViewport({ ratio: 1 });
  await expect(history(page).getByRole('status')).toBeInViewport({ ratio: 1 });
  await expect(row(page, first.items[0]!)).toBeInViewport({ ratio: 1 });
  await screenshot(page, '188-task-completion-history-pagination.png');
  let fail = true;
  const before = first.nextCursor!;
  const pattern = `**/api/v1/tasks/${task.id}/completion-history?limit=10&before=${encodeURIComponent(before)}`;
  const requests: string[] = [];
  let older: TaskCompletionHistory | undefined;
  await page.route(pattern, async (route) => {
    requests.push(route.request().url());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'READ_FAILED', message: '完成记录分页暂不可用' } },
      });
    else {
      older = (await response.json()) as TaskCompletionHistory;
      await route.fulfill({ response });
    }
  });
  try {
    await history(page).getByRole('button', { name: '更早的记录', exact: true }).click();
    await expect(history(page).getByRole('alert')).toContainText('完成记录分页暂不可用');
    await expectOrder(page, first.items);
    await expect(history(page)).toContainText('有新的完成记录');
    fail = false;
    await history(page).getByRole('button', { name: '重试记录读取', exact: true }).click();
    await expect(rows(page)).toHaveCount(14);
    await expect(rows(page).last()).toHaveAttribute('aria-label', '任务修订 2 · 标记完成');
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(new URL(request).searchParams.get('before')).toBe(before);
    await expect(
      history(page).getByRole('button', { name: '更早的记录', exact: true }),
    ).toHaveCount(0);
    await expect(
      history(page).getByRole('article', { name: new RegExp(`^任务修订 ${task.revision} ·`) }),
    ).toHaveCount(0);
    const loaded = [...first.items, ...older!.items];
    expect(new Set(loaded.map((item) => item.id)).size).toBe(14);
    await expectOrder(page, loaded);
    let failProbe = true;
    const probePattern = `**/api/v1/tasks/${task.id}/completion-history?limit=1`;
    await page.route(probePattern, async (route) => {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      if (failProbe)
        await route.fulfill({
          status: 503,
          json: { error: { code: 'READ_FAILED', message: '完成记录检查暂不可用' } },
        });
      else await route.fulfill({ response });
    });
    try {
      const event = await page.request.post(`/api/v1/tasks/${task.id}/messages`, {
        headers: headers(),
        data: { body: '已读两页之后真实事件触发记录检查' },
      });
      expect(event.ok(), await event.text()).toBe(true);
      await expect(history(page).getByRole('alert')).toContainText('完成记录检查暂不可用');
      await expectOrder(page, loaded);
      await expect(
        history(page).getByRole('button', { name: '重试记录读取', exact: true }),
      ).toHaveCount(0);
      failProbe = false;
      const checked = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/tasks/${task.id}/completion-history?limit=1`) &&
          response.status() === 200,
      );
      await history(page).getByRole('button', { name: '重试记录检查', exact: true }).click();
      await (await checked).finished();
      await expect(history(page).getByRole('alert')).toHaveCount(0);
      await expectOrder(page, loaded);
      // Retrying the probe must never re-append the already successful older page.
      expect(requests).toHaveLength(2);
      await expect(history(page)).toContainText('有新的完成记录');
    } finally {
      await page.unroute(probePattern);
    }
    await refresh(page).click();
    const latest = await readHistory(page, task);
    await expectOrder(page, latest.items);
    await expect(rows(page).first()).toHaveAttribute(
      'aria-label',
      `任务修订 ${task.revision} · 标记完成`,
    );
    await expect(history(page)).not.toContainText('有新的完成记录');
  } finally {
    await page.unroute(pattern);
  }
});

test('关闭重开后旧完成记录成功或拒绝不能影响新会话，所有延迟GET排空', async ({ page }) => {
  let task = await change(page, await create(page, '完成记录读取会话隔离'), 'complete');
  await go(page, task);
  for (const status of [200, 403] as const) {
    const held = await holdReads(page, `**/api/v1/tasks/${task.id}/completion-history?*`, status);
    let failed = false;
    try {
      await open(page);
      await held.reached;
      await expect(history(page)).toContainText('正在读取完成记录');
      await page.keyboard.press('Escape');
      await expect(history(page)).toHaveCount(0);
      task = await change(page, task, status === 200 ? 'reopen' : 'complete');
      const current = await readHistory(page, task);
      held.stopCapture();
      await open(page);
      await expectOrder(page, current.items);
      await held.releaseAndDrain();
      await expectOrder(page, current.items);
      await expect(history(page).getByRole('alert')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
      await page.keyboard.press('Escape');
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      await held.dispose(failed);
    }
  }
});

test('首次读取挂起期间的真实SSE在旧快照返回后补查，保留旧页并提示新记录', async ({ page }) => {
  let task = await change(page, await create(page, '初次完成记录读取期间有新事件'), 'complete');
  const saved = await readHistory(page, task);
  await go(page, task);
  const held = await holdReads(page, `**/api/v1/tasks/${task.id}/completion-history?*`, 200);
  let failed = false;
  try {
    await open(page);
    await held.reached;
    await expect(history(page)).toContainText('正在读取完成记录');
    const changedRevision = task.revision + 1;
    const changedWorkbench = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/api/v1/workbench') || response.status() !== 200) return false;
      const body = (await response.json()) as { tasks: Task[] };
      return body.tasks.some((item) => item.id === task.id && item.revision === changedRevision);
    });
    // No second event is sent after releasing the first read: this update must not be lost.
    const previous = task;
    const next = await change(page, previous, 'reopen');
    await (await changedWorkbench).finished();
    task = next;
    await expect(page.locator('.task-title .badge')).toHaveText('待处理');
    await expect(history(page)).toContainText('正在读取完成记录');
    await expect(rows(page)).toHaveCount(0);
    held.stopCapture();
    await held.releaseAndDrain();
    await expectOrder(page, saved.items);
    await expect(history(page).getByRole('status')).toContainText('有新的完成记录');
    await expectOrder(page, saved.items);
    await refresh(page).click();
    const current = await readHistory(page, task);
    await expectOrder(page, current.items);
    await expect(rows(page).first()).toHaveAttribute(
      'aria-label',
      `任务修订 ${task.revision} · 重新打开`,
    );
    await expect(history(page)).not.toContainText('有新的完成记录');
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    await held.dispose(failed);
  }
});

test('同一抽屉真实SSE的旧权限拒绝被明确200重读淘汰，当前403清空且不自动复活', async ({ page }) => {
  const task = await change(page, await create(page, '完成记录权限读取次序'), 'complete');
  const saved = await readHistory(page, task);
  await go(page, task);
  await open(page);
  await expectOrder(page, saved.items);
  const pattern = `**/api/v1/tasks/${task.id}/completion-history?limit=1`;
  const held = await holdReads(page, pattern, 403);
  let failed = false;
  try {
    const event = await page.request.post(`/api/v1/tasks/${task.id}/messages`, {
      headers: headers(),
      data: { body: '真实讨论事件触发完成记录权限重查' },
    });
    expect(event.ok(), await event.text()).toBe(true);
    await held.reached;
    const response = page.waitForResponse(
      (value) =>
        value.url().endsWith(`/tasks/${task.id}/completion-history?limit=10`) &&
        value.status() === 200,
    );
    await refresh(page).click();
    await (await response).finished();
    await expect(refresh(page)).toBeEnabled();
    await expectOrder(page, saved.items);
    held.stopCapture();
    await held.releaseAndDrain();
    await expectOrder(page, saved.items);
    await expect(history(page).getByRole('alert')).toHaveCount(0);
    const currentPattern = `**/api/v1/tasks/${task.id}/completion-history?limit=10`;
    await page.route(currentPattern, async (route) => {
      const current = await route.fetch();
      expect(current.ok(), await current.text()).toBe(true);
      await route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '当前完成记录读取已拒绝' } },
      });
    });
    try {
      await refresh(page).click();
      await expect(history(page)).toContainText('完成记录已不可访问，先前记录已清除。');
      await expect(rows(page)).toHaveCount(0);
      await expect(refresh(page)).toHaveCount(0);
    } finally {
      await page.unroute(currentPattern);
    }
    const nextBody = '后续真实事件不会复活当前被拒绝的完成记录';
    const update = page.waitForResponse(async (response) => {
      if (!response.url().endsWith(`/api/v1/tasks/${task.id}`) || response.status() !== 200)
        return false;
      const value = (await response.json()) as TaskDetail;
      return value.messages.some((message) => message.body === nextBody);
    });
    const next = await page.request.post(`/api/v1/tasks/${task.id}/messages`, {
      headers: headers(),
      data: { body: nextBody },
    });
    expect(next.ok(), await next.text()).toBe(true);
    await (await update).finished();
    await expect(history(page)).toContainText('完成记录已不可访问，先前记录已清除。');
    await expect(rows(page)).toHaveCount(0);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    await held.dispose(failed);
  }
});

test('真实团队只读成员可读完成记录，当前撤权清空入口且迟到成功和刷新不能复活', async ({ page }) => {
  const origin = 'http://127.0.0.1:4338';
  const f = await teamFixture(origin);
  let failed = false;
  let held: Awaited<ReturnType<typeof holdReads>> | undefined;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const task = await f.task(alice, project.id, '撤权后不再可见的完成记录');
    const completed = await f.call(`tasks/${task.id}/complete`, alice, {
      expectedRevision: 1,
      activeRunAction: 'keep',
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const grant = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'view',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const savedResponse = await f.call(`tasks/${task.id}/completion-history?limit=10`, bob);
    expect(savedResponse.statusCode, savedResponse.body).toBe(200);
    const saved = savedResponse.json() as TaskCompletionHistory;
    await f.app.listen({ host: '127.0.0.1', port: 4338 });
    await authenticate(page, bob, origin);
    await go(page, task, origin);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeDisabled();
    await open(page);
    await expectOrder(page, saved.items);
    await expect(rows(page).first()).toContainText(alice.user.name);
    held = await holdReads(page, `${origin}/api/v1/tasks/${task.id}/completion-history?*`, 200);
    await refresh(page).click();
    await held.reached;
    await expect(history(page)).toContainText('正在读取完成记录');
    held.stopCapture();
    const revoked = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: null,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(history(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完成记录', exact: true })).toHaveCount(0);
    await held.releaseAndDrain();
    await expect(history(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(task.title);
    const denied = await f.call(
      `tasks/${task.id}/completion-history?limit=10&before=${encodeURIComponent(saved.items[0]!.id)}`,
      bob,
    );
    expect(denied.statusCode, denied.body).toBe(404);
    const reopened = await f.call(`tasks/${task.id}/reopen`, alice, {
      expectedRevision: 2,
      activeRunAction: 'keep',
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    await page.reload();
    await expect(page.getByText('当前无法访问此任务', { exact: true })).toBeVisible();
    await expect(history(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完成记录', exact: true })).toHaveCount(0);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    const errors: unknown[] = [];
    try {
      await held?.dispose(failed);
    } catch (cause) {
      errors.push(cause);
    }
    try {
      await closeFixture(page, () => f.close(), failed || errors.length > 0);
    } catch (cause) {
      errors.push(cause);
    }
    reportCleanup(errors, failed, '撤权完成记录清理失败');
  }
});

test('原事件不补造历史姓名，退出空间的操作者按当前可见成员清除显示名', async ({ page }) => {
  const origin = 'http://127.0.0.1:4338';
  const f = await teamFixture(origin);
  let failed = false;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const task = await f.task(alice, project.id, '完成记录操作者当前可见性');
    const grant = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const completed = await f.call(`tasks/${task.id}/complete`, bob, {
      expectedRevision: 1,
      activeRunAction: 'keep',
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const originalResponse = await f.call(`tasks/${task.id}/completion-history?limit=10`, alice);
    expect(originalResponse.statusCode, originalResponse.body).toBe(200);
    const original = originalResponse.json() as TaskCompletionHistory;
    expect(original.items[0]!.actorName).toBe(bob.user.name);
    await f.app.listen({ host: '127.0.0.1', port: 4338 });
    await authenticate(page, alice, origin);
    await go(page, task, origin);
    await open(page);
    await expectOrder(page, original.items);
    await expect(rows(page).first()).toContainText(bob.user.name);
    const removed = await f.call(
      `spaces/${alice.spaceId}/members/${bob.user.id}/remove`,
      alice,
      {},
    );
    expect(removed.statusCode, removed.body).toBe(200);
    await refresh(page).click();
    await expect(rows(page).first()).toContainText('操作者当前不可见');
    await expect(history(page)).not.toContainText(bob.user.name);
    await expect(history(page)).not.toContainText(bob.user.id);
    const currentResponse = await f.call(`tasks/${task.id}/completion-history?limit=10`, alice);
    expect(currentResponse.statusCode, currentResponse.body).toBe(200);
    const current = currentResponse.json() as TaskCompletionHistory;
    expect(current.items).toEqual(original.items.map((item) => ({ ...item, actorName: null })));
    await page.reload();
    await open(page);
    await expectOrder(page, current.items);
    await expect(rows(page).first()).toContainText('操作者当前不可见');
    await expect(rows(page).first().locator('time')).toHaveAttribute(
      'datetime',
      original.items[0]!.createdAt,
    );
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    await closeFixture(page, () => f.close(), failed);
  }
});
