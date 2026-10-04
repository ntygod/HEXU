import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Project, Result, Task, TaskDetail } from '../../packages/contracts/src/index.js';
import type { ResultDetail } from '../../packages/contracts/src/results.js';
import { prepareScreenshot } from '../helpers/task-reliability.js';

const fixedLink = (page: Page) =>
  page.getByRole('link', { name: '打开此版本固定链接', exact: true });
const picker = (page: Page) => page.getByRole('combobox', { name: '查看固定版本', exact: true });
const explanation = (page: Page) =>
  page.getByText('此地址始终打开当前查看的版本。', { exact: true });

async function post<T>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data: body,
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api/v1/' + path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function fixture(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('hexu-theme')) localStorage.setItem('hexu-theme', 'dark');
  });
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: '成果固定地址验收',
    description: '普通文字成果的只读版本导航。',
  });
  const task = await post<Task>(page, 'spaces/space-demo/tasks', {
    projectId: project.id,
    title: '保留成果原版本地址',
    description: '查看和打开固定链接不改变任务、成果或讨论。',
  });
  const result = await post<Result>(page, `tasks/${task.id}/results`, {
    title: '可重复打开的文字成果',
    body: '这份第一版说明在固定地址、刷新和前进后退中保持一致。',
  });
  const [beforeResult, beforeTask] = await Promise.all([
    get<ResultDetail>(page, `results/${result.id}`),
    get<TaskDetail>(page, `tasks/${task.id}`),
  ]);
  expect(beforeResult.version).toMatchObject({
    resultId: result.id,
    taskId: task.id,
    revision: 1,
    body: result.body,
    source: { kind: 'member' },
  });
  expect(beforeResult.version.id).toBeTruthy();
  expect(beforeResult.revisions).toHaveLength(1);
  expect(beforeTask.runs).toEqual([]);
  return {
    result,
    task,
    beforeResult,
    beforeTask,
    floatingPath: `/results/${result.id}`,
    fixedPath: `/results/${result.id}/versions/${beforeResult.version.id}`,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectVersion(page: Page, f: Fixture, path: string) {
  await expect(page).toHaveURL(new URL(path, page.url()).href);
  await expect(picker(page)).toHaveCount(1);
  await expect(page.locator('.result-workspace select')).toHaveCount(1);
  await expect(picker(page)).toHaveValue(f.beforeResult.version.id);
  await expect(fixedLink(page)).toHaveCount(1);
  await expect(fixedLink(page)).toHaveAttribute('href', f.fixedPath);
  expect(await fixedLink(page).evaluate((element) => element.closest('label') === null)).toBe(true);
  await expect(
    page.getByRole('heading', { name: `${f.result.title} · 当前成果`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(f.result.body, { exact: true })).toBeVisible();
  await expect(
    page.getByText('v1 的讨论会保留在这个版本，不随新成果迁移。', { exact: true }),
  ).toBeVisible();
}

async function screenshot(page: Page, path: string, minimumHeight: number) {
  // Scroll to the actual link and its nearby explanation, not the distant footer.
  await prepareScreenshot(page, fixedLink(page), page.locator('.result-workspace'));
  await expect(explanation(page)).toBeVisible();
  await expect(explanation(page)).toBeInViewport({ ratio: 1 });
  expect((await fixedLink(page).boundingBox())!.height).toBeGreaterThanOrEqual(minimumHeight);
  expect((await picker(page).boundingBox())!.width).toBeGreaterThan(240);
  await page.screenshot({ path });
}

test('普通成果固定链接支持键盘、刷新和历史导航，明暗窄屏保持可用且只读', async ({ page }) => {
  const f = await fixture(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  const resultRead = `**/api/v1/results/${f.result.id}`;
  let releaseRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let capturing = true;
  const pending: Promise<void>[] = [];
  const cleanupErrors: unknown[] = [];
  const holdRead = async (route: Route) => {
    if (!capturing || route.request().method() !== 'GET') return route.continue();
    const work = (async () => {
      await reading;
      await route.continue();
    })().catch((error) => {
      cleanupErrors.push(error);
    });
    pending.push(work);
    await work;
  };
  await page.route(resultRead, holdRead);
  let failed = false;
  try {
    await page.goto(f.floatingPath);
    await expect(page.getByLabel('正在打开成果', { exact: true })).toBeVisible();
    await expect(picker(page)).toHaveCount(0);
    await expect(fixedLink(page)).toHaveCount(0);
    await expect(page.locator('a[href*="undefined"]')).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Stop new holds, then let every captured handler settle before removing it.
    capturing = false;
    releaseRead();
    await Promise.all(pending);
    try {
      await page.unroute(resultRead, holdRead);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      if (!failed) throw new AggregateError(cleanupErrors, '成果固定链接读取夹具清理失败');
      test.info().annotations.push({
        type: 'cleanup failure',
        description: cleanupErrors.map(String).join('\n'),
      });
    }
  }
  await expectVersion(page, f, f.floatingPath);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('artifacts', { recursive: true });
  await screenshot(page, 'artifacts/221-result-version-link-dark.png', 32);

  await picker(page).focus();
  await page.keyboard.press('Tab');
  await expect(fixedLink(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expectVersion(page, f, f.fixedPath);
  await page.reload();
  await expectVersion(page, f, f.fixedPath);
  await page.goBack();
  await expectVersion(page, f, f.floatingPath);
  await page.goForward();
  await expectVersion(page, f, f.fixedPath);

  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await expectVersion(page, f, f.floatingPath);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await screenshot(page, 'artifacts/222-result-version-link-mobile-light.png', 44);
  await fixedLink(page).click();
  await expectVersion(page, f, f.fixedPath);

  expect(await get<TaskDetail>(page, `tasks/${f.task.id}`)).toEqual(f.beforeTask);
  expect(await get<ResultDetail>(page, `results/${f.result.id}`)).toEqual(f.beforeResult);
  expect(await get<ResultDetail>(page, f.fixedPath.slice(1))).toEqual(f.beforeResult);
  expect(writes).toEqual([]);
});
