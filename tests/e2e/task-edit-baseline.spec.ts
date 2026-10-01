import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';
import { PASSWORD, teamFixture, type Account } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const editor = (page: Page) => page.getByRole('dialog', { name: '编辑工作说明', exact: true });
const title = (page: Page) => editor(page).getByLabel('标题', { exact: true });
const description = (page: Page) => editor(page).getByLabel('说明', { exact: true });
const attention = (page: Page) => editor(page).getByLabel('需要关注什么', { exact: true });
const save = (page: Page) => editor(page).getByRole('button', { name: '保存修改', exact: true });
const conflict = (page: Page) => editor(page).getByLabel('工作说明版本冲突', { exact: true });
const pending = (page: Page) => editor(page).getByLabel('工作说明保存待确认', { exact: true });
const confirm = (page: Page) =>
  editor(page).getByRole('button', { name: '确认原修改是否已保存', exact: true });
const closePending = (page: Page) =>
  editor(page).getByRole('button', { name: '关闭并保留待确认请求', exact: true });
const reread = (page: Page) =>
  editor(page).getByRole('button', { name: '重读当前任务', exact: true });
const keep = (page: Page) =>
  editor(page).getByRole('button', { name: '保留草稿并使用当前版本', exact: true });
const discard = (page: Page) =>
  editor(page).getByRole('button', { name: '放弃草稿并载入最新版', exact: true });
