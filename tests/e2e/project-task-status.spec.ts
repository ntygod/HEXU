import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  Project,
  Result,
  Task,
  TaskDetail,
  TaskStatus,
} from '../../packages/contracts/src/index.js';

const statuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const labels = { todo: '待处理', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
const statusFilter = (page: Page) => page.getByLabel('任务状态筛选', { exact: true });
const ownerFilter = (page: Page) => page.getByLabel('负责人筛选', { exact: true });
const participantFilter = (page: Page) => page.getByLabel('参与者筛选', { exact: true });
const searchFilter = (page: Page) => page.getByLabel('筛选项目任务', { exact: true });
const boardLinks = (page: Page) => page.locator('.project-task-card > a');
const listLinks = (page: Page) => page.locator('.work-task-list > .work-task-row');

async function post<T>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function detail(page: Page, id: string): Promise<TaskDetail> {
  const response = await page.request.get(`/api/v1/tasks/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function fixture(page: Page, withDecoys = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: '项目状态筛选验收',
    description: '同一项目里的任务与成果，保留原有工作记录。',
  });
  const tasks: Task[] = [];
  async function create(
    status: TaskStatus,
    title: string,
    owner = 'user-demo-chen',
    participant = true,
    description = '状态筛选 alpha',
  ) {
    const task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId: project.id,
      title,
      description,
    });
    if (task.ownerUserId !== owner)
      await post(page, `tasks/${task.id}/assignment`, {
        expectedRevision: task.revision,
        ownerUserId: owner,
      });
    if (participant)
      await post(page, `tasks/${task.id}/participants`, {
        expectedRevision: 1,
        action: 'add',
        userId: 'user-demo-zhou',
      });
    if (status !== 'todo') {
      const action = { in_progress: 'start', done: 'complete', cancelled: 'cancel' }[status];
      await post(page, `tasks/${task.id}/${action}`, {
        expectedRevision: (await detail(page, task.id)).task.revision,
        activeRunAction: 'keep',
      });
    }
    const saved = await detail(page, task.id);
    expect(saved.task.status).toBe(status);
    expect(saved.runs).toEqual([]);
    tasks.push(saved.task);
    return saved.task;
  }
  const primary = {} as Record<TaskStatus, Task>;
  for (const status of statuses) primary[status] = await create(status, `${labels[status]}的工作`);
  if (withDecoys) {
    await create('cancelled', '另一位负责人的已取消工作', 'user-demo-lin');
    await create('cancelled', '未参与的已取消工作', 'user-demo-chen', false);
    await create('cancelled', '另一段说明的已取消工作', 'user-demo-chen', true, '状态筛选 beta');
  }
  // Ordinary text results need no Run. The cancelled result remains outside the
  // existing project results view, including when cancelled tasks are selected.
  const activeResult = await post<Result>(page, `tasks/${primary.todo.id}/results`, {
    title: '项目原有成果',
    body: '任务状态筛选不改变这份项目成果。',
  });
  await post<Result>(page, `tasks/${primary.cancelled.id}/results`, {
    title: '已取消任务保留的成果',
    body: '在原任务中保留，不因项目筛选而改变原有成果范围。',
  });
  const before = await Promise.all(tasks.map((task) => detail(page, task.id)));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return { project, tasks, primary, activeResult, before, writes };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectIds(links: Locator, tasks: Task[]) {
  await expect(links).toHaveCount(tasks.length);
  await expect
    .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href')).sort()))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`).sort());
}

async function expectUnchanged(page: Page, f: Fixture) {
  expect(await Promise.all(f.tasks.map((task) => detail(page, task.id)))).toEqual(f.before);
  expect(f.writes).toEqual([]);
}

