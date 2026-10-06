import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { branchResultFixture } from '../helpers/branch-results.js';
import { PASSWORD, type Account } from '../helpers/team.js';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';
import { completionEvents, prepareScreenshot } from '../helpers/task-reliability.js';

const origin = 'http://127.0.0.1:4342';
type Action = 'cancel' | 'complete';
type Packet = { path: string; body: string | null; key: string };
type Disposable = { dispose(failed: boolean): Promise<void> };
const dialog = (page: Page, action: Action = 'cancel') =>
  page.getByRole('dialog', {
    name: action === 'cancel' ? '取消任务' : '标记任务完成',
    exact: true,
  });
const choice = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('checkbox', { name: '同时请求停止当前执行' });
const confirm = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', {
    name: action === 'cancel' ? '确认取消任务' : '标记完成',
    exact: true,
  });
const entry = (page: Page, action: Action = 'cancel') =>
  page.locator(action === 'cancel' ? '.w1-task-scope' : 'main').getByRole('button', {
    name: action === 'cancel' ? '取消任务…' : '标记完成',
    exact: true,
  });
const pending = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByLabel('任务状态请求待确认', { exact: true });
const accepted = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByLabel('任务状态请求已确认', { exact: true });
const recover = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', { name: '确认原请求结果', exact: true });
const refresh = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', { name: '刷新任务状态', exact: true });
const dismiss = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', { name: '暂时关闭', exact: true });
const status = (page: Page) => page.locator('.task-title .badge');
const endpoint = (f: Fixture, action: Action) => `${origin}/api/v1/tasks/${f.task.id}/${action}`;
const packet = (request: Request): Packet => ({
  path: new URL(request.url()).pathname,
  body: request.postData(),
  key: request.headers()['idempotency-key'] ?? '',
});

