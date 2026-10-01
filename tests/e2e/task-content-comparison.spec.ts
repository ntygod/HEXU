import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task } from '../../packages/contracts/src/index.js';
import { Store } from '../../packages/db/src/store.js';
import { createApp } from '../../apps/control/src/app.js';
import { teamFixture } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const history = (page: Page) => page.getByRole('dialog', { name: '工作说明历史', exact: true });
const picker = (page: Page) =>
  history(page).getByRole('region', { name: '工作说明版本对照', exact: true });
const comparison = (page: Page) =>
  picker(page).getByRole('region', { name: '固定工作说明对照', exact: true });
const before = (page: Page) => picker(page).getByLabel('较早版本', { exact: true });
const after = (page: Page) => picker(page).getByLabel('较新版本', { exact: true });
const show = (page: Page) =>
  picker(page).getByRole('button', { name: '查看两版对照', exact: true });
async function create(page: Page, title: string, description = '初始说明') {
  const r = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title, description, projectId: 'project-orders' },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Task;
}
async function patch(page: Page, task: Task, changes: Partial<Task>, origin = '') {
  const r = await page.request.patch(`${origin}/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, ...changes },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Task;
}
async function open(page: Page, task: Task, origin = '') {
  await page.goto(`${origin}/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '工作说明历史', exact: true }).click();
  await history(page).getByRole('button', { name: '对照两个版本', exact: true }).click();
  await expect(before(page)).toBeVisible();
}
async function closeFixture(page: Page, close: () => Promise<unknown>, failed: boolean) {
  const errors: unknown[] = [];
  for (const action of [
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.goto('about:blank'),
    () => page.context().close(),
    close,
  ]) {
    try {
      await action();
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length && !failed) throw new AggregateError(errors, 'Task comparison cleanup failed');
  if (errors.length && failed)
    test
      .info()
      .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('固定两版的标题关注和行级说明对照，未变行可展开，全文和手机键盘可读', async ({ page }) => {
  const prefix = Array.from({ length: 12 }, (_, i) => `开头未变 ${i + 1}`).join('\n');
  const suffix = Array.from({ length: 12 }, (_, i) => `结尾未变 ${i + 1}`).join('\n');
  const oldBody = `${prefix}\n原处理步骤\n${suffix}`;
  const newBody = `${prefix}\n新处理步骤 <img src=x onerror="window.taskComparisonInjected=true">\n${suffix}`;
  let task = await create(page, '原工作标题', oldBody);
  task = await patch(page, task, {
    title: '新版工作标题',
    description: newBody,
    attention: '等待字段说明',
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.method() + ' ' + request.url());
  });
  await open(page, task);
  await expect(before(page)).toHaveValue('1');
  await expect(after(page)).toHaveValue('2');
  await show(page).focus();
  await page.keyboard.press('Enter');
  await expect(
    comparison(page).getByRole('heading', { name: '任务修订 1 → 2', exact: true }),
  ).toBeVisible();
  await expect(
    comparison(page).getByRole('region', { name: '标题对照', exact: true }),
  ).toContainText('原工作标题');
  await expect(
    comparison(page).getByRole('region', { name: '关注内容对照', exact: true }),
  ).toContainText('等待字段说明');
  const table = comparison(page).getByRole('table', { name: '说明行级变化', exact: true });
  await expect(table).toContainText('原处理步骤');
  await expect(table).toContainText('新处理步骤');
  await expect(table.getByRole('cell', { name: '新增行', exact: true })).toHaveCount(1);
  await expect(table.getByRole('cell', { name: '删除行', exact: true })).toHaveCount(1);
  const expand = table.getByRole('button', { name: '展开原第4–9行未变说明', exact: true });
  await expand.click();
  await expect(table).toContainText('开头未变 6');
  await table.getByRole('button', { name: '收起原第4–9行未变说明', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'taskComparisonInjected'))).toBeUndefined();
  await comparison(page)
    .getByRole('heading', { name: '任务修订 1 → 2', exact: true })
    .scrollIntoViewIfNeeded();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/180-task-content-comparison-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '工作说明历史', exact: true }).click();
  await history(page).getByRole('button', { name: '对照两个版本', exact: true }).click();
  await show(page).click();
  await comparison(page).getByRole('button', { name: '两版全文', exact: true }).click();
  await expect(
    comparison(page).getByRole('region', { name: '较早说明全文', exact: true }).locator('pre'),
  ).toHaveText(oldBody);
  await expect(
    comparison(page).getByRole('region', { name: '较新说明全文', exact: true }).locator('pre'),
  ).toHaveText(newBody);
  await comparison(page)
    .getByRole('region', { name: '说明文字对照', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'artifacts/181-task-content-comparison-mobile-light.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(await comparison(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await before(page).selectOption('2');
  await expect(show(page)).toBeDisabled();
  await expect(
    comparison(page).getByRole('heading', { name: '任务修订 1 → 2', exact: true }),
  ).toHaveCount(1);
  await before(page).selectOption('1');
  await expect(show(page)).toBeEnabled();
  await history(page)
    .locator('.dialog-footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  expect(writes).toEqual([]);
  const detail = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(detail.task.revision).toBe(2);
  expect(detail.runs).toHaveLength(0);
});

test('翻页和SSE/明确刷新不漂移双方固定版本；选项变化须再次查看，不改写任务', async ({ page }) => {
  let task = await create(page, '跨页固定版本对照');
  for (let i = 2; i <= 14; i++)
    task = await patch(page, task, { description: `记录中的说明 ${i}` });
  await open(page, task);
  await before(page).selectOption('5');
  await show(page).click();
  await expect(comparison(page)).toContainText('记录中的说明 5');
  await expect(comparison(page)).toContainText('记录中的说明 14');
  for (let i = 15; i <= 26; i++)
    task = await patch(page, task, { description: `后来保存的说明 ${i}` });
  await expect(history(page)).toContainText('有新的工作说明记录');
  await expect(before(page)).toHaveValue('5');
  await expect(after(page)).toHaveValue('14');
  await history(page).getByRole('button', { name: '重新读取历史', exact: true }).click();
  await expect(
    history(page).getByRole('article', { name: '工作说明修订 26', exact: true }),
  ).toBeVisible();
  await expect(
    history(page).getByRole('article', { name: '工作说明修订 5', exact: true }),
  ).toHaveCount(0);
  await expect(before(page)).toHaveValue('5');
  await expect(after(page)).toHaveValue('14');
  await expect(
    comparison(page).getByRole('heading', { name: '任务修订 5 → 14', exact: true }),
  ).toHaveCount(1);
  await after(page).selectOption('26');
  await expect(picker(page)).toContainText('选择已改变，点击查看后再切换对照');
  await expect(comparison(page)).not.toContainText('后来保存的说明 26');
  await show(page).click();
  await expect(comparison(page)).toContainText('后来保存的说明 26');
  for (let i = 0; i < 2; i++)
    await history(page).getByRole('button', { name: '更早的工作说明', exact: true }).click();
  await expect(
    history(page).getByRole('article', { name: '工作说明修订 1', exact: true }),
  ).toHaveCount(1);
  await before(page).selectOption('1');
  await show(page).click();
  await expect(comparison(page)).toContainText('初始说明');
  await expect(
    comparison(page).getByRole('heading', { name: '任务修订 1 → 26', exact: true }),
  ).toHaveCount(1);
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.revision).toBe(
    26,
  );
});

