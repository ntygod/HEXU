import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Project, Task, TaskDetail, TaskStatus } from '../../packages/contracts/src/index.js';

const query = '尾段 🧭 <b>核对</b>';
const longQuery = '长查询🧪' + '需要完整核对'.repeat(24);
const oversizedQuery = longQuery.repeat(3);
const description =
  '开头背景不含检索词。' +
  '尚未进入尾段的普通背景。'.repeat(70) +
  `第一处检查 ${query} 首次命中后的说明。` +
  '两处之间的普通背景。'.repeat(50) +
  `第二处检查 ${query} 重复命中之后的说明。`;
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
const search = (page: Page) => page.getByLabel('筛选项目任务', { exact: true });
const boardLinks = (page: Page) => page.locator('.project-task-card > a');
const listLinks = (page: Page) => page.locator('.work-task-list > .work-task-row');
const snippets = (container: Page | Locator) =>
  container.getByLabel('任务说明匹配片段', { exact: true });
const taskLink = (links: Locator, task: Task) =>
  links.and(links.page().locator(`a[href="/tasks/${task.id}"]`));

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function detail(page: Page, task: Task): Promise<TaskDetail> {
  const response = await page.request.get(`/api/v1/tasks/${task.id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function fixture(page: Page, withIntersections = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: '项目说明匹配验收',
    description: '从任务原说明的命中位置找到工作。',
  });
  const tasks: Task[] = [];
  async function create(
    title: string,
    text = description,
    options: {
      attention?: string;
      status?: TaskStatus;
      owner?: string;
      participant?: boolean;
      includeOwnId?: boolean;
    } = {},
  ) {
    let task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId: project.id,
      title,
      description: text,
    });
    const owner = options.owner ?? 'user-demo-chen';
    if (task.ownerUserId !== owner)
      await post(page, `tasks/${task.id}/assignment`, {
        expectedRevision: task.revision,
        ownerUserId: owner,
      });
    if (options.participant !== false)
      await post(page, `tasks/${task.id}/participants`, {
        expectedRevision: 1,
        action: 'add',
        userId: 'user-demo-zhou',
      });
    if (options.status && options.status !== 'todo')
      await post(
        page,
        `tasks/${task.id}/${{ in_progress: 'start', done: 'complete', cancelled: 'cancel' }[options.status]}`,
        { expectedRevision: (await detail(page, task)).task.revision, activeRunAction: 'keep' },
      );
    if (options.attention || options.includeOwnId) {
      task = (await detail(page, task)).task;
      const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
        headers: headers(),
        data: {
          expectedRevision: task.revision,
          ...(options.attention ? { attention: options.attention } : {}),
          ...(options.includeOwnId ? { description: `${text} 原编号 ${task.shortId}` } : {}),
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    const saved = await detail(page, task);
    expect(saved.task.ownerUserId).toBe(owner);
    expect(saved.task.status).toBe(options.status ?? 'todo');
    expect(saved.runs).toEqual([]);
    tasks.push(saved.task);
    return saved.task;
  }
  const tail = await create('需要查看说明尾段的工作', description, { attention: '保留原关注文字' });
  const title = await create(`标题已包含 ${query} 的工作`);
  const id = await create('编号已能解释的工作', '编号对照的普通说明。', { includeOwnId: true });
  const empty = await create('没有说明的对照工作', '');
  const long = await create(
    '长查询对应的工作',
    '长查询之前的背景。'.repeat(70) + oversizedQuery + '末尾。',
    {
      attention: '长查询原关注文字',
    },
  );
  const cancelled = await create('已取消的尾段检查工作', description, {
    status: 'cancelled',
    attention: '取消后保留的关注文字',
  });
  const decoys = withIntersections
    ? {
        owner: await create('其他负责人对应的工作', description, {
          owner: 'user-demo-lin',
          attention: '普通关注文字',
        }),
        participant: await create('没有该参与者的工作', description, {
          participant: false,
          attention: '普通关注文字',
        }),
        attention: await create('没有关注文字的工作'),
        status: await create('已完成的尾段检查工作', description, {
          status: 'done',
          attention: '普通关注文字',
        }),
      }
    : null;
  const before = await Promise.all(tasks.map((task) => detail(page, task)));
  const browserWrites: string[] = [];
  // These are browser-originated requests only; all explicit HTTP fixture
  // creation above is complete before the read-only interaction baseline.
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return { project, tasks, tail, title, id, empty, long, cancelled, decoys, before, browserWrites };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectIds(links: Locator, tasks: Task[]) {
  await expect(links).toHaveCount(tasks.length);
  await expect
    .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href')).sort()))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`).sort());
}

