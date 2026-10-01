import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { teamFixture, type Account } from '../helpers/team.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import type { Result, Task } from '../../packages/contracts/src/index.js';
import type { ProjectResultPage } from '../../packages/contracts/src/project-results.js';
import type { MemberResultVersionReceipt } from '../../packages/contracts/src/member-result-versions.js';

const origin = 'http://127.0.0.1:4333';
async function fixture(count = 1) {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair(),
      project = await api.project(alice);
    await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'view' });
    const task = (await api.task(alice, project.id, '退款边界与取消行为')) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const create = (title: string, body: string, target = task) =>
      as(() => api.store.createResult(target.id, title, body, randomUUID()));
    const results: Result[] = [];
    for (let index = 1; index <= count; index++)
      results.push(create(`成果 ${String(index).padStart(2, '0')}`, `固定成果正文 ${index}`));
    const list = async (cursor = '', account: Account = alice) => {
      const response = await api.call(
        `projects/${project.id}/results${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        account,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as ProjectResultPage;
    };
    const saveVersion = async (result: Result, title: string, body: string) => {
      const current = as(() => new ResultRevisions(api.store).detail(result.id).version);
      const response = await api.call(`results/${result.id}/versions`, alice, {
        expectedRevision: current.revision,
        expectedRevisionId: current.id,
        title,
        body,
      });
      expect(response.statusCode, response.body).toBe(201);
      const receipt = response.json() as MemberResultVersionReceipt;
      return as(() => new ResultRevisions(api.store).get(result.id, receipt.revisionId));
    };
    return { api, alice, bob, project, task, results, as, create, list, saveVersion };
  } catch (error) {
    await api.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const url = (f: Fixture, cursor = '') =>
  `${origin}/projects/${f.project.id}?tab=results${cursor ? `&resultsCursor=${encodeURIComponent(cursor)}` : ''}`;
const endpoint = (f: Fixture) => `${origin}/api/v1/projects/${f.project.id}/results`;
const section = (page: Page) => page.getByRole('region', { name: '项目成果汇总' });
const rows = (page: Page) => section(page).locator('[data-result-id]');
const row = (page: Page, id: string) => section(page).locator(`[data-result-id="${id}"]`);
const pageIds = (page: Page) =>
  rows(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-result-id')),
  );
const versionPath = (id: string, revisionId: string) => `/results/${id}/versions/${revisionId}`;
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function open(page: Page, f: Fixture, account = f.alice) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4333, host: '127.0.0.1' });
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
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
    ({ userId, spaceId }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', 'dark');
    },
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(url(f));
  await expect(section(page)).toBeVisible();
}
async function close(page: Page, f: Fixture, preserveFailure = false) {
  const errors: unknown[] = [];
  // Timeout teardown may already have closed the page. Still release the browser
  // context (including SSE) before the HTTP fixture, even when a cleanup step fails.
  for (const cleanup of [
    async () => {
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    () => page.context().close(),
    () => f.api.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (!preserveFailure) throw new AggregateError(errors, '项目成果浏览器夹具清理失败');
    test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
  }
}

test('项目成果按首次分享顺序分页，URL刷新与前后退保留游标，新版本不移动当前页', async ({
  page,
}) => {
  const f = await fixture(23);
  try {
    const first = await f.list(),
      second = await f.list(first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') writes.push(request.url());
    });
    await open(page, f);
    await expect(rows(page)).toHaveCount(20);
    expect(await pageIds(page)).toEqual(first.items.map((item) => item.id));
    await expect(section(page)).toContainText('按首次分享时间从新到旧');
    await section(page).getByRole('link', { name: '较早成果' }).press('Enter');
    await expect(page).toHaveURL(url(f, first.nextCursor!));
    await expect(rows(page)).toHaveCount(3);
    expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
    await expect(section(page).getByRole('link', { name: '较早成果' })).toHaveCount(0);
    await page.reload();
    await expect(rows(page)).toHaveCount(3);
    expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
    await page.goBack();
    await expect(page).toHaveURL(url(f));
    await expect(rows(page)).toHaveCount(20);
    await page.goForward();
    await expect(page).toHaveURL(url(f, first.nextCursor!));
    await expect(rows(page)).toHaveCount(3);
    const changed = second.items[0]!,
      result = f.results.find((item) => item.id === changed.id)!;
    const v2 = await f.saveVersion(result, '旧成果的新说明', '第二页的当前文字已经补充');
    f.create('后来首次分享的成果', '只应进入第一页，不改变第二页的游标');
    await expect(row(page, changed.id)).toContainText('当前 v2');
    await expect(row(page, changed.id).getByRole('link', { name: '查看此版本' })).toHaveAttribute(
      'href',
      versionPath(changed.id, v2.id),
    );
    await expect(page).toHaveURL(url(f, first.nextCursor!));
    expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
    await section(page).getByRole('link', { name: '返回第一页' }).click();
    await expect(page).toHaveURL(url(f));
    await expect(rows(page)).toHaveCount(20);
    await expect(section(page)).toContainText('后来首次分享的成果');
    await expect(row(page, changed.id)).toHaveCount(0);
    expect(writes).toEqual([]);
  } finally {
    await close(page, f);
  }
});

test('摘要限制160个Unicode字符，任务与固定版本链接独立，键盘及明暗手机布局可读', async ({
  page,
}) => {
  const f = await fixture(0);
  try {
    const body = '本轮已经梳理退款边界。\n' + '边界🧪与任务关联说明'.repeat(40),
      result = f.create('取消后的退款处理与回执说明', body);
    f.create('人工复核记录', '已完成字段梳理，仍需核对最后一项兼容行为。');
    const pageData = await f.list(),
      summary = pageData.items.find((item) => item.id === result.id)!;
    expect(Array.from(summary.excerpt)).toHaveLength(160);
    expect(summary.excerpt).toBe(Array.from(body).slice(0, 160).join(''));
    expect(summary.excerptTruncated).toBe(true);
    const taskBefore = f.as(() => f.api.store.getTask(f.task.id));
    await open(page, f, f.bob);
    await expect(rows(page)).toHaveCount(2);
    expect(await row(page, result.id).locator('.project-result-excerpt').textContent()).toBe(
      summary.excerpt,
    );
    await expect(row(page, result.id)).toContainText('摘要已截取');
    await expect(row(page, result.id)).toContainText(f.task.title);
    await expect(row(page, result.id)).toContainText('任务当前状态');
    await expect(row(page, result.id)).toContainText('待处理');
    await expect(row(page, result.id).locator('a a')).toHaveCount(0);
    await expect(row(page, result.id).getByRole('link')).toHaveCount(2);
    await mkdir('artifacts', { recursive: true });
    await section(page).screenshot({ path: 'artifacts/165-project-results-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: 'artifacts/166-project-results-mobile-light.png',
      fullPage: true,
    });
    expect((await row(page, result.id).boundingBox())!.width).toBeGreaterThan(280);
    expect(
      await section(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const fixedLink = row(page, result.id).getByRole('link', { name: '查看此版本' }),
      taskLink = row(page, result.id).getByRole('link', { name: '打开任务' });
    await fixedLink.focus();
    await page.keyboard.press('Tab');
    await expect(taskLink).toBeFocused();
    expect((await taskLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin}/tasks/${f.task.id}`);
    await expect(page.getByRole('heading', { name: f.task.title, exact: true })).toBeVisible();
    await page.goBack();
    await expect(rows(page)).toHaveCount(2);
    await fixedLink.press('Enter');
    await expect(page).toHaveURL(`${origin}${versionPath(result.id, summary.revisionId)}`);
    await expect(page.locator('.written-result .text-block')).toHaveText(body);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(taskBefore);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
  } finally {
    await close(page, f);
  }
});