test('旧快照未知来源不补造，过多行回退完整说明且键盘可读到末尾', async ({ page }) => {
  const origin = 'http://127.0.0.1:4337';
  const store = new Store();
  const app = await createApp({ store, port: 4337, native: { enabled: false, roots: [] } });
  let failed = false;
  try {
    await app.listen({ host: '127.0.0.1', port: 4337 });
    const original = store.getTask('task-24');
    const body = '说明行\n'.repeat(2001) + '必须完整保留的末尾';
    const task = await patch(page, original, { description: body }, origin);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, task, origin);
    await show(page).click();
    const older = comparison(page).getByRole('region', { name: '较早一版', exact: true });
    await expect(older).toContainText('已有内容快照');
    await expect(older).toContainText('操作者未记录');
    await expect(older).toContainText('保存时间未记录');
    await expect(older).toContainText('更早的修改过程未记录');
    await expect(comparison(page)).toContainText('说明行数或长度超过行级展示上限');
    await expect(
      comparison(page).getByRole('button', { name: '行级变化', exact: true }),
    ).toBeDisabled();
    const text = comparison(page)
      .getByRole('region', { name: '较新说明全文', exact: true })
      .locator('pre');
    await expect(text).toHaveText(body);
    await text.focus();
    await page.keyboard.press('End');
    await expect
      .poll(() => text.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(1);
    await expect.poll(() => text.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await older.scrollIntoViewIfNeeded();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/182-task-content-comparison-legacy-mobile.png',
      fullPage: true,
    });
    expect(await comparison(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    expect(store.getTask(task.id).revision).toBe(task.revision);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    await closeFixture(page, () => app.close(), failed);
  }
});

test('只读成员可对照自己的可见历史，真实撤权清空双方正文和入口', async ({ page }) => {
  const origin = 'http://127.0.0.1:4337';
  const f = await teamFixture(origin);
  let failed = false;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const original = await f.task(alice, project.id, '可读历史中的固定对照');
    const r = await f.call(
      `tasks/${original.id}`,
      alice,
      { expectedRevision: 1, description: '旧版敏感说明仅项目成员可见' },
      'v2',
      'PATCH',
    );
    expect(r.statusCode, r.body).toBe(200);
    const next = await f.call(
      `tasks/${original.id}`,
      alice,
      { expectedRevision: 2, description: '新版敏感说明同样受当前权限限制' },
      'v3',
      'PATCH',
    );
    expect(next.statusCode, next.body).toBe(200);
    const task = next.json() as Task;
    const grant = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'view',
    });
    expect(grant.statusCode, grant.body).toBe(200);
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
    await open(page, task, origin);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();
    await before(page).selectOption('1');
    await after(page).selectOption('2');
    await show(page).click();
    await expect(comparison(page)).toContainText('旧版敏感说明仅项目成员可见');
    await expect(
      comparison(page).getByRole('heading', { name: '任务修订 1 → 2', exact: true }),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('敏感说明');
    const pattern = `${origin}/api/v1/tasks/${task.id}/content-history?*`;
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '当前历史读取被拒绝' } },
      }),
    );
    const event = await f.call(`tasks/${task.id}/messages`, alice, {
      body: '真实SSE触发当前历史权限重查',
    });
    expect(event.statusCode, event.body).toBe(201);
    await expect(history(page)).toContainText('先前内容已清除');
    await expect(comparison(page)).toHaveCount(0);
    await expect(history(page)).not.toContainText('旧版敏感说明');
    await page.unroute(pattern);
    const latest = await f.call(
      `tasks/${task.id}`,
      alice,
      { expectedRevision: 3, description: '重开前新保存的第四版说明' },
      'v4',
      'PATCH',
    );
    expect(latest.statusCode, latest.body).toBe(200);
    await expect(comparison(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '工作说明历史', exact: true }).click();
    await expect(comparison(page)).toHaveCount(0);
    await history(page).getByRole('button', { name: '对照两个版本', exact: true }).click();
    await expect(before(page)).toHaveValue('3');
    await expect(after(page)).toHaveValue('4');
    await expect(comparison(page)).toHaveCount(0);
    await show(page).click();
    await expect(comparison(page)).toContainText('新版敏感说明同样受当前权限限制');
    await expect(comparison(page)).toContainText('重开前新保存的第四版说明');
    await expect(comparison(page)).not.toContainText('旧版敏感说明仅项目成员可见');
    const revoked = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: null,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(history(page)).toHaveCount(0);
    await expect(comparison(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('旧版敏感说明');
    await expect(page.locator('body')).not.toContainText('新版敏感说明');
    await expect(page.locator('body')).not.toContainText('重开前新保存的第四版说明');
    expect((await f.call(`tasks/${task.id}/content-history?before=3`, bob)).statusCode).toBe(404);
    expect((await f.call(`tasks/${task.id}`, alice)).json().task.revision).toBe(4);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    await closeFixture(page, () => f.close(), failed);
  }
});
