import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Result, Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskParticipantsView } from '../../packages/contracts/src/task-participants.js';

const section = (page: Page) => page.getByRole('region', { name: '最近任务', exact: true });
const includeCancelled = (page: Page) =>
  section(page).getByRole('checkbox', { name: '包括已取消任务', exact: true });
const rows = (page: Page) => section(page).locator('a.work-task-row');
const taskRow = (page: Page, task: Task) =>
  section(page).locator(`a.work-task-row[href="/tasks/${task.id}"]`);
const tab = (page: Page, name: string) =>
  page.locator('.work-tabs').getByRole('button', { name, exact: true });
const more = (page: Page) => section(page).getByRole('button', { name: '显示更多', exact: true });
const collapse = (page: Page) => section(page).getByRole('button', { name: '收起', exact: true });
const resume = (page: Page) => page.locator('.resume-work');
const resultLinks = (page: Page) => page.locator('.work-result-grid > a.work-result-card');
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const cancelledDescription = '当前范围内只有已取消的任务。勾选「包括已取消任务」查看。';

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1/${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/${path}`, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

const detail = (page: Page, id: string) => get<TaskDetail>(page, `tasks/${id}`);
const snapshot = (page: Page, tasks: Task[]) =>
  Promise.all(tasks.map((task) => detail(page, task.id)));

interface TaskSpec {
  title: string;
  private?: boolean;
  owner?: 'other';
  participating?: boolean;
  status?: Task['status'];
  attention?: string;
  result?: boolean;
}

async function fixture(page: Page, specs: TaskSpec[]) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const initial = await get<Workbench>(page, 'workbench');
  const userId = initial.user.id;
  const other = initial.members.find((member) => member.id !== userId)!;
  expect(other).toBeTruthy();
  const tasks: Task[] = [];
  for (const spec of specs) {
    let task = await post<Task>(page, 'spaces/space-demo/tasks', {
      title: spec.title,
      description: '从最近任务找回原工作区，浏览不会修改任务。',
      projectId: spec.private ? null : 'project-orders',
    });
    if (spec.owner)
      task = await post<Task>(page, `tasks/${task.id}/assignment`, {
        expectedRevision: task.revision,
        ownerUserId: other.id,
      });
    if (spec.participating) {
      const current = await get<TaskParticipantsView>(page, `tasks/${task.id}/participants`);
      await post(page, `tasks/${task.id}/participants`, {
        expectedRevision: current.revision,
        userId,
        action: 'add',
      });
    }
    if (spec.status && spec.status !== 'todo')
      task = await post<Task>(
        page,
        `tasks/${task.id}/${{ in_progress: 'start', done: 'complete', cancelled: 'cancel' }[spec.status]}`,
        { expectedRevision: task.revision, activeRunAction: 'keep' },
      );
    if (spec.attention) {
      const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
        headers: headers(),
        data: { expectedRevision: task.revision, attention: spec.attention },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    if (spec.result)
      await post<Result>(page, `tasks/${task.id}/results`, {
        title: `${spec.title}的成果`,
        body: '这份文字成果仍保留在原任务中。',
      });
    tasks.push((await detail(page, task.id)).task);
  }
  const ids = new Set(tasks.map((task) => task.id));
  const current = async () => {
    const data = await get<Workbench>(page, 'workbench');
    return { ...data, tasks: data.tasks.filter((task) => ids.has(task.id)) };
  };
  const data = await current();
  expect(data.tasks.map((task) => task.id).sort()).toEqual([...ids].sort());
  const before = await snapshot(page, data.tasks);
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
      if (!capturing) return route.continue();
      const response = await route.fetch();
      const latest = (await response.json()) as Workbench;
      // Isolate only the selected real HTTP fixture tasks. Retain their current
      // projections and server order, every other field and all TaskDetail reads.
      await route.fulfill({
        response,
        json: { ...latest, tasks: latest.tasks.filter((task) => ids.has(task.id)) },
      });
    })();
    pending.add(operation);
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
    data,
    tasks,
    userId,
    before,
    browserWrites,
    current,
    async stop(testFailed: boolean) {
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
      } else expect(failures).toEqual([]);
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

async function expectDashboard(page: Page, data: Workbench, scoped: Task[]) {
  // These fixtures have no Runs. Cancelled tasks must remain excluded from all
  // dashboard consumers even while the recent-list checkbox includes them.
  const normal = scoped.filter((task) => task.status !== 'cancelled');
  const current =
    normal.find((task) => task.status === 'in_progress') ??
    normal.find((task) => task.status === 'todo');
  if (current) {
    await expect(
      resume(page).getByRole('heading', { name: current.title, exact: true }),
    ).toBeVisible();
    await expect(resume(page).getByRole('link', { name: '继续任务' })).toHaveAttribute(
      'href',
      `/tasks/${current.id}`,
    );
  } else await expect(resume(page).getByRole('link', { name: '继续任务' })).toHaveCount(0);
  const attention = normal.filter((task) => task.attention && task.status !== 'done');
  const attentionLinks = page.locator('.home-attention > a.attention-row');
  await expect(attentionLinks).toHaveCount(attention.length);
  await expect
    .poll(() =>
      attentionLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    )
    .toEqual(attention.map((task) => `/tasks/${task.id}`));
  await expect(page.locator('.work-tabs > .muted')).toHaveText(
    `${normal.filter((task) => task.status === 'in_progress').length} 项进行中 · ${attention.length} 项需关注`,
  );
  const results = data.results
    .filter((result) => normal.some((task) => task.id === result.taskId))
    .slice(0, 3);
  await expect(resultLinks(page)).toHaveCount(results.length);
  await expect
    .poll(() =>
      resultLinks(page).evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    )
    .toEqual(results.map((result) => `/results/${result.id}`));
}

async function expectUnchanged(page: Page, f: Fixture, baseline = f.before) {
  expect(await snapshot(page, f.data.tasks)).toEqual(baseline);
  expect(f.browserWrites).toEqual([]);
}

async function expectHitTarget(target: Locator, width: number, height: number) {
  // CI200 left the mobile Task row fractionally clipped at the lower edge.
  // Place the actual target inside the viewport before retaining ratio=1.
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
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

async function captureCancelled(page: Page, task: Task, mobile = false) {
  const link = taskRow(page, task);
  const control = section(page).locator('label.workbench-task-list-option');
  await expect(includeCancelled(page)).toBeChecked();
  await expect(link).toHaveAttribute('href', `/tasks/${task.id}`);
  await expect(link.locator('strong')).toHaveText(task.title);
  await expect(link.locator('.badge')).toHaveText('已取消');
  await expect(link).toContainText('个人工作');
  await expectHitTarget(control, 44, mobile ? 44 : 32);
  await expectHitTarget(link, mobile ? 280 : 320, 44);
  for (const content of [page.locator('main'), section(page), control, link]) {
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect((await section(page).boundingBox())!.width).toBeGreaterThan(mobile ? 280 : 320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // A compact real cancelled-task fixture keeps the checked control, original
  // Task entry/status and list count together below the sticky topbar.
  await section(page).evaluate((element) => {
    const topbar = document.querySelector('.workbench-topbar');
    window.scrollTo({
      top:
        element.getBoundingClientRect().top +
        window.scrollY -
        (topbar?.getBoundingClientRect().height ?? 0) -
        16,
      behavior: 'instant',
    });
  });
  for (const target of [control, includeCancelled(page), link, section(page).getByRole('status')])
    await expect(target).toBeInViewport({ ratio: 1 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', mobile ? 'light' : 'dark');
  const path = mobile
    ? 'artifacts/233-workbench-cancelled-mobile-light.png'
    : 'artifacts/232-workbench-cancelled-dark.png';
  test.info().annotations.push({
    type: 'capture-surface',
    description: `${path}: ${mobile ? '390×844 light' : '1440×1000 dark'} viewport with checked 包括已取消任务, the real private cancelled Task link/status and current-list count.`,
  });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

test('主动包括较早已取消任务才可分批找回，切换范围与筛选重置首批并保留焦点', async ({ page }) => {
  const specs: TaskSpec[] = [
    {
      title: '较早取消的个人想法',
      private: true,
      status: 'cancelled',
      attention: '旧备注',
      result: true,
    },
    {
      title: '参与过的已取消任务',
      owner: 'other',
      participating: true,
      status: 'cancelled',
      result: true,
    },
    { title: '仅团队可见的已取消任务', owner: 'other', status: 'cancelled' },
    ...Array.from({ length: 9 }, (_, index) => ({
      title: `较新的项目任务 ${index + 1}`,
      participating: index < 3,
    })),
    {
      title: '当前进行中的项目任务',
      participating: true,
      status: 'in_progress',
      attention: '待核对',
      result: true,
    },
  ];
  const f = await fixture(page, specs);
  const old = f.tasks[0]!;
  const mine = f.data.tasks.filter((task) => task.ownerUserId === f.userId);
  const normalMine = mine.filter((task) => task.status !== 'cancelled');
  expect(old).toMatchObject({ projectId: null, visibility: 'private', status: 'cancelled' });
  expect(mine.findIndex((task) => task.id === old.id)).toBeGreaterThanOrEqual(8);
  let testFailed = false;
  try {
    await page.goto('/');
    await expect(includeCancelled(page)).not.toBeChecked();
    await expectRows(page, normalMine.slice(0, 8), normalMine.length);
    await expect(taskRow(page, old)).toHaveCount(0);
    await more(page).click();
    await expectRows(page, normalMine);
    await expect(rows(page).nth(8)).toBeFocused();
    await expect(taskRow(page, old)).toHaveCount(0);
    await expectDashboard(page, f.data, mine);

    await includeCancelled(page).focus();
    await includeCancelled(page).press('Space');
    await expect(includeCancelled(page)).toBeChecked();
    await expect(includeCancelled(page)).toBeFocused();
    await expectRows(page, mine.slice(0, 8), mine.length);
    await expect(collapse(page)).toHaveCount(0);
    await expect(taskRow(page, old)).toHaveCount(0);
    await more(page).click();
    await expectRows(page, mine);
    await expect(rows(page).nth(8)).toBeFocused();
    await expect(taskRow(page, old).locator('.badge')).toHaveText('已取消');
    await expectDashboard(page, f.data, mine);
    await includeCancelled(page).focus();
    await includeCancelled(page).press('Space');
    await expect(includeCancelled(page)).not.toBeChecked();
    await expect(includeCancelled(page)).toBeFocused();
    await expectRows(page, normalMine.slice(0, 8), normalMine.length);
    await expect(collapse(page)).toHaveCount(0);
    await includeCancelled(page).check();

    const participating = f.data.tasks.filter((task) =>
      task.participantUserIds?.includes(f.userId),
    );
    const team = f.data.tasks.filter((task) => task.visibility === 'project');
    for (const [label, scoped] of [
      ['我参与的', participating],
      ['团队概览', team],
      ['我的工作', mine],
    ] as const) {
      await tab(page, label).click();
      await expect(tab(page, label)).toHaveAttribute('aria-pressed', 'true');
      await expect(includeCancelled(page)).not.toBeChecked();
      const normal = scoped.filter((task) => task.status !== 'cancelled');
      await expectRows(page, normal.slice(0, 8), normal.length);
      await expect(collapse(page)).toHaveCount(0);
      await includeCancelled(page).check();
      await expect(includeCancelled(page)).toBeFocused();
      await expectRows(page, scoped.slice(0, 8), scoped.length);
      if (scoped.length > 8) {
        await more(page).click();
        await expectRows(page, scoped);
        await expect(rows(page).nth(8)).toBeFocused();
      }
      await expectDashboard(page, f.data, scoped);
    }
    await collapse(page).click();
    await expectRows(page, mine.slice(0, 8), mine.length);
    await expect(
      section(page).getByRole('heading', { name: '最近任务', exact: true }),
    ).toBeFocused();
    await expect(includeCancelled(page)).toBeChecked();
    await more(page).click();
    await expectRows(page, mine);
    await taskRow(page, old).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${old.id}$`));
    await expect(page.getByRole('heading', { name: old.title, exact: true })).toBeVisible();
    await expect(page.locator('.task-title .badge')).toHaveText('已取消');
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
    await expectUnchanged(page, f);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});