test('列表展示v1后并发保存v2，原入口仍打开固定v1，返回列表才读到当前v2', async ({ page }) => {
  const f = await fixture(),
    held = gate();
  try {
    const result = f.results[0]!,
      first = (await f.list()).items[0]!,
      taskBefore = f.as(() => f.api.store.getTask(f.task.id));
    await open(page, f);
    await expect(row(page, result.id)).toContainText('当前 v1');
    await page.route(endpoint(f), async (route) => {
      await held.promise;
      await route.continue().catch(() => {});
    });
    const v2 = await f.saveVersion(result, '补充后的退款说明', 'V2_CURRENT_BODY');
    await expect(row(page, result.id).getByRole('link', { name: '查看此版本' })).toHaveAttribute(
      'href',
      versionPath(result.id, first.revisionId),
    );
    await row(page, result.id).getByRole('link', { name: '查看此版本' }).click();
    await expect(page).toHaveURL(`${origin}${versionPath(result.id, first.revisionId)}`);
    held.resolve();
    await page.unroute(endpoint(f));
    await expect(page.getByLabel('查看固定版本')).toHaveValue(first.revisionId);
    await expect(page.locator('.written-result .text-block')).toHaveText(result.body);
    await expect(page.getByText('正在查看历史版本 v1，最新为 v2', { exact: false })).toBeVisible();
    await expect(page.locator('.written-result')).not.toContainText('V2_CURRENT_BODY');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/167-project-results-fixed-version-mobile.png',
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.reload();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(first.revisionId);
    await page.goBack();
    await expect(page).toHaveURL(url(f));
    await expect(row(page, result.id)).toContainText('当前 v2');
    await expect(row(page, result.id).getByRole('link', { name: '查看此版本' })).toHaveAttribute(
      'href',
      versionPath(result.id, v2.id),
    );
    await row(page, result.id).getByRole('link', { name: '查看此版本' }).click();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(v2.id);
    await expect(page.locator('.written-result .text-block')).toHaveText('V2_CURRENT_BODY');
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(taskBefore);
  } finally {
    held.resolve();
    await close(page, f);
  }
});

