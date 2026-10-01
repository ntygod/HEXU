import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Task, TaskDetail, TaskStatus } from '../../packages/contracts/src/index.js';
import { teamFixture, type Account } from '../helpers/team.js';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const status = (page: Page) => page.getByLabel('状态筛选', { exact: true });
const attention = (page: Page) => page.getByLabel('关注内容筛选', { exact: true });
const search = (page: Page) => page.getByLabel('筛选项目任务', { exact: true });
const clear = (page: Page) => page.getByRole('button', { name: '清除筛选', exact: true });
const board = (page: Page) => page.locator('.project-board');
const taskLinks = (page: Page) =>
  page.locator('.project-board .project-task-card > a, .work-task-list > a.work-task-row');
const sortedIds = (tasks: Task[]) => tasks.map((task) => task.id).sort();
const actions = { todo: 'reopen', in_progress: 'start', done: 'complete', cancelled: 'cancel' };

async function post<T>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function project(page: Page, name: string) {
  return post<{ id: string; name: string }>(page, 'spaces/space-demo/projects', { name });
}
async function detail(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/tasks/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TaskDetail;
}
async function patchAttention(page: Page, task: Task, value: string | null) {
  const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(),
    data: { expectedRevision: task.revision, attention: value },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await detail(page, task.id)).task;
}
async function changeStatus(page: Page, task: Task, value: TaskStatus) {
  await post<Task>(page, `tasks/${task.id}/${actions[value]}`, {
    expectedRevision: task.revision,
    activeRunAction: 'keep',
  });
  return (await detail(page, task.id)).task;
}
async function createTask(
  page: Page,
  projectId: string | null,
  title: string,
  options: {
    status?: TaskStatus;
    attention?: string | null;
    description?: string;
    owner?: string;
    participant?: string;
  } = {},
) {
  let task = await post<Task>(page, 'spaces/space-demo/tasks', {
    projectId,
    title,
    description: options.description ?? '',
  });
  if (options.status && options.status !== 'todo')
    task = await changeStatus(page, task, options.status);
  if (options.attention !== undefined) task = await patchAttention(page, task, options.attention);
  if (options.owner)
    task = await post<Task>(page, `tasks/${task.id}/assignment`, {
      expectedRevision: task.revision,
      ownerUserId: options.owner,
    });
  if (options.participant)
    await post(page, `tasks/${task.id}/participants`, {
      expectedRevision: 1,
      action: 'add',
      userId: options.participant,
    });
  return (await detail(page, task.id)).task;
}
async function expectTasks(page: Page, tasks: Task[]) {
  await expect
    .poll(() =>
      taskLinks(page).evaluateAll((links) =>
        links.map((link) => link.getAttribute('href')!.split('/').at(-1)!).sort(),
      ),
    )
    .toEqual(sortedIds(tasks));
  for (const task of tasks)
    await expect(taskLinks(page).filter({ hasText: task.title })).toBeVisible();
}
async function apiTasks(page: Page, projectId: string, filters = '') {
  const response = await page.request.get(
    `/api/v1/spaces/space-demo/tasks?projectId=${projectId}${filters ? '&' + filters : ''}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { items: Task[] }).items;
}
function observeWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}
async function screenshot(page: Page, name: string) {
  await mkdir('artifacts', { recursive: true });
  // Capture the real viewport after scrolling, so fixed shell chrome is not repeated.
  await page.screenshot({ path: `artifacts/${name}` });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('状态与关注内容同搜索和人员取交集，看板列表及 API 一致且不改变任务', async ({ page }) => {
  const p = await project(page, '订单筛选交集');
  const common = {
    status: 'in_progress' as const,
    attention: '等待接口确认',
    description: 'alpha 退款协作',
    owner: 'user-demo-chen',
    participant: 'user-demo-zhou',
  };
  const match = await createTask(page, p.id, '完整命中的退款接口', common);
  const wrongSearch = await createTask(page, p.id, '只有搜索不符', {
    ...common,
    description: 'beta',
  });
  const wrongOwner = await createTask(page, p.id, '只有负责人不符', {
    ...common,
    owner: 'user-demo-lin',
  });
  const wrongParticipant = await createTask(page, p.id, '只有参与者不符', {
    ...common,
    participant: 'user-demo-chen',
  });
  const wrongStatus = await createTask(page, p.id, '只有状态不符', { ...common, status: 'todo' });
  const blank = await createTask(page, p.id, '空白关注内容', { ...common, attention: '  \n\t ' });
  const other = await project(page, '另一个筛选项目');
  await createTask(page, other.id, '另一个项目的相同条件', common);
  await createTask(page, null, '私人任务的相同条件', {
    status: 'in_progress',
    attention: '等待确认',
    description: 'alpha',
  });
  const writes = observeWrites(page);
  await page.goto(`/projects/${p.id}`);
  await status(page).selectOption('in_progress');
  await attention(page).selectOption('present');
  await page.getByLabel('负责人筛选', { exact: true }).selectOption(common.owner);
  await page.getByLabel('参与者筛选', { exact: true }).selectOption(common.participant);
  await search(page).fill('alpha');
  await expectTasks(page, [match]);
  // Project selections must not replace the Provider's task collection or guide.
  for (const task of [match, wrongSearch, wrongOwner, wrongParticipant, wrongStatus, blank])
    await expect(page.locator(`a.context-task[href="/tasks/${task.id}"]`)).toHaveCount(1);
  const query =
    'status=in_progress&attention=present&ownerUserId=user-demo-chen&participantUserId=user-demo-zhou&q=alpha';
  expect(sortedIds(await apiTasks(page, p.id, query))).toEqual([match.id]);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectTasks(page, [match]);
  await attention(page).selectOption('absent');
  await expectTasks(page, [blank]);
  expect(sortedIds(await apiTasks(page, p.id, query.replace('present', 'absent')))).toEqual([
    blank.id,
  ]);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectTasks(page, [blank]);
  await search(page).fill('没有任何任务包含这句话');
  await expectTasks(page, []);
  await expect(board(page).locator('.work-empty-text')).toHaveText([
    '暂无任务',
    '暂无任务',
    '暂无任务',
  ]);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectTasks(page, []);
  await expect(page.getByRole('heading', { name: '没有匹配的任务', exact: true })).toBeVisible();
  await clear(page).click();
  const all = [match, wrongSearch, wrongOwner, wrongParticipant, wrongStatus, blank];
  await expectTasks(page, all);
  expect(new URL(page.url()).search).toBe('?view=list');
  for (const task of all) {
    const stored = await detail(page, task.id);
    expect(stored.task).toEqual(task);
    expect(stored.runs).toHaveLength(0);
  }
  expect(writes).toEqual([]);
});

test('组合筛选深链接刷新和前后退保留，打开 Task 后返回同一列表', async ({ page }) => {
  const p = await project(page, '可恢复的筛选视图');
  const task = await createTask(page, p.id, '返回后继续的工作', {
    status: 'in_progress',
    attention: '等待评审',
    description: 'alpha',
    owner: 'user-demo-chen',
    participant: 'user-demo-zhou',
  });
  await createTask(page, p.id, '不在筛选内的工作');
  const query =
    'status=in_progress&attention=present&ownerUserId=user-demo-chen&participantUserId=user-demo-zhou&q=alpha';
  await page.goto(`/projects/${p.id}?${query}`);
  await expectTasks(page, [task]);
  const boardURL = page.url();
  await page.getByRole('button', { name: '列表', exact: true }).press('Enter');
  const listURL = page.url();
  await expect(page.getByRole('button', { name: '列表', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expectTasks(page, [task]);
  await expect(status(page)).toHaveValue('in_progress');
  await expect(attention(page)).toHaveValue('present');
  await expect(search(page)).toHaveValue('alpha');
  await expect(page.getByLabel('负责人筛选', { exact: true })).toHaveValue('user-demo-chen');
  await expect(page.getByLabel('参与者筛选', { exact: true })).toHaveValue('user-demo-zhou');
  await page.goBack();
  await expect(page).toHaveURL(boardURL);
  await expect(board(page)).toBeVisible();
  await expectTasks(page, [task]);
  await page.goForward();
  await expect(page).toHaveURL(listURL);
  await taskLinks(page).filter({ hasText: task.title }).press('Enter');
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  const draft = '返回筛选前尚未发送的讨论草稿';
  await page.getByLabel('任务评论', { exact: true }).fill(draft);
  await page.goBack();
  await expect(page).toHaveURL(listURL);
  await expectTasks(page, [task]);
  await page.goForward();
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue(draft);
  await page.goBack();
  await expect(page).toHaveURL(listURL);
  await expect(status(page)).toHaveValue('in_progress');
  await expect(attention(page)).toHaveValue('present');
  await expectTasks(page, [task]);
});

test('真实事件更新状态和关注文本时重算成员集合，保留筛选 URL 且选择筛选不发送命令', async ({
  page,
}) => {
  const p = await project(page, '事件驱动的筛选');
  let task = await createTask(page, p.id, '等待条件满足的退款校验', { description: 'alpha' });
  await page.goto(`/projects/${p.id}?view=list&status=in_progress&attention=present&q=alpha`);
  await expect(page.getByTitle('任务事件已连接', { exact: true })).toBeVisible();
  await expectTasks(page, []);
  const selectedURL = page.url();
  const writes = observeWrites(page);
  task = await patchAttention(page, task, '  等待确认  ');
  await expectTasks(page, []);
  task = await changeStatus(page, task, 'in_progress');
  await expectTasks(page, [task]);
  await expect(page).toHaveURL(selectedURL);
  task = await patchAttention(page, task, ' \t\n ');
  await expectTasks(page, []);
  await expect(page).toHaveURL(selectedURL);
  task = await patchAttention(page, task, '等待第二轮确认');
  await expectTasks(page, [task]);
  task = await changeStatus(page, task, 'done');
  await expectTasks(page, []);
  await expect(page).toHaveURL(selectedURL);
  await status(page).selectOption('done');
  await attention(page).selectOption('absent');
  await expectTasks(page, [task]);
  const doneURL = page.url();
  task = await patchAttention(page, task, '完成后补充关注内容');
  await expectTasks(page, []);
  await expect(page).toHaveURL(doneURL);
  await attention(page).selectOption('present');
  await expectTasks(page, [task]);
  const stored = await detail(page, task.id);
  expect(stored.task).toEqual(task);
  expect(stored.runs).toHaveLength(0);
  // APIRequestContext seeds updates outside the browser. UI must remain read-only.
  expect(writes).toEqual([]);
});

test('无效未知或重复 URL 条件明确阻止结果，修改或清除可恢复并保留有效路由', async ({ page }) => {
  const p = await project(page, '链接校验与恢复');
  const task = await createTask(page, p.id, '恢复后可见的任务');
  const routing =
    'tab=tasks&view=list&source=source-filter-fixture&agreement=agreement-filter-fixture&resultsCursor=result-filter-fixture';
  const invalid = [
    'status=unknown',
    'status=',
    'attention=Present',
    'attention=%20',
    'status=todo&status=done',
    'attention=absent&attention=present',
    'q=one&q=two',
    'unexpected=todo',
    `q=${'x'.repeat(161)}`,
  ];
  const writes = observeWrites(page);
  for (const bad of invalid) {
    await page.goto(`/projects/${p.id}?${routing}&${bad}`);
    await expect(page.getByRole('alert').filter({ hasText: '筛选链接无效' })).toBeVisible();
    await expectTasks(page, []);
    await clear(page).click();
    await expect(page.getByRole('alert').filter({ hasText: '筛选链接无效' })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.toString()).toBe(routing);
    await expectTasks(page, [task]);
  }
  await page.goto(`/projects/${p.id}?view=list&status=done&status=todo`);
  await expect(page.getByRole('alert').filter({ hasText: '筛选链接无效' })).toBeVisible();
  await status(page).selectOption('todo');
  expect(new URL(page.url()).searchParams.getAll('status')).toEqual(['todo']);
  await expectTasks(page, [task]);
  await page.goto(`/projects/${p.id}?view=list&view=board&tab=tasks&attention=absent`);
  await expect(page.getByRole('alert').filter({ hasText: '筛选链接无效' })).toBeVisible();
  await expectTasks(page, []);
  await clear(page).click();
  expect(new URL(page.url()).searchParams.toString()).toBe('view=list&tab=tasks');
  await expect(page.getByRole('button', { name: '列表', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectTasks(page, [task]);
  expect(writes).toEqual([]);
});

test('默认项目排除已取消而 API 包含，显式取消列表与只读看板一致且手机可打开', async ({ page }) => {
  const p = await project(page, '取消工作仍可查阅');
  const todo = await createTask(page, p.id, '待处理的退款检查');
  const active = await createTask(page, p.id, '进行中的订单检查', { status: 'in_progress' });
  const done = await createTask(page, p.id, '已完成的接口检查', { status: 'done' });
  const cancelled = await createTask(page, p.id, '已取消的旧退款方案', { status: 'cancelled' });
  expect(sortedIds(await apiTasks(page, p.id))).toEqual(sortedIds([todo, active, done, cancelled]));
  const writes = observeWrites(page);
  await page.goto(`/projects/${p.id}`);
  await expectTasks(page, [todo, active, done]);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectTasks(page, [todo, active, done]);
  await status(page).selectOption('cancelled');
  await expectTasks(page, [cancelled]);
  await expect(page.locator('.work-task-list').getByRole('combobox')).toHaveCount(0);
  expect(sortedIds(await apiTasks(page, p.id, 'status=cancelled&attention=absent'))).toEqual([
    cancelled.id,
  ]);
  await attention(page).selectOption('absent');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectTasks(page, [cancelled]);
  await expect(board(page).locator('.project-column')).toHaveCount(1);
  await expect(board(page)).toContainText('已取消');
  await expect(board(page)).toContainText('只读');
  await expect(board(page).getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.project-status-counts > div > strong')).toHaveText(['1', '1', '1']);
  await page.getByRole('button', { name: '需求与任务', exact: true }).click();
  await expectTasks(page, [cancelled]);
  await page.setViewportSize({ width: 390, height: 844 });
  await board(page).scrollIntoViewIfNeeded();
  expect((await board(page).boundingBox())!.width).toBeGreaterThan(280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await screenshot(page, '176-task-state-filters-cancelled-mobile.png');
  const cancelledURL = page.url();
  await taskLinks(page).filter({ hasText: cancelled.title }).click();
  await expect(page.getByRole('heading', { name: cancelled.title, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(cancelledURL);
  await expectTasks(page, [cancelled]);
  await expect(board(page).getByRole('combobox')).toHaveCount(0);
  expect((await detail(page, cancelled.id)).task).toEqual(cancelled);
  expect(writes).toEqual([]);
});

test('真实键盘与手机指针操作筛选和清除，深浅色控件可达且内容宽度可用', async ({ page }) => {
  const p = await project(page, '退款工作筛选');
  const active = await createTask(page, p.id, '核对退款状态与失败提示', {
    status: 'in_progress',
    attention: '等待接口字段确认',
  });
  const todo = await createTask(page, p.id, '补充空结果说明');
  await page.goto(`/projects/${p.id}`);
  await status(page).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveValue('in_progress');
  await attention(page).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(attention(page)).toHaveValue('present');
  await expectTasks(page, [active]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.project-toolbar').scrollIntoViewIfNeeded();
  await screenshot(page, '174-task-state-filters-dark.png');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await status(page).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveValue('todo');
  await attention(page).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(attention(page)).toHaveValue('absent');
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectTasks(page, [todo]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect((await page.locator('.work-task-list').boundingBox())!.width).toBeGreaterThan(280);
  for (const control of [status(page), attention(page), search(page)]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.width).toBeGreaterThan(90);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.locator('.project-toolbar').scrollIntoViewIfNeeded();
  await screenshot(page, '175-task-state-filters-mobile-light.png');
  await clear(page).click();
  await expect(status(page)).toHaveValue('');
  await expect(attention(page)).toHaveValue('');
  await expectTasks(page, [active, todo]);
  expect(new URL(page.url()).search).toBe('?view=list');
});

async function installAccount(page: Page, account: Account, origin: string) {
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
      const separator = cookie.indexOf('=');
      return {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
  await page.addInitScript(
    ({ userId, spaceId }) => sessionStorage.setItem(`hexu-space:${userId}`, spaceId),
    {
      userId: account.user.id,
      spaceId: account.spaceId,
    },
  );
}
async function closeTeam(
  page: Page,
  fixture: Awaited<ReturnType<typeof teamFixture>>,
  primaryFailure: boolean,
) {
  const failures: unknown[] = [];
  // Always reach server cleanup even if timeout teardown has already closed the browser.
  for (const cleanup of [
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.goto('about:blank'),
    () => page.context().close(),
    () => fixture.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  if (!primaryFailure)
    throw new AggregateError(failures, 'Task filter team fixture cleanup failed');
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: failures.map(String).join('\n') });
}

test('团队只读筛选不扩权，私有及其他项目不泄露，真实撤权立即清空当前筛选结果', async ({ page }) => {
  const origin = 'http://127.0.0.1:4336';
  const f = await teamFixture(origin);
  let primaryFailure = false;
  try {
    const { alice, bob } = await f.pair();
    const p = await f.project(alice);
    const grant = await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: 'view' });
    expect(grant.statusCode, grant.body).toBe(200);
    let visible = (await f.task(alice, p.id, '只读成员可筛选的工作')) as Task;
    const response = await f.call(
      `tasks/${visible.id}`,
      alice,
      {
        expectedRevision: visible.revision,
        attention: '团队关注内容',
      },
      randomUUID(),
      'PATCH',
    );
    expect(response.statusCode, response.body).toBe(200);
    visible = response.json() as Task;
    const participant = await f.call(`tasks/${visible.id}/participants`, bob, {
      expectedRevision: 1,
      action: 'add',
      userId: bob.user.id,
    });
    expect(participant.statusCode, participant.body).toBe(200);
    const privateTask = (await f.task(alice, null, '只有负责人可见的私有工作')) as Task;
    const otherProject = await f.project(alice);
    const hidden = (await f.task(alice, otherProject.id, '未授权项目的工作')) as Task;
    for (const task of [privateTask, hidden]) {
      const changed = await f.call(
        `tasks/${task.id}`,
        alice,
        {
          expectedRevision: task.revision,
          attention: '团队关注内容',
        },
        randomUUID(),
        'PATCH',
      );
      expect(changed.statusCode, changed.body).toBe(200);
    }
    await f.app.listen({ port: 4336, host: '127.0.0.1' });
    await installAccount(page, bob, origin);
    const path = `/projects/${p.id}?status=todo&attention=present&participantUserId=${bob.user.id}`;
    await page.goto(origin + path);
    await expect(page.getByTitle('任务事件已连接', { exact: true })).toBeVisible();
    await expectTasks(page, [visible]);
    await expect(board(page).getByLabel(`${visible.shortId} 状态`, { exact: true })).toBeDisabled();
    const writes = observeWrites(page);
    await attention(page).selectOption('absent');
    await expectTasks(page, []);
    await attention(page).selectOption('present');
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await expectTasks(page, [visible]);
    for (const task of [privateTask, hidden]) {
      await expect(page.getByText(task.title, { exact: true })).toHaveCount(0);
      const denied = await f.call(`tasks/${task.id}`, bob);
      expect(denied.statusCode, denied.body).toBe(404);
    }
    const list = await f.call(
      `spaces/${bob.spaceId}/tasks?status=todo&attention=present&participantUserId=${bob.user.id}`,
      bob,
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(sortedIds(list.json().items as Task[])).toEqual([visible.id]);
    const allPeople = await f.call(
      `spaces/${bob.spaceId}/tasks?status=todo&attention=present`,
      bob,
    );
    expect(allPeople.statusCode, allPeople.body).toBe(200);
    expect(sortedIds(allPeople.json().items as Task[])).toEqual([visible.id]);
    await page.getByLabel('参与者筛选', { exact: true }).selectOption('');
    await expectTasks(page, [visible]);
    const forbidden = await f.call(`tasks/${visible.id}/start`, bob, {
      expectedRevision: visible.revision,
    });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    const selectedURL = page.url();
    const revoke = await f.call(`projects/${p.id}/members/${bob.user.id}`, alice, { role: null });
    expect(revoke.statusCode, revoke.body).toBe(200);
    await expect(
      page.getByRole('heading', { name: '项目不存在或当前无权访问', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(visible.title, { exact: true })).toHaveCount(0);
    await expectTasks(page, []);
    await expect(page).toHaveURL(selectedURL);
    const after = await f.call(
      `spaces/${bob.spaceId}/tasks?projectId=${p.id}&status=todo&attention=present`,
      bob,
    );
    expect(after.statusCode, after.body).toBe(404);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '项目不存在或当前无权访问', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(visible.title, { exact: true })).toHaveCount(0);
    const current = await f.call(`tasks/${visible.id}`, alice);
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json().task).toMatchObject({
      status: 'todo',
      revision: visible.revision,
      attention: visible.attention,
    });
    expect(current.json().runs).toHaveLength(0);
    expect(writes).toEqual([]);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    await closeTeam(page, f, primaryFailure);
  }
});
