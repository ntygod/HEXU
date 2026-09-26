import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('工作台真实打开，并保留桌面截图', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(page.getByText('本地开发预览 · 执行模式明确标识')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: '收起项目导航', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开项目导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '项目导引栏' })).toBeVisible();
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
test('命令搜索、主题和密度偏好在刷新后保留', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '全局搜索' })).toBeFocused();
  await page.getByRole('textbox', { name: '全局搜索' }).fill('浏览器中创建');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /浏览器中创建的真实任务/ })
    .click();
  await expect(
    page.getByRole('heading', { name: '浏览器中创建的真实任务', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '切换浅色模式' }).click();
  await page.getByRole('button', { name: '切换舒适密度' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'artifacts/04-dark-workspace.png', fullPage: true });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '开始一项工作' })).toBeVisible();
  await page.getByLabel('要做什么').fill('通过命令面板创建的任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '通过命令面板创建的任务', exact: true }),
  ).toBeVisible();
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
    await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '项目导引栏' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '展开项目导航', exact: true })).toBeFocused();
    if (path === '/tasks/task-24') {
      await page.getByRole('button', { name: '代码与成果', exact: true }).click();
      await expect(page.getByRole('button', { name: '代码变更', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '讨论', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '任务评论', exact: true })).toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.screenshot({ path: 'artifacts/05-mobile.png', fullPage: true });
});
test('任务草稿随路由保留，阅读历史不被新记录打断', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('要做什么').fill('W1 草稿与阅读位置检查');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'W1 草稿与阅读位置检查', exact: true }),
  ).toBeVisible();
  const taskId = new URL(page.url()).pathname.split('/').at(-1)!;
  const composer = page.getByRole('textbox', { name: '任务评论', exact: true });
  await composer.fill('尚未发送的讨论，只属于这个任务');
  await page.getByRole('button', { name: '上下文', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务上下文', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '上下文', exact: true })).toBeFocused();
  await page.locator('.navigation-rail').getByRole('link', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await page.getByRole('textbox', { name: '全局搜索' }).fill('W1 草稿与阅读位置检查');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /W1 草稿与阅读位置检查/ })
    .click();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.route(`**/tasks/${taskId}/messages`, (route) => route.abort('failed'));
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.locator('.toast.error')).toBeVisible();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.unroute(`**/tasks/${taskId}/messages`);
  const addMessage = async (body: string) => {
    const response = await page.request.post(`/api/v1/tasks/${taskId}/messages`, {
      headers: { 'X-Hexu-Client': 'web', 'Idempotency-Key': crypto.randomUUID() },
      data: { body, resultId: null },
    });
    expect(response.status()).toBe(201);
  };
  for (let i = 0; i < 10; i++)
    await addMessage(`历史记录 ${i}\n` + '这是一段用于阅读位置检查的虚构讨论。\n'.repeat(10));
  await expect(page.locator('.message')).toHaveCount(10);
  const history = page.getByLabel('任务讨论记录', { exact: true });
  await history.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await addMessage('来自其他参与者的新记录');
  await expect(
    page.getByRole('button', { name: '有新记录 · 回到最新', exact: true }),
  ).toBeVisible();
  expect(await history.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  await page.getByRole('button', { name: '有新记录 · 回到最新', exact: true }).click();
  await expect(page.getByText('来自其他参与者的新记录', { exact: true })).toBeInViewport();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.getByRole('button', { name: '收起成果面板', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开成果面板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开成果面板', exact: true }).click();
});

test('评论按文本呈现，不执行 HTML', async ({ page }) => {
  await page.goto('/tasks/task-24');
  const payload = '<img src=x onerror="window.__hexuXss=1">';
  await page.getByRole('textbox', { name: '任务评论', exact: true }).fill(payload);
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => '__hexuXss' in window)).toBe(false);
});
