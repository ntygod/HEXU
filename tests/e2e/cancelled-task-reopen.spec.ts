import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { branchResultFixture } from '../helpers/branch-results.js';
import type { Account } from '../helpers/team.js';
import type { TaskCompletionHistory } from '../../packages/contracts/src/task-completion-history.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';

const origin = 'http://127.0.0.1:4339';
type Surface = 'task' | 'result';
const reopen = (page: Page) => page.getByRole('button', { name: '重新打开', exact: true });
const status = (page: Page, surface: Surface) =>
  page.locator(surface === 'task' ? '.task-title .badge' : '.result-eyebrow .badge');

async function fixture() {
  const f = await branchResultFixture(origin);
  try {
    // Existing control/API-only protocol substitutes: no process or model is launched.
    const source = f.begin();
    source.start();
    source.finish('failed', '已取消任务仍保留这份历史执行输出');
    const first = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '取消前保存的成果',
      body: 'CANCELLED_TASK_PINNED_VERSION_ONE',
    });
    expect(first.statusCode, first.body).toBe(201);
    const saved = first.json() as { resultId: string; revisionId: string };
    const version = f.as(() =>
      new ResultRevisions(f.api.store).get(saved.resultId, saved.revisionId),
    );
    const second = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '后续保存的成果',
      body: 'NEWER_VERSION_MUST_NOT_REPLACE_PINNED_BODY',
    });
    expect(second.statusCode, second.body).toBe(201);
    const active = f.begin(1);
    active.start();
    const cancelled = await f.api.call(`tasks/${f.task.id}/cancel`, f.alice, {
      expectedRevision: f.as(() => f.api.store.getTask(f.task.id)).revision,
      activeRunAction: 'keep',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    return { ...f, source, active, version };
  } catch (error) {
    try {
      await f.close();
    } catch (cleanupError) {
      reportCleanup([cleanupError], true, '已取消任务夹具初始化后的清理失败');
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
const url = (f: Fixture, surface: Surface) =>
  surface === 'task'
    ? `${origin}/tasks/${f.task.id}`
    : `${origin}/results/${f.version.resultId}/versions/${f.version.id}`;
async function history(f: Fixture) {
  const response = await f.api.call(`tasks/${f.task.id}/completion-history?limit=10`, f.alice);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as TaskCompletionHistory;
}
async function open(
  page: Page,
  f: Fixture,
  surface: Surface,
  account: Account = f.alice,
  theme: 'dark' | 'light' = 'dark',
) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // As in result-task-activity, connect fixture nodes to the app's registry epoch.
  // Only the live peer reports fresh evidence; the frozen source stays terminal.
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
        snapshot: {
          capturedAt: at,
          workspaces: [{ ...node.summary, capturedAt: at }],
        },
      },
    });
    expect(sync.statusCode, sync.body).toBe(200);
  }
  f.active.send('unknown');
  f.active.send('running');
  await f.api.app.listen({ port: 4339, host: '127.0.0.1' });
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
    ({ userId, spaceId, theme }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
    },
    { userId: account.user.id, spaceId: account.spaceId, theme },
  );
  await page.goto(url(f, surface));
  await expect(status(page, surface)).toHaveText('已取消');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
function reportCleanup(errors: unknown[], failed: boolean, message: string) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, message);
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
async function close(page: Page, f: Fixture, failed: boolean) {
  // Closing the service remains necessary even if an assertion closed the browser.
  const errors: unknown[] = [];
  try {
    await page.unrouteAll({ behavior: 'wait' });
  } catch (error) {
    errors.push(error);
  }
  try {
    await page.context().close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await f.close();
  } catch (error) {
    errors.push(error);
  }
  reportCleanup(errors, failed, '已取消任务测试资源清理失败');
}

