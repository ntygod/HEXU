import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

test('两种工具与执行目录来自明确配置，能力检测不代表账户联调', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Claude Code', exact: true })).toBeVisible();
  await expect(page.getByText('已检测配置', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Codex', exact: true })).toBeVisible();
  await expect(page.getByText('本机显式授权', { exact: true })).toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/06-native-resources.png', fullPage: true });
});
test('明确选择原生、确认费用，显示协议 fixture 的实际文件改动', async ({ page }) => {
  const created = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data: { title: '原生文件工具 · 协议替身测试' },
  });
  const task = await created.json();
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '使用本机原生工具', exact: true }).click();
  await page.getByLabel('本次能力', { exact: true }).selectOption('edit');
  await page.getByLabel('接下来做什么', { exact: true }).fill('FIXTURE_WRITE');
  await expect(page.getByRole('button', { name: '开始原生执行', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.screenshot({ path: 'artifacts/07-native-start.png', fullPage: true });
  await page.getByRole('button', { name: '开始原生执行', exact: true }).click();
  await expect(page.getByText('本次原生已结束', { exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('进行中');
  await page.getByRole('button', { name: '代码变更', exact: true }).click();
  await page.getByRole('button', { name: /native-output.txt/ }).click();
  await expect(page.locator('.native-diff')).toContainText('fixture edit');
  await page.screenshot({ path: 'artifacts/08-native-workspace.png', fullPage: true });
  await page.reload();
  await expect(page.getByText('本次原生已结束', { exact: true })).toBeVisible();
  await expect(
    page.locator('.message-content').filter({ hasText: /fixture response \[REDACTED\]/ }),
  ).toBeVisible();
});
test('原生开始面板在手机宽度保持可操作', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks/task-28');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '使用本机原生工具', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始原生执行', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('Claude 到 Codex：同任务继续、读取模型、保留未提交文件并可刷新', async ({ page }) => {
  const created = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data: { title: '跨工具继续 · 协议替身测试' },
  });
  const task = await created.json();
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '使用本机原生工具', exact: true }).click();
  await page.getByLabel('本次能力', { exact: true }).selectOption('edit');
  await page.getByLabel('接下来做什么', { exact: true }).fill('FIXTURE_WRITE');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '开始原生执行', exact: true }).click();
  await expect(page.getByText('本次原生已结束', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();

  await page.locator('.native-tool-choice button').filter({ hasText: 'Codex' }).click();
  await expect(page.getByLabel('工作目录', { exact: true })).toBeDisabled();
  await page.getByLabel('本次能力', { exact: true }).selectOption('edit');
  await page.getByLabel('接下来做什么', { exact: true }).fill('CODEX_WRITE');
  await page.getByRole('button', { name: '从 Codex 读取模型', exact: true }).click();
  await expect(page.locator('#native-codex-models option')).toHaveCount(1);
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  await page.getByRole('checkbox').check();
  // Changing tool invalidates consent rather than inheriting it to another provider.
  await page.locator('.native-tool-choice button').filter({ hasText: 'Claude Code' }).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.locator('.native-tool-choice button').filter({ hasText: 'Codex' }).click();
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  await page.getByRole('checkbox').check();
  await page.getByText('查看接续上下文与代码来源', { exact: true }).click();
  await expect(page.locator('.native-details pre')).toContainText('native-output.txt');
  await page.getByText('查看接续上下文与代码来源', { exact: true }).click();
  await page.locator('.drawer-form .dialog-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: 'artifacts/09-codex-continuation.png', fullPage: true });
  await page.getByRole('button', { name: '用 Codex 继续', exact: true }).click();
  await expect(
    page.locator('.message-content').filter({ hasText: /Codex fixture result \[REDACTED\]/ }),
  ).toBeVisible();
  await expect(page.getByText('本次原生已结束', { exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('进行中');
  await page.getByRole('button', { name: '代码变更', exact: true }).click();
  await page.getByRole('button', { name: /codex-output.txt/ }).click();
  await expect(page.locator('.native-diff')).toContainText('fixture continued');
  await expect(page.locator('.native-diff')).toContainText('fixture edit');
  await page.screenshot({ path: 'artifacts/10-cross-tool-workspace.png', fullPage: true });
  await page.reload();
  await expect(
    page.locator('.message-content').filter({ hasText: /Codex fixture result \[REDACTED\]/ }),
  ).toBeVisible();
  const runs = (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).runs;
  expect(runs).toHaveLength(2);
  expect(runs[1].requestedTool).toBe('codex');
  expect(runs[1].previousRunId).toBe(runs[0].id);
});
