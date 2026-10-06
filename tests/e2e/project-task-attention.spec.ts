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

const attentionFilter = (page: Page) => page.getByLabel('关注内容筛选', { exact: true });
const statusFilter = (page: Page) => page.getByLabel('任务状态筛选', { exact: true });
const ownerFilter = (page: Page) => page.getByLabel('负责人筛选', { exact: true });
const participantFilter = (page: Page) => page.getByLabel('参与者筛选', { exact: true });
const searchFilter = (page: Page) => page.getByLabel('筛选项目任务', { exact: true });
const boardLinks = (page: Page) => page.locator('.project-task-card > a');
const listLinks = (page: Page) => page.locator('.work-task-list > .work-task-row');
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function detail(page: Page, id: string): Promise<TaskDetail> {
  const response = await page.request.get(`/api/v1/tasks/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function patchAttention(page: Page, task: Task, attention: string | null): Promise<Task> {
  const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, attention },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function snapshot(page: Page, tasks: Task[]) {
  return Promise.all(tasks.map((task) => detail(page, task.id)));
}

async function fixture(page: Page, withDecoys = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: '项目关注内容筛选验收',
    description: '按已保存的关注文字查找当前项目任务。',
  });
  const tasks: Task[] = [];
  async function create(
    title: string,
    attention: string | null,
    status: TaskStatus = 'todo',
    owner = 'user-demo-chen',
    participant = true,
    description = '关注筛选 alpha',
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
    if (status !== 'todo')
      await post(
        page,
        `tasks/${task.id}/${{ in_progress: 'start', done: 'complete', cancelled: 'cancel' }[status]}`,
        {
          expectedRevision: (await detail(page, task.id)).task.revision,
          activeRunAction: 'keep',
        },
      );
    // Completion/cancellation clear old attention; save this ordinary text only
    // after creating the desired status. No Run or model work is involved.
    if (attention !== null)
      await patchAttention(page, (await detail(page, task.id)).task, attention);
    const saved = await detail(page, task.id);
    expect(saved.task.attention).toBe(attention === null ? null : attention.trim());
    expect(saved.task.status).toBe(status);
    expect(saved.runs).toEqual([]);
    tasks.push(saved.task);
    return saved.task;
  }
  const empty = await create('现场同步的工作', null);
  const blank = await create('只填空白关注的工作', ' \t\n　 ');
  const present = await create('接口字段的工作', '普通备注：核对字段示例');
  const progress = await create('进行中的工作', 'waiting / blocked 只是普通文字', 'in_progress');
  const done = await create('已完成的工作', '完成后保留的备注', 'done');
  const cancelled = await create('已取消的工作', '取消后保留的备注', 'cancelled');
  if (withDecoys) {
    await create('另一位负责人的工作', '负责人对照', 'todo', 'user-demo-lin');
    await create('未参与的工作', '参与者对照', 'todo', 'user-demo-chen', false);
    await create('另一段说明的工作', '关键词对照', 'todo', 'user-demo-chen', true, '关注筛选 beta');
  }
  const unfilteredResult = withDecoys
    ? await post<Result>(page, `tasks/${empty.id}/results`, {
        title: '无关注任务的原有成果',
        body: '项目成果保留自己的范围，不随任务关注筛选改变。',
      })
    : null;
  // Existing PATCH normalizes whitespace to an empty string. This is the real
  // HTTP fixture boundary; raw-whitespace projections are covered by unit tests.
  expect(blank.attention).toBe('');
  const before = await snapshot(page, tasks);
  const browserWrites: string[] = [];
  // Page requests capture browser UI writes, separately from explicit fixture
  // setup and the page.request PATCH used by the live-update test below.
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return {
    project,
    tasks,
    empty,
    blank,
    present,
    progress,
    done,
    cancelled,
    unfilteredResult,
    before,
    browserWrites,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectIds(links: Locator, tasks: Task[]) {
  await expect(links).toHaveCount(tasks.length);
  await expect
    .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href')).sort()))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`).sort());
}

async function expectUnchanged(page: Page, f: Fixture, baseline = f.before) {
  expect(await snapshot(page, f.tasks)).toEqual(baseline);
  expect(f.browserWrites).toEqual([]);
}

