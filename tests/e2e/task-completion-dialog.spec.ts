import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { branchResultFixture } from '../helpers/branch-results.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskCompletionHistory } from '../../packages/contracts/src/task-completion-history.js';

const origin = 'http://127.0.0.1:4340';
type Surface = 'task' | 'result';
const dialog = (page: Page) => page.getByRole('dialog', { name: '标记任务完成', exact: true });
const choice = (page: Page) => dialog(page).getByRole('checkbox', { name: '同时请求停止当前执行' });
const confirm = (page: Page) => dialog(page).getByRole('button', { name: '标记完成', exact: true });
const cancel = (page: Page) => dialog(page).getByRole('button', { name: '取消', exact: true });
const entry = (page: Page) =>
  page.locator('main').getByRole('button', { name: '标记完成', exact: true });
const status = (page: Page, surface: Surface) =>
  page.locator(surface === 'task' ? '.task-title .badge' : '.result-eyebrow .badge');
const conflictText = '任务已更新，本次完成确认已失效。请关闭后查看当前任务，再重新选择标记完成。';

async function fixture() {
  const f = await branchResultFixture(origin);
  try {
    // Control/API-only protocol substitutes; no executor or paid model is launched.
    const source = f.begin();
    source.start();
    source.finish('failed', '固定成果来自已结束的协议执行');
    const saved = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '固定成果的完成入口',
      body: 'COMPLETION_PINNED_VERSION_ONE',
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const { resultId, revisionId } = saved.json() as { resultId: string; revisionId: string };
    const version = f.as(() => new ResultRevisions(f.api.store).get(resultId, revisionId));
    const newer = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '后续成果说明',
      body: 'NEWER_RESULT_MUST_NOT_REPLACE_PINNED_VERSION',
    });
    expect(newer.statusCode, newer.body).toBe(201);
    const active = f.begin(1, 'codex');
    active.start();
    // Alice owns the active Run. Revoking Bob must not itself stop this Run.
    const grant = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    return { ...f, source, active, version };
  } catch (error) {
    try {
      await f.close();
    } catch (cause) {
      reportCleanup([cause], true, '完成确认夹具初始化清理失败');
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const taskState = (f: Fixture) => f.as(() => f.api.store.getTask(f.task.id));
const runs = (f: Fixture) => f.as(() => f.api.store.runs(f.task.id));
const resultState = (f: Fixture) =>
  f.as(() => {
    const revisions = new ResultRevisions(f.api.store);
    return {
      result: f.api.store.result(f.version.resultId),
      versions: revisions
        .list(f.version.resultId)
        .map((v) => revisions.get(f.version.resultId, v.id)),
    };
  });
const taskEvents = (f: Fixture) =>
  f.api.store.db
    .prepare('SELECT kind FROM outbox WHERE task_id=? ORDER BY sequence')
    .all(f.task.id);
const url = (f: Fixture, surface: Surface) =>
  surface === 'task'
    ? `${origin}/tasks/${f.task.id}`
    : `${origin}/results/${f.version.resultId}/versions/${f.version.id}`;
async function history(f: Fixture) {
  const response = await f.api.call(`tasks/${f.task.id}/completion-history?limit=10`, f.alice);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as TaskCompletionHistory).items;
}
async function role(f: Fixture, value: 'edit' | 'view' | null) {
  const response = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
    role: value,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function command(
  f: Fixture,
  action: 'complete' | 'reopen',
  expectedRevision = taskState(f).revision,
) {
  return f.api.call(`tasks/${f.task.id}/${action}`, f.alice, {
    expectedRevision,
    activeRunAction: 'keep',
  });
}
async function open(page: Page, f: Fixture, surface: Surface, theme: 'dark' | 'light' = 'dark') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Join the actual control app's registry epoch before completion reconciliation.
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
  await f.api.app.listen({ port: 4340, host: '127.0.0.1' });
  await page.context().addCookies(
    f.bob.cookie.split('; ').map((cookie) => {
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
    ({ userId, spaceId, theme }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, theme },
  );
  await page.goto(url(f, surface));
  await expect(entry(page)).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  if (surface === 'result') {
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await expect(page.locator('.written-result')).toContainText(f.version.body);
  }
}
async function openDialog(page: Page) {
  await entry(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(choice(page)).toBeChecked();
}
function reportCleanup(errors: unknown[], failed: boolean, message: string) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, message);
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hold(page: Page, pattern: string, beforeFetch = false) {
  const requestGate = gate(),
    responseGate = gate();
  if (!beforeFetch) requestGate.resolve();
  let capturing = true;
  const captured: { method: string; body: unknown; status?: number }[] = [];
  const pending: Promise<void>[] = [],
    errors: unknown[] = [];
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    const record = {
      method: route.request().method(),
      body: route.request().postDataJSON(),
      status: undefined as number | undefined,
    };
    captured.push(record);
    const work = (async () => {
      await requestGate.promise;
      const response = await route.fetch();
      record.status = response.status();
      await responseGate.promise;
      await route.fulfill({ response });
    })();
    // Observe failures immediately, including before the gate's expected phase.
    const observed = work.catch((error) => {
      errors.push(error);
    });
    pending.push(observed);
    await observed;
  };
  await page.route(pattern, handler);
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '完成确认延迟请求失败');
  };
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
      this.stopCapture();
      try {
        await this.releaseAndDrain();
      } catch (cause) {
        cleanup.push(cause);
      }
      // Stop capture, then release/drain, then unroute. Never orphan a held Route.
      try {
        await page.unroute(pattern, handler);
      } catch (cause) {
        cleanup.push(cause);
      }
      reportCleanup(cleanup, failed, '完成确认延迟请求清理失败');
    },
  };
}
type Held = Awaited<ReturnType<typeof hold>>;
async function close(page: Page, f: Fixture, failed: boolean, held: Held[] = []) {
  const errors: unknown[] = [];
  for (const item of held) {
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
  reportCleanup(errors, failed, '完成确认团队服务清理失败');
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function screenshot(page: Page, name: string) {
  await expect(dialog(page).getByRole('heading', { name: '标记任务完成' })).toBeInViewport({
    ratio: 1,
  });
  await expect(choice(page)).toBeInViewport({ ratio: 1 });
  await expect(confirm(page)).toBeInViewport({ ratio: 1 });
  await expect(cancel(page)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${name}` });
}

for (const surface of ['task', 'result'] as const) {
  const name = surface === 'task' ? '任务详情' : '固定历史成果页';
  test(`${name}完成确认随当前降权和撤权清除，重授编辑权不会复活旧确认`, async ({ page }) => {
    const f = await fixture();
    let failed = false;
    try {
      await open(page, f, surface);
      const before = taskState(f),
        originalRuns = runs(f),
        originalResults = resultState(f),
        originalHistory = await history(f);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
      });
      await openDialog(page);
      await choice(page).uncheck();
      await role(f, 'view');
      await expect(dialog(page)).toHaveCount(0);
      await expect(entry(page)).toBeDisabled();
      const deniedView = await f.api.call(`tasks/${f.task.id}/complete`, f.bob, {
        expectedRevision: before.revision,
        activeRunAction: 'stop',
      });
      expect(deniedView.statusCode, deniedView.body).toBe(403);
      await role(f, 'edit');
      await expect(entry(page)).toBeEnabled();
      await expect(dialog(page)).toHaveCount(0);
      await openDialog(page);
      // Exercise the Task detail's transient-read preservation simultaneously with
      // real Workbench removal. Its old title must not survive in the sibling dialog.
      const detailPattern = `${origin}/api/v1/tasks/${f.task.id}`;
      let transientReads = 0;
      await page.route(detailPattern, async (route) => {
        await route.fetch();
        transientReads++;
        await route.fulfill({
          status: 503,
          json: { error: { code: 'TEMPORARY_FAILURE', message: '临时详情读取故障' } },
        });
      });
      await role(f, null);
      await expect(dialog(page)).toHaveCount(0);
      await expect(
        page.getByRole('heading', {
          name: surface === 'task' ? '当前无法访问此任务' : '无法打开成果',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator('body')).not.toContainText(before.title);
      if (surface === 'task') await expect.poll(() => transientReads).toBeGreaterThan(0);
      const deniedRead = await f.api.call(`tasks/${f.task.id}`, f.bob);
      expect(deniedRead.statusCode, deniedRead.body).toBe(404);
      const deniedWrite = await f.api.call(`tasks/${f.task.id}/complete`, f.bob, {
        expectedRevision: before.revision,
        activeRunAction: 'stop',
      });
      expect([403, 404]).toContain(deniedWrite.statusCode);
      await page.unroute(detailPattern);
      await role(f, 'edit');
      // The Task is visible again in this still-mounted Provider, without a reload.
      await expect(entry(page)).toBeEnabled();
      await expect(dialog(page)).toHaveCount(0);
      await openDialog(page);
      await cancel(page).click();
      expect(writes).toEqual([]);
      expect(taskState(f)).toEqual(before);
      expect(runs(f)).toEqual(originalRuns);
      expect(resultState(f)).toEqual(originalResults);
      expect(await history(f)).toEqual(originalHistory);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed);
    }
  });

  test(`${name}修订变化必须重新确认，原停止选择不被重写且自身SSE不误判已接受命令`, async ({
    page,
  }) => {
    const f = await fixture();
    let failed = false;
    const held: Held[] = [];
    try {
      if (surface === 'result') await page.setViewportSize({ width: 390, height: 844 });
      await open(page, f, surface, surface === 'task' ? 'dark' : 'light');
      const before = taskState(f),
        originalRuns = runs(f),
        originalResults = resultState(f),
        originalHistory = await history(f);
      await openDialog(page);
      await expect(dialog(page)).toContainText(before.title);
      if (surface === 'task') await screenshot(page, '191-task-completion-dialog-dark.png');
      await choice(page).uncheck();
      const changed = await f.api.call(
        `tasks/${f.task.id}`,
        f.alice,
        { expectedRevision: before.revision, title: '当前任务：先核对更新再完成' },
        randomUUID(),
        'PATCH',
      );
      expect(changed.statusCode, changed.body).toBe(200);
      const updated = changed.json() as Task;
      await expect(dialog(page).getByRole('alert')).toHaveText(conflictText);
      await expect(choice(page)).not.toBeChecked();
      await expect(choice(page)).toBeDisabled();
      await expect(confirm(page)).toBeDisabled();
      await expect(cancel(page)).toBeEnabled();
      await expect(dialog(page)).toContainText(before.title);
      if (surface === 'result') {
        await expect(dialog(page).getByRole('alert')).toBeInViewport({ ratio: 1 });
        await screenshot(page, '192-task-completion-dialog-mobile-light.png');
      }
      const events = taskEvents(f);
      const conflict = await f.api.call(`tasks/${f.task.id}/complete`, f.bob, {
        expectedRevision: before.revision,
        activeRunAction: 'stop',
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(taskEvents(f)).toEqual(events);
      expect(taskState(f)).toEqual(updated);
      expect(runs(f)).toEqual(originalRuns);
      expect(await history(f)).toEqual(originalHistory);
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);
      if (surface === 'task')
        await expect(page.getByRole('heading', { name: updated.title, exact: true })).toBeVisible();
      await openDialog(page);
      await expect(dialog(page)).toContainText(updated.title);
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      await choice(page).uncheck();
      const accepted = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/complete`);
      held.push(accepted);
      await confirm(page).click();
      await accepted.reached(200);
      await expect(status(page, surface)).toHaveText('已完成');
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      await expect(choice(page)).not.toBeChecked();
      await expect(choice(page)).toBeDisabled();
      await expect(confirm(page)).toBeDisabled();
      await expect(cancel(page)).toBeDisabled();
      expect(accepted.captured).toEqual([
        {
          method: 'POST',
          body: { expectedRevision: updated.revision, activeRunAction: 'keep' },
          status: 200,
        },
      ]);
      accepted.stopCapture();
      await accepted.releaseAndDrain();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator('.toast')).toHaveText(/已标记完成，随时可以重新打开/);
      expect(taskState(f)).toMatchObject({
        id: before.id,
        status: 'done',
        revision: updated.revision + 1,
      });
      const eventsAfter = await history(f);
      expect(eventsAfter).toHaveLength(originalHistory.length + 1);
      expect(eventsAfter[0]).toMatchObject({
        action: 'complete',
        actorId: f.bob.user.id,
        taskRevision: updated.revision + 1,
      });
      expect(eventsAfter.slice(1)).toEqual(originalHistory);
      expect(runs(f)).toEqual(originalRuns);
      expect(resultState(f)).toEqual(originalResults);
      await expect(page).toHaveURL(url(f, surface));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed, held);
    }
  });
}

