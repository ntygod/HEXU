import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Result, Task, TaskDetail, Workbench } from '../../packages/contracts/src/index.js';
import type { TaskParticipantsView } from '../../packages/contracts/src/task-participants.js';

const section = (page: Page) => page.getByRole('region', { name: '最近任务', exact: true });
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
const emptyDescription = '还没有参与的任务。可在项目任务详情的「参与者」中加入。';

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

async function participate(page: Page, task: Task, userId: string, action: 'add' | 'remove') {
  const current = await get<TaskParticipantsView>(page, `tasks/${task.id}/participants`);
  await post(page, `tasks/${task.id}/participants`, {
    expectedRevision: current.revision,
    userId,
    action,
  });
}

interface TaskSpec {
  title: string;
  owner?: 'self' | 'other';
  participant?: 'self' | 'other';
  private?: boolean;
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
      description: '在原任务中协作与浏览。',
      projectId: spec.private ? null : 'project-orders',
    });
    if (spec.owner === 'other')
      task = await post<Task>(page, `tasks/${task.id}/assignment`, {
        expectedRevision: task.revision,
        ownerUserId: other.id,
      });
    if (spec.participant)
      await participate(page, task, spec.participant === 'self' ? userId : other.id, 'add');
    if (spec.status && spec.status !== 'todo')
      await post(
        page,
        `tasks/${task.id}/${{ in_progress: 'start', done: 'complete', cancelled: 'cancel' }[spec.status]}`,
        {
          expectedRevision: task.revision,
          activeRunAction: 'keep',
        },
      );
    if (spec.attention) {
      const saved = (await detail(page, task.id)).task;
      const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
        headers: headers(),
        data: { expectedRevision: saved.revision, attention: spec.attention },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    if (spec.result)
      await post<Result>(page, `tasks/${task.id}/results`, {
        title: `${spec.title}的成果`,
        body: '这份文字成果仍属于原任务。',
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
      // Bound isolation to these ordinary HTTP fixture tasks. Preserve their
      // current real projections and server order, all other Workbench fields,
      // and every TaskDetail response; never fabricate participation or identity.
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
    otherId: other.id,
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

async function expectDashboard(page: Page, data: Workbench, selected: Task[]) {
  await expectRows(page, selected);
  const current =
    selected.find((task) => task.status === 'in_progress') ??
    selected.find((task) => task.status === 'todo');
  if (current) {
    await expect(
      resume(page).getByRole('heading', { name: current.title, exact: true }),
    ).toBeVisible();
    await expect(resume(page).getByRole('link', { name: '继续任务' })).toHaveAttribute(
      'href',
      `/tasks/${current.id}`,
    );
  } else await expect(resume(page).getByRole('link', { name: '继续任务' })).toHaveCount(0);
  const attention = selected.filter((task) => task.attention && task.status !== 'done');
  const links = page.locator('.home-attention > a.attention-row');
  await expect(links).toHaveCount(attention.length);
  await expect
    .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href'))))
    .toEqual(attention.map((task) => `/tasks/${task.id}`));
  await expect(page.locator('.work-tabs > .muted')).toHaveText(
    `${selected.filter((task) => task.status === 'in_progress').length} 项进行中 · ${attention.length} 项需关注`,
  );
  const results = data.results
    .filter((result) => selected.some((task) => task.id === result.taskId))
    .slice(0, 3);
  await expect(resultLinks(page)).toHaveCount(results.length);
  await expect
    .poll(() =>
      resultLinks(page).evaluateAll((items) => items.map((item) => item.getAttribute('href'))),
    )
    .toEqual(results.map((result) => `/results/${result.id}`));
}

async function expectUnchanged(page: Page, f: Fixture, baseline = f.before) {
  expect(await snapshot(page, f.data.tasks)).toEqual(baseline);
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

async function captureSelection(page: Page, selected: Task[], mobile = false) {
  const selectedTab = tab(page, '我参与的');
  for (const label of ['我的工作', '我参与的', '团队概览'])
    await expectHitTarget(tab(page, label), 44, mobile ? 44 : 32);
  for (const task of selected) await expectHitTarget(taskRow(page, task), mobile ? 280 : 320, 44);
  for (const content of [
    page.locator('main'),
    page.locator('.work-tabs'),
    section(page),
    rows(page).first(),
  ]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(mobile ? 280 : 320);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // This compact two-row fixture can show the selected tab, actual rows and
  // count together. Scroll beneath the real sticky topbar, then prove all are
  // in the viewport; a full-page image alone would not establish reachability.
  await page.locator('.work-tabs').evaluate((element) => {
    const topbar = document.querySelector('.workbench-topbar');
    const top =
      element.getBoundingClientRect().top +
      window.scrollY -
      (topbar?.getBoundingClientRect().height ?? 0) -
      16;
    window.scrollTo({ top, behavior: 'instant' });
  });
  await expect(selectedTab).toHaveAttribute('aria-pressed', 'true');
  await expect(selectedTab).toBeInViewport({ ratio: 1 });
  for (const task of selected) await expect(taskRow(page, task)).toBeInViewport({ ratio: 1 });
  await expect(section(page).getByRole('status')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', mobile ? 'light' : 'dark');
  const path = mobile
    ? 'artifacts/231-workbench-participating-mobile-light.png'
    : 'artifacts/230-workbench-participating-dark.png';
  test.info().annotations.push({
    type: 'capture-surface',
    description: `${path}: ${mobile ? '390×844 light' : '1440×1000 dark'} viewport, selected 我参与的 tab, two real participating task rows and current-list count visible beneath sticky topbar.`,
  });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

test('我参与的按当前参与关系筛选整个工作台，明暗与手机入口保留原任务详情', async ({ page }) => {
  const f = await fixture(page, [
    {
      title: '一起核对字段',
      owner: 'other',
      participant: 'self',
      status: 'in_progress',
      attention: '待核对字段',
      result: true,
    },
    {
      title: '已整理的说明',
      participant: 'self',
      status: 'done',
      attention: '完成后的备注',
      result: true,
    },
    { title: '只由我负责', status: 'in_progress', attention: '负责人对照', result: true },
    {
      title: '仅他人参与',
      owner: 'other',
      participant: 'other',
      attention: '他人参与对照',
      result: true,
    },
    { title: '自己的个人工作', private: true, result: true },
    {
      title: '参与过的已取消工作',
      owner: 'other',
      participant: 'self',
      status: 'cancelled',
      attention: '取消对照',
      result: true,
    },
  ]);
  const available = f.data.tasks.filter((task) => task.status !== 'cancelled');
  const selected = available.filter((task) => task.participantUserIds?.includes(f.userId));
  expect(selected).toHaveLength(2);
  let testFailed = false;
  try {
    await page.goto('/');
    await expectDashboard(
      page,
      f.data,
      available.filter((task) => task.ownerUserId === f.userId),
    );
    await tab(page, '我参与的').focus();
    await tab(page, '我参与的').press('Enter');
    await expect(
      page.getByRole('heading', { level: 1, name: '我参与的', exact: true }),
    ).toBeVisible();
    await expectDashboard(page, f.data, selected);
    await expect(collapse(page)).toHaveCount(0);
    await expect(more(page)).toHaveCount(0);
    await captureSelection(page, selected);
    await tab(page, '团队概览').click();
    await expectDashboard(
      page,
      f.data,
      available.filter((task) => task.visibility === 'project'),
    );
    await tab(page, '我参与的').click();
    await expectDashboard(page, f.data, selected);
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await captureSelection(page, selected, true);
    const task = selected[0]!;
    await taskRow(page, task).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    await expectUnchanged(page, f);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});

test('我参与的超过八项后展开和收起，三个页签各自重置首批并支持键盘深链接', async ({ page }) => {
  const specs: TaskSpec[] = Array.from({ length: 10 }, (_, index) => ({
    title: `共同浏览任务 ${index + 1}`,
    owner: index < 8 ? 'self' : 'other',
    participant: 'self',
  }));
  specs.push(
    { title: '只负责的项目任务甲' },
    { title: '只负责的项目任务乙' },
    { title: '只负责的个人任务', private: true },
  );
  const f = await fixture(page, specs);
  const mine = f.data.tasks.filter((task) => task.ownerUserId === f.userId);
  const participating = f.data.tasks.filter((task) => task.participantUserIds?.includes(f.userId));
  const team = f.data.tasks.filter((task) => task.visibility === 'project');
  let testFailed = false;
  try {
    await page.goto('/');
    await expectRows(page, mine.slice(0, 8), mine.length);
    await more(page).click();
    await expectRows(page, mine);
    for (const [label, tasks] of [
      ['我参与的', participating],
      ['团队概览', team],
      ['我的工作', mine],
      ['我参与的', participating],
    ] as const) {
      await tab(page, label).click();
      await expectRows(page, tasks.slice(0, 8), tasks.length);
      await expect(collapse(page)).toHaveCount(0);
      await more(page).focus();
      await more(page).press('Enter');
      await expectRows(page, tasks);
      await expect(rows(page).nth(8)).toBeFocused();
      await expect(more(page)).toHaveCount(0);
    }
    await collapse(page).focus();
    await collapse(page).press('Enter');
    await expectRows(page, participating.slice(0, 8), participating.length);
    await expect(
      section(page).getByRole('heading', { name: '最近任务', exact: true }),
    ).toBeFocused();
    await more(page).focus();
    await more(page).press('Space');
    await expectRows(page, participating);
    await expect(rows(page).nth(8)).toBeFocused();
    const ninth = participating[8]!;
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

test('当前加入和退出投影立即更新参与任务、继续卡与成果，空列表和全部完成说明准确', async ({
  page,
}) => {
  const f = await fixture(page, [
    { title: '参与后已完成', owner: 'other', participant: 'self', status: 'done', result: true },
    {
      title: '可以加入的工作',
      owner: 'other',
      participant: 'other',
      attention: '等待共同核对',
      result: true,
    },
    { title: '仍只由我负责' },
  ]);
  const done = f.tasks[0]!;
  const joining = f.tasks[1]!;
  let expected = f.before;
  const expectedParticipation = (task: Task, participantUserIds: string[]) => {
    expected = expected.map((entry) =>
      entry.task.id === task.id ? { ...entry, task: { ...entry.task, participantUserIds } } : entry,
    );
  };
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
    await expectDashboard(page, f.data, [done]);
    await expect(
      resume(page).getByRole('heading', { name: '暂无可继续的参与任务', exact: true }),
    ).toBeVisible();
    await expect(resume(page)).toContainText('已参与的任务仍可在下方查看。');
    await expect(section(page).getByText(emptyDescription, { exact: true })).toHaveCount(0);
    await expectUnchanged(page, f);

    // These are explicit fixture HTTP mutations. The browser only navigates;
    // exact full-detail equality permits only the known participation projection.
    await participate(page, joining, f.userId, 'add');
    expectedParticipation(joining, [f.otherId, f.userId].sort());
    let data = await f.current();
    await expectDashboard(
      page,
      data,
      data.tasks.filter((task) => task.participantUserIds?.includes(f.userId)),
    );
    await expectUnchanged(page, f, expected);

    await participate(page, done, f.userId, 'remove');
    expectedParticipation(done, []);
    data = await f.current();
    await expectDashboard(
      page,
      data,
      data.tasks.filter((task) => task.id === joining.id),
    );
    await expectUnchanged(page, f, expected);

    await participate(page, joining, f.userId, 'remove');
    expectedParticipation(joining, [f.otherId]);
    data = await f.current();
    await expectDashboard(page, data, []);
    await expect(tab(page, '我参与的')).toHaveAttribute('aria-pressed', 'true');
    await expect(
      resume(page).getByRole('heading', { name: '还没有参与的任务', exact: true }),
    ).toBeVisible();
    await expect(resume(page)).toContainText('可在项目任务详情的「参与者」中加入。');
    await expect(resume(page).getByRole('button', { name: '新建任务', exact: true })).toHaveCount(
      0,
    );
    await expect(section(page).getByText(emptyDescription, { exact: true })).toBeVisible();
    await expect(more(page)).toHaveCount(0);
    await expect(collapse(page)).toHaveCount(0);
    await tab(page, '团队概览').click();
    await expectRows(
      page,
      data.tasks.filter((task) => task.visibility === 'project'),
    );
    await taskRow(page, joining).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${joining.id}$`));
    await expect(page.getByRole('heading', { name: joining.title, exact: true })).toBeVisible();
    await expectUnchanged(page, f, expected);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await f.stop(testFailed);
  }
});
