import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task } from '../../packages/contracts/src/index.js';
import type { TaskLabelsReceipt } from '../../packages/contracts/src/task-labels.js';
import { teamFixture } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const drawer = (page: Page) => page.getByRole('dialog', { name: '任务标签', exact: true });
const draft = (page: Page) =>
  drawer(page).getByRole('region', { name: '本次标签草稿', exact: true });
const input = (page: Page) => drawer(page).getByLabel('新标签', { exact: true });
const save = (page: Page) => drawer(page).getByRole('button', { name: '保存标签', exact: true });
async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const r = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function setup(page: Page, title: string) {
  const project = await post<{ id: string }>(page, 'spaces/space-demo/projects', {
    name: title + '项目',
  });
  const task = await post<Task>(page, 'spaces/space-demo/tasks', {
    projectId: project.id,
    title,
    description: '不因标签改变的说明',
  });
  return { project, task };
}
async function go(page: Page, task: Task, origin = '') {
  await page.goto(`${origin}/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole('button', { name: '查看任务标签', exact: true }).click();
  await expect(drawer(page)).toBeVisible();
}
async function add(page: Page, label: string) {
  await input(page).fill(label);
  await drawer(page).getByRole('button', { name: '加入草稿', exact: true }).click();
}
async function close(page: Page) {
  await drawer(page)
    .locator('.dialog-footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(drawer(page)).toHaveCount(0);
}
async function labels(page: Page, task: Task) {
  return (await (
    await page.request.get(`/api/v1/tasks/${task.id}/labels`)
  ).json()) as TaskLabelsReceipt;
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

test('真实标签增删保存、规范化/重复提示、重开持久化，深浅窄屏键盘和主按钮可用', async ({
  page,
}) => {
  const { task } = await setup(page, '可维护的任务标签');
  await go(page, task);
  await open(page);
  await input(page).fill(' 接口 ');
  await page.keyboard.press('Enter');
  await add(page, '接口');
  await expect(drawer(page).getByRole('alert')).toContainText('重复');
  await expect(draft(page)).toContainText('接口');
  await add(page, '<img src=x onerror=alert(1)>');
  await expect(save(page)).toBeInViewport();
  await expect(draft(page)).toBeInViewport();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/183-task-labels-editor-dark.png', fullPage: true });
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  expect((await labels(page, task)).labels).toEqual(['<img src=x onerror=alert(1)>', '接口']);
  await page.reload();
  await open(page);
  await expect(draft(page)).toContainText('接口');
  await close(page);
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await drawer(page)
    .getByRole('button', { name: '移除标签：<img src=x onerror=alert(1)>', exact: true })
    .click();
  await input(page).fill('中文标签'.repeat(8));
  await page.keyboard.press('Enter');
  await expect(save(page)).toBeInViewport({ ratio: 1 });
  await expect(draft(page)).toBeInViewport({ ratio: 1 });
  const box = await input(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(320);
  expect(await drawer(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({
    path: 'artifacts/184-task-labels-editor-mobile-light.png',
    fullPage: true,
  });
  await save(page).focus();
  await page.keyboard.press('Enter');
  await expect(drawer(page)).toHaveCount(0);
  await open(page);
  await expect(draft(page)).not.toContainText('<img');
  await expect(draft(page)).toContainText('中文标签'.repeat(8));
  await close(page);
  const taskAfter = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(taskAfter.task.revision).toBe(task.revision);
  expect(taskAfter.task.description).toBe(task.description);
  expect(taskAfter.runs).toHaveLength(0);
});

test('SSE并发标签不覆盖本地草稿，失败保留输入，明确采用当前基线后保存', async ({ page }) => {
  const { task } = await setup(page, '标签并发基线');
  await go(page, task);
  await open(page);
  await add(page, '我的草稿');
  const pattern = `**/api/v1/tasks/${task.id}/labels`;
  let raced = false;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST' || raced) return route.continue();
    raced = true;
    await post(page, `tasks/${task.id}/labels`, { expectedRevision: 1, labels: ['别人保存'] });
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    await route.fulfill({ response });
  });
  await save(page).click();
  await expect(drawer(page).getByRole('alert')).toContainText('内容已被更新');
  await page.unroute(pattern);
  await expect(
    drawer(page).getByRole('region', { name: '标签版本冲突', exact: true }),
  ).toContainText('别人保存');
  await expect(draft(page)).toContainText('我的草稿');
  await expect(save(page)).toBeDisabled();
  await page.route(pattern, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          json: { error: { code: 'TEMPORARY', message: '读取暂时失败' } },
        })
      : route.continue(),
  );
  await drawer(page).getByRole('button', { name: '重新读取标签', exact: true }).click();
  await expect(drawer(page)).toContainText('输入已保留');
  await expect(draft(page)).toContainText('我的草稿');
  await page.unroute(pattern);
  await drawer(page).getByRole('button', { name: '重新读取标签', exact: true }).click();
  await expect(drawer(page)).not.toContainText('输入已保留');
  await drawer(page).getByRole('button', { name: '保留草稿，采用当前基线', exact: true }).click();
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  expect((await labels(page, task)).labels).toEqual(['我的草稿']);
  await open(page);
  await add(page, '未保存应丢弃');
  await close(page);
  await open(page);
  await expect(draft(page)).not.toContainText('未保存应丢弃');
});

test('丢失标签ACK只确认原包原键，较新集合不会被旧回执覆盖', async ({ page }) => {
  const { task } = await setup(page, '标签原请求回执');
  await go(page, task);
  await open(page);
  await add(page, '原请求标签');
  const requests: { body: unknown; key: string | undefined }[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith(`/tasks/${task.id}/labels`) && r.method() === 'POST')
      requests.push({ body: r.postDataJSON(), key: r.headers()['idempotency-key'] });
  });
  const pattern = `**/api/v1/tasks/${task.id}/labels`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await save(page).click();
  await expect(
    drawer(page).getByRole('region', { name: '标签保存待确认', exact: true }),
  ).toBeVisible();
  await page.unroute(pattern);
  await post(page, `tasks/${task.id}/labels`, { expectedRevision: 2, labels: ['后续标签'] });
  await expect(drawer(page)).toContainText('后续标签');
  await expect(input(page)).toBeDisabled();
  await drawer(page).getByRole('button', { name: '确认原标签是否已保存', exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect((await labels(page, task)).labels).toEqual(['后续标签']);
  expect((await labels(page, task)).revision).toBe(3);
});

test('关闭重开及显式读取取消旧标签GET，迟到拒绝不抹掉新草稿；当前拒绝仍清除', async ({ page }) => {
  const { task } = await setup(page, '标签读取归属');
  await go(page, task);
  await open(page);
  await add(page, '旧会话草稿');
  const pattern = `**/api/v1/tasks/${task.id}/labels`,
    release = gate(),
    captured = gate(),
    work: Promise<void>[] = [],
    errors: unknown[] = [];
  let holding = true,
    failed = false;
  const routeHandler = (route: Route) => {
    if (route.request().method() !== 'GET' || !holding) return route.continue();
    const pending = (async () => {
      await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '旧读取拒绝' } },
      });
    })();
    work.push(pending);
    void pending.catch((error) => errors.push(error));
    return pending;
  };
  await page.route(pattern, routeHandler);
  try {
    await post(page, `tasks/${task.id}/messages`, { body: '触发真实SSE后的旧读取' });
    await captured.promise;
    await close(page);
    holding = false;
    await open(page);
    await add(page, '新会话草稿');
    const fresh = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/tasks/${task.id}/labels`) &&
        response.request().method() === 'GET' &&
        response.status() === 200,
    );
    await drawer(page).getByRole('button', { name: '重新读取标签', exact: true }).click();
    await fresh;
    await expect(draft(page)).toContainText('新会话草稿');
    release.resolve();
    await Promise.all(work);
    await page.unroute(pattern, routeHandler);
    expect(errors).toEqual([]);
    await expect(draft(page)).toContainText('新会话草稿');
    await expect(draft(page)).not.toContainText('旧会话草稿');
    await expect(save(page)).toBeEnabled();
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '当前读取拒绝' } },
      }),
    );
    await drawer(page).getByRole('button', { name: '重新读取标签', exact: true }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看任务标签', exact: true })).toBeDisabled();
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    holding = false;
    release.resolve();
    const cleanup: unknown[] = [];
    for (const action of [
      () => Promise.all(work),
      () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    ]) {
      try {
        await action();
      } catch (cause) {
        cleanup.push(cause);
      }
    }
    if (cleanup.length && !failed) throw new AggregateError(cleanup, '标签读取清理失败');
    if (cleanup.length && failed)
      test
        .info()
        .annotations.push({ type: 'cleanup failure', description: cleanup.map(String).join('\n') });
  }
});