test('全已取消和真正空范围说明准确，暗色与手机浅色保留可达的原任务入口', async ({ page }) => {
  const f = await fixture(page, [
    { title: '可找回的个人工作', private: true, status: 'cancelled', result: true },
  ]);
  const cancelled = f.tasks[0]!;
  let testFailed = false;
  try {
    await page.goto('/');
    await expectRows(page, []);
    await expect(includeCancelled(page)).not.toBeChecked();
    await expect(section(page).getByText(cancelledDescription, { exact: true })).toBeVisible();
    await includeCancelled(page).check();
    await expectRows(page, f.data.tasks);
    await expectDashboard(page, f.data, f.data.tasks);
    await captureCancelled(page, cancelled);
    for (const label of ['我参与的', '团队概览']) {
      await tab(page, label).click();
      await expect(includeCancelled(page)).not.toBeChecked();
      await expectRows(page, []);
      await includeCancelled(page).check();
      await expectRows(page, []);
      await expect(more(page)).toHaveCount(0);
      await expect(collapse(page)).toHaveCount(0);
      await expect(section(page).getByText(cancelledDescription, { exact: true })).toHaveCount(0);
      await expectDashboard(page, f.data, []);
    }
    await tab(page, '我的工作').click();
    await expect(includeCancelled(page)).not.toBeChecked();
    await expectRows(page, []);
    await includeCancelled(page).check();
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectRows(page, f.data.tasks);
    await captureCancelled(page, cancelled, true);
    await taskRow(page, cancelled).focus();
    await taskRow(page, cancelled).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${cancelled.id}$`));
    await expect(page.getByRole('heading', { name: cancelled.title, exact: true })).toBeVisible();
    await expect(page.locator('.task-title .badge')).toHaveText('已取消');
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
    await expectUnchanged(page, f);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});

test('普通取消与重开立即采用当前投影，勾选状态保留且浏览不产生业务写入', async ({ page }) => {
  const f = await fixture(page, [
    {
      title: '参与中的状态更新任务',
      participating: true,
      status: 'in_progress',
      attention: '正在核对',
      result: true,
    },
    { title: '下一项个人工作', private: true },
  ]);
  const changing = f.tasks[0]!;
  let baseline = f.before;
  let testFailed = false;
  try {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/events' && response.status() === 200,
      ),
      page.goto('/'),
    ]);
    await tab(page, '我参与的').click();
    await expectRows(page, [changing]);
    await includeCancelled(page).check();
    await expectUnchanged(page, f);

    // Explicit ordinary fixture commands are the only mutations. Exact detail
    // comparisons allow only their status/revision/time and the existing
    // cancellation rule that clears attention to change.
    for (const action of ['cancel', 'reopen', 'cancel'] as const) {
      const prior = baseline.find((entry) => entry.task.id === changing.id)!.task;
      const receipt = await post<Task>(page, `tasks/${changing.id}/${action}`, {
        expectedRevision: prior.revision,
        ...(action === 'cancel' ? { activeRunAction: 'keep' } : {}),
      });
      const updated = (await detail(page, changing.id)).task;
      expect(receipt).toMatchObject({
        id: updated.id,
        status: updated.status,
        revision: updated.revision,
      });
      expect(updated).toEqual({
        ...prior,
        status: action === 'cancel' ? 'cancelled' : 'todo',
        attention: action === 'cancel' ? null : prior.attention,
        revision: prior.revision + 1,
        updatedAt: updated.updatedAt,
      });
      baseline = baseline.map((entry) =>
        entry.task.id === changing.id ? { ...entry, task: updated } : entry,
      );
      const current = await f.current();
      const participating = current.tasks.filter((task) =>
        task.participantUserIds?.includes(f.userId),
      );
      await expect(includeCancelled(page)).toBeChecked();
      await expectRows(page, participating);
      await expect(taskRow(page, changing).locator('.badge')).toHaveText(
        action === 'cancel' ? '已取消' : '待处理',
      );
      await expectDashboard(page, current, participating);
      if (action === 'cancel') {
        await expect(
          resume(page).getByRole('heading', { name: '暂无可继续的参与任务', exact: true }),
        ).toBeVisible();
        await expect(resume(page)).toContainText('可在下方勾选「包括已取消任务」查看。');
      }
      await includeCancelled(page).uncheck();
      await expectRows(page, action === 'cancel' ? [] : participating);
      if (action === 'cancel') {
        await expect(section(page).getByText(cancelledDescription, { exact: true })).toBeVisible();
        await expect(
          resume(page).getByRole('heading', { name: '还没有参与的任务', exact: true }),
        ).toHaveCount(0);
        await expect(
          resume(page).getByRole('heading', { name: '暂无可继续的参与任务', exact: true }),
        ).toBeVisible();
        await expect(resume(page)).toContainText('可在下方勾选「包括已取消任务」查看。');
      }
      await expectDashboard(page, current, participating);
      await includeCancelled(page).check();
      await expectRows(page, participating);
      await expectUnchanged(page, f, baseline);
    }
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});