test('已取消任务与归档项目仍可读，私有任务不泄露，真实撤权清除成果且拒绝固定入口', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const result = f.results[0]!,
      version = (await f.list()).items[0]!;
    const privateTask = (await f.api.task(f.alice, f.project.id, '隐藏的私有任务')) as Task;
    f.create('PRIVATE_PROJECT_RESULT', 'PRIVATE_PROJECT_RESULT_BODY', privateTask);
    // Persisted private-task fixture exercises legacy project-associated private rows.
    f.api.store.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...privateTask, visibility: 'private' }), privateTask.id);
    const cancelled = await f.api.call(`tasks/${f.task.id}/cancel`, f.alice, {
      expectedRevision: f.task.revision,
      activeRunAction: 'keep',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const archived = await f.api.call(`projects/${f.project.id}/lifecycle`, f.alice, {
      action: 'archive',
      expectedRevision: f.project.revision,
      activeRunAction: 'keep',
    });
    expect(archived.statusCode, archived.body).toBe(200);
    await open(page, f, f.bob);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('.project-archive-banner')).toContainText('项目已归档');
    await expect(row(page, result.id)).toContainText('已取消');
    await expect(page.locator('body')).not.toContainText('PRIVATE_PROJECT_RESULT');
    await expect(page.locator('body')).not.toContainText('隐藏的私有任务');
    await row(page, result.id).getByRole('link', { name: '查看此版本' }).click();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(version.revisionId);
    await expect(page.locator('.written-result .text-block')).toHaveText(result.body);
    await page.goBack();
    await expect(rows(page)).toHaveCount(1);
    const revoked = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: null,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(section(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '项目不存在或当前无权访问' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(result.body);
    const denied = await f.api.call(`projects/${f.project.id}/results`, f.bob);
    expect([403, 404]).toContain(denied.statusCode);
    await page.goto(`${origin}${versionPath(result.id, version.revisionId)}`);
    await expect(page.getByRole('heading', { name: '无法打开成果' })).toBeVisible();
    await expect(page.locator('.written-result')).toHaveCount(0);
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).toBe('cancelled');
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
  } finally {
    await close(page, f);
  }
});