async function expectSelection(page: Page, view: 'board' | 'list', task: Task) {
  await expect(statusFilter(page)).toHaveValue('cancelled');
  await expect(ownerFilter(page)).toHaveValue('user-demo-chen');
  await expect(participantFilter(page)).toHaveValue('user-demo-zhou');
  await expect(searchFilter(page)).toHaveValue('alpha');
  await expect(
    page.getByRole('button', { name: view === 'board' ? '看板' : '列表', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectIds(view === 'board' ? boardLinks(page) : listLinks(page), [task]);
}

test('项目状态与人员文字筛选取交集，看板列表及刷新前进后退一致，成果总览保持原范围', async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.goto(`/projects/${f.project.id}?tab=tasks&keep=stable#filter-anchor`);
  const defaults = [f.primary.todo, f.primary.in_progress, f.primary.done];
  await expect(statusFilter(page)).toHaveValue('');
  await expect(statusFilter(page).locator('option')).toHaveText([
    '默认状态（不含已取消）',
    '待处理',
    '进行中',
    '已完成',
    '已取消',
  ]);
  await expectIds(boardLinks(page), defaults);
  await expect(page.locator('.project-column > header .badge')).toHaveText([
    '待处理',
    '进行中',
    '已完成',
  ]);
  for (const task of defaults) {
    const select = page.getByLabel(`${task.shortId} 状态`, { exact: true });
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveText(['待处理', '进行中', '已完成']);
  }
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), defaults);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  for (const status of statuses) {
    const expected = f.tasks.filter((task) => task.status === status);
    await statusFilter(page).selectOption(status);
    expect(new URL(page.url()).searchParams.getAll('status')).toEqual([status]);
    await expect(page.locator('.project-column > header .badge')).toHaveText([labels[status]]);
    await expectIds(boardLinks(page), expected);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await expectIds(listLinks(page), expected);
    await page.getByRole('button', { name: '看板', exact: true }).click();
  }
  await ownerFilter(page).selectOption('user-demo-chen');
  await expectIds(
    boardLinks(page),
    f.tasks.filter((task) => task.status === 'cancelled' && task.ownerUserId === 'user-demo-chen'),
  );
  await participantFilter(page).selectOption('user-demo-zhou');
  await expectIds(
    boardLinks(page),
    f.tasks.filter(
      (task) =>
        task.status === 'cancelled' &&
        task.ownerUserId === 'user-demo-chen' &&
        task.participantUserIds?.includes('user-demo-zhou'),
    ),
  );
  await searchFilter(page).fill('alpha');
  await expectSelection(page, 'board', f.primary.cancelled);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectSelection(page, 'list', f.primary.cancelled);
  const selectedUrl = page.url();
  await page.reload();
  await expectSelection(page, 'list', f.primary.cancelled);
  await page.goBack();
  await expectSelection(page, 'board', f.primary.cancelled);
  await page.goBack();
  await expect(participantFilter(page)).toHaveValue('');
  await expect(searchFilter(page)).toHaveValue('');
  await expectIds(
    boardLinks(page),
    f.tasks.filter((task) => task.status === 'cancelled' && task.ownerUserId === 'user-demo-chen'),
  );
  await page.goForward();
  await expectSelection(page, 'board', f.primary.cancelled);
  await page.goForward();
  await expect(page).toHaveURL(selectedUrl);
  await expectSelection(page, 'list', f.primary.cancelled);

  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.project-status-counts strong')).toHaveText(['1', '1', '1']);
  await page.getByRole('button', { name: '项目成果', exact: true }).click();
  await expect(page.locator('.work-result-grid > a')).toHaveCount(1);
  await expect(page.locator('.work-result-grid > a')).toHaveAttribute(
    'href',
    `/results/${f.activeResult.id}`,
  );
  await page.getByRole('button', { name: '需求与任务', exact: true }).click();
  await expectSelection(page, 'list', f.primary.cancelled);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expectIds(listLinks(page), defaults);
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.project-status-counts strong')).toHaveText(['1', '1', '1']);
  await page.getByRole('button', { name: '项目成果', exact: true }).click();
  await expect(page.locator('.work-result-grid > a')).toHaveCount(1);
  await expect(page.locator('.work-result-grid > a')).toHaveAttribute(
    'href',
    `/results/${f.activeResult.id}`,
  );
  await expectUnchanged(page, f);
});