async function fixture() {
  const f = await branchResultFixture(origin);
  try {
    // Only real control endpoints and the existing explicit node-protocol substitute.
    // This fixture never starts an executor, local browser, or paid provider.
    const active = f.begin(1, 'codex');
    active.start();
    const other = (await f.api.task(f.alice, f.project.id, '另一个任务的独立确认')) as Task;
    const grant = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    return { ...f, active, other };
  } catch (error) {
    try {
      await f.close();
    } catch (cause) {
      reportCleanup([cause], true);
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const taskState = (f: Fixture) => f.as(() => f.api.store.getTask(f.task.id));
const runs = (f: Fixture) => f.as(() => f.api.store.runs(f.task.id));
const taskEvents = (f: Fixture) =>
  f.api.store.db
    .prepare(
      "SELECT sequence,kind FROM outbox WHERE task_id=? AND kind='task.updated' ORDER BY sequence",
    )
    .all(f.task.id);
function history(f: Fixture) {
  return completionEvents(f.api.store, f.task.id);
}
async function role(f: Fixture, value: 'edit' | 'view' | null) {
  const response = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
    role: value,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function command(f: Fixture, action: 'reopen') {
  const response = await f.api.call(`tasks/${f.task.id}/${action}`, f.alice, {
    expectedRevision: taskState(f).revision,
    activeRunAction: 'keep',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function patch(f: Fixture, title: string) {
  const response = await f.api.call(
    `tasks/${f.task.id}`,
    f.alice,
    { expectedRevision: taskState(f).revision, title },
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
async function open(page: Page, f: Fixture, theme: 'dark' | 'light' = 'dark') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const node of f.ns) {
    const headers = { authorization: `Bearer ${node.token}`, 'x-hexu-runner': '1' };
    const hello = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/hello',
      headers,
      payload: { protocol: 1, connectionId: node.connection },
    });
    expect(hello.statusCode, hello.body).toBe(200);
    const at = new Date().toISOString();
    const sync = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/sync',
      headers,
      payload: {
        connectionId: node.connection,
        sequence: 2,
        snapshot: { capturedAt: at, workspaces: [{ ...node.summary, capturedAt: at }] },
      },
    });
    expect(sync.statusCode, sync.body).toBe(200);
  }
  f.active.send('unknown');
  f.active.send('running');
  await f.api.app.listen({ port: 4342, host: '127.0.0.1' });
  await install(page, f.bob);
  await page.addInitScript(
    ({ userId, spaceId, theme }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, theme },
  );
  await page.goto(`${origin}/tasks/${f.task.id}`);
  await expect(entry(page)).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Establish a real post-startup SSE/Workbench baseline. Initial outbox delivery
  // may otherwise race the first owned-read gate or its revision assertions.
  const title = '请求确认基线：订单导出';
  const observed = page.waitForResponse(async (reply) => {
    if (reply.url() !== `${origin}/api/v1/workbench` || reply.status() !== 200) return false;
    const value = (await reply.json()) as Workbench;
    return value.tasks.some((task) => task.id === f.task.id && task.title === title);
  });
  await patch(f, title);
  await (await observed).finished();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function openDialog(page: Page, action: Action = 'cancel') {
  await entry(page, action).click();
  await expect(dialog(page, action)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(choice(page, action)).toBeChecked();
}
async function navigateTask(page: Page, task: Task) {
  await page.locator(`a.context-task[href="/tasks/${task.id}"]`).click();
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}
function writes(page: Page, f: Fixture) {
  const records: Packet[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.match(
        new RegExp(`^/api/v1/tasks/${f.task.id}/(cancel|complete|reopen|start)$`),
      )
    )
      records.push(packet(request));
  });
  return records;
}
function reportCleanup(errors: unknown[], failed: boolean) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, '任务状态请求恢复夹具清理失败');
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function hold(page: Page, pattern: string, beforeFetch = false, denyRead = false) {
  const requestGate = gate(),
    responseGate = gate();
  if (!beforeFetch) requestGate.resolve();
  let capturing = true;
  const captured: (Packet & { status?: number; result?: unknown })[] = [];
  const pending: Promise<void>[] = [],
    errors: unknown[] = [];
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '延迟请求失败');
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
      if (denyRead)
        await route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: '本次工作台读取被拒绝' } },
        });
      else await route.fulfill({ response });
    })().catch((error) => {
      errors.push(error);
    });
    pending.push(work);
    await work;
  };
  await page.route(pattern, handler);
  return {
    captured,
    async reached(status?: number) {
      await expect
        .poll(() => {
          check();
          return status === undefined
            ? captured.length
            : captured.filter((item) => item.status === status).length;
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
      await Promise.all(pending);
      check();
    },
    async dispose(failed: boolean) {
      const cleanup: unknown[] = [];
      capturing = false;
      try {
        await this.releaseAndDrain();
      } catch (error) {
        cleanup.push(error);
      }
      // Hold every read belonging to this old session. Stop, release and drain
      // before unroute, including on failed assertions or a closed browser page.
      try {
        await page.unroute(pattern, handler);
      } catch (error) {
        cleanup.push(error);
      }
      reportCleanup(cleanup, failed);
    },
  };
}
async function run(page: Page, body: (f: Fixture, owned: Disposable[]) => Promise<void>) {
  const f = await fixture(),
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
    for (const action of [
      () => page.unrouteAll({ behavior: 'wait' }),
      () => page.context().close(),
      () => f.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    reportCleanup(errors, failed);
  }
}
async function makeUnknown(page: Page, f: Fixture, action: Action = 'cancel', keep = true) {
  const pattern = endpoint(f, action);
  // Deterministic pre-commit transport loss: never forward this browser request.
  const abort = (route: Route) => route.abort('failed');
  await page.route(pattern, abort);
  try {
    await openDialog(page, action);
    if (keep) await choice(page, action).uncheck();
    await confirm(page, action).click();
    await expect(pending(page, action)).toBeVisible();
    await expect(recover(page, action)).toBeEnabled();
    await expect(choice(page, action)).toBeDisabled();
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
async function screenshot(page: Page, name: string, action: Action, known = false) {
  await prepareScreenshot(
    page,
    known ? refresh(page, action) : recover(page, action),
    dialog(page, action),
  );
  await expect(dialog(page, action).getByRole('heading')).toBeInViewport({ ratio: 1 });
  await expect(known ? accepted(page, action) : pending(page, action)).toBeInViewport({ ratio: 1 });
  await expect(choice(page, action)).toBeInViewport({ ratio: 1 });
  await expect(choice(page, action)).toBeDisabled();
  await expect(known ? refresh(page, action) : recover(page, action)).toBeInViewport({ ratio: 1 });
  await expect(dismiss(page, action)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${name}` });
}

for (const action of ['cancel', 'complete'] as const) {
  test(`${action}提交前断网固定原包键和停止选择，关闭导航与另一状态入口恢复原请求，双击只提交一次`, async ({
    page,
  }) => {
    await run(page, async (f, owned) => {
      await open(page, f);
      const before = taskState(f),
        originalRuns = runs(f),
        originalHistory = await history(f),
        events = taskEvents(f);
      const outgoing = writes(page, f);
      const keep = action === 'complete';
      await makeUnknown(page, f, action, keep);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.key).toMatch(/^[\w.:-]+$/);
      expect(JSON.parse(outgoing[0]!.body!)).toEqual({
        expectedRevision: before.revision,
        activeRunAction: keep ? 'keep' : 'stop',
      });
      expect(taskState(f)).toEqual(before);
      expect(taskEvents(f)).toEqual(events);
      expect(await history(f)).toEqual(originalHistory);
      expect(runs(f)).toEqual(originalRuns);
      await expect(choice(page, action)).toBeChecked({ checked: !keep });
      if (action === 'cancel') await screenshot(page, '210-task-status-unknown-dark.png', action);
      await dismiss(page, action).click();
      await navigateTask(page, f.other);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await navigateTask(page, before);
      // Opposite task command cannot start a fresh operation while one is unknown.
      await entry(page, action === 'cancel' ? 'complete' : 'cancel').click();
      await expect(pending(page, action)).toBeVisible();
      await expect(choice(page, action)).toBeChecked({ checked: !keep });
      await dismiss(page, action).click();
      await page.locator(`a.context-link[href="/projects/${f.project.id}"]`).click();
      await page.getByRole('button', { name: '看板', exact: true }).click();
      await page.getByLabel(`${before.shortId} 状态`, { exact: true }).selectOption('todo');
      await expect(pending(page, action)).toBeVisible();
      await expect(choice(page, action)).toBeDisabled();
      expect(outgoing).toHaveLength(1);
      await dismiss(page, action).click();
      await navigateTask(page, before);
      await entry(page, action).click();
      const retry = await hold(page, endpoint(f, action), true);
      owned.push(retry);
      await recover(page, action).evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await retry.reached();
      await expect(recover(page, action)).toBeDisabled();
      await expect(choice(page, action)).toBeDisabled();
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      retry.releaseRequest();
      await retry.reached(200);
      await retry.releaseAndDrain();
      await expect(dialog(page, action)).toHaveCount(0);
      await expect(status(page)).toHaveText(action === 'cancel' ? '已取消' : '已完成');
      expect(taskState(f).revision).toBe(before.revision + 1);
      expect(taskEvents(f)).toHaveLength(events.length + 1);
      expect((await history(f)).map((item) => item.action)).toEqual([
        action,
        ...originalHistory.map((item) => item.action),
      ]);
      if (keep) expect(runs(f)).toEqual(originalRuns);
      else
        expect(runs(f).find((item) => item.id === f.active.run.id)).toMatchObject({
          state: 'stopping',
          node: { terminationConfirmed: false },
        });
    });
  });

  test(`${action}真实提交丢失ACK后任务再次变化，明确恢复仍取原回执且不重复状态或停止副作用`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f);
      const before = taskState(f),
        originalHistory = await history(f);
      const outgoing = writes(page, f);
      let receipt: unknown;
      const lost = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        receipt = await response.json();
        await route.abort('failed');
      };
      await page.route(endpoint(f, action), lost);
      await openDialog(page, action);
      if (action === 'cancel') await choice(page, action).uncheck();
      await confirm(page, action).click();
      await expect(pending(page, action)).toBeVisible();
      await expect(recover(page, action)).toBeEnabled();
      await page.unroute(endpoint(f, action), lost);
      expect(receipt).toMatchObject({
        id: before.id,
        status: action === 'cancel' ? 'cancelled' : 'done',
        revision: before.revision + 1,
      });
      expect(JSON.parse(outgoing[0]!.body!)).toEqual({
        expectedRevision: before.revision,
        activeRunAction: action === 'complete' ? 'stop' : 'keep',
      });
      await dismiss(page, action).click();
      // The normal reopen entry must first resume the uncertain cancel/complete.
      await expect(status(page)).toHaveText(action === 'cancel' ? '已取消' : '已完成');
      await page.locator('main').getByRole('button', { name: '重新打开', exact: true }).click();
      await expect(pending(page, action)).toBeVisible();
      expect(outgoing).toHaveLength(1);
      await dismiss(page, action).click();
      await command(f, 'reopen');
      const later = await patch(f, `原${action}提交后另一个编辑者的新标题`);
      await expect(page.getByRole('heading', { name: later.title, exact: true })).toBeVisible();
      const events = taskEvents(f),
        completed = await history(f),
        originalRuns = runs(f);
      await entry(page, action === 'cancel' ? 'complete' : 'cancel').click();
      await expect(pending(page, action)).toBeVisible();
      await expect(dialog(page, action)).toContainText(before.title);
      await expect(choice(page, action)).toBeChecked({ checked: action === 'complete' });
      await expect(choice(page, action)).toBeDisabled();
      const response = page.waitForResponse(
        (reply) => reply.url() === endpoint(f, action) && reply.status() === 200,
      );
      await recover(page, action).click();
      expect(await (await response).json()).toEqual(receipt);
      await expect(dialog(page, action)).toHaveCount(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      expect(taskState(f)).toEqual(later);
      expect(taskEvents(f)).toEqual(events);
      expect(await history(f)).toEqual(completed);
      expect(completed.map((item) => item.action)).toEqual([
        'reopen',
        action,
        ...originalHistory.map((item) => item.action),
      ]);
      expect(runs(f)).toEqual(originalRuns);
      await expect(status(page)).toHaveText('待处理');
      await expect(page.getByRole('heading', { name: later.title, exact: true })).toBeVisible();
    });
  });
}

test('浏览器先失去原请求后服务器才收到它，随后明确确认复用已捕获原包键', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const before = taskState(f),
      originalHistory = await history(f),
      originalRuns = runs(f);
    const outgoing = writes(page, f);
    await makeUnknown(page, f);
    await dismiss(page).click();
    await navigateTask(page, f.other);
    expect(taskState(f)).toEqual(before);
    const original = outgoing[0]!;
    // Model delayed delivery of the original already-sent packet over the real HTTP
    // endpoint. It reaches the server only after the browser entered unknown state.
    const delivered = await page.request.post(origin + original.path, {
      headers: {
        origin,
        'x-hexu-client': 'web',
        'x-hexu-space': f.bob.spaceId,
        'idempotency-key': original.key,
        'content-type': 'application/json',
      },
      data: original.body!,
    });
    expect(delivered.status(), await delivered.text()).toBe(200);
    const receipt = await delivered.json();
    expect(receipt).toMatchObject({ status: 'cancelled', revision: before.revision + 1 });
    const events = taskEvents(f),
      completed = await history(f);
    await navigateTask(page, taskState(f));
    await expect(status(page)).toHaveText('已取消');
    await page.locator('main').getByRole('button', { name: '重新打开', exact: true }).click();
    await expect(pending(page)).toBeVisible();
    const retry = page.waitForResponse(
      (reply) => reply.url() === endpoint(f, 'cancel') && reply.status() === 200,
    );
    await recover(page).click();
    expect(await (await retry).json()).toEqual(receipt);
    await expect(dialog(page)).toHaveCount(0);
    expect(outgoing).toEqual([original, original]);
    expect(taskEvents(f)).toEqual(events);
    expect(await history(f)).toEqual(completed);
    expect(completed.map((item) => item.action)).toEqual([
      'cancel',
      ...originalHistory.map((item) => item.action),
    ]);
    expect(runs(f)).toEqual(originalRuns);
  });
});

test('完成ACK已确认后Workbench失败只刷新GET，手机浅色仍显示已知结果与锁定选择', async ({
  page,
}) => {
  await run(page, async (f, owned) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, f, 'light');
    const outgoing = writes(page, f),
      before = taskState(f);
    const originalRuns = runs(f),
      originalHistory = await history(f);
    let reads = 0;
    const pattern = `${origin}/api/v1/workbench`;
    const responseGate = gate();
    let injecting = true,
      pauseResponses = false,
      delayedReads = 0,
      disposed = false;
    const pendingReads: Promise<void>[] = [],
      readErrors: unknown[] = [];
    const failRead = async (route: Route) => {
      if (!injecting) return route.continue();
      const work = (async () => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        reads++;
        if (pauseResponses) {
          delayedReads++;
          await responseGate.promise;
        }
        await route.fulfill({
          status: 503,
          json: { error: { code: 'TEMPORARY_FAILURE', message: '已接收命令，工作台暂时读取失败' } },
        });
      })().catch((error) => {
        readErrors.push(error);
      });
      pendingReads.push(work);
      await work;
    };
    await page.route(pattern, failRead);
    const failures: Disposable = {
      async dispose(failed) {
        if (disposed) return;
        disposed = true;
        // Keep the interceptor registered until every captured fetch/fulfill
        // has settled. Unroute must not handle an already owned read first.
        injecting = false;
        responseGate.resolve();
        await Promise.all(pendingReads);
        try {
          await page.unroute(pattern, failRead);
        } catch (error) {
          readErrors.push(error);
        }
        reportCleanup(readErrors, failed);
      },
    };
    owned.push(failures);
    await openDialog(page, 'complete');
    await choice(page, 'complete').uncheck();
    const ack = page.waitForResponse(
      (reply) => reply.url() === endpoint(f, 'complete') && reply.status() === 200,
    );
    const [receipt] = await Promise.all([ack, confirm(page, 'complete').click()]);
    expect(await receipt.json()).toMatchObject({
      id: before.id,
      status: 'done',
      revision: before.revision + 1,
    });
    await expect(accepted(page, 'complete')).toBeVisible();
    await expect(refresh(page, 'complete')).toBeEnabled();
    await expect(pending(page, 'complete')).toHaveCount(0);
    await expect(recover(page, 'complete')).toHaveCount(0);
    await expect(choice(page, 'complete')).not.toBeChecked();
    await screenshot(page, '211-task-status-refresh-mobile-light.png', 'complete', true);
    expect(reads).toBeGreaterThan(0);
    const completed = await history(f),
      events = taskEvents(f);
    await dismiss(page, 'complete').click();
    await entry(page, 'cancel').click();
    await expect(accepted(page, 'complete')).toBeVisible();
    // Exercise the overlap deterministically with a real GET whose successful
    // backend response is still owned by the temporary-failure interceptor.
    pauseResponses = true;
    await refresh(page, 'complete').click();
    await expect
      .poll(() => {
        reportCleanup(readErrors, false);
        return delayedReads;
      })
      .toBeGreaterThan(0);
    await failures.dispose(false);
    await expect(accepted(page, 'complete')).toBeVisible();
    await expect(refresh(page, 'complete')).toBeEnabled();
    const get = page.waitForResponse((reply) => reply.url() === pattern && reply.status() === 200);
    const [response] = await Promise.all([get, refresh(page, 'complete').click()]);
    await response.finished();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    await expect(status(page)).toHaveText('已完成');
    expect(outgoing).toHaveLength(1);
    expect(taskState(f).revision).toBe(before.revision + 1);
    expect(taskEvents(f)).toEqual(events);
    expect(await history(f)).toEqual(completed);
    expect(completed.map((item) => item.action)).toEqual([
      'complete',
      ...originalHistory.map((item) => item.action),
    ]);
    expect(runs(f)).toEqual(originalRuns);
  });
});

test('200回应的Task身份、目标状态或回执修订不匹配仍属未知，只能重试原包键', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const before = taskState(f),
      originalHistory = await history(f),
      originalRuns = runs(f);
    const outgoing = writes(page, f),
      received: Task[] = [];
    const pattern = endpoint(f, 'complete');
    const mismatched = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const receipt = (await response.json()) as Task;
      received.push(receipt);
      const invalid =
        received.length === 1
          ? { ...receipt, id: f.other.id }
          : received.length === 2
            ? { ...receipt, status: 'cancelled' }
            : { ...receipt, revision: receipt.revision + 1 };
      await route.fulfill({ status: 200, json: invalid });
    };
    await page.route(pattern, mismatched);
    await openDialog(page, 'complete');
    await choice(page, 'complete').uncheck();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = page.waitForResponse(
        (reply) => reply.url() === pattern && reply.status() === 200,
      );
      await (attempt === 0 ? confirm(page, 'complete') : recover(page, 'complete')).click();
      await (await response).finished();
      await expect(pending(page, 'complete')).toContainText('服务未返回可核对的原请求回执');
      await expect(recover(page, 'complete')).toBeEnabled();
      await expect(accepted(page, 'complete')).toHaveCount(0);
      await expect(refresh(page, 'complete')).toHaveCount(0);
      await expect(choice(page, 'complete')).not.toBeChecked();
      await expect(choice(page, 'complete')).toBeDisabled();
      expect(received).toHaveLength(attempt + 1);
      expect(outgoing).toHaveLength(attempt + 1);
      expect(outgoing.every((item) => JSON.stringify(item) === JSON.stringify(outgoing[0]))).toBe(
        true,
      );
      expect(received.every((item) => JSON.stringify(item) === JSON.stringify(received[0]))).toBe(
        true,
      );
      expect(taskState(f)).toMatchObject({ status: 'done', revision: before.revision + 1 });
    }
    const events = taskEvents(f),
      completed = await history(f);
    await page.unroute(pattern, mismatched);
    await recover(page, 'complete').click();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    expect(outgoing).toHaveLength(4);
    expect(outgoing[3]).toEqual(outgoing[0]);
    expect(taskEvents(f)).toEqual(events);
    expect(await history(f)).toEqual(completed);
    expect(completed.map((item) => item.action)).toEqual([
      'complete',
      ...originalHistory.map((item) => item.action),
    ]);
    expect(runs(f)).toEqual(originalRuns);
  });
});

for (const access of ['view', null] as const) {
  test(`未知请求关闭后当前${access === 'view' ? '降权' : '撤权'}也删除原包，重新授权不恢复旧选择或自动发送`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f);
      const before = taskState(f),
        originalRuns = runs(f),
        originalHistory = await history(f);
      const outgoing = writes(page, f);
      await makeUnknown(page, f);
      await dismiss(page).click();
      await role(f, access);
      if (access === 'view') await expect(entry(page)).toBeDisabled();
      else
        await expect(
          page.getByRole('heading', { name: '当前无法访问此任务', exact: true }),
        ).toBeVisible();
      const denied = await f.api.call(
        `tasks/${f.task.id}/cancel`,
        f.bob,
        JSON.parse(outgoing[0]!.body!),
        outgoing[0]!.key,
      );
      expect([403, 404]).toContain(denied.statusCode);
      await role(f, 'edit');
      await expect(entry(page)).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await openDialog(page);
      await expect(pending(page)).toHaveCount(0);
      await expect(choice(page)).toBeEnabled();
      expect(outgoing).toHaveLength(1);
      expect(taskState(f)).toEqual(before);
      expect(runs(f)).toEqual(originalRuns);
      expect(await history(f)).toEqual(originalHistory);
      await choice(page).uncheck();
      await confirm(page).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(2);
      expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
      expect(JSON.parse(outgoing[1]!.body!)).toEqual(JSON.parse(outgoing[0]!.body!));
    });
  });
}

test('未知请求暂时关闭后切换空间再返回清除原包，不自动恢复或写入浏览器存储', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const before = taskState(f),
      originalHistory = await history(f),
      outgoing = writes(page, f);
    await makeUnknown(page, f);
    await dismiss(page).click();
    await page
      .getByLabel('当前工作空间', { exact: true })
      .selectOption(`personal-${f.bob.user.id}`);
    await expect(page.getByLabel('当前工作空间')).toHaveValue(`personal-${f.bob.user.id}`);
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(f.bob.spaceId);
    await navigateTask(page, before);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openDialog(page);
    await expect(pending(page)).toHaveCount(0);
    await expect(choice(page)).toBeEnabled();
    expect(outgoing).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain(outgoing[0]!.key);
    expect(taskState(f)).toEqual(before);
    expect(await history(f)).toEqual(originalHistory);
  });
});

test('未知请求关闭后真实退出并换账号，返回原账号也不复活原包', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const before = taskState(f),
      originalHistory = await history(f),
      outgoing = writes(page, f);
    await makeUnknown(page, f, 'complete');
    await dismiss(page, 'complete').click();
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
      await openDialog(page, 'complete');
      await expect(pending(page, 'complete')).toHaveCount(0);
      await expect(choice(page, 'complete')).toBeEnabled();
      await dialog(page, 'complete').getByRole('button', { name: '取消', exact: true }).click();
    }
    expect(outgoing).toHaveLength(1);
    expect(taskState(f)).toEqual(before);
    expect(await history(f)).toEqual(originalHistory);
  });
});

for (const outcome of ['success', 'refusal'] as const) {
  test(`旧未知请求明确重试的真实${outcome === 'success' ? '成功' : '拒绝'}晚回不能复活已撤权包或改变新确认`, async ({
    page,
  }) => {
    await run(page, async (f, owned) => {
      await open(page, f);
      const outgoing = writes(page, f);
      await makeUnknown(page, f, 'complete');
      const old = await hold(page, endpoint(f, 'complete'), outcome === 'refusal');
      owned.push(old);
      await recover(page, 'complete').click();
      await old.reached(outcome === 'success' ? 200 : undefined);
      old.stopCapture();
      await role(f, 'view');
      await expect(dialog(page, 'complete')).toHaveCount(0);
      await expect(entry(page)).toBeDisabled();
      if (outcome === 'refusal') {
        old.releaseRequest();
        await old.reached(403);
      }
      await role(f, 'edit');
      if (outcome === 'success') await command(f, 'reopen');
      await expect(status(page)).toHaveText(outcome === 'success' ? '待处理' : '进行中');
      await expect(entry(page)).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const notice = page.getByRole('button', { name: '关闭通知', exact: true });
      if (await notice.count()) await notice.click();
      await openDialog(page);
      const current = taskState(f),
        completed = await history(f);
      const response = page.waitForResponse((reply) => reply.url() === endpoint(f, 'complete'));
      await old.releaseAndDrain();
      await (await response).finished();
      await painted(page);
      // Inspect immediately after the delivered late response; polling could hide an overwrite.
      expect(await dialog(page).isVisible()).toBe(true);
      expect(await choice(page).isChecked()).toBe(true);
      expect(await choice(page).isEnabled()).toBe(true);
      expect(await confirm(page).isEnabled()).toBe(true);
      expect(await pending(page).count()).toBe(0);
      expect(await accepted(page).count()).toBe(0);
      expect(await page.locator('.toast').count()).toBe(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      expect(taskState(f)).toEqual(current);
      expect(await history(f)).toEqual(completed);
      await confirm(page).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(status(page)).toHaveText('已取消');
      expect(outgoing).toHaveLength(3);
      expect(outgoing[2]!.key).not.toBe(outgoing[0]!.key);
      expect(runs(f).find((item) => item.id === f.active.run.id)).toMatchObject({
        state: 'stopping',
        node: { terminationConfirmed: false },
      });
    });
  });
}

test('原请求确认拥有的所有Workbench晚读都失效，不覆盖重新授权后的新确认', async ({ page }) => {
  await run(page, async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f);
    await makeUnknown(page, f, 'complete');
    const retry = await hold(page, endpoint(f, 'complete'));
    owned.push(retry);
    await recover(page, 'complete').click();
    await retry.reached(200);
    // Consume the real commit's SSE snapshot before trapping its owned GET.
    await expect(status(page)).toHaveText('已完成');
    const oldReads = await hold(page, `${origin}/api/v1/workbench`);
    owned.push(oldReads);
    await retry.releaseAndDrain();
    await oldReads.reached(200);
    oldReads.stopCapture();
    await role(f, 'view');
    await expect(dialog(page, 'complete')).toHaveCount(0);
    await expect(entry(page)).toBeDisabled();
    await role(f, 'edit');
    await command(f, 'reopen');
    await expect(status(page)).toHaveText('待处理');
    const current = taskState(f),
      completed = await history(f);
    const notice = page.getByRole('button', { name: '关闭通知', exact: true });
    if (await notice.count()) await notice.click();
    await openDialog(page);
    await choice(page).uncheck();
    const delivered = page.waitForResponse(async (reply) => {
      if (reply.url() !== `${origin}/api/v1/workbench` || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.status === 'done');
    });
    await oldReads.releaseAndDrain();
    await (await delivered).finished();
    await painted(page);
    // Inspect immediately after the delivered late response; polling could hide an overwrite.
    await expect(status(page)).toHaveText('待处理');
    expect(await dialog(page).isVisible()).toBe(true);
    expect(await choice(page).isChecked()).toBe(false);
    expect(await choice(page).isEnabled()).toBe(true);
    expect(await confirm(page).isEnabled()).toBe(true);
    expect(await pending(page).count()).toBe(0);
    expect(await accepted(page).count()).toBe(0);
    expect(await page.locator('.toast').count()).toBe(0);
    expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
    expect(taskState(f)).toEqual(current);
    expect(await history(f)).toEqual(completed);
  });
});

test('较旧SSE工作台403晚于更新成功读取不清原包，当前403才永久清除已关闭请求', async ({ page }) => {
  await run(page, async (f, owned) => {
    await open(page, f);
    const outgoing = writes(page, f),
      originalHistory = await history(f);
    await makeUnknown(page, f);
    const pattern = `${origin}/api/v1/workbench`;
    // Controlled read fault after a real SSE-triggered server GET. The generic
    // denial deliberately does not synthesize an identity/space reset event.
    const old = await hold(page, pattern, false, true);
    owned.push(old);
    await patch(f, '旧工作台读取所属的修订');
    await old.reached(200);
    old.stopCapture();
    const nextTitle = '较新的工作台已确认仍可编辑';
    const next = page.waitForResponse(async (reply) => {
      if (reply.url() !== pattern || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.title === nextTitle);
    });
    await patch(f, nextTitle);
    await (await next).finished();
    await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
    await dismiss(page).click();
    const denied = page.waitForResponse(
      (reply) => reply.url() === pattern && reply.status() === 403,
    );
    await old.releaseAndDrain();
    await (await denied).finished();
    await painted(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await entry(page, 'complete').click();
    await expect(pending(page)).toBeVisible();
    await expect(recover(page)).toBeEnabled();
    await expect(choice(page)).not.toBeChecked();
    await expect(choice(page)).toBeDisabled();
    await dismiss(page).click();
    // This newer denial owns the current read, even while the packet is closed.
    const current = await hold(page, pattern, false, true);
    owned.push(current);
    await patch(f, '当前读取拒绝时必须丢弃原包');
    await current.reached(200);
    const currentDenial = page.waitForResponse(
      (reply) => reply.url() === pattern && reply.status() === 403,
    );
    await current.releaseAndDrain();
    await (await currentDenial).finished();
    await painted(page);
    const restoredTitle = '重新成功读取后必须重新确认';
    const restored = page.waitForResponse(async (reply) => {
      if (reply.url() !== pattern || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some((task) => task.id === f.task.id && task.title === restoredTitle);
    });
    await patch(f, restoredTitle);
    await (await restored).finished();
    await expect(page.getByRole('heading', { name: restoredTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openDialog(page);
    await expect(pending(page)).toHaveCount(0);
    await expect(choice(page)).toBeEnabled();
    expect(outgoing).toHaveLength(1);
    expect(await history(f)).toEqual(originalHistory);
  });
});
