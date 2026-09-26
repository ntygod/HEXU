import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function setup(page: Page, name: string) {
  const res = await page.request.post('/api/v1/spaces/space-demo/projects', {
    headers: headers(),
    data: { name, description: '归档保留历史，恢复不自动执行。' },
  });
  expect(res.ok()).toBe(true);
  const project = await res.json();
  const taskRes = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title: name + ' · 工作任务', projectId: project.id },
  });
  expect(taskRes.ok()).toBe(true);
  const task = await taskRes.json();
  await page.goto(`/projects/${project.id}`);
  return { project, task };
}
async function options(page: Page) {
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByRole('button', { name: '查看归档影响', exact: true }).click();
  await expect(page.getByRole('region', { name: '项目归档与恢复' })).toContainText('当前可见：');
}
const dialog = (page: Page) => page.getByRole('dialog', { name: '项目设置', exact: true });

test('归档保留历史和活动模拟，归档筛选与任务禁用准确，恢复项目不自动重跑', async ({ page }) => {
  const f = await setup(page, '归档体验 · 客户门户');
  const runRes = await page.request.post(`/api/v1/tasks/${f.task.id}/runs`, {
    headers: headers(),
    data: {
      provider: 'mock',
      requestedTool: 'claude-code',
      scenario: 'waiting_input',
      expectedRevision: 1,
      prompt: '',
    },
  });
  expect(runRes.ok(), await runRes.text()).toBe(true);
  const run = await runRes.json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/runs/${run.id}`)).json()).state)
    .toBe('waiting_input');
  await options(page);
  await expect(page.getByRole('button', { name: '确认归档项目', exact: true })).toBeDisabled();
  await page.getByLabel('已启动执行的处理', { exact: true }).selectOption('keep');
  await mkdir('artifacts', { recursive: true });
  await page.getByRole('button', { name: '确认归档项目', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/39-project-archive-options-dark.png', fullPage: true });
  await page.getByRole('button', { name: '确认归档项目', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.project-archive-banner')).toContainText('项目已归档');
  expect((await (await page.request.get(`/api/v1/runs/${run.id}`)).json()).state).toBe(
    'waiting_input',
  );
  await page.goto('/projects');
  await expect(
    page.locator('.work-project-grid').getByRole('heading', { name: f.project.name, exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await page
    .locator('.work-project-grid')
    .getByRole('heading', { name: f.project.name, exact: true })
    .click();
  await expect(page.locator('.project-archive-banner')).toBeVisible();
  await page.goto(`/tasks/${f.task.id}`);
  await expect(page.getByRole('button', { name: '工具与模型', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '停止模拟', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'artifacts/40-project-archived-task.png', fullPage: true });
  await page.goto(`/projects/${f.project.id}`);
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByRole('button', { name: '查看修订记录', exact: true }).click();
  await expect(page.getByLabel('项目修订记录').locator('details')).toHaveCount(2);
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.project-archive-banner')).toHaveCount(0);
  const details = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(details.runs).toHaveLength(1);
  expect(details.runs[0].state).toBe('waiting_input');
  await page.request.post(`/api/v1/runs/${run.id}/stop`, { headers: headers(), data: {} });
});

test('归档冲突保留草稿；丢失回执可复用原请求，浅色和手机界面不溢出', async ({ page }) => {
  const f = await setup(page, '归档冲突与回执');
  await options(page);
  await page.getByLabel('已启动执行的处理', { exact: true }).selectOption('stop');
  await page.getByLabel('项目名称', { exact: true }).fill('未保存草稿');
  await expect(page.getByRole('button', { name: '确认归档项目', exact: true })).toBeDisabled();
  const changed = await page.request.patch(`/api/v1/projects/${f.project.id}`, {
    headers: headers(),
    data: { expectedRevision: 1, name: '其他管理者的新名称' },
  });
  expect(changed.ok()).toBe(true);
  await expect(page.getByRole('region', { name: '项目版本冲突' })).toContainText(
    '其他管理者的新名称',
  );
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('未保存草稿');
  await page.getByRole('button', { name: '放弃草稿，载入最新内容', exact: true }).click();
  let firstKey = '';
  const routePattern = `**/api/v1/projects/${f.project.id}/lifecycle`;
  await page.route(
    routePattern,
    async (route) => {
      firstKey = route.request().headers()['idempotency-key']!;
      const saved = await route.fetch();
      expect(saved.ok()).toBe(true);
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: '确认归档项目', exact: true }).click();
  await expect(
    page.getByText('请求可能已经保存。再次确认使用原请求', { exact: false }),
  ).toBeVisible();
  const replay = page.waitForRequest(
    (req) => req.url().endsWith(`/projects/${f.project.id}/lifecycle`) && req.method() === 'POST',
  );
  await page.getByRole('button', { name: '再次确认项目状态', exact: true }).click();
  expect((await replay).headers()['idempotency-key']).toBe(firstKey);
  await expect(dialog(page)).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/projects/${f.project.id}`)).json()).revision).toBe(
    3,
  );
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByRole('button', { name: '恢复项目', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/41-project-restore-light.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByRole('button', { name: '恢复项目', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/42-project-restore-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('其他页面归档后关闭已打开的执行面板，但保留任务讨论草稿', async ({ page }) => {
  const f = await setup(page, '跨页面归档');
  await page.goto(`/tasks/${f.task.id}`);
  await page.getByRole('textbox', { name: '任务评论', exact: true }).fill('归档后仍要讨论的内容');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const archived = await page.request.post(`/api/v1/projects/${f.project.id}/lifecycle`, {
    headers: headers(),
    data: { action: 'archive', expectedRevision: 1, activeRunAction: 'keep' },
  });
  expect(archived.ok()).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '任务评论', exact: true })).toHaveValue(
    '归档后仍要讨论的内容',
  );
});
