import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

async function createProject(page: Page, name: string) {
  const response = await page.request.post('/api/v1/spaces/space-demo/projects', {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data: { name, description: '原项目说明' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return project;
}
const settings = (page: Page) => page.getByRole('dialog', { name: '项目设置', exact: true });
async function openSettings(page: Page) {
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

test('项目名称说明编辑、刷新持久化、历史查看与键盘退出，浅深色窄屏可操作', async ({ page }) => {
  const project = await createProject(page, '设置测试 · 客户门户');
  await openSettings(page);
  await expect(page.getByLabel('项目名称', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '保存项目设置', exact: true })).toBeDisabled();
  await page.getByLabel('项目名称', { exact: true }).fill('客户门户 · 持续交付');
  const description =
    '统一客户工作入口，保留订单与协作记录。\n<img src=x onerror="window.hexuProjectInjected=true">';
  await page.getByLabel('项目说明', { exact: false }).fill(description);
  await page.getByRole('button', { name: '保存项目设置', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '客户门户 · 持续交付', exact: true }),
  ).toBeVisible();
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel('项目说明', { exact: false })).toHaveValue(description);
  await page.getByRole('button', { name: '查看修订记录', exact: true }).click();
  await expect(page.getByLabel('项目修订记录', { exact: true }).locator('details')).toHaveCount(2);
  await page.getByText('修订 1 · 设置测试 · 客户门户', { exact: true }).click();
  await expect(page.getByLabel('项目修订记录', { exact: true })).toContainText('原项目说明');
  expect(await page.evaluate(() => Reflect.get(window, 'hexuProjectInjected'))).toBeUndefined();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/35-project-settings-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '项目设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await openSettings(page);
  await page.screenshot({ path: 'artifacts/36-project-settings-light.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await page.getByLabel('项目说明', { exact: false }).fill('');
  await page.screenshot({ path: 'artifacts/37-project-settings-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await settings(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.getByRole('button', { name: '保存项目设置', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
  const stored = await (await page.request.get(`/api/v1/projects/${project.id}`)).json();
  expect(stored.description).toBe('');
  expect(stored.revision).toBe(3);
});

test('两页并发编辑保留草稿，SSE 不静默更新基线；明确比较后才保存', async ({ page, context }) => {
  const project = await createProject(page, '并发基线');
  const other = await context.newPage();
  try {
    await other.goto(`/projects/${project.id}`);
    await openSettings(page);
    await openSettings(other);
    await page.getByLabel('项目名称', { exact: true }).fill('我的未保存草稿');
    await other.getByLabel('项目名称', { exact: true }).fill('同事先保存的名称');
    await other.getByLabel('项目说明', { exact: false }).fill('同事先保存的说明');
    await other.getByRole('button', { name: '保存项目设置', exact: true }).click();
    const conflict = page.getByRole('region', { name: '项目版本冲突' });
    await expect(conflict).toContainText('同事先保存的名称');
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('我的未保存草稿');
    await expect(page.getByRole('button', { name: '保存项目设置', exact: true })).toBeDisabled();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/38-project-settings-conflict.png', fullPage: true });
    await page.getByRole('button', { name: '保留草稿，基于最新版本编辑', exact: true }).click();
    expect((await (await page.request.get(`/api/v1/projects/${project.id}`)).json()).revision).toBe(
      2,
    );
    await page.getByLabel('项目说明', { exact: false }).fill('结合双方意见的新说明');
    await page.getByRole('button', { name: '保存项目设置', exact: true }).click();
    await expect(other.getByRole('heading', { name: '我的未保存草稿', exact: true })).toBeVisible();
    await openSettings(page);
    await page.getByLabel('项目名称', { exact: true }).fill('随后放弃的草稿');
    const update = await other.request.patch(`/api/v1/projects/${project.id}`, {
      headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
      data: { expectedRevision: 3, name: '又一个已保存版本' },
    });
    expect(update.ok()).toBe(true);
    await expect(conflict).toBeVisible();
    await page.getByRole('button', { name: '放弃草稿，载入最新内容', exact: true }).click();
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('又一个已保存版本');
    await expect(page.getByRole('button', { name: '保存项目设置', exact: true })).toBeDisabled();
  } finally {
    await other.close();
  }
});

test('保存回执丢失后复用原请求确认结果，不重复修订；历史接口失败可重试', async ({ page }) => {
  const project = await createProject(page, '回执基线');
  await openSettings(page);
  await page.getByLabel('项目名称', { exact: true }).fill('已保存但丢失回执');
  const keys: string[] = [];
  await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存项目设置', exact: true }).click();
  await expect(page.getByRole('region', { name: '保存结果待确认' })).toBeVisible();
  await expect(page.getByLabel('项目名称', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '再次确认保存结果', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const revision = await (
    await page.request.get(`/api/v1/projects/${project.id}/revisions`)
  ).json();
  expect(revision.items.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);
  await openSettings(page);
  await page.route(
    `**/api/v1/projects/${project.id}/revisions`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FIXTURE', message: '测试读取暂不可用' } }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: '查看修订记录', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText('测试读取暂不可用');
  await page.getByRole('button', { name: '重试读取修订', exact: true }).click();
  await expect(page.getByLabel('项目修订记录', { exact: true }).locator('details')).toHaveCount(2);
});
