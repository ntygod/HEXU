import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(page: Page) {
  const project = await post(page, 'spaces/space-demo/projects', {
    name: '约定协作 ' + randomUUID().slice(0, 5),
  });
  const task = await post(page, 'spaces/space-demo/tasks', {
    title: '对齐订单金额处理',
    projectId: project.id,
  });
  const message = await post(page, `tasks/${task.id}/messages`, {
    body: '金额在接口中使用分，避免浮点误差。',
  });
  return { project, task, message };
}
async function publish(page: Page, f: Awaited<ReturnType<typeof fixture>>, title = '金额处理规则') {
  const preview = await (
    await page.request.get(`/api/v1/tasks/${f.task.id}/messages/${f.message.id}/agreement-preview`)
  ).json();
  return post(page, `projects/${f.project.id}/agreements`, {
    title,
    content: '金额使用整数分',
    sourceTaskId: f.task.id,
    sourceMessageId: f.message.id,
    expectedSourceHash: preview.origin.hash,
  });
}
const url = (projectId: string, id: string) =>
  `/projects/${projectId}?tab=agreements&agreement=${id}`;
const detail = (page: Page) => page.getByRole('dialog', { name: '项目约定', exact: true });

test('从讨论明确保存项目约定，任务内查看、深链接、浅深色手机和讨论草稿保留', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/tasks/${f.task.id}`);
  await page.getByLabel('任务评论', { exact: true }).fill('原任务未发送的讨论草稿');
  await page.getByRole('button', { name: '设为项目约定', exact: true }).click();
  await expect(page.getByLabel('约定正文', { exact: true })).toHaveValue(f.message.body);
  await page.getByLabel('约定标题', { exact: true }).fill('订单金额必须用分');
  await page.getByLabel('约定正文', { exact: true }).fill('  接口使用整数分\n展示层再格式化\n');
  await page.getByRole('button', { name: '保存项目约定', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设为项目约定', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^项目约定（1）/ }).click();
  await page.getByRole('button', { name: '查看约定 订单金额必须用分', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: '任务中的项目约定', exact: true });
  await expect(
    taskDialog.getByRole('heading', { name: '订单金额必须用分', exact: true }),
  ).toBeVisible();
  expect(await taskDialog.locator('.agreement-text').textContent()).toBe(
    '  接口使用整数分\n展示层再格式化\n',
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/57-task-agreement-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('原任务未发送的讨论草稿');
  const list = await (await page.request.get(`/api/v1/projects/${f.project.id}/agreements`)).json(),
    id = list.items[0].id;
  await page.goto(url(f.project.id, id));
  await page.reload();
  await expect(
    detail(page).getByRole('heading', { name: '订单金额必须用分', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '约定修订记录', exact: true }).click();
  await expect(page.getByLabel('约定历史版本', { exact: true }).locator('details')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByRole('button', { name: '查看约定 订单金额必须用分', exact: true }).click();
  await page.screenshot({ path: 'artifacts/58-project-agreement-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/59-project-agreement-mobile.png', fullPage: true });
  expect(
    await detail(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const task = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(task.task.revision).toBe(f.task.revision);
  expect(task.runs).toHaveLength(0);
  expect(task.messages).toHaveLength(1);
});

test('明确替代保留旧约定，选择不生效，停用与启用不复活旧规则', async ({ page }) => {
  const f = await fixture(page),
    old = await publish(page, f, '旧金额约定');
  const message = await post(page, `tasks/${f.task.id}/messages`, {
    body: '新的讨论：统一使用精确定点金额',
  });
  await page.goto(`/tasks/${f.task.id}`);
  await page
    .locator('.message')
    .filter({ hasText: message.body })
    .getByRole('button', { name: '设为项目约定', exact: true })
    .click();
  await page.getByLabel('约定标题', { exact: true }).fill('新金额约定');
  await page.getByLabel('约定正文', { exact: true }).fill('以新版精确定点格式为准');
  await page.getByLabel('替代已有约定', { exact: true }).check();
  await page.getByLabel('被替代约定', { exact: true }).selectOption(old.id);
  await expect(page.locator('.agreement-compare')).toContainText(old.content);
  expect(
    (await (await page.request.get(`/api/v1/projects/${f.project.id}/agreements/${old.id}`)).json())
      .state,
  ).toBe('active');
  await page.getByRole('button', { name: '保存项目约定', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设为项目约定', exact: true })).toHaveCount(0);
  const record = await (
    await page.request.get(`/api/v1/projects/${f.project.id}/agreements/${old.id}`)
  ).json();
  expect(record.state).toBe('superseded');
  expect(record.supersededById).toBeTruthy();
  await page.goto(url(f.project.id, old.id));
  await expect(detail(page)).toContainText('已由新的项目约定替代');
  await expect(page.getByRole('button', { name: '重新启用约定', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看后续约定', exact: true }).click();
  await expect(
    detail(page).getByRole('heading', { name: '新金额约定', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '停用约定', exact: true }).click();
  await page.getByLabel('停用原因', { exact: true }).fill('接口已废弃');
  await page.getByRole('button', { name: '确认停用约定', exact: true }).click();
  await expect(detail(page)).toContainText('接口已废弃');
  await page.getByRole('button', { name: '重新启用约定', exact: true }).click();
  await page.getByRole('button', { name: '确认启用约定', exact: true }).click();
  await expect(page.getByRole('button', { name: '停用约定', exact: true })).toBeVisible();
  const current = await (
    await page.request.get(`/api/v1/projects/${f.project.id}/agreements/${record.supersededById}`)
  ).json();
  expect(current.state).toBe('active');
  expect(current.origin.messageId).toBe(message.id);
  expect(current.replacesId).toBe(old.id);
  expect(
    (await (await page.request.get(`/api/v1/projects/${f.project.id}/agreements/${old.id}`)).json())
      .state,
  ).toBe('superseded');
});

test('两页约定编辑冲突保留草稿，任务提示真实变化，读取错误不丢编辑内容', async ({
  page,
  context,
}) => {
  const f = await fixture(page),
    agreement = await publish(page, f),
    other = await context.newPage(),
    task = await context.newPage();
  try {
    await page.goto(url(f.project.id, agreement.id));
    await other.goto(url(f.project.id, agreement.id));
    await task.goto(`/tasks/${f.task.id}`);
    await expect(task.getByRole('button', { name: '项目约定（1）', exact: true })).toBeVisible();
    for (const current of [page, other])
      await current.getByRole('button', { name: '编辑约定', exact: true }).click();
    await page.getByLabel('约定正文', { exact: true }).fill('本页保留的规则草稿');
    await other.getByLabel('约定正文', { exact: true }).fill('另一页保存的新规则');
    await other.getByRole('button', { name: '保存约定修改', exact: true }).click();
    await expect(page.getByLabel('约定版本冲突', { exact: true })).toContainText(
      '另一页保存的新规则',
    );
    await expect(page.getByLabel('约定正文', { exact: true })).toHaveValue('本页保留的规则草稿');
    await expect(page.getByRole('button', { name: '保存约定修改', exact: true })).toBeDisabled();
    await expect(
      task.getByRole('button', { name: '项目约定（1），有更新', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '保留草稿，基于最新约定', exact: true }).click();
    await page.getByRole('button', { name: '保存约定修改', exact: true }).click();
    await expect(other.locator('.agreement-text')).toHaveText('本页保留的规则草稿');
    await page.getByRole('button', { name: '编辑约定', exact: true }).click();
    await page.getByLabel('约定正文', { exact: true }).fill('临时读取失败时保留');
    let unavailable = true;
    const path = `/api/v1/projects/${f.project.id}/agreements/${agreement.id}`;
    await page.route('**' + path, (route) =>
      unavailable && route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'FIXTURE', message: '测试中的约定读取失败' } }),
          })
        : route.continue(),
    );
    await post(page, `tasks/${f.task.id}/messages`, { body: '触发一次普通讨论刷新' });
    await expect(detail(page)).toContainText('测试中的约定读取失败');
    await expect(page.getByLabel('约定正文', { exact: true })).toHaveValue('临时读取失败时保留');
    unavailable = false;
    await page.getByRole('button', { name: '重读项目约定', exact: true }).click();
    await expect(detail(page)).not.toContainText('测试中的约定读取失败');
    await page.getByRole('button', { name: '取消编辑约定', exact: true }).click();
    await task.getByRole('button', { name: /^项目约定（1）/ }).click();
    await task.getByRole('button', { name: `查看约定 ${agreement.title}`, exact: true }).click();
    await expect(task.locator('.agreement-text')).toHaveText('本页保留的规则草稿');
  } finally {
    await other.close();
    await task.close();
  }
});

test('发布回执丢失只确认原请求，私有讨论没有共享约定入口', async ({ page }) => {
  const f = await fixture(page),
    base = `/api/v1/projects/${f.project.id}/agreements`,
    keys: string[] = [];
  let drop = true;
  await page.route('**' + base, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    if (drop) {
      drop = false;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(`/tasks/${f.task.id}`);
  await page.getByRole('button', { name: '设为项目约定', exact: true }).click();
  await page.getByLabel('约定标题', { exact: true }).fill('回执需要确认的约定');
  await page.getByRole('button', { name: '保存项目约定', exact: true }).click();
  await expect(page.getByLabel('约定操作待确认', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存项目约定', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '确认上次约定操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设为项目约定', exact: true })).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]);
  const rows = await (await page.request.get(base)).json();
  expect(rows.items).toHaveLength(1);
  expect(
    (await (await page.request.get(base + '/' + rows.items[0].id + '/revisions')).json()).items,
  ).toHaveLength(1);
  const privateTask = await post(page, 'spaces/space-demo/tasks', {
    title: '个人私有讨论',
    projectId: null,
  });
  await post(page, `tasks/${privateTask.id}/messages`, { body: '不应直接公开的内容' });
  await page.goto(`/tasks/${privateTask.id}`);
  await expect(page.getByRole('heading', { name: privateTask.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '设为项目约定', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^项目约定（/ })).toHaveCount(0);
});
