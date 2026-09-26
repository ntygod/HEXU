import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function post(page: Page, path: string, body: unknown) {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function createTask(
  page: Page,
  title: string,
  projectId = 'project-orders',
  description = '',
) {
  return post(page, 'spaces/space-demo/tasks', { title, projectId, description });
}
const drawer = (page: Page) => page.getByRole('dialog', { name: '任务参与者', exact: true });
async function open(page: Page) {
  await page.getByRole('button', { name: /^任务参与者（\d+）$/ }).click();
  await expect(drawer(page)).toBeVisible();
}

test('参与抽屉加入/退出和管理成员，刷新保留，历史与深浅色手机可用，原任务材料不变', async ({
  page,
}) => {
  const task = await createTask(page, '一起梳理订单退货流程');
  await page.goto(`/tasks/${task.id}`);
  await open(page);
  await page.getByRole('button', { name: '参与此任务', exact: true }).click();
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('林舟');
  await page.getByLabel('查找参与成员', { exact: true }).fill('陈');
  await page.getByRole('button', { name: '添加参与者 陈一', exact: true }).click();
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('陈一');
  await page.getByRole('button', { name: '参与变更记录', exact: true }).click();
  await expect(page.getByLabel('参与变更历史', { exact: true }).locator('article')).toHaveCount(2);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/48-task-participants-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '任务参与者（2）', exact: true })).toBeFocused();
  await page.reload();
  await open(page);
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('陈一');
  await page.getByRole('button', { name: '退出参与', exact: true }).click();
  await expect(page.getByLabel('当前参与者', { exact: true })).not.toContainText('林舟');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await open(page);
  await page.screenshot({ path: 'artifacts/49-task-participants-light.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.screenshot({ path: 'artifacts/50-task-participants-mobile.png', fullPage: true });
  expect(
    await drawer(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.getByRole('button', { name: '移除参与者 陈一', exact: true }).click();
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('还没有参与者');
  const detail = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(detail.task.revision).toBe(task.revision);
  expect(detail.task.ownerUserId).toBe(task.ownerUserId);
  expect(detail.task.participantUserIds).toEqual([]);
  expect(detail.runs).toHaveLength(0);
});

test('参与回执丢失复用原请求，陈旧参与修订拒绝覆盖并允许核对后重新操作', async ({ page }) => {
  const task = await createTask(page, '参与确认与并发修改');
  await page.goto(`/tasks/${task.id}`);
  await open(page);
  const url = `**/api/v1/tasks/${task.id}/participants`,
    keys: string[] = [];
  let drop = true;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    if (drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '添加参与者 陈一', exact: true }).click();
  await expect(drawer(page)).toContainText('上次操作的回执未确认');
  await expect(page.getByRole('button', { name: '参与此任务', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '确认上次参与操作', exact: true }).click();
  await expect(drawer(page)).not.toContainText('上次操作的回执未确认');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await page.unroute(url);
  let conflict = true;
  await page.route(url, async (route) => {
    if (route.request().method() === 'POST' && conflict) {
      conflict = false;
      await post(page, `tasks/${task.id}/participants`, {
        expectedRevision: 2,
        action: 'add',
        userId: 'user-demo-lin',
      });
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '添加参与者 周悦', exact: true }).click();
  await expect(drawer(page)).toContainText('参与关系或成员权限已变化');
  await expect(page.getByLabel('当前参与者', { exact: true })).not.toContainText('周悦');
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('林舟');
  await page.getByRole('button', { name: '添加参与者 周悦', exact: true }).click();
  await expect(page.getByLabel('当前参与者', { exact: true })).toContainText('周悦');
  const history = await (
    await page.request.get(`/api/v1/tasks/${task.id}/participants/history`)
  ).json();
  expect(history.items).toHaveLength(3);
  const privateTask = await post(page, 'spaces/space-demo/tasks', {
    title: '私有参与不可共享',
    projectId: null,
  });
  await page.goto(`/tasks/${privateTask.id}`);
  await expect(page.getByRole('heading', { name: privateTask.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^任务参与者/ })).toHaveCount(0);
});

test('负责人/参与者/搜索共用看板与列表，深链接刷新和后退保留组合，手机筛选可达', async ({
  page,
}) => {
  const project = await post(page, 'spaces/space-demo/projects', { name: '协作筛选项目' });
  const first = await createTask(page, '退款接口', project.id, '退款协作 alpha');
  const second = await createTask(page, '售后入口', project.id, '退款协作 beta');
  await createTask(page, '待安排工作', project.id);
  for (const task of [first, second])
    await post(page, `tasks/${task.id}/assignment`, {
      expectedRevision: 1,
      ownerUserId: 'user-demo-chen',
    });
  await post(page, `tasks/${first.id}/participants`, {
    expectedRevision: 1,
    action: 'add',
    userId: 'user-demo-zhou',
  });
  await page.goto(`/projects/${project.id}`);
  const board = page.locator('.project-board'),
    list = page.locator('.work-task-list');
  await page.getByLabel('负责人筛选', { exact: true }).selectOption('user-demo-chen');
  await expect(board.locator('.project-task-card')).toHaveCount(2);
  await page.getByLabel('参与者筛选', { exact: true }).selectOption('user-demo-zhou');
  await page.getByLabel('筛选项目任务', { exact: true }).fill('alpha');
  await expect(board.locator('.project-task-card')).toHaveCount(1);
  await expect(board).toContainText(first.title);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(list).toContainText(first.title);
  await expect(list).not.toContainText(second.title);
  await page.reload();
  await expect(page.getByLabel('负责人筛选', { exact: true })).toHaveValue('user-demo-chen');
  await expect(page.getByLabel('参与者筛选', { exact: true })).toHaveValue('user-demo-zhou');
  await expect(page.getByLabel('筛选项目任务', { exact: true })).toHaveValue('alpha');
  await expect(list).toContainText(first.title);
  await page.goBack();
  await expect(page.getByRole('button', { name: '看板', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(board.locator('.project-task-card')).toHaveCount(1);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/51-project-people-filters.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('负责人筛选', { exact: true })).toBeVisible();
  await expect(page.getByLabel('参与者筛选', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'artifacts/52-project-filters-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(board.locator('.project-task-card')).toHaveCount(3);
  expect(new URL(page.url()).search).toBe('');
});