async function expectMatch(link: Locator, match = query, truncated = false) {
  const snippet = snippets(link);
  await expect(snippet).toHaveCount(1);
  await expect(snippet.locator('mark')).toHaveCount(1);
  if (truncated) {
    const highlighted = (await snippet.locator('mark').textContent())!;
    expect(highlighted.length).toBeGreaterThan(0);
    expect(highlighted.length).toBeLessThan(match.length);
    expect(match.startsWith(highlighted)).toBe(true);
    expect(highlighted).not.toContain('…');
    expect(await snippet.textContent()).toMatch(/…$/);
  } else await expect(snippet.locator('mark')).toHaveText(match);
  await expect(snippet.locator('b, img, script')).toHaveCount(0);
  expect(Array.from((await snippet.textContent())!).length).toBeLessThanOrEqual(160);
  if (match === query) {
    await expect(snippet).toContainText('第一处检查');
    await expect(snippet).not.toContainText('第二处检查');
    await expect(snippet).not.toContainText('开头背景');
  }
}

async function expectUnchanged(page: Page, f: Fixture) {
  expect(await Promise.all(f.tasks.map((task) => detail(page, task)))).toEqual(f.before);
  expect(f.browserWrites).toEqual([]);
}

test('说明尾段显示首处纯文本匹配，标题编号与默认展示保持，长查询和空结果有界', async ({ page }) => {
  const f = await fixture(page);
  const defaults = f.tasks.filter((task) => task.status !== 'cancelled');
  await page.goto(`/projects/${f.project.id}?tab=tasks&keep=stable#match-anchor`);
  await expectIds(boardLinks(page), defaults);
  await expect(snippets(page)).toHaveCount(0);
  await expect(taskLink(boardLinks(page), f.tail).locator('p')).toHaveText(description);
  await expect(taskLink(boardLinks(page), f.empty).locator('p')).toHaveText(
    '打开任务查看讨论与成果。',
  );
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), defaults);
  const originalOrder = await listLinks(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')),
  );
  await expect(taskLink(listLinks(page), f.tail).locator('.grow > small')).toHaveText(
    f.tail.attention!,
  );
  await expect(taskLink(listLinks(page), f.empty).locator('.grow > small')).toHaveText(
    f.project.name,
  );
  await search(page).fill('   ');
  await expectIds(listLinks(page), defaults);
  await expect(snippets(page)).toHaveCount(0);
  await search(page).fill(query);
  await expectIds(listLinks(page), [f.tail, f.title]);
  await expectMatch(taskLink(listLinks(page), f.tail));
  await expect(snippets(taskLink(listLinks(page), f.title))).toHaveCount(0);
  expect(
    await listLinks(page).evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
  ).toEqual(
    originalOrder.filter((href) => [`/tasks/${f.tail.id}`, `/tasks/${f.title.id}`].includes(href!)),
  );
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), [f.tail, f.title]);
  await expectMatch(taskLink(boardLinks(page), f.tail));
  await expect(snippets(taskLink(boardLinks(page), f.title))).toHaveCount(0);
  await expect(taskLink(boardLinks(page), f.title).locator('p')).toHaveText(f.title.description);
  await search(page).fill(f.id.shortId);
  await expectIds(boardLinks(page), [f.id]);
  await expect(snippets(page)).toHaveCount(0);
  await expect(taskLink(boardLinks(page), f.id).locator('p')).toHaveText(f.id.description);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), [f.id]);
  await expect(snippets(page)).toHaveCount(0);
  await search(page).fill(longQuery);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), longQuery);
  const longSnippet = snippets(taskLink(listLinks(page), f.long));
  await longSnippet.scrollIntoViewIfNeeded();
  await expect(longSnippet.locator('mark')).toBeInViewport({ ratio: 1 });
  expect(
    await longSnippet.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  // Existing direct links may exceed the input's typing limit. Rendering must
  // stay bounded without rewriting that q or changing the matching task set.
  await page.goto(
    `/projects/${f.project.id}?view=list&tab=tasks&keep=stable&q=${encodeURIComponent(oversizedQuery)}#match-anchor`,
  );
  await expect(search(page)).toHaveValue(oversizedQuery);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), oversizedQuery, true);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), [f.long]);
  await expectMatch(taskLink(boardLinks(page), f.long), oversizedQuery, true);
  const clippedSnippet = snippets(taskLink(boardLinks(page), f.long));
  await clippedSnippet.scrollIntoViewIfNeeded();
  await expect(clippedSnippet.locator('mark')).toBeInViewport({ ratio: 1 });
  expect(
    await clippedSnippet.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(new URL(page.url()).searchParams.get('q')).toBe(oversizedQuery);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await search(page).fill('完全不存在的说明内容');
  await expectIds(listLinks(page), []);
  await expect(snippets(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有匹配的任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), []);
  await expect(snippets(page)).toHaveCount(0);
  await expect(page.locator('.project-column .work-empty-text')).toHaveText([
    '暂无任务',
    '暂无任务',
    '暂无任务',
  ]);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expectIds(boardLinks(page), defaults);
  await expect(snippets(page)).toHaveCount(0);
  await expectUnchanged(page, f);
});