type Attempt = { body: string | null; key: string };
const attempt = (route: Route): Attempt => ({
  body: route.request().postData(),
  key: route.request().headers()['idempotency-key']!,
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function createTask(page: Page, name: string, body = '打开编辑器时已保存的说明') {
  const response = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title: name, description: body, projectId: 'project-orders' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function detail(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/tasks/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TaskDetail;
}
async function patch(page: Page, task: Task, changes: Partial<Task>) {
  const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, ...changes },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Task;
}
async function open(page: Page) {
  await page.getByRole('button', { name: '编辑工作说明', exact: true }).click();
  await expect(editor(page)).toBeVisible();
}
async function goTask(page: Page, task: Task) {
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function navigateTask(page: Page, task: Task) {
  // Exercise client navigation, keeping the identity/space Provider mounted.
  await page.locator(`a.context-task[href="/tasks/${task.id}"]`).click();
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function noStoredDraft(page: Page, text: string) {
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(text);
}
async function closeTeam(
  page: Page,
  fixture: Awaited<ReturnType<typeof teamFixture>>,
  primaryFailure: boolean,
) {
  const errors: unknown[] = [];
  // Cleanup must reach the local control service even when Playwright has already
  // closed its page/context after a timeout. Do not mask the original assertion.
  for (const action of [
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.goto('about:blank'),
    () => page.context().close(),
    () => fixture.close(),
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;
  if (!primaryFailure) throw new AggregateError(errors, 'Task edit team fixture cleanup failed');
  test.info().annotations.push({
    type: 'cleanup failure',
    description: errors.map((error) => String(error)).join('\n'),
  });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('工作说明固定起点，取消不写入，键盘与手机浅色保存不启动执行', async ({ page }) => {
  const task = await createTask(page, '补齐订单筛选的工作说明');
  await goTask(page, task);
  await open(page);
  await expect(title(page)).toBeFocused();
  await expect(save(page)).toBeDisabled();
  await title(page).fill('取消的任务标题');
  await description(page).fill('取消的临时说明');
  await noStoredDraft(page, '取消的临时说明');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeFocused();
  await open(page);
  await expect(title(page)).toHaveValue(task.title);
  await expect(description(page)).toHaveValue(task.description);
  await title(page).fill('订单筛选 · 空状态与错误提示');
  const body =
    '保留筛选项，补充没有结果时的说明。\n<img src=x onerror="window.taskEditInjected=true">';
  await description(page).fill(body);
  await attention(page).fill('等待接口字段确认');
  await expect(editor(page).getByLabel('工作说明固定基线')).toContainText(task.title);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/171-task-edit-baseline-dark.png', fullPage: true });
  // Submit through the real keyboard form path rather than clicking a hidden footer.
  await title(page).press('Enter');
  await expect(editor(page)).toHaveCount(0);
  let stored = await detail(page, task.id);
  expect(stored.task).toMatchObject({
    title: '订单筛选 · 空状态与错误提示',
    description: body,
    attention: '等待接口字段确认',
    revision: task.revision + 1,
    status: task.status,
    ownerUserId: task.ownerUserId,
  });
  expect(stored.runs).toHaveLength(0);
  expect(await page.evaluate(() => Reflect.get(window, 'taskEditInjected'))).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(description(page)).toHaveValue(body);
  await expect(attention(page)).toHaveValue('等待接口字段确认');
  await description(page).fill('确认空状态文案，并保留原筛选条件。');
  await attention(page).fill('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await editor(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect((await description(page).boundingBox())!.width).toBeGreaterThan(240);
  await save(page).scrollIntoViewIfNeeded();
  await expect(save(page)).toBeInViewport();
  await page.screenshot({ path: 'artifacts/172-task-edit-baseline-mobile-light.png' });
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  stored = await detail(page, task.id);
  expect(stored.task.attention).toBeNull();
  expect(stored.task.revision).toBe(task.revision + 2);
  expect(stored.runs).toHaveLength(0);
});

test('SSE同时更新标题说明和关注时保留原草稿与选区，明确比较采用或放弃才换基线', async ({
  page,
}) => {
  const initial = await createTask(page, '两人同时补充订单说明');
  const task = await patch(page, initial, { attention: '原关注事项' });
  await goTask(page, task);
  await page.getByLabel('任务评论', { exact: true }).fill('独立的讨论草稿不受工作说明编辑影响');
  await open(page);
  await title(page).fill('我的未保存标题');
  await description(page).fill('我的未保存说明');
  await attention(page).fill('我的未保存关注');
  await description(page).focus();
  await description(page).evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(2, 5),
  );
  const outgoing: Attempt[] = [];
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() === 'PATCH') outgoing.push(attempt(route));
    await route.continue();
  });
  const changed = await patch(page, task, {
    title: '同事先保存的标题',
    description: '同事先保存的说明',
    attention: '同事先保存的关注',
  });
  await expect(conflict(page)).toContainText(changed.title);
  await expect(conflict(page)).toContainText(changed.description);
  await expect(conflict(page)).toContainText(changed.attention!);
  await expect(editor(page).getByLabel('本次原内容', { exact: true })).toContainText(
    task.description,
  );
  await expect(editor(page).getByLabel('本次原内容', { exact: true })).toContainText(
    task.attention!,
  );
  await expect(title(page)).toHaveValue('我的未保存标题');
  await expect(description(page)).toHaveValue('我的未保存说明');
  await expect(attention(page)).toHaveValue('我的未保存关注');
  await expect(description(page)).toBeFocused();
  expect(
    await description(page).evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([2, 5]);
  await expect(save(page)).toBeDisabled();
  expect(outgoing).toHaveLength(0);
  expect((await detail(page, task.id)).task).toMatchObject({ ...changed });
  await page.setViewportSize({ width: 390, height: 844 });
  await keep(page).scrollIntoViewIfNeeded();
  await expect(keep(page)).toBeInViewport();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/173-task-edit-baseline-conflict-mobile.png' });
  expect(
    await editor(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await keep(page).click();
  await expect(save(page)).toBeEnabled();
  expect((await detail(page, task.id)).task.revision).toBe(changed.revision);
  await save(page).scrollIntoViewIfNeeded();
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(outgoing).toHaveLength(1);
  expect(JSON.parse(outgoing[0]!.body!)).toEqual({
    expectedRevision: changed.revision,
    title: '我的未保存标题',
    description: '我的未保存说明',
    attention: '我的未保存关注',
  });
  await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue(
    '独立的讨论草稿不受工作说明编辑影响',
  );
  const saved = (await detail(page, task.id)).task;
  await open(page);
  await description(page).fill('明确放弃的第二份草稿');
  const latest = await patch(page, saved, {
    title: '后来保存的任务',
    description: '后来保存的完整内容',
    attention: null,
  });
  await expect(conflict(page)).toContainText(latest.description);
  await expect(description(page)).toHaveValue('明确放弃的第二份草稿');
  await discard(page).scrollIntoViewIfNeeded();
  await discard(page).click();
  await expect(title(page)).toHaveValue(latest.title);
  await expect(description(page)).toHaveValue(latest.description);
  await expect(attention(page)).toHaveValue('');
  await expect(save(page)).toBeDisabled();
  expect(outgoing).toHaveLength(1);
});

test('提交瞬间的真实修订冲突不覆盖草稿，短暂任务读取失败和重读不静默换基线', async ({ page }) => {
  const task = await createTask(page, '提交瞬间发生修订竞争');
  await goTask(page, task);
  await open(page);
  await description(page).fill('冲突与读取故障都不能丢弃的草稿');
  const outgoing: Attempt[] = [];
  let current = task;
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    outgoing.push(attempt(route));
    if (outgoing.length === 1)
      current = await patch(page, task, {
        title: '请求发出后先提交的版本',
        description: '并发已保存正文',
        attention: '新关注',
      });
    await route.continue();
  });
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/tasks/${task.id}`) &&
      response.request().method() === 'PATCH' &&
      response.status() === 409,
  );
  await save(page).click();
  await (await rejected).finished();
  await expect(conflict(page)).toContainText(current.description);
  await expect(description(page)).toHaveValue('冲突与读取故障都不能丢弃的草稿');
  expect(JSON.parse(outgoing[0]!.body!).expectedRevision).toBe(task.revision);
  expect((await detail(page, task.id)).task.revision).toBe(current.revision);

  // Fail the explicit read, not the write; a transport failure is not access revocation.
  const failedRead = deferred();
  const readFailure = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 503,
      json: { error: { code: 'TEST_READ_UNAVAILABLE', message: '测试：任务读取暂时不可用' } },
    });
    failedRead.resolve();
  };
  await page.route(`**/api/v1/tasks/${task.id}`, readFailure);
  await reread(page).click();
  await failedRead.promise;
  await expect(editor(page)).toBeVisible();
  await expect(page.locator('.task-page > .notice-box')).toContainText('测试：任务读取暂时不可用');
  await expect(description(page)).toHaveValue('冲突与读取故障都不能丢弃的草稿');
  await expect(title(page)).toHaveValue(task.title);
  await page.unroute(`**/api/v1/tasks/${task.id}`, readFailure);
  await reread(page).click();
  await expect(conflict(page)).toContainText(current.description);
  await expect(description(page)).toHaveValue('冲突与读取故障都不能丢弃的草稿');
  await expect(save(page)).toBeDisabled();
  expect(outgoing).toHaveLength(1);
  await discard(page).click();
  await expect(description(page)).toHaveValue(current.description);
  await expect(save(page)).toBeDisabled();
});

test('丢失回执跨关闭和前进后退仍确认原body与key，后续任务版本不被旧回执替换', async ({ page }) => {
  const task = await createTask(page, '已提交但尚未确认回执');
  await goTask(page, task);
  await open(page);
  await title(page).fill('第一次确实保存的标题');
  await description(page).fill('需要按原请求确认的完整正文');
  await attention(page).fill('第一次提交的关注');
  const outgoing: Attempt[] = [];
  const receipts: Task[] = [];
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    outgoing.push(attempt(route));
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    receipts.push((await response.json()) as Task);
    if (outgoing.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await save(page).click();
  await expect(pending(page)).toBeVisible();
  await expect(confirm(page)).toBeEnabled();
  await expect(title(page)).toBeDisabled();
  await expect(save(page)).toBeDisabled();
  const later = await patch(page, receipts[0]!, {
    title: '另一人后来保存的标题',
    description: '当前真正最新的正文',
    attention: '后来保存的关注',
  });
  await expect(page.locator('.task-title h1')).toHaveText(later.title);
  await expect(title(page)).toHaveValue('第一次确实保存的标题');
  await closePending(page).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '项目', exact: true })
    .click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: later.title, exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goBack();
  await open(page);
  await expect(pending(page)).toBeVisible();
  await expect(description(page)).toHaveValue('需要按原请求确认的完整正文');
  await expect(title(page)).toBeDisabled();
  await noStoredDraft(page, '需要按原请求确认的完整正文');
  await confirm(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(outgoing).toHaveLength(2);
  expect(outgoing[0]!.key).toBeTruthy();
  expect(outgoing[1]).toEqual(outgoing[0]);
  expect(receipts[1]).toEqual(receipts[0]);
  await expect(page.getByRole('heading', { name: later.title, exact: true })).toBeVisible();
  expect((await detail(page, task.id)).task).toMatchObject({ ...later });
  await open(page);
  await expect(title(page)).toHaveValue(later.title);
  await expect(description(page)).toHaveValue(later.description);
  await expect(attention(page)).toHaveValue(later.attention!);
  await expect(save(page)).toBeDisabled();
  expect((await detail(page, task.id)).runs).toHaveLength(0);
});

test('双提交只发一包，关闭后的晚到成功不能清掉重开的确认或另一个任务的新编辑器', async ({
  page,
}) => {
  const task = await createTask(page, '旧请求所属任务');
  const other = await createTask(page, '另一个任务的新编辑器');
  await goTask(page, task);
  const first = deferred(),
    firstSent = deferred(),
    replay = deferred(),
    replaySent = deferred();
  const outgoing: Attempt[] = [];
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    outgoing.push(attempt(route));
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (outgoing.length === 1) {
      firstSent.resolve();
      await first.promise;
    } else {
      replaySent.resolve();
      await replay.promise;
    }
    await route.fulfill({ response });
  });
  try {
    await open(page);
    await description(page).fill('晚到成功仍属于旧编辑器');
    await save(page).click();
    await firstSent.promise;
    await expect(save(page)).toBeDisabled();
    // A second submit event exercises the handler guard as well as the disabled button.
    await editor(page).locator('form').dispatchEvent('submit');
    await closePending(page).click();
    await open(page);
    await expect(pending(page)).toBeVisible();
    const late = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().endsWith(`/tasks/${task.id}`),
    );
    first.resolve();
    await (await late).finished();
    await expect(editor(page)).toBeVisible();
    await expect(pending(page)).toBeVisible();
    await expect(description(page)).toHaveValue('晚到成功仍属于旧编辑器');
    await expect(confirm(page)).toBeEnabled();
    expect(outgoing).toHaveLength(1);

    await confirm(page).click();
    await replaySent.promise;
    await closePending(page).click();
    await navigateTask(page, other);
    await open(page);
    await description(page).fill('新任务编辑器不能被旧回执清掉');
    const lateReplay = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().endsWith(`/tasks/${task.id}`),
    );
    replay.resolve();
    await (await lateReplay).finished();
    await expect(editor(page)).toBeVisible();
    await expect(description(page)).toHaveValue('新任务编辑器不能被旧回执清掉');
    await expect(title(page)).toHaveValue(other.title);
    await expect(save(page)).toBeEnabled();
    expect(outgoing).toHaveLength(2);
    expect(outgoing[1]).toEqual(outgoing[0]);
    await editor(page).getByRole('button', { name: '取消', exact: true }).click();
    await navigateTask(page, task);
    await open(page);
    await expect(pending(page)).toBeVisible();
    await confirm(page).click();
    await expect(editor(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(3);
    expect(outgoing[2]).toEqual(outgoing[0]);
    expect((await detail(page, task.id)).task.revision).toBe(task.revision + 1);
    expect((await detail(page, other.id)).task.revision).toBe(other.revision);
  } finally {
    first.resolve();
    replay.resolve();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('当前撤权清空草稿与待确认包，迟到失败不复活；切换空间和账号不带走临时编辑', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:4335';
  const f = await teamFixture(origin);
  const blocked = deferred(),
    sent = deferred();
  let primaryFailure = false;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const task: Task = await f.task(alice, project.id, '权限与会话隔离的工作说明');
    const grant = async (role: 'edit' | 'view') => {
      const response = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
        role,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await grant('edit');
    await f.app.listen({ port: 4335, host: '127.0.0.1' });
    const install = async (account: Account) => {
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
    };
    await install(bob);
    await page.addInitScript(
      ({ userId, spaceId }) => sessionStorage.setItem(`hexu-space:${userId}`, spaceId),
      { userId: bob.user.id, spaceId: bob.spaceId },
    );
    await page.goto(`${origin}/tasks/${task.id}`);
    await open(page);
    await description(page).fill('撤权时必须删除的临时工作说明');
    await grant('view');
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();
    await grant('edit');
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await description(page).fill('已提交但撤权后不得复活的包');
    const url = `${origin}/api/v1/tasks/${task.id}`;
    const lateFailure = async (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      sent.resolve();
      await blocked.promise;
      await route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '测试：旧编辑器已撤权' } },
      });
    };
    await page.route(url, lateFailure);
    await save(page).click();
    await sent.promise;
    await grant('view');
    await expect(editor(page)).toHaveCount(0);
    await grant('edit');
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await description(page).fill('重新授权后的新草稿');
    const denied = page.waitForResponse(
      (response) => response.url() === url && response.status() === 403,
    );
    blocked.resolve();
    await (await denied).finished();
    await expect(description(page)).toHaveValue('重新授权后的新草稿');
    await expect(pending(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    await page.unroute(url, lateFailure);
    await page.keyboard.press('Escape');

    // An unknown request is deliberately retained on close, then must be erased by a
    // real Provider boundary. Ordinary cancellation alone would not prove isolation.
    const makeUnknown = async (body: string) => {
      const drop = async (route: Route) => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        await route.abort('failed');
      };
      await page.route(url, drop);
      await open(page);
      await description(page).fill(body);
      await save(page).click();
      await expect(pending(page)).toBeVisible();
      await expect(confirm(page)).toBeEnabled();
      await page.unroute(url, drop);
      await closePending(page).click();
    };
    await makeUnknown('不能跨空间的原请求');
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(`personal-${bob.user.id}`);
    await expect(page.getByLabel('当前工作空间')).toHaveValue(`personal-${bob.user.id}`);
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(bob.spaceId);
    await navigateTask(page, task);
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await expect(pending(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await makeUnknown('不能跨账号的原请求');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '资源与设置', exact: true })
      .click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('alice@example.invalid');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(alice.spaceId);
    await navigateTask(page, task);
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await expect(pending(page)).toHaveCount(0);
    await noStoredDraft(page, '不能跨账号的原请求');
    await page.keyboard.press('Escape');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '资源与设置', exact: true })
      .click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill('bob@example.invalid');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(bob.spaceId);
    await navigateTask(page, task);
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await expect(pending(page)).toHaveCount(0);
    const current = await f.call(`tasks/${task.id}`, alice);
    expect(current.json().task.revision).toBe(task.revision);
    expect(current.json().runs).toHaveLength(0);
    for (const table of ['continuation_operations', 'node_continuation_operations'])
      expect(
        f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id=?`).get(task.id),
      ).toMatchObject({ count: 0 });
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    blocked.resolve();
    await closeTeam(page, f, primaryFailure);
  }
});

test('当前工作台撤权优先于失败的详情读取，详情拒绝也优先于旧工作台，旧内容与待确认包不复活', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:4335';
  const f = await teamFixture(origin);
  let primaryFailure = false;
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    let task: Task = await f.task(alice, project.id, 'REVOKED_TASK_TITLE');
    const changed = await f.call(
      `tasks/${task.id}`,
      alice,
      {
        expectedRevision: task.revision,
        description: 'REVOKED_CONTEXT_BODY',
      },
      randomUUID(),
      'PATCH',
    );
    expect(changed.statusCode, changed.body).toBe(200);
    task = changed.json();
    const message = await f.call(`tasks/${task.id}/messages`, alice, {
      body: 'REVOKED_MESSAGE_BODY',
    });
    expect(message.statusCode, message.body).toBe(201);
    const result = await f.call(`tasks/${task.id}/results`, alice, {
      title: 'REVOKED_RESULT_TITLE',
      body: 'REVOKED_RESULT_BODY',
    });
    expect(result.statusCode, result.body).toBe(201);
    const grant = async (role: 'edit' | null) => {
      const response = await f.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
        role,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await grant('edit');
    await f.app.listen({ port: 4335, host: '127.0.0.1' });
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
    await page.goto(`${origin}/tasks/${task.id}`);
    await expect(page.locator('.task-title h1')).toHaveText(task.title);
    await expect(page.locator('.message-content')).toContainText('REVOKED_MESSAGE_BODY');
    await expect(page.locator('.task-results')).toContainText('REVOKED_RESULT_BODY');
    const context = page.getByRole('dialog', { name: '任务上下文', exact: true });
    const url = `${origin}/api/v1/tasks/${task.id}`;
    const workbenchURL = `${origin}/api/v1/workbench`;
    const omitted = deferred(),
      failedRead = deferred();
    let failDetail = false;
    let staleWorkbench: Workbench | undefined;
    await page.route(workbenchURL, async (route) => {
      if (staleWorkbench) return route.fulfill({ json: staleWorkbench });
      const response = await route.fetch();
      const current = (await response.json()) as Workbench;
      await route.fulfill({ response });
      if (!current.tasks.some((item) => item.id === task.id)) omitted.resolve();
    });
    await page.route(url, async (route) => {
      if (route.request().method() === 'PATCH') return route.abort('failed');
      if (!failDetail) return route.continue();
      await route.fulfill({
        status: 503,
        json: { error: { code: 'TEST_DETAIL_OFFLINE', message: '测试：撤权后的详情读取失败' } },
      });
      failedRead.resolve();
    });
    const unknownFromContext = async (body: string) => {
      await page.getByRole('button', { name: '上下文', exact: true }).click();
      await expect(context).toContainText('REVOKED_CONTEXT_BODY');
      await context.getByRole('button', { name: '编辑说明', exact: true }).click();
      await description(page).fill(body);
      await save(page).click();
      await expect(confirm(page)).toBeEnabled();
      await expect(pending(page)).toBeVisible();
    };
    const assertHidden = async () => {
      await expect(page.locator('.task-page')).toHaveCount(0);
      await expect(editor(page)).toHaveCount(0);
      await expect(context).toHaveCount(0);
      for (const secret of [
        'REVOKED_TASK_TITLE',
        'REVOKED_CONTEXT_BODY',
        'REVOKED_MESSAGE_BODY',
        'REVOKED_RESULT_TITLE',
        'REVOKED_RESULT_BODY',
      ])
        await expect(page.locator('#main-content')).not.toContainText(secret);
      await expect(
        page.getByRole('button', { name: '确认原修改是否已保存', exact: true }),
      ).toHaveCount(0);
    };

    // Current Workbench is a successful real authorized read. A failed detail read
    // must not keep the previously accessible task or either stacked dialog alive.
    await unknownFromContext('OMITTED_TASK_PENDING_DRAFT');
    failDetail = true;
    await grant(null);
    await omitted.promise;
    await failedRead.promise;
    await expect(
      page.getByRole('heading', { name: '当前无法访问此任务', exact: true }),
    ).toBeVisible();
    await assertHidden();
    await expect(page.locator('body')).not.toContainText(task.title);
    failDetail = false;
    await grant('edit');
    await expect(page.locator('.task-title h1')).toHaveText(task.title);
    await expect(context).toHaveCount(0);
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await expect(pending(page)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Conversely, retain an older successful Workbench response while the actual
    // server denies TaskDetail after project revocation. No synthetic permissions.
    const old = await f.call('workbench', bob);
    expect(old.statusCode, old.body).toBe(200);
    expect((old.json() as Workbench).tasks.some((item) => item.id === task.id)).toBe(true);
    await unknownFromContext('DENIED_DETAIL_PENDING_DRAFT');
    staleWorkbench = old.json() as Workbench;
    const deniedRead = page.waitForResponse(
      (response) =>
        response.url() === url &&
        response.request().method() === 'GET' &&
        response.status() === 404,
    );
    await grant(null);
    await (await deniedRead).finished();
    await assertHidden();
    staleWorkbench = undefined;
    await grant('edit');
    await expect(page.locator('.task-title h1')).toHaveText(task.title);
    await expect(context).toHaveCount(0);
    await open(page);
    await expect(description(page)).toHaveValue(task.description);
    await expect(pending(page)).toHaveCount(0);
    await expect(save(page)).toBeDisabled();
    await noStoredDraft(page, 'OMITTED_TASK_PENDING_DRAFT');
    await noStoredDraft(page, 'DENIED_DETAIL_PENDING_DRAFT');
    const final = await f.call(`tasks/${task.id}`, alice);
    expect(final.json().task.revision).toBe(task.revision);
    expect(final.json().runs).toHaveLength(0);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    await closeTeam(page, f, primaryFailure);
  }
});