async function expectSelection(page: Page, view: 'board' | 'list', task: Task) {
  await expect(attentionFilter(page)).toHaveValue('present');
  await expect(statusFilter(page)).toHaveValue('todo');
  await expect(ownerFilter(page)).toHaveValue('user-demo-chen');
  await expect(participantFilter(page)).toHaveValue('user-demo-zhou');
  await expect(searchFilter(page)).toHaveValue('alpha');
  await expect(
    page.getByRole('button', { name: view === 'board' ? '看板' : '列表', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectIds(view === 'board' ? boardLinks(page) : listLinks(page), [task]);
}

test('关注文字有无与状态人员关键词取交集，看板列表和历史导航一致且只读', async ({ page }) => {
  const f = await fixture(page, true);
  const defaults = f.tasks.filter((task) => task.status !== 'cancelled');
  const present = defaults.filter((task) => task.id !== f.empty.id && task.id !== f.blank.id);
  await page.goto(`/projects/${f.project.id}?tab=tasks&keep=stable#filter-anchor`);
  await expect(attentionFilter(page)).toHaveValue('');
  await expect(attentionFilter(page).locator('option')).toHaveText([
    '全部关注情况',
    '有关注内容',
    '无关注内容',
  ]);
  await expect(statusFilter(page)).toHaveValue('');
  await expectIds(boardLinks(page), defaults);
  await attentionFilter(page).selectOption('absent');
  expect(new URL(page.url()).searchParams.getAll('attention')).toEqual(['absent']);
  await expectIds(boardLinks(page), [f.empty, f.blank]);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), [f.empty, f.blank]);
  await attentionFilter(page).selectOption('present');
  await expectIds(listLinks(page), present);
  await expect(listLinks(page).filter({ hasText: f.progress.title })).toContainText(
    f.progress.attention!,
  );
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), present);
  await statusFilter(page).selectOption('todo');
  await expectIds(
    boardLinks(page),
    present.filter((task) => task.status === 'todo'),
  );
  await ownerFilter(page).selectOption('user-demo-chen');
  const owned = present.filter(
    (task) => task.status === 'todo' && task.ownerUserId === 'user-demo-chen',
  );
  await expectIds(boardLinks(page), owned);
  await participantFilter(page).selectOption('user-demo-zhou');
  await expectIds(
    boardLinks(page),
    owned.filter((task) => task.participantUserIds?.includes('user-demo-zhou')),
  );
  await searchFilter(page).fill('alpha');
  await expectSelection(page, 'board', f.present);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectSelection(page, 'list', f.present);
  const selectedUrl = page.url();
  await page.reload();
  await expectSelection(page, 'list', f.present);
  await page.goBack();
  await expectSelection(page, 'board', f.present);
  await page.goBack();
  await expect(attentionFilter(page)).toHaveValue('present');
  await expect(participantFilter(page)).toHaveValue('');
  await expect(searchFilter(page)).toHaveValue('');
  await expectIds(boardLinks(page), owned);
  await page.goForward();
  await expectSelection(page, 'board', f.present);
  await page.goForward();
  await expect(page).toHaveURL(selectedUrl);
  await expectSelection(page, 'list', f.present);
  expect(new URL(page.url()).searchParams.getAll('attention')).toEqual(['present']);

  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.project-status-counts strong')).toHaveText(['6', '1', '1']);
  await page.getByRole('button', { name: '项目成果', exact: true }).click();
  expect(f.unfilteredResult).not.toBeNull();
  await expect(page.locator('.work-result-grid > a')).toHaveCount(1);
  await expect(page.locator('.work-result-grid > a')).toHaveAttribute(
    'href',
    `/results/${f.unfilteredResult!.id}`,
  );
  expect(new URL(page.url()).searchParams.getAll('attention')).toEqual(['present']);
  await page.getByRole('button', { name: '需求与任务', exact: true }).click();
  await expectSelection(page, 'list', f.present);

  await statusFilter(page).selectOption('cancelled');
  await expectIds(listLinks(page), [f.cancelled]);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), [f.cancelled]);
  await expect(page.locator('.project-column > header .badge')).toHaveText(['已取消']);
  await expect(page.locator('.project-task-card').getByRole('combobox')).toHaveCount(0);
  await boardLinks(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${f.cancelled.id}$`));
  await expect(page.getByRole('heading', { name: f.cancelled.title, exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('已取消');
  await expectUnchanged(page, f);
});

test('非法关注链接明确报错并可修复，清除全部筛选保留视图和无关 URL', async ({ page }) => {
  const f = await fixture(page);
  for (const query of [
    'attention=unknown',
    'attention=',
    'attention=%20',
    'attention=%20present%20',
    'attention=present&attention=present',
    'attention=present&attention=absent',
  ]) {
    await page.goto(
      `/projects/${f.project.id}?${query}&status=todo&view=list&tab=tasks&keep=stable&q=alpha&ownerUserId=user-demo-chen&participantUserId=user-demo-zhou#filter-anchor`,
    );
    await expect(page.getByRole('alert')).toContainText('关注筛选无效');
    await expect(page.getByRole('alert')).toContainText('请重新选择关注情况或清除筛选。');
    await expect(attentionFilter(page).locator('option:checked')).toHaveText(
      '链接中的关注筛选无效',
    );
    await expect(attentionFilter(page)).toBeEnabled();
    // Native option state matters: toBeDisabled follows the wrapping label to
    // the enabled select, which must remain usable for invalid-link recovery.
    await expect(attentionFilter(page).locator('option:checked')).toHaveJSProperty(
      'disabled',
      true,
    );
    await expect(page.locator('.project-toolbar')).toContainText('0 项任务');
    await expectIds(listLinks(page), []);
    await expectIds(boardLinks(page), []);
  }
  await attentionFilter(page).selectOption('present');
  expect(new URL(page.url()).searchParams.getAll('attention')).toEqual(['present']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectIds(listLinks(page), [f.present]);
  await page.goBack();
  await expect(page.getByRole('alert')).toContainText('关注筛选无效');
  await page.goForward();
  await expectIds(listLinks(page), [f.present]);
  await searchFilter(page).fill('没有对应的关注工作');
  await expectIds(listLinks(page), []);
  await expect(page.getByRole('heading', { name: '没有匹配的任务', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('alert')).toContainText('关注筛选无效');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  for (const filter of [
    attentionFilter(page),
    statusFilter(page),
    ownerFilter(page),
    participantFilter(page),
    searchFilter(page),
  ])
    await expect(filter).toHaveValue('');
  await expectIds(listLinks(page), [f.empty, f.blank, f.present, f.progress, f.done]);
  const url = new URL(page.url());
  expect([...url.searchParams.entries()].sort()).toEqual([
    ['keep', 'stable'],
    ['tab', 'tasks'],
    ['view', 'list'],
  ]);
  expect(url.hash).toBe('#filter-anchor');
  await expectUnchanged(page, f);
});

async function captureAttention(
  page: Page,
  task: Task,
  path: string,
  input: 'keyboard' | 'pointer',
) {
  const select = attentionFilter(page);
  const link = boardLinks(page).filter({
    has: page.getByRole('heading', { name: task.title, exact: true }),
  });
  const attention = link.locator('.badge.amber');
  await select.scrollIntoViewIfNeeded();
  await attention.scrollIntoViewIfNeeded();
  await expect(select).toHaveValue('present');
  await expect(select.locator('option:checked')).toHaveText('有关注内容');
  await expect(select).toBeInViewport({ ratio: 1 });
  await expect(link).toBeVisible();
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect(attention).toHaveText(task.attention!);
  await expect(attention).toBeInViewport({ ratio: 1 });
  for (const content of [page.locator('main'), link]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  for (const [target, minWidth, minHeight] of [
    [select, 100, 32],
    [link, 240, 44],
  ] as const) {
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
        { width: minWidth, height: minHeight },
      ),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
  if (input === 'keyboard') {
    await link.focus();
    await expect(link).toBeFocused();
    await link.press('Enter');
  } else await link.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
}

test('普通关注修改经事件刷新进入筛选结果，桌面暗色键盘和手机浅色指针可用', async ({ page }) => {
  const f = await fixture(page);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/events' && response.status() === 200,
    ),
    page.goto(
      `/projects/${f.project.id}?attention=absent&status=todo&q=${encodeURIComponent(f.empty.title)}`,
    ),
  ]);
  await expectIds(boardLinks(page), [f.empty]);
  // Establish the unchanged filter-only baseline before the deliberate API
  // content edit. That edit is not attributed to any browser filter action.
  const beforeUpdate = await snapshot(page, f.tasks);
  expect(beforeUpdate).toEqual(f.before);
  expect(f.browserWrites).toEqual([]);
  const text = '接口字段已确认，待补充示例';
  const [, updated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/workbench' &&
        response.request().method() === 'GET' &&
        response.ok(),
    ),
    patchAttention(page, f.empty, text),
  ]);
  await expect(attentionFilter(page)).toHaveValue('absent');
  await expectIds(boardLinks(page), []);
  const afterUpdate = await snapshot(page, f.tasks);
  expect(afterUpdate).toEqual(
    beforeUpdate.map((entry) =>
      entry.task.id === f.empty.id
        ? {
            ...entry,
            task: {
              ...entry.task,
              attention: text,
              revision: entry.task.revision + 1,
              updatedAt: updated.updatedAt,
            },
          }
        : entry,
    ),
  );
  const changed = afterUpdate.find((entry) => entry.task.id === f.empty.id)!.task;

  await attentionFilter(page).focus();
  await attentionFilter(page).press('Home');
  await expect(attentionFilter(page)).toHaveValue('');
  await attentionFilter(page).press('ArrowDown');
  await expect(attentionFilter(page)).toHaveValue('present');
  await expectIds(boardLinks(page), [changed]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await captureAttention(
    page,
    changed,
    'artifacts/219-project-task-attention-dark.png',
    'keyboard',
  );
  await page.goBack();
  await expectIds(boardLinks(page), [changed]);
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await attentionFilter(page).scrollIntoViewIfNeeded();
  await attentionFilter(page).click();
  await attentionFilter(page).press('Escape');
  await attentionFilter(page).selectOption('absent');
  await expectIds(boardLinks(page), []);
  await attentionFilter(page).selectOption('present');
  await expectIds(boardLinks(page), [changed]);
  await captureAttention(
    page,
    changed,
    'artifacts/220-project-task-attention-mobile-light.png',
    'pointer',
  );
  await expectUnchanged(page, f, afterUpdate);
});