async function repeatReopen(page: Page, f: Fixture, surface: Surface) {
  const pattern = `${origin}/api/v1/tasks/${f.task.id}/reopen`;
  const captured: { method: string; body: unknown }[] = [];
  const responses: number[] = [];
  const pending: Promise<PromiseSettledResult<void>>[] = [];
  let holding = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (!holding) return route.continue();
    captured.push({ method: route.request().method(), body: route.request().postDataJSON() });
    const work = (async () => {
      // Both clicks reach the original command before either receives a response.
      // The real service, not a fabricated response, decides the revision conflict.
      await gate;
      const response = await route.fetch();
      responses.push(response.status());
      await route.fulfill({ response });
    })();
    pending.push(
      work.then(
        () => ({ status: 'fulfilled', value: undefined }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    );
    await work;
  };
  await page.route(pattern, handler);
  let failed = false;
  try {
    const before = taskState(f);
    await reopen(page).click();
    await expect.poll(() => captured.length).toBe(1);
    await expect(status(page, surface)).toHaveText('已取消');
    await reopen(page).click();
    await expect.poll(() => captured.length).toBe(2);
    expect(responses).toEqual([]);
    expect(taskState(f)).toEqual(before);
    expect(captured).toEqual([
      { method: 'POST', body: { expectedRevision: before.revision, activeRunAction: 'stop' } },
      { method: 'POST', body: { expectedRevision: before.revision, activeRunAction: 'stop' } },
    ]);
    holding = false;
    release();
    await expect.poll(() => responses.slice().sort()).toEqual([200, 409]);
    await expect(status(page, surface)).toHaveText('待处理');
    await expect(page.getByRole('button', { name: '标记完成', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: '标记任务完成', exact: true })).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    holding = false;
    release();
    const settled = await Promise.all(pending);
    const errors = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
    try {
      await page.unroute(pattern, handler);
    } catch (error) {
      errors.push(error);
    }
    reportCleanup(errors, failed, '重新打开请求清理失败');
  }
}

for (const surface of ['task', 'result'] as const) {
  const name = surface === 'task' ? '任务详情' : '固定历史成果页';
  test(`${name}明确重开已取消任务，重复点击只生效一次且保留运行和固定成果`, async ({ page }) => {
    const f = await fixture();
    let failed = false;
    try {
      if (surface === 'result') await page.setViewportSize({ width: 390, height: 844 });
      await open(page, f, surface, f.alice, surface === 'task' ? 'dark' : 'light');
      const before = taskState(f),
        originalRuns = runs(f),
        originalResult = resultState(f),
        originalHistory = await history(f);
      expect(originalRuns.find((run) => run.id === f.active.run.id)?.state).toBe('running');
      expect(originalRuns.find((run) => run.id === f.source.run.id)?.state).toBe('failed');
      await expect(reopen(page)).toBeEnabled();
      await expect(page.getByRole('button', { name: '标记完成', exact: true })).toHaveCount(0);
      if (surface === 'task') {
        await expect(page.getByRole('button', { name: '准备接续', exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
        await expect(page.locator('.written-result')).toContainText(f.version.body);
        await expect(page.locator('.written-result')).not.toContainText(
          'NEWER_VERSION_MUST_NOT_REPLACE_PINNED_BODY',
        );
      }
      if (surface === 'result') {
        // This is a long document: its normal-flow footer need not share the
        // viewport with the header action. Check each at its actual scroll position.
        const footer = page.locator('.workbench-footer');
        await footer.scrollIntoViewIfNeeded();
        await expect(footer).toBeInViewport({ ratio: 1 });
        await status(page, surface).scrollIntoViewIfNeeded();
      }
      await reopen(page).scrollIntoViewIfNeeded();
      await expect(reopen(page)).toBeInViewport({ ratio: 1 });
      await expect(status(page, surface)).toBeInViewport({ ratio: 1 });
      await expect(status(page, surface)).toHaveText('已取消');
      if (surface === 'result') {
        expect(
          await reopen(page).evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return button.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            );
          }),
        ).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      }
      await mkdir('artifacts', { recursive: true });
      await page.screenshot({
        path: `artifacts/${surface === 'task' ? '189-cancelled-task-reopen-dark.png' : '190-cancelled-result-reopen-mobile-light.png'}`,
      });
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
      });
      await repeatReopen(page, f, surface);
      expect(writes).toEqual([
        `/api/v1/tasks/${f.task.id}/reopen`,
        `/api/v1/tasks/${f.task.id}/reopen`,
      ]);
      expect(taskState(f)).toMatchObject({
        id: before.id,
        status: 'todo',
        revision: before.revision + 1,
      });
      const completed = await history(f);
      expect(completed.items).toHaveLength(originalHistory.items.length + 1);
      expect(completed.items[0]).toMatchObject({
        taskId: f.task.id,
        action: 'reopen',
        actorId: f.alice.user.id,
        taskRevision: before.revision + 1,
      });
      expect(completed.items.slice(1)).toEqual(originalHistory.items);
      expect(runs(f)).toEqual(originalRuns);
      expect(resultState(f)).toEqual(originalResult);
      await expect(page).toHaveURL(url(f, surface));
      await page.reload();
      await expect(status(page, surface)).toHaveText('待处理');
      await expect(reopen(page)).toHaveCount(0);
      if (surface === 'result') {
        await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
        await expect(page.locator('.written-result')).toContainText(f.version.body);
        await expect(page.locator('.written-result')).not.toContainText(
          'NEWER_VERSION_MUST_NOT_REPLACE_PINNED_BODY',
        );
      }
      expect(runs(f)).toEqual(originalRuns);
      expect(resultState(f)).toEqual(originalResult);
      expect((await history(f)).items).toEqual(completed.items);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed);
    }
  });

  test(`${name}重开遵守当前只读权限，撤权后清除内容且直接重开拒绝`, async ({ page }) => {
    const f = await fixture();
    let failed = false;
    try {
      const memberPath = `projects/${f.project.id}/members/${f.bob.user.id}`;
      const edit = await f.api.call(memberPath, f.alice, { role: 'edit' });
      expect(edit.statusCode, edit.body).toBe(200);
      if (surface === 'result') await page.setViewportSize({ width: 390, height: 844 });
      await open(page, f, surface, f.bob, surface === 'task' ? 'dark' : 'light');
      await expect(reopen(page)).toBeEnabled();
      const before = taskState(f),
        originalRuns = runs(f),
        originalResult = resultState(f),
        originalHistory = await history(f);
      const view = await f.api.call(memberPath, f.alice, { role: 'view' });
      expect(view.statusCode, view.body).toBe(200);
      await expect(reopen(page)).toBeDisabled();
      await expect(status(page, surface)).toHaveText('已取消');
      const body = { expectedRevision: before.revision, activeRunAction: 'stop' };
      const readOnlyWrite = await f.api.call(`tasks/${f.task.id}/reopen`, f.bob, body);
      expect(readOnlyWrite.statusCode, readOnlyWrite.body).toBe(403);
      const revoke = await f.api.call(memberPath, f.alice, { role: null });
      expect(revoke.statusCode, revoke.body).toBe(200);
      await expect(
        page.getByRole('heading', {
          name: surface === 'task' ? '当前无法访问此任务' : '无法打开成果',
          exact: true,
        }),
      ).toBeVisible();
      await expect(reopen(page)).toHaveCount(0);
      await expect(page.locator('.written-result')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(f.version.body);
      await expect(page.locator('body')).not.toContainText(f.active.run.id);
      const revokedWrite = await f.api.call(`tasks/${f.task.id}/reopen`, f.bob, body);
      expect([403, 404]).toContain(revokedWrite.statusCode);
      const revokedRead = await f.api.call(
        surface === 'task'
          ? `tasks/${f.task.id}`
          : `results/${f.version.resultId}/versions/${f.version.id}`,
        f.bob,
      );
      expect([403, 404]).toContain(revokedRead.statusCode);
      expect(taskState(f)).toEqual(before);
      expect(runs(f)).toEqual(originalRuns);
      expect(resultState(f)).toEqual(originalResult);
      expect((await history(f)).items).toEqual(originalHistory.items);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed);
    }
  });
}