test('初次失败不冒充空项目，短暂故障明确保留旧摘要，拒绝清空且无工作台正文回退', async ({
  page,
}) => {
  const f = await fixture();
  let failed = false;
  try {
    let status = 503;
    let successfulRead: Promise<void> | undefined;
    async function retrySuccessfully() {
      const held = gate();
      successfulRead = held.promise;
      status = 0;
      try {
        // SSE or polling can issue a read while Playwright waits for actionability.
        // Keep success pending so it cannot remove the retry button before the click.
        await section(page).getByRole('button', { name: '重读项目成果' }).click();
      } finally {
        successfulRead = undefined;
        held.resolve();
      }
      await expect(rows(page)).toHaveCount(1);
    }
    await page.route(`${endpoint(f)}*`, async (route) => {
      if (status)
        await route.fulfill({
          status,
          json: {
            error: {
              code: status === 409 ? 'RESULT_VERSION_MISSING' : 'READ_FAILED',
              message:
                status === 403
                  ? '项目成果读取已拒绝'
                  : status === 409
                    ? '当前成果缺少固定版本'
                    : '项目成果暂时无法读取',
            },
          },
        });
      else {
        await successfulRead;
        await route.continue();
      }
    });
    await open(page, f);
    await expect(section(page).getByRole('alert')).toContainText('项目成果读取失败');
    await expect(rows(page)).toHaveCount(0);
    await expect(
      section(page).getByRole('heading', { name: '这个项目还没有可见成果' }),
    ).toHaveCount(0);
    await expect(section(page)).not.toContainText(f.results[0]!.body);
    await retrySuccessfully();
    status = 409;
    await expect(section(page).getByRole('alert')).toContainText('下面保留上次读取的摘要');
    await expect(section(page).getByRole('alert')).toContainText('当前成果缺少固定版本');
    await expect(row(page, f.results[0]!.id)).toContainText('当前 v1');
    status = 503;
    await section(page).getByRole('button', { name: '重读项目成果' }).click();
    await expect(section(page).getByRole('alert')).toContainText('项目成果暂时无法读取');
    await expect(rows(page)).toHaveCount(1);
    status = 403;
    await section(page).getByRole('button', { name: '重读项目成果' }).click();
    await expect(section(page).getByRole('alert')).toContainText('此页摘要已清空');
    await expect(rows(page)).toHaveCount(0);
    await expect(section(page)).not.toContainText(f.results[0]!.body);
    await retrySuccessfully();
    await page.goto(url(f, 'not-a-result'));
    await expect(section(page).getByRole('alert')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(section(page).getByRole('heading', { name: '此页没有更多可见成果' })).toHaveCount(
      0,
    );
    await section(page).getByRole('link', { name: '返回第一页' }).click();
    await expect(rows(page)).toHaveCount(1);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed);
  }
});

test('切换分页后晚到的旧页成功或拒绝均不覆盖当前页，读取中的URL可后退', async ({ page }) => {
  const f = await fixture(21),
    releases: Array<ReturnType<typeof gate>> = [];
  try {
    const first = await f.list(),
      second = await f.list(first.nextCursor!);
    await open(page, f);
    await expect(rows(page)).toHaveCount(20);
    for (const status of [200, 403]) {
      const held = gate(),
        reached = gate(),
        finished = gate();
      releases.push(held);
      await page.route(
        `${endpoint(f)}?cursor=*`,
        async (route) => {
          reached.resolve();
          await held.promise;
          try {
            await route.fulfill({
              status,
              json: status === 200 ? second : { error: { message: '晚到旧页已拒绝' } },
            });
          } finally {
            finished.resolve();
          }
        },
        { times: 1 },
      );
      await section(page).getByRole('link', { name: '较早成果' }).click();
      await reached.promise;
      await expect(page).toHaveURL(url(f, first.nextCursor!));
      await expect(section(page).getByRole('status')).toContainText('正在读取项目成果');
      await expect(rows(page)).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(url(f));
      await expect(rows(page)).toHaveCount(20);
      held.resolve();
      await finished.promise;
      await expect(section(page).getByRole('alert')).toHaveCount(0);
      expect(await pageIds(page)).toEqual(first.items.map((item) => item.id));
      await expect(rows(page)).toHaveCount(20);
    }
    await page.goForward();
    await expect(page).toHaveURL(url(f, first.nextCursor!));
    await expect(rows(page)).toHaveCount(1);
    expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
  } finally {
    for (const held of releases) held.resolve();
    await close(page, f);
  }
});