test('标签精确筛选与状态/关注/搜索交集，列表看板URL一致且取消列只读', async ({ page }) => {
  const { task, project } = await setup(page, '标签精确交集');
  const other = await post<Task>(page, 'spaces/space-demo/tasks', {
    projectId: project.id,
    title: '不匹配标签',
  });
  const cancelled = await post<Task>(page, 'spaces/space-demo/tasks', {
    projectId: project.id,
    title: '带标签取消记录',
  });
  for (const t of [task, cancelled])
    await post(page, `tasks/${t.id}/labels`, { expectedRevision: 1, labels: ['接口'] });
  await post(page, `tasks/${other.id}/labels`, { expectedRevision: 1, labels: ['接口草稿'] });
  await post(page, `tasks/${cancelled.id}/cancel`, {
    expectedRevision: 1,
    activeRunAction: 'keep',
  });
  await page.goto(`/projects/${project.id}?view=list&label=${encodeURIComponent('接口')}`);
  const links = () =>
    page.locator('.project-board .project-task-card > a, .work-task-list > a.work-task-row');
  await expect(links()).toHaveCount(1);
  await expect(links()).toContainText(task.title);
  await expect(links().getByLabel('任务标签', { exact: true })).toContainText('接口');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expect(links()).toHaveCount(1);
  await expect(page.getByLabel('标签筛选', { exact: true })).toHaveValue('接口');
  await page.getByLabel('状态筛选', { exact: true }).selectOption('cancelled');
  await expect(links()).toHaveCount(1);
  await expect(links()).toContainText(cancelled.title);
  await expect(page.locator('.project-cancelled-board')).toContainText('只读');
  await expect(page.locator('.project-cancelled-board select')).toHaveCount(0);
  await page.getByLabel('状态筛选', { exact: true }).selectOption('todo');
  await page.getByLabel('关注内容筛选', { exact: true }).selectOption('absent');
  await page.getByLabel('筛选项目任务', { exact: true }).fill(task.title);
  await expect(links()).toHaveCount(1);
  await page.getByLabel('标签筛选', { exact: true }).scrollIntoViewIfNeeded();
  await expect(links()).toBeInViewport();
  await page.screenshot({
    path: 'artifacts/185-task-labels-project-filter-dark.png',
    fullPage: true,
  });
  await page.goBack();
  await expect(page.getByLabel('关注内容筛选', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('标签筛选', { exact: true })).toHaveValue('接口');
  await page.goForward();
  await expect(page.getByLabel('关注内容筛选', { exact: true })).toHaveValue('absent');
  await page.reload();
  await expect(links()).toHaveCount(1);
  await page.goto(`/projects/${project.id}?label=${encodeURIComponent('未知标签')}`);
  await expect(links()).toHaveCount(0);
  await expect(page.getByLabel('标签筛选', { exact: true })).toHaveValue('未知标签');
  for (const query of ['label=', 'label=a&label=b', 'label=%0A']) {
    await page.goto(`/projects/${project.id}?view=list&${query}`);
    await expect(page.getByRole('alert')).toContainText('筛选链接无效');
    await expect(links()).toHaveCount(0);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.getByRole('button', { name: '列表', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(links()).toHaveCount(2);
  }
});

test('真实只读成员查看，降级清草稿，撤权后正文/入口和API都不可见', async ({ page }) => {
  const origin = 'http://127.0.0.1:4337',
    f = await teamFixture(origin);
  let failed = false;
  const release = gate(),
    captured = gate(),
    pending: Promise<void>[] = [],
    writeErrors: unknown[] = [];
  try {
    const { alice, bob } = await f.pair(),
      project = await f.project(alice),
      task = await f.task(alice, project.id, '标签真实权限');
    expect(
      (
        await f.call(`tasks/${task.id}/labels`, alice, {
          expectedRevision: 1,
          labels: ['项目内标签'],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
    ).toBe(200);
    await f.app.listen({ host: '127.0.0.1', port: 4337 });
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
    await go(page, task, origin);
    await open(page);
    await expect(drawer(page)).toContainText('项目内标签');
    await expect(save(page)).toHaveCount(0);
    await close(page);
    expect(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' }))
        .statusCode,
    ).toBe(200);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeEnabled();
    await open(page);
    await add(page, '权限内临时草稿');
    expect(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' }))
        .statusCode,
    ).toBe(200);
    await expect(drawer(page)).toHaveCount(0);
    await open(page);
    await expect(drawer(page)).not.toContainText('权限内临时草稿');
    await expect(save(page)).toHaveCount(0);
    await close(page);
    expect(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' }))
        .statusCode,
    ).toBe(200);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeEnabled();
    await open(page);
    await add(page, '保存后撤权的标签');
    const pattern = `${origin}/api/v1/tasks/${task.id}/labels`;
    await page.route(pattern, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const work = (async () => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        captured.resolve();
        await release.promise;
        await route.fulfill({ response });
      })();
      pending.push(work);
      void work.catch((cause) => writeErrors.push(cause));
      return work;
    });
    await save(page).click();
    await captured.promise;
    expect(
      (await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: null }))
        .statusCode,
    ).toBe(200);
    await expect(drawer(page)).toHaveCount(0);
    release.resolve();
    await Promise.all(pending);
    await page.unroute(pattern);
    expect(writeErrors).toEqual([]);
    await expect(page.getByRole('button', { name: '查看任务标签', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('项目内标签');
    await expect(page.locator('body')).not.toContainText('保存后撤权的标签');
    await expect(page.locator('body')).not.toContainText('标签已保存');
    expect((await f.call(`tasks/${task.id}/labels`, bob)).statusCode).toBe(404);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('临时草稿');
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    release.resolve();
    const errors: unknown[] = [];
    for (const action of [
      () => Promise.all(pending),
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
    if (errors.length && !failed) throw new AggregateError(errors, '标签权限夹具清理失败');
    if (errors.length && failed)
      test
        .info()
        .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
  }
});
