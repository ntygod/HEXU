import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task } from '../../packages/contracts/src/index.js';
import { teamFixture } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const history = (page: Page) => page.getByRole('dialog', { name: '工作说明历史', exact: true });
const rows = (page: Page) => history(page).locator('article');
const row = (page: Page, revision: number) =>
  history(page).getByRole('article', { name: `工作说明修订 ${revision}`, exact: true });
async function create(page: Page, name: string) {
  const response = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title: name, description: '初始任务说明', projectId: 'project-orders' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function patch(page: Page, task: Task, description: string) {
  const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, description },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function go(page: Page, task: Task) {
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole('button', { name: '工作说明历史', exact: true }).click();
  await expect(history(page)).toBeVisible();
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('真实编辑保存与历史持久化，旧版本全文及来源可读，深浅手机和键盘可操作', async ({ page }) => {
  const task = await create(page, '工作说明历史 · 订单导出');
  await go(page, task);
  await page.getByRole('button', { name: '编辑工作说明', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑工作说明', exact: true });
  const body =
    '补充没有结果时的说明。\n<img src=x onerror="window.taskHistoryInjected=true">\n' +
    'LongUnbrokenDescription'.repeat(12);
  await editor.getByLabel('说明', { exact: true }).fill(body);
  await editor.getByLabel('需要关注什么', { exact: true }).fill('等待接口字段确认');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, 2)).toContainText('手工编辑');
  await expect(row(page, 2)).toContainText('变更：说明、关注内容');
  await expect(row(page, 2)).toContainText(body);
  await row(page, 1).locator('summary').click();
  await expect(row(page, 1).locator('dd').nth(1)).toHaveText('初始任务说明');
  expect(await page.evaluate(() => Reflect.get(window, 'taskHistoryInjected'))).toBeUndefined();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/177-task-content-history-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '工作说明历史', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  await page.screenshot({
    path: 'artifacts/178-task-content-history-mobile-light.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await history(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  const reading = history(page).locator('.task-content-history');
  const readingBox = await reading.boundingBox();
  const paragraphBox = await reading.locator(':scope > p').first().boundingBox();
  expect(readingBox).not.toBeNull();
  expect(paragraphBox).not.toBeNull();
  expect(paragraphBox!.x - readingBox!.x).toBeGreaterThanOrEqual(12);
  expect(paragraphBox!.width).toBeGreaterThanOrEqual(320);
  await expect(
    history(page).locator('.dialog-footer').getByRole('button', { name: '关闭', exact: true }),
  ).toBeInViewport();
  const refresh = history(page).getByRole('button', { name: '重新读取历史', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(refresh).toBeEnabled();
  await expect(rows(page)).toHaveCount(2);
  await history(page)
    .locator('.dialog-footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.reload();
  await open(page);
  await expect(row(page, 2)).toContainText(body);
  const detail = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(detail.runs).toHaveLength(0);
  expect(detail.task.revision).toBe(2);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(body);
});

test('有界历史分页保留已展开旧版，SSE提示新记录；短暂读取失败按原页重试', async ({ page }) => {
  let task = await create(page, '工作说明分页');
  for (let i = 2; i <= 14; i++) task = await patch(page, task, `历史说明 ${i}`);
  await go(page, task);
  await open(page);
  await expect(rows(page)).toHaveCount(10);
  await row(page, 5).locator('summary').click();
  await expect(row(page, 5).locator('details')).toHaveAttribute('open', '');
  task = await patch(page, task, '后来保存的新说明');
  await expect(history(page)).toContainText('有新的工作说明记录');
  await expect(rows(page)).toHaveCount(10);
  await expect(row(page, 5).locator('details')).toHaveAttribute('open', '');
  await expect(row(page, 15)).toHaveCount(0);
  let fail = true;
  const pattern = `**/api/v1/tasks/${task.id}/content-history?limit=10&before=5`;
  await page.route(pattern, (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'READ_FAILED', message: '历史分页暂不可用' } },
        })
      : route.continue(),
  );
  try {
    await history(page).getByRole('button', { name: '更早的工作说明', exact: true }).click();
    await expect(history(page).getByRole('alert')).toContainText('历史分页暂不可用');
    await expect(rows(page)).toHaveCount(10);
    fail = false;
    await history(page).getByRole('button', { name: '重试历史读取', exact: true }).click();
    await expect(rows(page)).toHaveCount(14);
    await expect(row(page, 1)).toContainText('创建任务');
    await expect(row(page, 5).locator('details')).toHaveAttribute('open', '');
    await expect(
      history(page).getByRole('button', { name: '更早的工作说明', exact: true }),
    ).toHaveCount(0);
    await history(page).getByRole('button', { name: '重新读取历史', exact: true }).click();
    await expect(rows(page)).toHaveCount(10);
    await expect(row(page, 15)).toContainText('后来保存的新说明');
    await expect(history(page)).not.toContainText('有新的工作说明记录');
  } finally {
    await page.unroute(pattern);
  }
});

test('关闭重开后旧历史成功或拒绝不覆盖新抽屉，延迟读取完整排空', async ({ page }) => {
  let task = await create(page, '读取会话隔离');
  await go(page, task);
  for (const status of [200, 403]) {
    const held = gate(),
      reached = gate();
    const pending: Promise<PromiseSettledResult<void>>[] = [];
    let holding = true;
    let failed = false;
    const pattern = `**/api/v1/tasks/${task.id}/content-history?*`;
    const handler = async (route: Route) => {
      if (!holding) return route.continue();
      const work = (async () => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        reached.resolve();
        await held.promise;
        if (status === 200) await route.fulfill({ response });
        else
          await route.fulfill({
            status,
            json: { error: { code: 'FORBIDDEN', message: '旧读取已拒绝' } },
          });
      })();
      // Observe every rejection immediately, then surface it at the bounded drain.
      pending.push(
        work.then(
          () => ({ status: 'fulfilled', value: undefined }),
          (reason) => ({ status: 'rejected', reason }),
        ),
      );
      await work;
    };
    await page.route(pattern, handler);
    try {
      await open(page);
      await reached.promise;
      await expect(history(page)).toContainText('正在读取工作说明历史');
      await page.keyboard.press('Escape');
      await expect(history(page)).toHaveCount(0);
      task = await patch(page, task, `新会话说明 ${status}`);
      holding = false;
      await open(page);
      await expect(row(page, task.revision)).toContainText(`新会话说明 ${status}`);
      held.resolve();
      const results = await Promise.all(pending);
      const errors = results.filter((item) => item.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((item) => item.reason),
          '旧历史读取失败',
        );
      await expect(history(page).getByRole('alert')).toHaveCount(0);
      await expect(row(page, task.revision)).toContainText(`新会话说明 ${status}`);
      await page.keyboard.press('Escape');
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      holding = false;
      held.resolve();
      const results = await Promise.all(pending);
      const errors = results.filter((item) => item.status === 'rejected');
      await page.unroute(pattern, handler);
      if (errors.length && !failed)
        throw new AggregateError(
          errors.map((item) => item.reason),
          '历史读取清理失败',
        );
      if (errors.length && failed)
        test.info().annotations.push({
          type: 'cleanup failure',
          description: errors.map((item) => String(item.reason)).join('\n'),
        });
    }
  }
});

test('已知旧快照不补造操作者或保存时间，手机可展开全文并关闭', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks/task-24');
  await open(page);
  const legacy = rows(page).filter({ hasText: '已有内容快照' });
  await expect(legacy).toHaveCount(1);
  await expect(legacy).toContainText('操作者未记录');
  await expect(legacy).toContainText('保存时间未记录');
  await expect(legacy).toContainText('之前的修改过程未记录');
  if (
    !(await legacy.locator('details').evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await legacy.locator('summary').click();
  await legacy.scrollIntoViewIfNeeded();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({
    path: 'artifacts/179-task-content-history-legacy-mobile.png',
    fullPage: true,
  });
  expect(
    await history(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await history(page)
    .locator('.dialog-footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(history(page)).toHaveCount(0);
});

test('同一抽屉手动重读后旧SSE权限拒绝失效，当前读取拒绝仍清空历史', async ({ page }) => {
  const task = await create(page, '同一历史抽屉的读取次序');
  await go(page, task);
  await open(page);
  await expect(rows(page)).toHaveCount(1);
  const held = gate(),
    reached = gate();
  let holding = true;
  let failed = false;
  const pending: Promise<PromiseSettledResult<void>>[] = [];
  const pattern = `**/api/v1/tasks/${task.id}/content-history?limit=1`;
  const handler = async (route: Route) => {
    if (!holding) return route.continue();
    const work = held.promise.then(() =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '较早权限探测的拒绝' } },
      }),
    );
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
  try {
    const event = await page.request.post(`/api/v1/tasks/${task.id}/messages`, {
      headers: headers(),
      data: { body: '真实事件引起独立权限重读' },
    });
    expect(event.ok(), await event.text()).toBe(true);
    await reached.promise;
    const response = page.waitForResponse(
      (value) =>
        value.url().endsWith(`/tasks/${task.id}/content-history?limit=10`) &&
        value.status() === 200,
    );
    await history(page).getByRole('button', { name: '重新读取历史', exact: true }).click();
    await (await response).finished();
    await expect(
      history(page).getByRole('button', { name: '重新读取历史', exact: true }),
    ).toBeEnabled();
    await expect(row(page, 1)).toContainText('初始任务说明');
    holding = false;
    held.resolve();
    const results = await Promise.all(pending);
    const errors = results.filter((item) => item.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((item) => item.reason),
        '旧权限探测未完成',
      );
    await expect(history(page).getByRole('alert')).toHaveCount(0);
    await expect(row(page, 1)).toContainText('初始任务说明');
    await page.unroute(pattern, handler);
    const currentPattern = `**/api/v1/tasks/${task.id}/content-history?limit=10`;
    await page.route(currentPattern, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '本次历史读取已拒绝' } },
      }),
    );
    await history(page).getByRole('button', { name: '重新读取历史', exact: true }).click();
    await expect(history(page)).toContainText('先前内容已清除');
    await expect(rows(page)).toHaveCount(0);
    await page.unroute(currentPattern);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    holding = false;
    held.resolve();
    const results = await Promise.all(pending);
    const errors = results.filter((item) => item.status === 'rejected');
    await page.unroute(pattern, handler);
    if (errors.length && !failed)
      throw new AggregateError(
        errors.map((item) => item.reason),
        '旧权限探测清理失败',
      );
    if (errors.length && failed)
      test.info().annotations.push({
        type: 'cleanup failure',
        description: errors.map((item) => String(item.reason)).join('\n'),
      });
  }
});

