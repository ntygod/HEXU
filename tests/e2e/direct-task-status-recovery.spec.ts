import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { teamFixture, PASSWORD, type Account } from '../helpers/team.js';
import { completionEvents, prepareScreenshot } from '../helpers/task-reliability.js';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';

const origin = 'http://127.0.0.1:4343';
type Action = 'start' | 'reopen' | 'complete';
type Packet = { path: string; body: string | null; key: string };
type Disposable = { dispose(failed: boolean): Promise<void> };
const target = { start: 'in_progress', reopen: 'todo', complete: 'done' } as const;
const title = { start: '标记任务进行中', reopen: '重新打开任务', complete: '标记任务完成' };
const dialog = (page: Page, action: Action) =>
  page.getByRole('dialog', { name: title[action], exact: true });
const pending = (page: Page) => page.getByLabel('任务状态请求待确认', { exact: true });
const accepted = (page: Page) => page.getByLabel('任务状态请求已确认', { exact: true });
const recover = (page: Page) => page.getByRole('button', { name: '确认原请求结果', exact: true });
const refresh = (page: Page) => page.getByRole('button', { name: '刷新任务状态', exact: true });
const dismiss = (page: Page) => page.getByRole('button', { name: '暂时关闭', exact: true });
const cancelEntry = (page: Page) =>
  page.locator('.w1-task-scope').getByRole('button', { name: '取消任务…', exact: true });
const status = (page: Page) => page.locator('.task-title .badge');
const endpoint = (f: Fixture, action: Action) => `${origin}/api/v1/tasks/${f.task.id}/${action}`;
const packet = (request: Request): Packet => ({
  path: new URL(request.url()).pathname,
  body: request.postData(),
  key: request.headers()['idempotency-key'] ?? '',
});

