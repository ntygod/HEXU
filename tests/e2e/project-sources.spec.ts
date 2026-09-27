import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const drawer = (page: Page) => page.getByRole('dialog', { name: '项目资料', exact: true });
async function project(page: Page) {
  const response = await page.request.post('/api/v1/spaces/space-demo/projects', {
    headers: headers(),
    data: { name: '项目资料验收 ' + randomUUID().slice(0, 5) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function source(page: Page, projectId: string, title: string, content = '原项目参考内容') {
  const response = await page.request.post(`/api/v1/projects/${projectId}/sources`, {
    headers: headers(),
    data: { kind: 'text', title, content },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const sourceURL = (projectId: string, id: string) =>
  `/projects/${projectId}?tab=sources&source=${id}`;

test('文本资料创建、修订、删除恢复和深链接刷新，安全原文与深浅色/手机布局', async ({ page }) => {
  const p = await project(page);
  await page.goto(`/projects/${p.id}`);
  await page.getByRole('button', { name: '项目资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有项目资料', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建资料', exact: true }).click();
  await page.getByLabel('资料标题', { exact: true }).fill('订单接口字段说明');
  const original =
    '  保留缩进与换行\n<img src=x onerror="window.sourceExecuted=true">\n订单编号：order_id\n';
  await page.getByLabel('资料正文', { exact: true }).fill(original);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(
    drawer(page).getByRole('heading', { name: '订单接口字段说明', exact: true }),
  ).toBeVisible();
  expect(await drawer(page).locator('.source-content').textContent()).toBe(original);
  expect(await page.evaluate(() => Object.hasOwn(window, 'sourceExecuted'))).toBe(false);
  await expect(drawer(page).locator('.source-reading img')).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get('source')!;
  expect(id).toBeTruthy();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/53-project-source-dark.png', fullPage: true });
  await page.reload();
  await expect(drawer(page).locator('.source-content')).toContainText('order_id');
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByLabel('资料正文', { exact: true }).fill('字段说明第二版：订单号不可为空');
  await page.getByRole('button', { name: '保存资料修改', exact: true }).click();
  await expect(drawer(page).locator('.source-content')).toHaveText(
    '字段说明第二版：订单号不可为空',
  );
  await page.getByRole('button', { name: '资料修订记录', exact: true }).click();
  const history = page.getByLabel('资料历史版本', { exact: true });
  await expect(history.locator('details')).toHaveCount(2);
  await history.getByText('修订 1 · 创建 · 订单接口字段说明', { exact: true }).click();
  await expect(history.locator('.source-content').last()).toContainText('order_id');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByRole('button', { name: '查看资料 订单接口字段说明', exact: true }).click();
  await page.screenshot({ path: 'artifacts/54-project-source-light.png', fullPage: true });
  await page.getByRole('button', { name: '删除资料', exact: true }).click();
  await expect(page.getByLabel('资料删除或恢复', { exact: true })).toContainText(
    '已有任务、运行与冻结材料保持不变',
  );
  await page.getByRole('button', { name: '确认删除资料', exact: true }).click();
  await expect(drawer(page)).toContainText('此资料已删除');
  await page.getByRole('button', { name: '关闭资料', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '查看资料 订单接口字段说明', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '已删除资料', exact: true }).click();
  await page.getByRole('button', { name: '查看资料 订单接口字段说明', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/55-project-source-mobile.png', fullPage: true });
  expect(
    await drawer(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.getByRole('button', { name: '恢复资料', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复资料', exact: true }).click();
  await expect(drawer(page)).not.toContainText('此资料已删除');
  expect(new URL(page.url()).searchParams.get('source')).toBe(id);
  await page.getByRole('button', { name: '关闭资料', exact: true }).click();
  await page.getByRole('button', { name: '当前资料', exact: true }).click();
  await page.getByLabel('搜索项目资料', { exact: true }).fill('不可为空');
  await expect(page.locator('.source-card')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/56-project-sources-mobile-list.png', fullPage: true });
  const versions = await (
    await page.request.get(`/api/v1/projects/${p.id}/sources/${id}/revisions`)
  ).json();
  expect(versions.items.map((item: { action: string }) => item.action)).toEqual([
    'restored',
    'deleted',
    'updated',
    'created',
  ]);
});

test('链接引用不自动访问外部站点；历史失败可重试，阅读旧版本不被新事件重置', async ({ page }) => {
  const p = await project(page);
  let externalRequests = 0;
  await page.route('https://example.invalid/**', (route) => {
    externalRequests++;
    return route.abort();
  });
  await page.goto(`/projects/${p.id}?tab=sources`);
  await page.getByRole('button', { name: '新建资料', exact: true }).click();
  await page.getByLabel('资料类型', { exact: true }).selectOption('link');
  await page.getByLabel('资料标题', { exact: true }).fill('支付服务接口参考');
  await page.getByLabel('资料链接', { exact: true }).fill('https://example.invalid/payments');
  await page.getByLabel('链接说明', { exact: true }).fill('人工保存的接口引用');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(drawer(page).getByRole('link')).toHaveAttribute(
    'href',
    'https://example.invalid/payments',
  );
  await expect(drawer(page).getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(externalRequests).toBe(0);
  const id = new URL(page.url()).searchParams.get('source')!,
    base = `/api/v1/projects/${p.id}/sources/${id}`;
  await page.route(
    '**' + base + '/revisions*',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FIXTURE', message: '测试中的资料历史读取失败' } }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: '资料修订记录', exact: true }).click();
  await expect(page.getByLabel('资料历史版本', { exact: true })).toContainText(
    '测试中的资料历史读取失败',
  );
  await page.getByRole('button', { name: '刷新资料记录', exact: true }).click();
  const history = page.getByLabel('资料历史版本', { exact: true });
  await history.getByText('修订 1 · 创建 · 支付服务接口参考', { exact: true }).click();
  const response = await page.request.patch(base, {
    headers: headers(),
    data: {
      expectedRevision: 1,
      title: '接口参考的新标题',
      content: '最新说明',
      url: 'https://example.invalid/payments-v2',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(
    drawer(page).getByRole('heading', { name: '接口参考的新标题', exact: true }),
  ).toBeVisible();
  await expect(history.locator('details')).toHaveCount(1);
  await expect(history.locator('details')).toHaveAttribute('open', '');
  await expect(history).toContainText('人工保存的接口引用');
  await page.getByRole('button', { name: '刷新资料记录', exact: true }).click();
  await expect(history.locator('details')).toHaveCount(2);
  expect(externalRequests).toBe(0);
});

test('两页修改同一资料保留草稿并明确比较，删除冲突不能静默恢复资料', async ({ page, context }) => {
  const p = await project(page),
    s = await source(page, p.id, '两人协作的需求说明'),
    other = await context.newPage();
  try {
    await page.goto(sourceURL(p.id, s.id));
    await other.goto(sourceURL(p.id, s.id));
    for (const current of [page, other])
      await current.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByLabel('资料正文', { exact: true }).fill('本页未发送的修改');
    let readUnavailable = true;
    await page.route(`**/api/v1/projects/${p.id}/sources/${s.id}`, (route) =>
      readUnavailable && route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'FIXTURE_READ_FAILED', message: '测试中的临时读取失败' },
            }),
          })
        : route.continue(),
    );
    await source(page, p.id, '触发资料刷新');
    await expect(drawer(page)).toContainText('测试中的临时读取失败');
    await expect(page.getByLabel('资料正文', { exact: true })).toHaveValue('本页未发送的修改');
    readUnavailable = false;
    await page.getByRole('button', { name: '重新读取资料', exact: true }).click();
    await expect(drawer(page)).not.toContainText('测试中的临时读取失败');
    await other.getByLabel('资料正文', { exact: true }).fill('另一页先保存的内容');
    await other.getByRole('button', { name: '保存资料修改', exact: true }).click();
    await expect(page.getByLabel('资料版本冲突', { exact: true })).toContainText(
      '另一页先保存的内容',
    );
    await expect(page.getByLabel('资料正文', { exact: true })).toHaveValue('本页未发送的修改');
    await expect(page.getByRole('button', { name: '保存资料修改', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '保留草稿，基于最新修订', exact: true }).click();
    await expect(other.locator('.source-detail > .source-reading')).toContainText(
      '另一页先保存的内容',
    );
    await page.getByRole('button', { name: '保存资料修改', exact: true }).click();
    await expect(other.locator('.source-detail > .source-reading')).toContainText(
      '本页未发送的修改',
    );
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByLabel('资料正文', { exact: true }).fill('不能使删除失效的旧编辑');
    await other.getByRole('button', { name: '删除资料', exact: true }).click();
    await other.getByRole('button', { name: '确认删除资料', exact: true }).click();
    await expect(page.getByLabel('资料版本冲突', { exact: true })).toContainText('已删除');
    await expect(page.getByRole('button', { name: '保存资料修改', exact: true })).toBeDisabled();
    await expect(page.getByLabel('资料正文', { exact: true })).toHaveValue(
      '不能使删除失效的旧编辑',
    );
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await expect(drawer(page)).toContainText('此资料已删除');
  } finally {
    await other.close();
  }
});

test('创建和删除回执丢失时确认原请求，不重复资料或修订', async ({ page }) => {
  const p = await project(page),
    base = `/api/v1/projects/${p.id}/sources`,
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
  await page.goto(`/projects/${p.id}?tab=sources`);
  await page.getByRole('button', { name: '新建资料', exact: true }).click();
  await page.getByLabel('资料标题', { exact: true }).fill('需要确认回执的参考');
  await page.getByLabel('资料正文', { exact: true }).fill('保存一次即可');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByLabel('资料操作待确认', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '确认上次资料操作', exact: true }).click();
  await expect(drawer(page)).toBeVisible();
  expect(keys.length).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]);
  const id = new URL(page.url()).searchParams.get('source')!;
  drop = true;
  const lifecycleKeys: string[] = [];
  await page.route('**' + base + '/' + id + '/lifecycle', async (route) => {
    lifecycleKeys.push(route.request().headers()['idempotency-key']!);
    if (drop) {
      drop = false;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '删除资料', exact: true }).click();
  await page.getByRole('button', { name: '确认删除资料', exact: true }).click();
  await expect(page.getByLabel('资料操作待确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认上次资料操作', exact: true }).click();
  await expect(page.getByLabel('资料操作待确认', { exact: true })).toHaveCount(0);
  await expect(drawer(page)).toContainText('此资料已删除');
  expect(lifecycleKeys.length).toBe(2);
  expect(lifecycleKeys[0]).toBe(lifecycleKeys[1]);
  const history = await (await page.request.get(base + '/' + id + '/revisions')).json();
  expect(history.items).toHaveLength(2);
  const deleted = await (await page.request.get(base + '?state=deleted')).json();
  expect(deleted.items).toHaveLength(1);
});