test('命中片段跟随原状态关注人员交集、视图、刷新与历史清除，原任务数据不变', async ({ page }) => {
  const f = await fixture(page, true);
  const decoys = f.decoys!;
  await page.goto(
    `/projects/${f.project.id}?tab=tasks&keep=stable&q=${encodeURIComponent(query)}#match-anchor`,
  );
  await expectIds(boardLinks(page), [f.tail, f.title, ...Object.values(decoys)]);
  await page.getByLabel('任务状态筛选', { exact: true }).selectOption('todo');
  await expectIds(boardLinks(page), [
    f.tail,
    f.title,
    decoys.owner,
    decoys.participant,
    decoys.attention,
  ]);
  await page.getByLabel('关注内容筛选', { exact: true }).selectOption('present');
  await expectIds(boardLinks(page), [f.tail, decoys.owner, decoys.participant]);
  await page.getByLabel('负责人筛选', { exact: true }).selectOption('user-demo-chen');
  await expectIds(boardLinks(page), [f.tail, decoys.participant]);
  await page.getByLabel('参与者筛选', { exact: true }).selectOption('user-demo-zhou');
  await expectIds(boardLinks(page), [f.tail]);
  await expectMatch(taskLink(boardLinks(page), f.tail));
  const boardUrl = page.url();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), [f.tail]);
  await expectMatch(taskLink(listLinks(page), f.tail));
  // q replaces the current URL entry; switching view supplies the real history
  // boundary. Back must restore the old board query and its own match context.
  await search(page).fill(longQuery);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), longQuery);
  const listUrl = page.url();
  await page.reload();
  await expect(search(page)).toHaveValue(longQuery);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), longQuery);
  await page.goBack();
  await expect(page).toHaveURL(boardUrl);
  await expect(search(page)).toHaveValue(query);
  await expectIds(boardLinks(page), [f.tail]);
  await expectMatch(taskLink(boardLinks(page), f.tail));
  await page.goForward();
  await expect(page).toHaveURL(listUrl);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), longQuery);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  const defaults = f.tasks.filter((task) => task.status !== 'cancelled');
  await expectIds(listLinks(page), defaults);
  await expect(snippets(page)).toHaveCount(0);
  for (const name of ['任务状态筛选', '关注内容筛选', '负责人筛选', '参与者筛选', '筛选项目任务'])
    await expect(page.getByLabel(name, { exact: true })).toHaveValue('');
  const clearedUrl = new URL(page.url());
  expect([...clearedUrl.searchParams.entries()].sort()).toEqual([
    ['keep', 'stable'],
    ['tab', 'tasks'],
    ['view', 'list'],
  ]);
  expect(clearedUrl.hash).toBe('#match-anchor');
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expectIds(listLinks(page), [f.long]);
  await expectMatch(taskLink(listLinks(page), f.long), longQuery);
  await page.goForward();
  await expectIds(listLinks(page), defaults);
  await expect(snippets(page)).toHaveCount(0);
  await expectUnchanged(page, f);
});

async function captureMatch(
  page: Page,
  task: Task,
  path: string,
  view: 'board' | 'list',
  input: 'keyboard' | 'pointer',
) {
  const links = view === 'board' ? boardLinks(page) : listLinks(page);
  const link = taskLink(links, task);
  const snippet = snippets(link);
  await expectIds(links, [task]);
  if (view === 'board') {
    await expect(page.locator('.project-column > header .badge')).toHaveText(['已取消']);
    await expect(page.locator('.project-task-card').getByRole('combobox')).toHaveCount(0);
  }
  await expectMatch(link);
  // Inspect the actual card/link, without requiring a distant footer or filter
  // row to occupy the same viewport as the highlighted match on a small screen.
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect(snippet).toBeInViewport({ ratio: 1 });
  await expect(snippet.locator('mark')).toBeInViewport({ ratio: 1 });
  expect(
    await snippet.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  for (const content of [page.locator('main'), link, snippet]) {
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
}

test('取消列匹配卡片保持只读，暗色看板和390px浅色列表高亮可见且原任务导航可用', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/projects/${f.project.id}?status=cancelled&q=${encodeURIComponent(query)}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await captureMatch(
    page,
    f.cancelled,
    'artifacts/223-project-task-match-dark.png',
    'board',
    'keyboard',
  );
  await page.goBack();
  await expectIds(boardLinks(page), [f.cancelled]);
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await captureMatch(
    page,
    f.cancelled,
    'artifacts/224-project-task-match-mobile-light.png',
    'list',
    'pointer',
  );
  await expectUnchanged(page, f);
});
