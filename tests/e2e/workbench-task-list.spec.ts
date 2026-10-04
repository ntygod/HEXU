import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';

const section = (page: Page) => page.getByRole('region', { name: '最近任务', exact: true });
const rows = (page: Page) => section(page).locator('a.work-task-row');
const taskRow = (page: Page, task: Task) =>
  section(page).locator(`a.work-task-row[href="/tasks/${task.id}"]`);
const more = (page: Page) => section(page).getByRole('button', { name: '显示更多', exact: true });
const collapse = (page: Page) => section(page).getByRole('button', { name: '收起', exact: true });
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/${path}`, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function detail(page: Page, id: string): Promise<TaskDetail> {
  const response = await page.request.get(`/api/v1/tasks/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function snapshot(page: Page, tasks: Task[]) {
  return Promise.all(tasks.map((task) => detail(page, task.id)));
}

async function workbench(page: Page): Promise<Workbench> {
  const response = await page.request.get('/api/v1/workbench');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function fixture(page: Page, privateCount: number, projectCount = 0) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const tasks: Task[] = [];
  for (let index = 0; index < privateCount + projectCount; index++) {
    const privateTask = index < privateCount;
    tasks.push(
      await post<Task>(page, 'spaces/space-demo/tasks', {
        title: `${privateTask ? '个人' : '项目'}任务浏览 ${index + 1}`,
        description: '只通过最近任务列表浏览，保留原任务工作区。',
        projectId: privateTask ? null : 'project-orders',
      }),
    );
  }
  const ids = new Set(tasks.map((task) => task.id));
  const current = await workbench(page);
  // Test-only isolation of the already-loaded task projection. Keep the real
  // HTTP response's Task objects and order; do not model server pagination or
  // alter identity, access, other Workbench fields, or any TaskDetail response.
  const ordered = current.tasks.filter((task) => ids.has(task.id));
  expect(ordered.map((task) => task.id).sort()).toEqual([...ids].sort());
  expect(ordered.every((task) => task.ownerUserId === current.user.id)).toBe(true);
  expect(ordered.filter((task) => task.visibility === 'private')).toHaveLength(privateCount);
  expect(ordered.filter((task) => task.projectId === null)).toHaveLength(privateCount);
  const before = await snapshot(page, ordered);
  expect(before.every((entry) => entry.runs.length === 0)).toBe(true);
  const browserWrites: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  const pattern = '**/api/v1/workbench';
  let capturing = true;
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const handler = (route: Route) => {
    const operation = (async () => {
      if (!capturing) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const data = (await response.json()) as Workbench;
      await route.fulfill({
        response,
        json: { ...data, tasks: data.tasks.filter((task) => ids.has(task.id)) },
      });
    })();
    pending.add(operation);
    // Observe rejection immediately, including requests racing with cleanup.
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        failures.push(error);
        pending.delete(operation);
      },
    );
    return operation;
  };
  await page.route(pattern, handler);
  return {
    ordered,
    before,
    browserWrites,
    async stop(testFailed: boolean) {
      // Stop new captures, drain every tracked handler, then remove the route.
      capturing = false;
      try {
        while (pending.size) await Promise.allSettled([...pending]);
      } finally {
        try {
          await page.unroute(pattern, handler);
        } catch (error) {
          failures.push(error);
        }
      }
      if (testFailed) {
        for (const error of failures)
          test.info().annotations.push({
            type: 'cleanup-error',
            description: error instanceof Error ? error.message : String(error),
          });
      } else {
        expect(failures).toEqual([]);
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectRows(page: Page, tasks: Task[], total = tasks.length) {
  await expect(rows(page)).toHaveCount(tasks.length);
  await expect
    .poll(() => rows(page).evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`));
  await expect(section(page).getByRole('status')).toHaveText(
    `当前列表：已显示 ${tasks.length} / ${total} 项`,
  );
}

async function expectUnchanged(page: Page, f: Fixture, baseline = f.before) {
  expect(await snapshot(page, f.ordered)).toEqual(baseline);
  expect(f.browserWrites).toEqual([]);
}

async function expectHitTarget(target: Locator, width: number, height: number) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(
    await target.evaluate(
      (element, minimum) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width >= minimum.width &&
          rect.height >= minimum.height &&
          element.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          )
        );
      },
      { width, height },
    ),
  ).toBe(true);
}

async function captureExpanded(page: Page, task: Task, path: string, mobile = false) {
  const link = taskRow(page, task);
  const footer = section(page).locator('.workbench-task-list-footer');
  await link.scrollIntoViewIfNeeded();
  await footer.scrollIntoViewIfNeeded();
  await expect(link).toHaveAttribute('href', `/tasks/${task.id}`);
  await expect(link.locator('strong')).toHaveText(task.title);
  await expect(link).toContainText('个人工作');
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect(footer).toBeInViewport({ ratio: 1 });
  await expect(collapse(page)).toBeInViewport({ ratio: 1 });
  await expectHitTarget(link, mobile ? 280 : 320, 44);
  await expectHitTarget(collapse(page), 44, mobile ? 44 : 32);
  for (const content of [page.locator('main'), section(page), link, footer]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(mobile ? 280 : 320);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // Recheck the critical targets after all scroll/hit checks. A full-page
  // capture alone would not prove an expanded row and footer were reachable.
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect(footer).toBeInViewport({ ratio: 1 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

for (const count of [0, 8, 9]) {
  test(`最近任务 ${count} 项的首批、边界和个人任务入口只读`, async ({ page }) => {
    const f = await fixture(page, count);
    let testFailed = false;
    try {
      await page.goto('/');
      await expectRows(page, f.ordered.slice(0, 8), count);
      await expect(collapse(page)).toHaveCount(0);
      await expect(more(page)).toHaveCount(count > 8 ? 1 : 0);
      await expect(
        section(page).getByText('还没有任务。创建后，工作记录会留在这里。', { exact: true }),
      ).toHaveCount(count === 0 ? 1 : 0);
      if (count === 9) {
        const ninth = f.ordered[8]!;
        await expect(taskRow(page, ninth)).toHaveCount(0);
        await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await expectHitTarget(more(page), 44, 44);
        await more(page).click();
        await expectRows(page, f.ordered);
        await expect(rows(page).nth(8)).toBeFocused();
        await expect(more(page)).toHaveCount(0);
        await captureExpanded(
          page,
          ninth,
          'artifacts/229-workbench-task-list-mobile-light.png',
          true,
        );
        await taskRow(page, ninth).click();
        await expect(page).toHaveURL(new RegExp(`/tasks/${ninth.id}$`));
        await expect(page.getByRole('heading', { name: ninth.title, exact: true })).toBeVisible();
      }
      await expectUnchanged(page, f);
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      await f.stop(testFailed);
    }
  });
}

test('最近任务多批到最后一批、收起和键盘焦点保留实际顺序', async ({ page }) => {
  const f = await fixture(page, 19);
  let testFailed = false;
  try {
    await page.goto('/');
    await expectRows(page, f.ordered.slice(0, 8), 19);
    await more(page).focus();
    await more(page).press('Enter');
    await expectRows(page, f.ordered.slice(0, 16), 19);
    await expect(rows(page).nth(8)).toBeFocused();
    await more(page).focus();
    await more(page).press('Space');
    await expectRows(page, f.ordered);
    await expect(rows(page).nth(16)).toBeFocused();
    await expect(more(page)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await captureExpanded(page, f.ordered[18]!, 'artifacts/228-workbench-task-list-dark.png');
    await collapse(page).focus();
    await collapse(page).press('Enter');
    await expectRows(page, f.ordered.slice(0, 8), 19);
    await expect(
      section(page).getByRole('heading', { name: '最近任务', exact: true }),
    ).toBeFocused();
    await expect(collapse(page)).toHaveCount(0);
    await more(page).focus();
    await more(page).press('Enter');
    await expectRows(page, f.ordered.slice(0, 16), 19);
    const ninth = f.ordered[8]!;
    await expect(rows(page).nth(8)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${ninth.id}$`));
    await expect(page.getByRole('heading', { name: ninth.title, exact: true })).toBeVisible();
    await expectUnchanged(page, f);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});

test('我的工作和团队概览分别回到首批，并沿用原私有与项目范围', async ({ page }) => {
  const f = await fixture(page, 9, 9);
  const team = f.ordered.filter((task) => task.visibility === 'project');
  let testFailed = false;
  try {
    await page.goto('/');
    await expectRows(page, f.ordered.slice(0, 8), 18);
    await more(page).click();
    await expectRows(page, f.ordered.slice(0, 16), 18);
    await page.getByRole('button', { name: '团队概览', exact: true }).click();
    await expectRows(page, team.slice(0, 8), 9);
    await expect(collapse(page)).toHaveCount(0);
    await more(page).click();
    await expectRows(page, team);
    await expect(more(page)).toHaveCount(0);
    await page.getByRole('button', { name: '我的工作', exact: true }).click();
    await expectRows(page, f.ordered.slice(0, 8), 18);
    await expect(collapse(page)).toHaveCount(0);
    await page.getByRole('button', { name: '团队概览', exact: true }).click();
    await expectRows(page, team.slice(0, 8), 9);
    await expect(collapse(page)).toHaveCount(0);
    await expectUnchanged(page, f);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});

test('展开后普通状态与标题更新立即使用当前投影，数量不保留旧任务副本', async ({ page }) => {
  const f = await fixture(page, 17);
  let testFailed = false;
  try {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/events' && response.status() === 200,
      ),
      page.goto('/'),
    ]);
    await more(page).click();
    await expectRows(page, f.ordered.slice(0, 16), 17);
    await expectUnchanged(page, f);

    // Only explicit fixture HTTP writes below alter business data; pagination
    // and navigation must issue no browser writes and preserve every detail.
    const removed = f.ordered[0]!;
    await post(page, `tasks/${removed.id}/cancel`, {
      expectedRevision: removed.revision,
      activeRunAction: 'keep',
    });
    const remaining = f.ordered.filter((task) => task.id !== removed.id);
    await expectRows(page, remaining);
    await expect(more(page)).toHaveCount(0);
    await expect(taskRow(page, removed)).toHaveCount(0);
    const afterCancel = await snapshot(page, f.ordered);
    expect(afterCancel.find((entry) => entry.task.id === removed.id)!.task.status).toBe(
      'cancelled',
    );
    expect(afterCancel.filter((entry) => entry.task.id !== removed.id)).toEqual(
      f.before.filter((entry) => entry.task.id !== removed.id),
    );

    const last = remaining.at(-1)!;
    const title = '展开后更新的个人任务标题';
    const response = await page.request.patch(`/api/v1/tasks/${last.id}`, {
      headers: headers(),
      data: { expectedRevision: last.revision, title },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const updated = (await response.json()) as Task;
    await expect(rows(page).last()).toContainText(title);
    await expectRows(page, remaining);
    const afterEdit = await snapshot(page, f.ordered);
    expect(afterEdit).toEqual(
      afterCancel.map((entry) =>
        entry.task.id === last.id
          ? {
              ...entry,
              task: {
                ...entry.task,
                title,
                revision: entry.task.revision + 1,
                updatedAt: updated.updatedAt,
              },
            }
          : entry,
      ),
    );
    await collapse(page).click();
    await expectRows(page, remaining.slice(0, 8), 16);
    await more(page).click();
    await expectRows(page, remaining);
    await expect(rows(page).last()).toContainText(title);
    await expectUnchanged(page, f, afterEdit);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});