test('只读成员可读历史，明确拒绝清除旧文且不自动复活；真实撤权移除整个入口', async ({ page }) => {
  const origin = 'http://127.0.0.1:4336';
  const f = await teamFixture(origin);
  let failed = false;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const task = await f.task(alice, project.id, '当前权限约束的历史');
    const edited = await f.call(
      `tasks/${task.id}`,
      alice,
      { expectedRevision: 1, description: '撤权后不再展示的旧说明' },
      'edit',
      'PATCH',
    );
    expect(edited.statusCode, edited.body).toBe(200);
    await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    await f.app.listen({ port: 4336, host: '127.0.0.1' });
    await page.context().addCookies(
      bob.cookie.split('; ').map((cookie) => {
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
      { userId: bob.user.id, spaceId: bob.spaceId },
    );
    await page.goto(`${origin}/tasks/${task.id}`);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();
    await open(page);
    await expect(row(page, 2)).toContainText('撤权后不再展示的旧说明');
    const pattern = `${origin}/api/v1/tasks/${task.id}/content-history?*`;
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '历史读取已拒绝' } },
      }),
    );
    const event = await f.call(`tasks/${task.id}/messages`, alice, {
      body: '真实事件触发当前历史权限重查',
    });
    expect(event.statusCode, event.body).toBe(201);
    await expect(history(page)).toContainText('先前内容已清除');
    await expect(rows(page)).toHaveCount(0);
    await page.unroute(pattern);
    const nextEvent = await f.call(`tasks/${task.id}/messages`, alice, {
      body: '再次真实事件不会复活已拒绝历史',
    });
    expect(nextEvent.statusCode, nextEvent.body).toBe(201);
    await expect(history(page)).toContainText('先前内容已清除');
    await expect(rows(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await open(page);
    await expect(rows(page)).toHaveCount(2);
    const revoked = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: null,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(history(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '工作说明历史', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('撤权后不再展示的旧说明');
    expect((await f.call(`tasks/${task.id}/content-history?before=2`, bob)).statusCode).toBe(404);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    const errors: unknown[] = [];
    for (const action of [
      () => page.unrouteAll({ behavior: 'ignoreErrors' }),
      () => page.goto('about:blank'),
      () => page.context().close(),
      () => f.close(),
    ]) {
      try {
        await action();
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length && !failed)
      throw new AggregateError(errors, 'Task history team cleanup failed');
    if (errors.length && failed)
      test
        .info()
        .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
  }
});
