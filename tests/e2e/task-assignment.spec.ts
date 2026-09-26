import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function createTask(page: Page, title: string) {
  const response = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title, projectId: 'project-orders' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const task = await response.json();
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return task;
}
const drawer = (page: Page) => page.getByRole('dialog', { name: '更改任务负责人', exact: true });
async function open(page: Page) {
  await page.getByRole('button', { name: '更改负责人', exact: true }).click();
  await expect(drawer(page)).toBeVisible();
}
const save = (page: Page) => page.getByRole('button', { name: '保存负责人', exact: true });
const owner = (page: Page) => page.getByLabel('任务负责人', { exact: true });

test('任务改派在原工作区保存与刷新，创建者不变，历史/浅深色/手机和键盘可操作', async ({ page }) => {
  const task = await createTask(page, '将订单筛选交给陈一负责');
  await open(page);
  await expect(drawer(page)).toContainText('创建者：林舟');
  await expect(page.getByLabel('新的负责人', { exact: true })).toBeFocused();
  await expect(save(page)).toBeDisabled();
  await expect(drawer(page)).toContainText('候选人是示例成员');
  await page.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-chen');
  await save(page).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(owner(page)).toContainText('陈一');
  await page.reload();
  await expect(owner(page)).toContainText('陈一');
  const stored = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(stored.task.createdByUserId).toBe('user-demo-lin');
  expect(stored.task.ownerUserId).toBe('user-demo-chen');
  expect(stored.runs).toHaveLength(0);
  await open(page);
  await page.getByRole('button', { name: '改派记录', exact: true }).click();
  await expect(page.getByLabel('负责人变更历史', { exact: true })).toContainText('林舟 → 陈一');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/44-task-assignment-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '更改负责人', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await open(page);
  await page.screenshot({ path: 'artifacts/45-task-assignment-light.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-zhou');
  await page.screenshot({ path: 'artifacts/46-task-assignment-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(await drawer(page).evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await save(page).click();
  await expect(owner(page)).toContainText('周悦');
});

test('两页改派冲突不自动覆盖选择，明确核对后保存，原任务讨论草稿保留', async ({
  page,
  context,
}) => {
  const task = await createTask(page, '两人同时安排负责人'),
    other = await context.newPage();
  try {
    await page.getByLabel('任务评论', { exact: true }).fill('未发送的讨论仍然保留');
    await other.goto(`/tasks/${task.id}`);
    await open(page);
    await open(other);
    await page.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-chen');
    await other.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-zhou');
    await save(other).click();
    await expect(drawer(other)).toHaveCount(0);
    await expect(page.getByRole('region', { name: '改派冲突' })).toContainText('周悦');
    await expect(page.getByLabel('新的负责人', { exact: true })).toHaveValue('user-demo-chen');
    await expect(save(page)).toBeDisabled();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/47-task-assignment-conflict.png', fullPage: true });
    await page.getByRole('button', { name: '保留选择，基于最新修订', exact: true }).click();
    await expect(drawer(page)).toBeVisible();
    await expect(owner(other)).toContainText('周悦');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(owner(other)).toContainText('陈一');
    await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('未发送的讨论仍然保留');
    const history = await (
      await page.request.get(`/api/v1/tasks/${task.id}/assignment-history`)
    ).json();
    expect(history.items.map((item: { toUserId: string }) => item.toUserId)).toEqual([
      'user-demo-chen',
      'user-demo-zhou',
    ]);
  } finally {
    await other.close();
  }
});

test('改派回执丢失时复用原请求确认，不重复历史；历史读取失败可重试，私有任务没有改派入口', async ({
  page,
}) => {
  const task = await createTask(page, '确认保存回执而不是再次改派');
  const keys: (string | undefined)[] = [];
  let drop = true;
  await page.route(`**/api/v1/tasks/${task.id}/assignment`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await open(page);
  await page.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-chen');
  await save(page).click();
  await expect(drawer(page)).toContainText('保存回执未确认');
  await expect(save(page)).toBeDisabled();
  await page.getByRole('button', { name: '确认上次改派结果', exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]);
  const historyURL = `**/api/v1/tasks/${task.id}/assignment-history*`;
  await page.route(
    historyURL,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: '测试中的历史读取失败' } }),
      }),
    { times: 1 },
  );
  await open(page);
  await page.getByLabel('新的负责人', { exact: true }).selectOption('user-demo-zhou');
  await page.getByRole('button', { name: '改派记录', exact: true }).click();
  await expect(drawer(page)).toContainText('测试中的历史读取失败');
  await page.getByRole('button', { name: '重试改派记录', exact: true }).click();
  await expect(page.getByLabel('负责人变更历史', { exact: true }).locator('article')).toHaveCount(
    1,
  );
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByLabel('新的负责人', { exact: true })).toHaveValue('user-demo-zhou');
  await page.keyboard.press('Escape');
  await expect(owner(page)).toContainText('陈一');
  const response = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title: '我的私有任务', projectId: null },
  });
  const privateTask = await response.json();
  await page.goto(`/tasks/${privateTask.id}`);
  await expect(page.getByRole('heading', { name: '我的私有任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '更改负责人', exact: true })).toHaveCount(0);
});
