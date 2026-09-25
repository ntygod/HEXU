import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('工作台真实打开，并保留桌面截图', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(page.getByText('本地开发预览 · 执行模式明确标识')).toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/01-workbench.png', fullPage: true });
});
test('项目看板和列表使用同一份持久化状态', async ({ page }) => {
  await page.goto('/projects/project-orders');
  await expect(page.getByRole('heading', { name: '订单管理改进', exact: true })).toBeVisible();
  await page.getByLabel('HX-032 状态').selectOption('in_progress');
  await expect(page.getByLabel('HX-032 状态')).toHaveValue('in_progress');
  await page.reload();
  await expect(page.getByLabel('HX-032 状态')).toHaveValue('in_progress');
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('.task-list').getByText('增加导出文件命名规则')).toBeVisible();
});
test('轻量新建、评论与刷新后恢复', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('要做什么').fill('浏览器中创建的真实任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '浏览器中创建的真实任务', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '任务评论', exact: true })
    .fill('这条评论应当在刷新后仍然存在。');
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.getByText('这条评论应当在刷新后仍然存在。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('这条评论应当在刷新后仍然存在。', { exact: true })).toBeVisible();
});
test('模拟等待回复，响应后结束但不完成任务', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('演示场景').selectOption('waiting_input');
  await page.getByRole('button', { name: '开始模拟', exact: true }).click();
  await expect(page.getByText('模拟执行等待你的回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '回复模拟执行', exact: true }).fill('先处理交互');
  await page.getByRole('button', { name: '发送执行回复', exact: true }).click();
  await expect(page.getByText('本次模拟已结束', { exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('进行中');
  await page.screenshot({ path: 'artifacts/02-task-workspace.png', fullPage: true });
});
test('模拟停止会等待真实适配器确认', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '开始模拟', exact: true }).click();
  await page.getByRole('button', { name: '停止模拟', exact: true }).click();
  await expect(page.getByText('模拟执行已停止', { exact: true })).toBeVisible();
});
test('文字成果、反馈与标记完成，不需要验收表', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '分享成果', exact: true }).click();
  await page.getByLabel('成果标题').fill('已保存的导出方案');
  await page.getByLabel('这次做了什么').fill('这里是团队自己的成果说明，不是模拟模型输出。');
  await page.getByRole('dialog').getByRole('button', { name: '分享成果', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已保存的导出方案 · 当前成果' })).toBeVisible();
  await page.getByRole('textbox', { name: '成果反馈', exact: true }).fill('继续补充文件命名说明');
  await page.getByRole('button', { name: '发送反馈', exact: true }).click();
  await expect(page.getByText('继续补充文件命名说明', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(page.locator('.result-eyebrow .badge')).toHaveText('已完成');
  await page.reload();
  await expect(page.getByText('继续补充文件命名说明', { exact: true })).toBeVisible();
});
test('示例预览筛选与 CSV 导出可操作', async ({ page }) => {
  await page.goto('/results/result-orders');
  await page.getByRole('combobox', { name: '订单状态', exact: true }).selectOption('pending');
  await expect(page.getByText('共 2 条演示订单', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('orders-2026-09-demo.csv');
  await page.screenshot({ path: 'artifacts/03-results.png', fullPage: true });
});
test('搜索与深色模式正常工作', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '搜索任务、项目… ⌘ K' }).click();
  await page.getByRole('textbox', { name: '全局搜索' }).fill('浏览器中创建');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /浏览器中创建的真实任务/ })
    .click();
  await expect(
    page.getByRole('heading', { name: '浏览器中创建的真实任务', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'artifacts/04-dark-workspace.png', fullPage: true });
});
test('窄屏没有整个页面的横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    '/',
    '/projects/project-orders',
    '/tasks/task-24',
    '/results/result-orders',
  ]) {
    await page.goto(path);
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.screenshot({ path: 'artifacts/05-mobile.png', fullPage: true });
});
test('评论按文本呈现，不执行 HTML', async ({ page }) => {
  await page.goto('/tasks/task-24');
  const payload = '<img src=x onerror="window.__hexuXss=1">';
  await page.getByRole('textbox', { name: '任务评论', exact: true }).fill(payload);
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => '__hexuXss' in window)).toBe(false);
});