test('非法状态链接明确报错且无匹配，清除全部筛选保留视图和无关 URL，合法空结果可辨认', async ({
  page,
}) => {
  const f = await fixture(page);
  for (const query of [
    'status=unknown',
    'status=',
    'status=%20',
    'status=%20todo%20',
    'status=todo&status=todo',
    'status=todo&status=cancelled',
  ]) {
    await page.goto(
      `/projects/${f.project.id}?${query}&view=list&tab=tasks&keep=stable&q=alpha&ownerUserId=user-demo-chen&participantUserId=user-demo-zhou#filter-anchor`,
    );
    await expect(page.getByRole('alert')).toContainText('状态筛选无效');
    await expect(page.getByRole('alert')).toContainText('请重新选择状态或清除筛选。');
    await expect(statusFilter(page).locator('option:checked')).toHaveText('链接中的状态无效');
    await expect(statusFilter(page)).toBeEnabled();
    // toBeDisabled follows this option's wrapping label to its enabled select.
    // Check the option's own native state; the select must still allow recovery.
    await expect(statusFilter(page).locator('option:checked')).toHaveJSProperty('disabled', true);
    await expect(page.locator('.project-toolbar')).toContainText('0 项任务');
    await expectIds(listLinks(page), []);
    await expectIds(boardLinks(page), []);
  }
  await statusFilter(page).selectOption('todo');
  expect(new URL(page.url()).searchParams.getAll('status')).toEqual(['todo']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectIds(listLinks(page), [f.primary.todo]);
  await page.goBack();
  await expect(page.getByRole('alert')).toContainText('状态筛选无效');
  await expectIds(listLinks(page), []);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('状态筛选无效');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('状态筛选无效');
  await expectIds(boardLinks(page), []);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(statusFilter(page)).toHaveValue('');
  await expect(ownerFilter(page)).toHaveValue('');
  await expect(participantFilter(page)).toHaveValue('');
  await expect(searchFilter(page)).toHaveValue('');
  await expectIds(listLinks(page), [f.primary.todo, f.primary.in_progress, f.primary.done]);
  const url = new URL(page.url());
  expect([...url.searchParams.entries()].sort()).toEqual([
    ['keep', 'stable'],
    ['tab', 'tasks'],
    ['view', 'list'],
  ]);
  expect(url.hash).toBe('#filter-anchor');
  await statusFilter(page).selectOption('cancelled');
  await searchFilter(page).fill('没有对应工作的文字');
  await expectIds(listLinks(page), []);
  await expect(page.getByRole('heading', { name: '没有匹配的任务', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.project-toolbar')).toContainText('0 项任务');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expect(page.locator('.project-column > header .badge')).toHaveText(['已取消']);
  await expectIds(boardLinks(page), []);
  await expect(page.locator('.project-column')).toContainText('暂无任务');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectUnchanged(page, f);
});

async function captureCancelled(
  page: Page,
  task: Task,
  path: string,
  input: 'keyboard' | 'pointer',
) {
  const card = page
    .locator('.project-task-card')
    .filter({ has: page.locator(`a[href="/tasks/${task.id}"]`) });
  const link = card.getByRole('link');
  await statusFilter(page).scrollIntoViewIfNeeded();
  await link.scrollIntoViewIfNeeded();
  await expect(statusFilter(page)).toHaveValue('cancelled');
  await expect(statusFilter(page)).toBeInViewport({ ratio: 1 });
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(link).toBeVisible();
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect(card.getByRole('combobox')).toHaveCount(0);
  await expect(card).toContainText(task.title);
  await expect(card.getByText('打开任务详情查看讨论与成果', { exact: true })).toBeInViewport({
    ratio: 1,
  });
  for (const content of [page.locator('main'), card]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await link.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width >= 44 &&
        rect.height >= 44 &&
        element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        )
      );
    }),
  ).toBe(true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
  if (input === 'keyboard') {
    await link.focus();
    await expect(link).toBeFocused();
    await link.press('Enter');
  } else await link.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('已取消');
  await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
}

test('已取消看板卡片只读并进入原任务重开入口，桌面暗色与手机浅色筛选和链接可用', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/projects/${f.project.id}?status=cancelled`);
  await expectIds(boardLinks(page), [f.primary.cancelled]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await captureCancelled(
    page,
    f.primary.cancelled,
    'artifacts/217-project-task-status-dark.png',
    'keyboard',
  );
  await page.goBack();
  await expectIds(boardLinks(page), [f.primary.cancelled]);
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await statusFilter(page).scrollIntoViewIfNeeded();
  await statusFilter(page).selectOption('done');
  await expectIds(boardLinks(page), [f.primary.done]);
  await statusFilter(page).selectOption('cancelled');
  await expectIds(boardLinks(page), [f.primary.cancelled]);
  await captureCancelled(
    page,
    f.primary.cancelled,
    'artifacts/218-project-task-status-mobile-light.png',
    'pointer',
  );
  await expectUnchanged(page, f);
});