for (const outcome of ['success', 'refusal'] as const) {
  test(`旧完成请求的真实${outcome === 'success' ? '成功' : '拒绝'}晚回不能改变新确认的选择、忙碌或通知`, async ({
    page,
  }) => {
    const f = await fixture();
    const held: Held[] = [];
    let failed = false;
    const surface = outcome === 'success' ? 'result' : 'task';
    try {
      await open(page, f, surface);
      const before = taskState(f),
        originalRuns = runs(f),
        originalResults = resultState(f),
        originalHistory = await history(f);
      await openDialog(page);
      await choice(page).uncheck();
      const old = await hold(
        page,
        `${origin}/api/v1/tasks/${f.task.id}/complete`,
        outcome === 'refusal',
      );
      held.push(old);
      await confirm(page).click();
      await old.reached(outcome === 'success' ? 200 : undefined);
      old.stopCapture();
      await role(f, 'view');
      await expect(dialog(page)).toHaveCount(0);
      await expect(
        page.locator('main').getByRole('button', {
          name: outcome === 'success' ? '重新打开' : '标记完成',
          exact: true,
        }),
      ).toBeDisabled();
      if (outcome === 'refusal') {
        old.releaseRequest();
        await old.reached(403);
      }
      expect(old.captured[0]).toMatchObject({
        body: { expectedRevision: before.revision, activeRunAction: 'keep' },
        status: outcome === 'success' ? 200 : 403,
      });
      await role(f, 'edit');
      if (outcome === 'success') {
        const reopened = await command(f, 'reopen');
        expect(reopened.statusCode, reopened.body).toBe(200);
      }
      await expect(entry(page)).toBeEnabled();
      await expect(dialog(page)).toHaveCount(0);
      const current = taskState(f);
      await page.getByRole('button', { name: '关闭通知', exact: true }).click();
      await openDialog(page);
      await expect(confirm(page)).toBeEnabled();
      // The new session keeps its default stop choice, unlike the old keep request.
      await expect(choice(page)).toBeChecked();
      const newer = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/complete`, true);
      held.push(newer);
      await confirm(page).click();
      await newer.reached();
      await expect(confirm(page)).toBeDisabled();
      await expect(choice(page)).toBeDisabled();
      await expect(cancel(page)).toBeDisabled();
      const oldResponse = page.waitForResponse((reply) =>
        reply.url().endsWith(`/tasks/${f.task.id}/complete`),
      );
      await old.releaseAndDrain();
      await (await oldResponse).finished();
      await painted(page);
      await expect(dialog(page)).toBeVisible();
      await expect(choice(page)).toBeChecked();
      await expect(choice(page)).toBeDisabled();
      await expect(confirm(page)).toBeDisabled();
      await expect(cancel(page)).toBeDisabled();
      await expect(page.locator('.toast')).toHaveCount(0);
      expect(taskState(f)).toEqual(current);
      expect(runs(f)).toEqual(originalRuns);
      newer.stopCapture();
      newer.releaseRequest();
      await newer.reached(200);
      await newer.releaseAndDrain();
      await expect(dialog(page)).toHaveCount(0);
      await expect(status(page, surface)).toHaveText('已完成');
      expect(newer.captured).toEqual([
        {
          method: 'POST',
          body: { expectedRevision: current.revision, activeRunAction: 'stop' },
          status: 200,
        },
      ]);
      expect(taskState(f)).toMatchObject({ status: 'done', revision: current.revision + 1 });
      const finalRuns = runs(f);
      expect(finalRuns).toHaveLength(originalRuns.length);
      expect(finalRuns.find((run) => run.id === f.source.run.id)).toEqual(
        originalRuns.find((run) => run.id === f.source.run.id),
      );
      expect(finalRuns.find((run) => run.id === f.active.run.id)).toMatchObject({
        state: 'stopping',
        node: { terminationConfirmed: false },
      });
      expect(resultState(f)).toEqual(originalResults);
      const finalHistory = await history(f);
      expect(finalHistory.map((item) => item.action)).toEqual(
        outcome === 'success'
          ? ['complete', 'reopen', 'complete', ...originalHistory.map((item) => item.action)]
          : ['complete', ...originalHistory.map((item) => item.action)],
      );
      expect(finalHistory[0]).toMatchObject({
        actorId: f.bob.user.id,
        taskRevision: current.revision + 1,
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed, held);
    }
  });
}

test('当前请求的真实403先于Workbench更新到达时也永久清除确认', async ({ page }) => {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await open(page, f, 'task');
    const before = taskState(f),
      originalRuns = runs(f),
      originalHistory = await history(f);
    await openDialog(page);
    const workbench = await hold(page, `${origin}/api/v1/workbench`, true);
    held.push(workbench);
    await role(f, 'view');
    await workbench.reached();
    await expect(confirm(page)).toBeEnabled();
    const response = page.waitForResponse(
      (reply) => reply.url().endsWith(`/tasks/${f.task.id}/complete`) && reply.status() === 403,
    );
    await confirm(page).click();
    await (await response).finished();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('任务当前不可编辑，已取消本次完成确认');
    workbench.stopCapture();
    await workbench.releaseAndDrain();
    await expect(entry(page)).toBeDisabled();
    await role(f, 'edit');
    await expect(entry(page)).toBeEnabled();
    await expect(dialog(page)).toHaveCount(0);
    expect(taskState(f)).toEqual(before);
    expect(runs(f)).toEqual(originalRuns);
    expect(await history(f)).toEqual(originalHistory);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});

test('旧完成命令拥有的Workbench读取晚回不能覆盖重授权限后的新确认', async ({ page }) => {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await open(page, f, 'task');
    const before = taskState(f),
      originalRuns = runs(f),
      originalHistory = await history(f);
    await openDialog(page);
    await choice(page).uncheck();
    const old = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/complete`);
    held.push(old);
    await confirm(page).click();
    await old.reached(200);
    // First consume the command's genuine SSE snapshot. The next Workbench read
    // is the accepted command's own refresh, not an unrelated background read.
    await expect(status(page, 'task')).toHaveText('已完成');
    const ownedRead = await hold(page, `${origin}/api/v1/workbench`);
    held.push(ownedRead);
    old.stopCapture();
    await old.releaseAndDrain();
    await ownedRead.reached(200);
    ownedRead.stopCapture();
    await role(f, 'view');
    await expect(dialog(page)).toHaveCount(0);
    await expect(
      page.locator('main').getByRole('button', { name: '重新打开', exact: true }),
    ).toBeDisabled();
    await role(f, 'edit');
    const reopened = await command(f, 'reopen');
    expect(reopened.statusCode, reopened.body).toBe(200);
    await expect(status(page, 'task')).toHaveText('待处理');
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await openDialog(page);
    await choice(page).uncheck();
    const current = taskState(f);
    expect(current.revision).toBe(before.revision + 2);
    const oldResponse = page.waitForResponse(async (reply) => {
      if (!reply.url().endsWith('/api/v1/workbench') || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some(
        (task) => task.id === f.task.id && task.revision === before.revision + 1,
      );
    });
    await ownedRead.releaseAndDrain();
    await (await oldResponse).finished();
    await painted(page);
    await expect(status(page, 'task')).toHaveText('待处理');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await expect(choice(page)).not.toBeChecked();
    await expect(choice(page)).toBeEnabled();
    await expect(confirm(page)).toBeEnabled();
    await expect(cancel(page)).toBeEnabled();
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(taskState(f)).toEqual(current);
    expect(runs(f)).toEqual(originalRuns);
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(status(page, 'task')).toHaveText('已完成');
    expect(taskState(f).revision).toBe(current.revision + 1);
    expect(runs(f)).toEqual(originalRuns);
    expect((await history(f)).map((item) => item.action)).toEqual([
      'complete',
      'reopen',
      'complete',
      ...originalHistory.map((item) => item.action),
    ]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});