async function fixture(action: Action) {
  const api = await teamFixture(origin);
  try {
    // Ordinary Task HTTP only: no Run, provider, node, material or executor fixture.
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, project.id, '手动任务状态原请求')) as Task;
    const other = (await api.task(alice, project.id, '另一个任务')) as Task;
    const as = <T>(read: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, read);
    const f = { api, alice, bob, project, task, other, as, close: api.close };
    const grant = await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    if (action === 'reopen') await command(f, 'complete');
    return f;
  } catch (error) {
    try {
      await api.close();
    } catch (cause) {
      reportCleanup([cause], true);
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const taskState = (f: Fixture) => f.as(() => f.api.store.getTask(f.task.id));
const runs = (f: Fixture) => f.as(() => f.api.store.runs(f.task.id));
const history = (f: Fixture) => completionEvents(f.api.store, f.task.id);
const events = (f: Fixture) =>
  f.api.store.db.prepare('SELECT * FROM outbox WHERE task_id=? ORDER BY sequence').all(f.task.id);
async function role(f: Fixture, value: 'edit' | 'view' | null) {
  const response = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
    role: value,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function command(f: Fixture, action: Action) {
  const response = await f.api.call(`tasks/${f.task.id}/${action}`, f.alice, {
    expectedRevision: taskState(f).revision,
    activeRunAction: 'stop',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function patch(f: Fixture, nextTitle: string) {
  const response = await f.api.call(
    `tasks/${f.task.id}`,
    f.alice,
    { expectedRevision: taskState(f).revision, title: nextTitle },
    randomUUID(),
    'PATCH',
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function install(page: Page, account: Account) {
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
}
async function observePatch(page: Page, f: Fixture, nextTitle: string) {
  const observed = page.waitForResponse(async (reply) => {
    if (reply.url() !== `${origin}/api/v1/workbench` || reply.status() !== 200) return false;
    const value = (await reply.json()) as Workbench;
    return value.tasks.some((task) => task.id === f.task.id && task.title === nextTitle);
  });
  const current = await patch(f, nextTitle);
  await (await observed).finished();
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
  return current;
}
async function open(page: Page, f: Fixture, theme: 'dark' | 'light' = 'dark') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4343, host: '127.0.0.1' });
  await install(page, f.bob);
  await page.addInitScript(
    ({ userId, spaceId, theme }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, theme },
  );
  await page.goto(`${origin}/tasks/${f.task.id}`);
  await expect(cancelEntry(page)).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Consume real startup SSE before installing failure/ownership boundaries.
  await observePatch(page, f, '状态请求基线：手动更新任务');
  expect(runs(f)).toEqual([]);
}
async function navigateTask(page: Page, task: Task) {
  if (new URL(page.url()).pathname !== `/tasks/${task.id}`) {
    if (await page.getByRole('button', { name: '展开项目导航', exact: true }).count())
      await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
    await page.locator(`a.context-task[href="/tasks/${task.id}"]`).click();
  }
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
async function board(page: Page, f: Fixture) {
  await page.locator(`a.context-link[href="/projects/${f.project.id}"]`).click();
  await page.getByRole('button', { name: '看板', exact: true }).click();
}
async function activate(page: Page, f: Fixture, action: Action, twice = false) {
  if (action === 'start') {
    await board(page, f);
    const select = page.getByLabel(`${f.task.shortId} 状态`, { exact: true });
    if (twice)
      await select.evaluate((element: HTMLSelectElement) => {
        element.value = 'in_progress';
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
    else await select.selectOption('in_progress');
  } else {
    const button = page.locator('main').getByRole('button', {
      name: action === 'reopen' ? '重新打开' : '标记完成',
      exact: true,
    });
    if (twice)
      await button.evaluate((element: HTMLButtonElement) => {
        element.click();
        element.click();
      });
    else await button.click();
  }
}
function writes(page: Page, f: Fixture) {
  const records: Packet[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.startsWith(`/api/v1/tasks/${f.task.id}/`)
    )
      records.push(packet(request));
  });
  return records;
}
function originalPacket(records: Packet[], f: Fixture, action: Action, before: Task) {
  expect(records).toHaveLength(1);
  expect(records[0]!.path).toBe(`/api/v1/tasks/${f.task.id}/${action}`);
  expect(records[0]!.key).toMatch(/^[\w.:-]+$/);
  expect(JSON.parse(records[0]!.body!)).toEqual({
    expectedRevision: before.revision,
    activeRunAction: 'stop',
  });
}
function unchanged(
  f: Fixture,
  before: Task,
  previousHistory: ReturnType<typeof history>,
  previousEvents: ReturnType<typeof events>,
) {
  expect(taskState(f)).toEqual(before);
  expect(history(f)).toEqual(previousHistory);
  expect(events(f)).toEqual(previousEvents);
  expect(runs(f)).toEqual([]);
}
function oneEffect(
  f: Fixture,
  action: Action,
  before: Task,
  previousHistory: ReturnType<typeof history>,
  previousEvents: ReturnType<typeof events>,
) {
  expect(taskState(f)).toMatchObject({
    id: before.id,
    status: target[action],
    revision: before.revision + 1,
  });
  const currentEvents = events(f);
  expect(currentEvents).toHaveLength(previousEvents.length + 1);
  expect(currentEvents.slice(0, -1)).toEqual(previousEvents);
  expect(currentEvents.at(-1)).toMatchObject({ kind: 'task.updated', task_id: f.task.id });
  if (action === 'start') expect(history(f)).toEqual(previousHistory);
  else {
    expect(history(f)).toHaveLength(previousHistory.length + 1);
    expect(history(f)[0]).toMatchObject({
      taskId: f.task.id,
      action,
      actorId: f.bob.user.id,
      taskRevision: before.revision + 1,
    });
    expect(history(f).slice(1)).toEqual(previousHistory);
  }
  expect(runs(f)).toEqual([]);
}
function reportCleanup(errors: unknown[], failed: boolean) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, '直接任务状态恢复夹具清理失败');
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function hold(
  page: Page,
  pattern: string,
  beforeFetch = false,
  denyRead = false,
  loseResponse = false,
) {
  const requestGate = gate(),
    responseGate = gate();
  if (!beforeFetch) requestGate.resolve();
  let capturing = true;
  const captured: (Packet & { status?: number; result?: unknown })[] = [];
  const pendingWork: Promise<void>[] = [],
    errors: unknown[] = [];
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '延迟原请求失败');
  };
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    const record: (typeof captured)[number] = packet(route.request());
    captured.push(record);
    const work = (async () => {
      await requestGate.promise;
      const response = await route.fetch();
      record.status = response.status();
      record.result = await response.json();
      await responseGate.promise;
      if (loseResponse) await route.abort('failed');
      else if (denyRead)
        await route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: '本次工作台读取被拒绝' } },
        });
      else await route.fulfill({ response });
    })().catch((error) => {
      errors.push(error);
    });
    pendingWork.push(work);
    await work;
  };
  await page.route(pattern, handler);
  return {
    captured,
    async reached(code?: number) {
      await expect
        .poll(() => {
          check();
          return code === undefined
            ? captured.length
            : captured.filter((item) => item.status === code).length;
        })
        .toBeGreaterThan(0);
    },
    stopCapture() {
      capturing = false;
    },
    releaseRequest() {
      requestGate.resolve();
    },
    async releaseAndDrain() {
      capturing = false;
      requestGate.resolve();
      responseGate.resolve();
      await Promise.all(pendingWork);
      check();
    },
    async dispose(failed: boolean) {
      const cleanup: unknown[] = [];
      try {
        await this.releaseAndDrain();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await page.unroute(pattern, handler);
      } catch (error) {
        cleanup.push(error);
      }
      reportCleanup(cleanup, failed);
    },
  };
}
async function run(
  page: Page,
  action: Action,
  body: (f: Fixture, owned: Disposable[]) => Promise<void>,
) {
  const f = await fixture(action),
    owned: Disposable[] = [];
  let failed = false;
  try {
    await body(f, owned);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const item of owned) {
      try {
        await item.dispose(failed || errors.length > 0);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const close of [
      () => page.unrouteAll({ behavior: 'wait' }),
      () => page.context().close(),
      () => f.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    reportCleanup(errors, failed);
  }
}
async function makeUnknown(page: Page, f: Fixture, action: Action, twice = false) {
  const pattern = endpoint(f, action),
    abort = (route: Route) => route.abort('failed');
  await page.route(pattern, abort);
  try {
    await activate(page, f, action, twice);
    await expect(dialog(page, action)).toBeVisible();
    await expect(pending(page)).toBeVisible();
    await expect(recover(page)).toBeEnabled();
    await expect(dialog(page, action).getByRole('checkbox')).toHaveCount(0);
  } finally {
    await page.unroute(pattern, abort);
  }
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function clearNotice(page: Page) {
  const close = page.getByRole('button', { name: '关闭通知', exact: true });
  if (await close.count()) await close.click();
}
async function screenshot(page: Page, name: string, action: Action, known = false) {
  const actionButton = known ? refresh(page) : recover(page);
  await prepareScreenshot(page, actionButton, dialog(page, action));
  await expect(dialog(page, action).getByRole('heading')).toBeInViewport({ ratio: 1 });
  await expect(known ? accepted(page) : pending(page)).toBeInViewport({ ratio: 1 });
  await expect(dismiss(page)).toBeInViewport({ ratio: 1 });
  await expect(dialog(page, action).getByRole('checkbox')).toHaveCount(0);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${name}` });
}

for (const action of ['start', 'reopen', 'complete'] as const) {
  test(`${action}直接首击立即发送，提交前断网后关闭导航与其他入口恢复同包，重复点击只提交一次`, async ({
    page,
  }) => {
    await run(page, action, async (f, owned) => {
      await open(page, f);
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, action, true);
      originalPacket(outgoing, f, action, before);
      unchanged(f, before, previousHistory, previousEvents);
      if (action === 'start') await screenshot(page, '212-direct-start-unknown-dark.png', action);
      await dismiss(page).click();
      await navigateTask(page, f.other);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await navigateTask(page, before);
      await cancelEntry(page).click();
      await expect(dialog(page, action)).toBeVisible();
      await expect(pending(page)).toBeVisible();
      await dismiss(page).click();
      await board(page, f);
      await page
        .getByLabel(`${before.shortId} 状态`, { exact: true })
        .selectOption(action === 'reopen' ? 'in_progress' : 'done');
      await expect(dialog(page, action)).toBeVisible();
      expect(outgoing).toHaveLength(1);
      const retry = await hold(page, endpoint(f, action), true);
      owned.push(retry);
      await recover(page).evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await retry.reached();
      await expect(recover(page)).toBeDisabled();
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      retry.releaseRequest();
      await retry.reached(200);
      await retry.releaseAndDrain();
      await expect(dialog(page, action)).toHaveCount(0);
      oneEffect(f, action, before, previousHistory, previousEvents);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
    });
  });

  test(`${action}已提交但回执丢失，后来标题修订变化仍只恢复原路径正文键和原回执`, async ({
    page,
  }) => {
    await run(page, action, async (f) => {
      await open(page, f);
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      const receipts: Task[] = [];
      const pattern = endpoint(f, action);
      const lost = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        receipts.push((await response.json()) as Task);
        await route.abort('failed');
      };
      await page.route(pattern, lost);
      await activate(page, f, action);
      await expect(pending(page)).toBeVisible();
      await expect(recover(page)).toBeEnabled();
      await page.unroute(pattern, lost);
      originalPacket(outgoing, f, action, before);
      oneEffect(f, action, before, previousHistory, previousEvents);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        id: before.id,
        status: target[action],
        revision: before.revision + 1,
      });
      await dismiss(page).click();
      await navigateTask(page, taskState(f));
      const current = await observePatch(page, f, `${action}已提交后的独立标题修改`);
      const committedHistory = history(f),
        committedEvents = events(f);
      await cancelEntry(page).click();
      await expect(dialog(page, action)).toContainText(before.title);
      await expect(pending(page)).toContainText(`原修订 ${before.revision}`);
      const ack = page.waitForResponse(
        (reply) => reply.url() === pattern && reply.status() === 200,
      );
      await recover(page).click();
      expect(await (await ack).json()).toEqual(receipts[0]);
      await expect(dialog(page, action)).toHaveCount(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      unchanged(f, current, committedHistory, committedEvents);
      await expect(page.getByRole('heading', { name: current.title, exact: true })).toBeVisible();
    });
  });

  test(`${action}有效ACK后Workbench失败保留已接受结果，关闭重开只GET刷新`, async ({ page }) => {
    await run(page, action, async (f) => {
      if (action === 'reopen') await page.setViewportSize({ width: 390, height: 844 });
      await open(page, f, action === 'reopen' ? 'light' : 'dark');
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      let reads = 0;
      const readPattern = `${origin}/api/v1/workbench`;
      const failRead = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        reads++;
        await route.fulfill({
          status: 503,
          json: { error: { code: 'TEMPORARY_FAILURE', message: '原命令已接收，工作台暂不可读' } },
        });
      };
      await page.route(readPattern, failRead);
      const ack = page.waitForResponse(
        (reply) => reply.url() === endpoint(f, action) && reply.status() === 200,
      );
      await activate(page, f, action);
      expect(await (await ack).json()).toMatchObject({
        id: before.id,
        status: target[action],
        revision: before.revision + 1,
      });
      await expect(accepted(page)).toBeVisible();
      await expect(refresh(page)).toBeEnabled();
      await expect(pending(page)).toHaveCount(0);
      await expect(recover(page)).toHaveCount(0);
      originalPacket(outgoing, f, action, before);
      oneEffect(f, action, before, previousHistory, previousEvents);
      expect(reads).toBeGreaterThan(0);
      if (action === 'reopen')
        await screenshot(page, '213-direct-reopen-refresh-mobile-light.png', action, true);
      const committedHistory = history(f),
        committedEvents = events(f);
      await dismiss(page).click();
      await navigateTask(page, before);
      await cancelEntry(page).click();
      await expect(accepted(page)).toBeVisible();
      const current = await patch(f, `${action}ACK后的独立标题修订`);
      await page.unroute(readPattern, failRead);
      const get = page.waitForResponse(
        (reply) => reply.url() === readPattern && reply.status() === 200,
      );
      await refresh(page).click();
      await (await get).finished();
      await expect(dialog(page, action)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: current.title, exact: true })).toBeVisible();
      expect(outgoing).toHaveLength(1);
      expect(taskState(f)).toEqual(current);
      expect(history(f)).toEqual(committedHistory);
      expect(events(f)).toHaveLength(committedEvents.length + 1);
      expect(runs(f)).toEqual([]);
    });
  });

  test(`${action}尚未提交的原包不随独立标题修订重设，重试原修订冲突不会悄悄重新发送`, async ({
    page,
  }) => {
    await run(page, action, async (f) => {
      if (action === 'complete') await page.setViewportSize({ width: 390, height: 844 });
      await open(page, f, action === 'complete' ? 'light' : 'dark');
      const before = taskState(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, action);
      await dismiss(page).click();
      await navigateTask(page, before);
      const current = await observePatch(page, f, `${action}未发送期间的独立标题修订`);
      const committedHistory = history(f),
        committedEvents = events(f);
      await cancelEntry(page).click();
      await expect(dialog(page, action)).toContainText(before.title);
      await expect(pending(page)).toContainText(`原修订 ${before.revision}`);
      if (action === 'complete')
        await screenshot(page, '214-direct-complete-original-revision-mobile-light.png', action);
      const conflict = page.waitForResponse(
        (reply) => reply.url() === endpoint(f, action) && reply.status() === 409,
      );
      await recover(page).click();
      await (await conflict).finished();
      await expect(pending(page)).toHaveCount(0);
      await expect(dialog(page, action)).toHaveCount(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      originalPacket(outgoing.slice(0, 1), f, action, before);
      unchanged(f, current, committedHistory, committedEvents);
    });
  });
}

for (const access of ['view', null] as const) {
  test(`直接未知请求关闭后当前${access === 'view' ? '降权' : '撤权'}删除原包，重授只恢复入口`, async ({
    page,
  }) => {
    await run(page, 'complete', async (f) => {
      await open(page, f);
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, 'complete');
      await dismiss(page).click();
      await role(f, access);
      if (access === 'view') await expect(cancelEntry(page)).toBeDisabled();
      else
        await expect(
          page.getByRole('heading', { name: '当前无法访问此任务', exact: true }),
        ).toBeVisible();
      const denied = await f.api.call(
        `tasks/${f.task.id}/complete`,
        f.bob,
        JSON.parse(outgoing[0]!.body!),
        outgoing[0]!.key,
      );
      expect([403, 404]).toContain(denied.statusCode);
      await role(f, 'edit');
      await expect(cancelEntry(page)).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await cancelEntry(page).click();
      const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
      await expect(fresh).toBeVisible();
      await expect(pending(page)).toHaveCount(0);
      await expect(fresh.getByRole('button', { name: '确认取消任务', exact: true })).toBeEnabled();
      expect(outgoing).toHaveLength(1);
      unchanged(f, before, previousHistory, previousEvents);
      await fresh.getByRole('button', { name: '返回', exact: true }).click();
      await activate(page, f, 'complete');
      await expect(status(page)).toHaveText('已完成');
      expect(outgoing).toHaveLength(2);
      expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
      expect(outgoing[1]!.body).toBe(outgoing[0]!.body);
      oneEffect(f, 'complete', before, previousHistory, previousEvents);
    });
  });
}

for (const reset of ['space', 'identity'] as const) {
  test(`直接未知请求暂时关闭后${reset === 'space' ? '切换空间' : '退出更换账号'}清除原包，返回不自动写入或恢复`, async ({
    page,
  }) => {
    await run(page, 'complete', async (f) => {
      await open(page, f);
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, 'complete');
      await dismiss(page).click();
      if (reset === 'space') {
        await page
          .getByLabel('当前工作空间', { exact: true })
          .selectOption(`personal-${f.bob.user.id}`);
        await expect(page.getByLabel('当前工作空间')).toHaveValue(`personal-${f.bob.user.id}`);
        await page.getByLabel('当前工作空间', { exact: true }).selectOption(f.bob.spaceId);
        await navigateTask(page, before);
      } else {
        for (const account of [f.alice, f.bob]) {
          await page
            .getByRole('navigation', { name: '主导航' })
            .getByRole('link', { name: '资源与设置', exact: true })
            .click();
          await page.getByRole('button', { name: '退出登录', exact: true }).click();
          await page
            .getByLabel('邮箱', { exact: true })
            .fill(account === f.alice ? 'alice@example.invalid' : 'bob@example.invalid');
          await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
          await page.getByRole('button', { name: '登录工作台', exact: true }).click();
          await page.getByLabel('当前工作空间', { exact: true }).selectOption(account.spaceId);
          await navigateTask(page, before);
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
      }
      await cancelEntry(page).click();
      const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
      await expect(fresh).toBeVisible();
      await expect(pending(page)).toHaveCount(0);
      await expect(accepted(page)).toHaveCount(0);
      await expect(fresh.getByRole('button', { name: '确认取消任务', exact: true })).toBeEnabled();
      expect(outgoing).toHaveLength(1);
      expect(
        await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        ),
      ).not.toContain(outgoing[0]!.key);
      unchanged(f, before, previousHistory, previousEvents);
    });
  });
}

for (const outcome of ['success', 'refusal'] as const) {
  test(`直接原POST的真实${outcome === 'success' ? '成功' : '拒绝'}晚回不能复活撤权包或覆盖重新授权后的新确认`, async ({
    page,
  }) => {
    await run(page, 'complete', async (f, owned) => {
      await open(page, f);
      const outgoing = writes(page, f);
      await makeUnknown(page, f, 'complete');
      const old = await hold(page, endpoint(f, 'complete'), outcome === 'refusal');
      owned.push(old);
      await recover(page).click();
      await old.reached(outcome === 'success' ? 200 : undefined);
      old.stopCapture();
      await role(f, 'view');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(cancelEntry(page)).toBeDisabled();
      if (outcome === 'refusal') {
        old.releaseRequest();
        await old.reached(403);
      }
      await role(f, 'edit');
      if (outcome === 'success') await command(f, 'reopen');
      await expect(status(page)).toHaveText('待处理');
      await expect(cancelEntry(page)).toBeEnabled();
      await clearNotice(page);
      await cancelEntry(page).click();
      const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
      await expect(fresh.getByRole('button', { name: '确认取消任务', exact: true })).toBeEnabled();
      const current = taskState(f),
        committedHistory = history(f),
        committedEvents = events(f);
      const response = page.waitForResponse((reply) => reply.url() === endpoint(f, 'complete'));
      await old.releaseAndDrain();
      await (await response).finished();
      await painted(page);
      expect(await fresh.isVisible()).toBe(true);
      expect(
        await fresh.getByRole('button', { name: '确认取消任务', exact: true }).isEnabled(),
      ).toBe(true);
      expect(await pending(page).count()).toBe(0);
      expect(await accepted(page).count()).toBe(0);
      expect(await page.locator('.toast').count()).toBe(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      unchanged(f, current, committedHistory, committedEvents);
      await fresh.getByRole('button', { name: '确认取消任务', exact: true }).click();
      await expect(status(page)).toHaveText('已取消');
      expect(outgoing).toHaveLength(3);
      expect(outgoing[2]!.key).not.toBe(outgoing[0]!.key);
    });
  });
}

test('直接原ACK拥有的所有Workbench晚读不能覆盖重授权限后的新确认或任务状态', async ({ page }) => {
  await run(page, 'complete', async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f);
    const post = await hold(page, endpoint(f, 'complete'));
    owned.push(post);
    await activate(page, f, 'complete');
    await post.reached(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Consume the real commit's SSE before trapping every command-owned GET.
    await expect(status(page)).toHaveText('已完成');
    const oldReads = await hold(page, `${origin}/api/v1/workbench`);
    owned.push(oldReads);
    await post.releaseAndDrain();
    await oldReads.reached(200);
    oldReads.stopCapture();
    await role(f, 'view');
    await expect(cancelEntry(page)).toBeDisabled();
    await role(f, 'edit');
    await command(f, 'reopen');
    await expect(status(page)).toHaveText('待处理');
    await expect(cancelEntry(page)).toBeEnabled();
    await clearNotice(page);
    await cancelEntry(page).click();
    const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
    await expect(fresh).toBeVisible();
    const current = taskState(f),
      committedHistory = history(f),
      committedEvents = events(f);
    const delivered = page.waitForResponse(async (reply) => {
      if (reply.url() !== `${origin}/api/v1/workbench` || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.status === 'done');
    });
    await oldReads.releaseAndDrain();
    await (await delivered).finished();
    await painted(page);
    expect(await status(page).textContent()).toBe('待处理');
    expect(await fresh.isVisible()).toBe(true);
    expect(await fresh.getByRole('button', { name: '确认取消任务', exact: true }).isEnabled()).toBe(
      true,
    );
    expect(await pending(page).count()).toBe(0);
    expect(await accepted(page).count()).toBe(0);
    expect(await page.locator('.toast').count()).toBe(0);
    expect(outgoing).toHaveLength(1);
    unchanged(f, current, committedHistory, committedEvents);
  });
});

test('旧Workbench拒绝晚于较新成功读取不能清直接原包，当前拒绝永久清除已关闭包', async ({
  page,
}) => {
  await run(page, 'complete', async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f);
    await makeUnknown(page, f, 'complete');
    const readPattern = `${origin}/api/v1/workbench`;
    const old = await hold(page, readPattern, false, true);
    owned.push(old);
    await patch(f, '触发较旧的工作台读取');
    await old.reached(200);
    old.stopCapture();
    await observePatch(page, f, '较新读取确认仍可编辑');
    await dismiss(page).click();
    const denied = page.waitForResponse(
      (reply) => reply.url() === readPattern && reply.status() === 403,
    );
    await old.releaseAndDrain();
    await (await denied).finished();
    await painted(page);
    await cancelEntry(page).click();
    await expect(dialog(page, 'complete')).toBeVisible();
    await expect(pending(page)).toBeVisible();
    await expect(recover(page)).toBeEnabled();
    await dismiss(page).click();
    const currentRead = await hold(page, readPattern, false, true);
    owned.push(currentRead);
    await patch(f, '触发当前工作台明确拒绝');
    await currentRead.reached(200);
    const currentDenial = page.waitForResponse(
      (reply) => reply.url() === readPattern && reply.status() === 403,
    );
    await currentRead.releaseAndDrain();
    await (await currentDenial).finished();
    await painted(page);
    const current = await observePatch(page, f, '恢复可见性后没有旧请求');
    const committedHistory = history(f),
      committedEvents = events(f);
    await cancelEntry(page).click();
    const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
    await expect(fresh).toBeVisible();
    await expect(pending(page)).toHaveCount(0);
    await expect(accepted(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    unchanged(f, current, committedHistory, committedEvents);
  });
});

test('直接200回执的Task身份、目标状态、原修订不匹配仍未知，真实回执后才能只GET', async ({
  page,
}) => {
  await run(page, 'complete', async (f) => {
    await open(page, f);
    const before = taskState(f),
      previousHistory = history(f),
      previousEvents = events(f),
      outgoing = writes(page, f);
    const received: Task[] = [],
      pattern = endpoint(f, 'complete');
    const mismatch = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const receipt = (await response.json()) as Task;
      received.push(receipt);
      const invalid =
        received.length === 1
          ? { ...receipt, id: f.other.id }
          : received.length === 2
            ? { ...receipt, status: 'in_progress' }
            : { ...receipt, revision: receipt.revision + 1 };
      await route.fulfill({ status: 200, json: invalid });
    };
    await page.route(pattern, mismatch);
    await activate(page, f, 'complete');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await recover(page).click();
      await expect(pending(page)).toContainText('服务未返回可核对的原请求回执');
      await expect(recover(page)).toBeEnabled();
      await expect(accepted(page)).toHaveCount(0);
      await expect(refresh(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(attempt + 1);
      expect(outgoing.every((item) => JSON.stringify(item) === JSON.stringify(outgoing[0]))).toBe(
        true,
      );
      expect(received.every((item) => JSON.stringify(item) === JSON.stringify(received[0]))).toBe(
        true,
      );
      oneEffect(f, 'complete', before, previousHistory, previousEvents);
    }
    await page.unroute(pattern, mismatch);
    const committedHistory = history(f),
      committedEvents = events(f),
      current = taskState(f);
    await recover(page).click();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    expect(outgoing).toHaveLength(4);
    expect(outgoing[3]).toEqual(outgoing[0]);
    unchanged(f, current, committedHistory, committedEvents);
  });
});

for (const outcome of ['lost', 'accepted'] as const) {
  test(`直接首POST持有期间只导航，晚${outcome === 'lost' ? '丢失回执' : '成功ACK'}不会在另一任务弹窗，返回才恢复原包`, async ({
    page,
  }) => {
    await run(page, 'complete', async (f, owned) => {
      await open(page, f);
      const before = taskState(f),
        previousHistory = history(f),
        previousEvents = events(f),
        outgoing = writes(page, f);
      const post = await hold(page, endpoint(f, 'complete'), false, false, outcome === 'lost');
      owned.push(post);
      await activate(page, f, 'complete');
      await post.reached(200);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await navigateTask(page, f.other);
      const settled =
        outcome === 'lost'
          ? page.waitForEvent(
              'requestfailed',
              (request) => request.url() === endpoint(f, 'complete'),
            )
          : page
              .waitForResponse(
                (reply) => reply.url() === endpoint(f, 'complete') && reply.status() === 200,
              )
              .then((reply) => reply.finished());
      await post.releaseAndDrain();
      await settled;
      await painted(page);
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.locator('.toast').count()).toBe(0);
      await expect(page.getByRole('heading', { name: f.other.title, exact: true })).toBeVisible();
      originalPacket(outgoing, f, 'complete', before);
      oneEffect(f, 'complete', before, previousHistory, previousEvents);
      const committedHistory = history(f),
        committedEvents = events(f),
        current = taskState(f);
      await navigateTask(page, current);
      await cancelEntry(page).click();
      await expect(dialog(page, 'complete')).toBeVisible();
      if (outcome === 'accepted') {
        await expect(accepted(page)).toBeVisible();
        await expect(recover(page)).toHaveCount(0);
        await refresh(page).click();
      } else {
        await expect(pending(page)).toBeVisible();
        await recover(page).click();
      }
      await expect(dialog(page, 'complete')).toHaveCount(0);
      expect(outgoing).toEqual(outcome === 'accepted' ? [outgoing[0]] : [outgoing[0], outgoing[0]]);
      unchanged(f, current, committedHistory, committedEvents);
    });
  });
}

test('直接首POST的晚ACK不影响另一Task新确认，原Task随后恢复已接受结果只GET', async ({ page }) => {
  await run(page, 'complete', async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f);
    const post = await hold(page, endpoint(f, 'complete'));
    owned.push(post);
    await activate(page, f, 'complete');
    await post.reached(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await navigateTask(page, f.other);
    await cancelEntry(page).click();
    const fresh = page.getByRole('dialog', { name: '取消任务', exact: true });
    await expect(fresh).toContainText(f.other.title);
    const ack = page.waitForResponse(
      (reply) => reply.url() === endpoint(f, 'complete') && reply.status() === 200,
    );
    await post.releaseAndDrain();
    await (await ack).finished();
    await painted(page);
    expect(await fresh.isVisible()).toBe(true);
    expect(await fresh.getByRole('button', { name: '确认取消任务', exact: true }).isEnabled()).toBe(
      true,
    );
    expect(await fresh.textContent()).toContain(f.other.title);
    expect(await pending(page).count()).toBe(0);
    expect(await accepted(page).count()).toBe(0);
    expect(await page.locator('.toast').count()).toBe(0);
    await fresh.getByRole('button', { name: '返回', exact: true }).click();
    const current = taskState(f),
      committedHistory = history(f),
      committedEvents = events(f);
    await navigateTask(page, current);
    await cancelEntry(page).click();
    await expect(accepted(page)).toBeVisible();
    await expect(recover(page)).toHaveCount(0);
    await refresh(page).click();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    unchanged(f, current, committedHistory, committedEvents);
    expect(f.as(() => f.api.store.getTask(f.other.id))).toEqual(f.other);
  });
});

test('直接ACK后的在途Workbench只导航即失效，晚旧快照不覆盖当前状态且原包仍只GET', async ({
  page,
}) => {
  await run(page, 'complete', async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f),
      readPattern = `${origin}/api/v1/workbench`;
    const post = await hold(page, endpoint(f, 'complete'));
    owned.push(post);
    await activate(page, f, 'complete');
    await post.reached(200);
    await expect(status(page)).toHaveText('已完成');
    const oldRead = await hold(page, readPattern);
    owned.push(oldRead);
    await post.releaseAndDrain();
    await oldRead.reached(200);
    oldRead.stopCapture();
    await navigateTask(page, f.other);
    const newer = page.waitForResponse(async (reply) => {
      if (reply.url() !== readPattern || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.status === 'todo');
    });
    await command(f, 'reopen');
    await (await newer).finished();
    const current = taskState(f),
      committedHistory = history(f),
      committedEvents = events(f);
    const delivered = page.waitForResponse(async (reply) => {
      if (reply.url() !== readPattern || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.status === 'done');
    });
    await oldRead.releaseAndDrain();
    await (await delivered).finished();
    await painted(page);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.locator('.toast').count()).toBe(0);
    await navigateTask(page, current);
    await expect(status(page)).toHaveText('待处理');
    await cancelEntry(page).click();
    await expect(accepted(page)).toBeVisible();
    await expect(recover(page)).toHaveCount(0);
    await refresh(page).click();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    unchanged(f, current, committedHistory, committedEvents);
  });
});

test('看板直接start在途切换项目查询页不弹出迟到恢复，返回后才确认原包', async ({ page }) => {
  await run(page, 'start', async (f, owned) => {
    await open(page, f);
    const before = taskState(f),
      previousHistory = history(f),
      previousEvents = events(f),
      outgoing = writes(page, f);
    const post = await hold(page, endpoint(f, 'start'), false, false, true);
    owned.push(post);
    await activate(page, f, 'start');
    await post.reached(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/projects/${f.project.id}?tab=overview`);
    const failed = page.waitForEvent(
      'requestfailed',
      (request) => request.url() === endpoint(f, 'start'),
    );
    await post.releaseAndDrain();
    await failed;
    await painted(page);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await expect(page.getByRole('heading', { name: '目标与进度', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '需求与任务', exact: true }).click();
    await page.getByLabel(`${before.shortId} 状态`, { exact: true }).selectOption('done');
    await expect(dialog(page, 'start')).toBeVisible();
    await expect(pending(page)).toBeVisible();
    originalPacket(outgoing, f, 'start', before);
    await recover(page).click();
    await expect(dialog(page, 'start')).toHaveCount(0);
    expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
    oneEffect(f, 'start', before, previousHistory, previousEvents);
  });
});

test('直接当前POST真实403先于Workbench撤权快照到达也清原包，重授后新首击使用新键', async ({
  page,
}) => {
  await run(page, 'complete', async (f, owned) => {
    await open(page, f);
    const before = taskState(f),
      previousHistory = history(f),
      previousEvents = events(f),
      outgoing = writes(page, f);
    const post = await hold(page, endpoint(f, 'complete'), true);
    owned.push(post);
    const readPattern = `${origin}/api/v1/workbench`;
    const unreadable = (route: Route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'TEMPORARY_FAILURE', message: '权限快照暂时不可读' } },
      });
    await page.route(readPattern, unreadable);
    await activate(page, f, 'complete');
    await post.reached();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await role(f, 'view');
    // The real command sees current authority while browser Workbench stays stale.
    await expect(cancelEntry(page)).toBeEnabled();
    post.stopCapture();
    post.releaseRequest();
    await post.reached(403);
    const denied = page.waitForResponse(
      (reply) => reply.url() === endpoint(f, 'complete') && reply.status() === 403,
    );
    await post.releaseAndDrain();
    await (await denied).finished();
    await expect(page.locator('.toast')).toContainText('任务当前不可编辑');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    originalPacket(outgoing, f, 'complete', before);
    unchanged(f, before, previousHistory, previousEvents);
    await page.unroute(readPattern, unreadable);
    await role(f, 'edit');
    await observePatch(page, f, '重新授权且确认新工作台读取');
    const current = taskState(f),
      committedHistory = history(f),
      committedEvents = events(f);
    await activate(page, f, 'complete');
    await expect(status(page)).toHaveText('已完成');
    expect(outgoing).toHaveLength(2);
    expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
    expect(JSON.parse(outgoing[1]!.body!)).toEqual({
      expectedRevision: current.revision,
      activeRunAction: 'stop',
    });
    oneEffect(f, 'complete', current, committedHistory, committedEvents);
  });
});
