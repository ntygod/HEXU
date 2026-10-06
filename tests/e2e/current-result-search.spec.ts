import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  Project,
  Result,
  Task,
  TaskDetail,
  Workbench,
} from '../../packages/contracts/src/index.js';
import type { ResultDetail } from '../../packages/contracts/src/results.js';
import type {
  ResultSearchHit,
  ResultSearchPage,
} from '../../packages/contracts/src/result-search.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: '搜索与快捷操作', exact: true });
const search = (page: Page) => dialog(page).getByRole('textbox', { name: '全局搜索', exact: true });
const type = (page: Page) => dialog(page).getByRole('combobox', { name: '搜索类型', exact: true });
const scope = (page: Page) =>
  dialog(page).getByRole('combobox', { name: '成果搜索范围', exact: true });
const results = (page: Page) =>
  dialog(page).getByRole('region', { name: '成果搜索结果', exact: true });
const rows = (page: Page) => results(page).getByRole('button');
const row = (page: Page, result: Result) =>
  results(page).locator(`button[data-result-id="${result.id}"]`);
const taskResults = (page: Page) =>
  dialog(page).getByRole('region', { name: '任务搜索结果', exact: true });
const status = (page: Page) =>
  dialog(page).getByRole('status', { name: '成果搜索分页状态', exact: true });
const more = (page: Page) =>
  dialog(page).getByRole('button', { name: '加载更多成果', exact: true });
const restart = (page: Page) => dialog(page).getByRole('button', { name: '重新搜索', exact: true });
const snippet = (target: Locator) => target.getByLabel('成果正文匹配片段', { exact: true });
const projectScope = (project: Project) => `project:${project.id}`;
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api/v1/' + path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Own every interceptor until its operations settle. Observe rejections as soon
// as they happen; teardown releases held real reads before draining/unrouting.
function readRoutes(page: Page) {
  let capturing = true;
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const releases: (() => void)[] = [];
  const handlers: { pattern: string; handler: (route: Route) => Promise<void> }[] = [];
  return {
    gate() {
      const release = deferred();
      releases.push(release.resolve);
      return {
        release: release.resolve,
        wait: release.promise,
        captured: null as ResultSearchPage | null,
        settled: false,
      };
    },
    async install(run: (route: Route) => Promise<void>) {
      const pattern = '**/api/v1/search?*';
      const handler = (route: Route) => {
        const operation = (async () => {
          if (!capturing) return route.continue();
          await run(route);
        })();
        pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          (error: unknown) => {
            errors.push(error);
            pending.delete(operation);
          },
        );
        return operation;
      };
      await page.route(pattern, handler);
      handlers.push({ pattern, handler });
    },
    async stop(failed: boolean) {
      capturing = false;
      for (const release of releases) release();
      while (pending.size) await Promise.allSettled([...pending]);
      for (const { pattern, handler } of handlers) {
        try {
          await page.unroute(pattern, handler);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!errors.length) return;
      if (failed) {
        for (const error of errors)
          base.info().annotations.push({
            type: 'cleanup-error',
            description: error instanceof Error ? error.message : String(error),
          });
      } else throw new AggregateError(errors, '当前成果搜索读取夹具清理失败');
    },
  };
}

async function fixture(page: Page, projectResultCount: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const token = randomUUID().slice(0, 8);
  const query = `Current-${token} 👩🏽‍💻 <b>核对</b>`;
  const alternateQuery = `OnlyBody-${token}`;
  const titleQuery = `OnlyTitle-${token}`;
  const parentQuery = `OnlyParent-${token}`;
  const descriptionQuery = `OnlyDescription-${token}`;
  const boundaryTitle = `BoundaryTitle-${token}`;
  const boundaryBody = `BoundaryBody-${token}`;
  const projects: Project[] = [];
  for (const name of ['成果范围', '较新成果', '空成果项目'])
    projects.push(
      await post<Project>(page, 'spaces/space-demo/projects', {
        name: `${name} ${token}`,
        description: '普通当前成果搜索验收。',
      }),
    );
  const [project, otherProject, emptyProject] = projects as [Project, Project, Project];
  const entries: { task: Task; result: Result }[] = [];
  const body =
    '开头背景没有检索词。' +
    '普通背景资料。'.repeat(65) +
    `第一处检查 ${query} 原始记录。` +
    '两处之间的背景材料。'.repeat(35) +
    `第二处检查 ${query} 保留原文。`;
  async function create(
    projectId: string | null,
    title: string,
    resultTitle: string,
    text: string,
  ) {
    const task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId,
      title,
      description: `${query} ${descriptionQuery} 仅为当前任务说明。`,
    });
    const result = await post<Result>(page, `tasks/${task.id}/results`, {
      title: resultTitle,
      body: text,
    });
    const entry = { task, result };
    entries.push(entry);
    return entry;
  }
  for (let index = 0; index < projectResultCount; index++)
    await create(
      project.id,
      index === 2 ? `${parentQuery} 原任务` : `当前源任务 ${index + 1}`,
      index === 0
        ? boundaryTitle
        : index === Math.floor(projectResultCount / 2)
          ? `正文命中的成果 ${index + 1}`
          : `${query} 成果 ${index + 1}${index === 1 ? ` ${titleQuery}` : ''}`,
      (index === 0 ? `${boundaryBody} ` : '') +
        body +
        (index === projectResultCount - 1 ? ` ${alternateQuery}` : ''),
    );
  const alternate = entries.at(-1)!;
  const titleEntry = entries[1]!;
  const parentEntry = entries[2]!;
  const boundaryEntry = entries[0]!;
  // A complete newer unscoped page precedes the selected project's Results.
  // Filtering only after a server page is fetched cannot satisfy this fixture.
  for (let index = 0; index < 31; index++)
    await create(
      otherProject.id,
      `另一个项目源任务 ${index + 1}`,
      `${query} 较新的成果 ${index + 1}`,
      '其他项目的当前成果正文。',
    );
  for (let index = 0; index < 2; index++)
    await create(
      null,
      `个人源任务 ${index + 1}`,
      `${query} 个人成果 ${index + 1}`,
      '无项目个人成果正文。',
    );
  const taskIds = new Set(entries.map(({ task }) => task.id));
  const resultIds = new Set(entries.map(({ result }) => result.id));
  const beforeTasks = new Map(
    await Promise.all(
      entries.map(
        async ({ task }) => [task.id, await get<TaskDetail>(page, `tasks/${task.id}`)] as const,
      ),
    ),
  );
  const beforeResults = new Map(
    await Promise.all(
      entries.map(
        async ({ result }) =>
          [result.id, await get<ResultDetail>(page, `results/${result.id}`)] as const,
      ),
    ),
  );
  for (const detail of beforeTasks.values()) expect(detail.runs).toEqual([]);
  for (const detail of beforeResults.values()) {
    expect(detail.result.revision).toBe(1);
    expect(detail.version.revision).toBe(1);
    expect(detail.version.source).toEqual({ kind: 'member' });
    expect(detail.version.id).toBeTruthy();
    expect(detail.revisions).toHaveLength(1);
  }
  const initial = await get<Workbench>(page, 'workbench');
  const expectedProjects = new Map(
    projects.map((project) => [
      project.id,
      initial.projects.find((item) => item.id === project.id)!,
    ]),
  );
  async function ordered(q = query) {
    const current = await get<Workbench>(page, 'workbench');
    const tasks = new Map(current.tasks.map((task) => [task.id, task]));
    const needle = q.trim().toLocaleLowerCase();
    // Expected membership and order come only from the real current Workbench
    // feed, independently of /search and its implementation helpers.
    return current.results
      .filter((result) => {
        const task = tasks.get(result.taskId);
        return (
          task &&
          [result.title, result.body, task.title, task.shortId].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          )
        );
      })
      .map((result): ResultSearchHit => {
        const task = tasks.get(result.taskId)!;
        return {
          ...result,
          task: {
            id: task.id,
            title: task.title,
            shortId: task.shortId,
            projectId: task.projectId,
          },
        };
      });
  }
  const originalOrder = await ordered();
  expect(originalOrder.map((result) => result.id).sort()).toEqual([...resultIds].sort());
  const selected = originalOrder.filter((result) => result.task.projectId === project.id);
  const other = originalOrder.filter((result) => result.task.projectId === otherProject.id);
  const personal = originalOrder.filter((result) => result.task.projectId === null);
  const taskOrder = initial.tasks.filter((task) => taskIds.has(task.id));
  expect(originalOrder.slice(0, 30).every((result) => result.task.projectId !== project.id)).toBe(
    true,
  );
  const browserWrites: string[] = [];
  const requests: {
    type: string | null;
    q: string;
    scope: string | null;
    projectId: string | null;
    cursor: string | null;
  }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      browserWrites.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'GET' && url.pathname === '/api/v1/search')
      requests.push({
        type: url.searchParams.get('type'),
        q: url.searchParams.get('q')!,
        scope: url.searchParams.get('scope'),
        projectId: url.searchParams.get('projectId'),
        cursor: url.searchParams.get('cursor'),
      });
  });
  return {
    query,
    alternateQuery,
    titleQuery,
    parentQuery,
    descriptionQuery,
    boundaryTitle,
    boundaryBody,
    project,
    otherProject,
    emptyProject,
    entries,
    alternate,
    titleEntry,
    parentEntry,
    boundaryEntry,
    originalOrder,
    selected,
    other,
    personal,
    taskOrder,
    beforeResults,
    requests,
    ordered,
    routes: readRoutes(page),
    async editTask(
      taskId: string,
      changes: { title?: string; description?: string; attention?: string },
    ) {
      const before = beforeTasks.get(taskId)!;
      const response = await page.request.patch(`/api/v1/tasks/${taskId}`, {
        headers: headers(),
        data: { expectedRevision: before.task.revision, ...changes },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const saved = (await response.json()) as Task;
      const { participantUserIds, ...storedBefore } = before.task;
      expect(saved).toEqual({
        ...storedBefore,
        ...changes,
        revision: before.task.revision + 1,
        updatedAt: saved.updatedAt,
      });
      expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true);
      const after = { ...before, task: { ...saved, participantUserIds } };
      expect(await get<TaskDetail>(page, `tasks/${taskId}`)).toEqual(after);
      beforeTasks.set(taskId, after);
      // Result content, version IDs, feedback and all other detail fields remain
      // exact. Only the verified current parent Task projection may change.
      for (const { result } of entries.filter(({ task }) => task.id === taskId)) {
        const previous = beforeResults.get(result.id)!;
        const expected = { ...previous, task: { ...previous.task, ...saved } };
        expect(await get<ResultDetail>(page, `results/${result.id}`)).toEqual(expected);
        beforeResults.set(result.id, expected);
      }
      return after.task;
    },
    async editProject(projectId: string, changes: { name?: string; description?: string }) {
      const before = expectedProjects.get(projectId)!;
      const response = await page.request.patch(`/api/v1/projects/${projectId}`, {
        headers: headers(),
        data: { expectedRevision: before.revision, ...changes },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const saved = (await response.json()) as Project;
      const { access, memberIds, ...storedBefore } = before;
      expect(saved).toEqual({ ...storedBefore, ...changes, revision: before.revision + 1 });
      const expected = { ...before, ...saved };
      expect(
        (await get<Workbench>(page, 'workbench')).projects.find(
          (project) => project.id === projectId,
        ),
      ).toEqual(expected);
      expectedProjects.set(projectId, expected);
    },
    async verifyUnchanged() {
      expect(
        await Promise.all(entries.map(({ task }) => get<TaskDetail>(page, `tasks/${task.id}`))),
      ).toEqual(entries.map(({ task }) => beforeTasks.get(task.id)));
      expect(
        await Promise.all(
          entries.map(({ result }) => get<ResultDetail>(page, `results/${result.id}`)),
        ),
      ).toEqual(entries.map(({ result }) => beforeResults.get(result.id)));
      const current = await get<Workbench>(page, 'workbench');
      expect(
        projects.map((project) => current.projects.find((item) => item.id === project.id)),
      ).toEqual(projects.map((project) => expectedProjects.get(project.id)));
      expect(browserWrites).toEqual([]);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ currentResults: Fixture; projectResultCount: number }>({
  projectResultCount: [31, { option: true }],
  currentResults: async ({ page, projectResultCount }, use) => {
    const f = await fixture(page, projectResultCount);
    let failed = false;
    try {
      await use(f);
      if (test.info().status === test.info().expectedStatus) await f.verifyUnchanged();
      else failed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.routes.stop(failed || test.info().status !== test.info().expectedStatus);
    }
  },
});

async function openSearch(page: Page) {
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await expect(search(page)).toBeFocused();
  await expect(type(page)).toHaveValue('task');
  await expect(
    dialog(page).getByRole('combobox', { name: '任务搜索范围', exact: true }),
  ).toHaveValue('all');
}

async function openResults(page: Page, f: Fixture) {
  await openSearch(page);
  await type(page).selectOption('result');
  await scope(page).selectOption(projectScope(f.project));
  await search(page).fill(f.query);
}

async function expectRows(page: Page, expected: Result[]) {
  await expect(rows(page)).toHaveCount(expected.length);
  await expect
    .poll(() =>
      rows(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-result-id'))),
    )
    .toEqual(expected.map((result) => result.id));
  await expect
    .poll(() => rows(page).locator('strong').allTextContents())
    .toEqual(expected.map((result) => result.title));
  await expect
    .poll(() => rows(page).locator('.command-result-version').allTextContents())
    .toEqual(expected.map((result) => `当前版本 ${result.revision}`));
  expect(
    new Set(
      await rows(page).evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-result-id')),
      ),
    ).size,
  ).toBe(expected.length);
  await expect(dialog(page).locator('[data-task-id]')).toHaveCount(0);
}

async function expectTaskRows(page: Page, tasks: Task[]) {
  await expect(taskResults(page).getByRole('button')).toHaveCount(tasks.length);
  await expect
    .poll(() =>
      taskResults(page)
        .locator('[data-task-id]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-task-id'))),
    )
    .toEqual(tasks.map((task) => task.id));
  await expect(dialog(page).locator('[data-result-id]')).toHaveCount(0);
}

async function expectCount(page: Page, count: number, terminal = false) {
  await expect(status(page)).toHaveText(
    `已显示 ${count} 项成果，${terminal ? '已加载全部结果' : '可继续加载'}`,
  );
  if (terminal) await expect(more(page)).toHaveCount(0);
  else await expect(more(page)).toBeEnabled();
}

async function append(page: Page, expected: Result[], touch = false) {
  const before = await rows(page).count();
  if (touch) await more(page).tap();
  else {
    await more(page).focus();
    await more(page).press('Enter');
  }
  await expectRows(page, expected);
  await expect(row(page, expected[before]!)).toBeFocused();
}

async function expectMetadata(page: Page, result: ResultSearchHit, source: string) {
  const target = row(page, result);
  await expect(target.locator('.command-result-task')).toContainText(result.task.title);
  await expect(target.locator('.command-result-task')).toContainText(result.task.shortId);
  await expect(target.locator('.command-task-source')).toHaveText(source);
  await expect(target.locator('.command-result-version')).toHaveText(`当前版本 ${result.revision}`);
}

async function expectBodyHit(page: Page, result: ResultSearchHit, query: string) {
  expect(result.title).not.toContain(query);
  expect(result.task.title).not.toContain(query);
  const match = snippet(row(page, result));
  await expect(match).toHaveCount(1);
  await expect(match.locator('mark')).toHaveText(query);
  await expect(match).toContainText('第一处检查');
  await expect(match).not.toContainText('开头背景');
  await expect(match).not.toContainText('第二处检查');
  await expect(match.locator('b')).toHaveCount(0);
  expect(Array.from((await match.textContent())!).length).toBeLessThanOrEqual(160);
}

async function hitTarget(target: Locator, minHeight: number) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(minHeight);
  expect(
    await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    }),
  ).toBe(true);
}

async function capture(
  page: Page,
  f: Fixture,
  result: ResultSearchHit,
  path: string,
  mobile: boolean,
  terminal: boolean,
) {
  const target = row(page, result);
  await expect(type(page)).toHaveValue('result');
  await expect(scope(page)).toHaveValue(projectScope(f.project));
  await expectMetadata(page, result, f.project.name);
  await expectBodyHit(page, result, f.query);
  const geometry = await target.evaluate((element) => {
    const scroller = element.closest('.command-results');
    if (!scroller) throw new Error('缺少成果搜索滚动容器');
    const content = scroller.getBoundingClientRect();
    const initial = element.getBoundingClientRect();
    scroller.scrollTop += initial.top - content.top - (scroller.clientHeight - initial.height) / 2;
    const row = element.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      content: { top: content.top, bottom: content.bottom },
      row: { top: row.top, bottom: row.bottom },
    };
  });
  expect(geometry.scrollTop, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.scrollHeight, JSON.stringify(geometry)).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.row.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry.content.top - 1,
  );
  expect(geometry.row.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.content.bottom + 1,
  );
  for (const visible of [
    dialog(page).locator('.dialog-heading'),
    search(page),
    type(page),
    scope(page),
    target,
    snippet(target),
    status(page),
  ])
    await expect(visible, JSON.stringify(geometry)).toBeInViewport({ ratio: 1 });
  for (const control of [
    search(page),
    type(page),
    scope(page),
    target,
    dialog(page).getByRole('button', { name: '关闭', exact: true }),
  ])
    await hitTarget(control, mobile ? 44 : 32);
  if (!terminal) await hitTarget(more(page), mobile ? 44 : 32);
  else await expect(status(page)).toContainText('已加载全部结果');
  for (const content of [dialog(page), results(page), target, snippet(target)]) {
    expect((await content.boundingBox())!.width).toBeGreaterThan(240);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(
    await snippet(target).evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  for (const visible of [
    type(page),
    scope(page),
    target,
    snippet(target),
    target.locator('.command-result-task'),
    target.locator('.command-task-source'),
    target.locator('.command-result-version'),
    status(page),
  ])
    await expect(visible).toBeInViewport({ ratio: 1 });
  if (!terminal) await expect(more(page)).toBeInViewport({ ratio: 1 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

async function expectDetail(page: Page, f: Fixture, result: Result) {
  await expect(page).toHaveURL(new RegExp(`/results/${result.id}$`));
  await expect(dialog(page)).toHaveCount(0);
  const baseline = f.beforeResults.get(result.id)!;
  await expect(page.getByRole('combobox', { name: '查看固定版本', exact: true })).toHaveValue(
    baseline.version.id,
  );
  await expect(page.getByRole('link', { name: '打开此版本固定链接', exact: true })).toHaveAttribute(
    'href',
    `/results/${result.id}/versions/${baseline.version.id}`,
  );
  await expect(page.locator('.written-result .text-block')).toHaveText(result.body);
  expect(await get<ResultDetail>(page, `results/${result.id}`)).toEqual(baseline);
}

// Ordinary POST creates real member revision 1. Higher current revisions belong
// to backend fixtures, not fabricated browser branch/native/history workflows.
test.describe('当前成果真实三批与截图', () => {
  test.use({ projectResultCount: 61, hasTouch: true });
  test('项目先筛选再分页，61项顺序无重复，真实版本来源正文片段与明暗窄屏导航', async ({
    page,
    currentResults: f,
  }) => {
    await page.goto(`/projects/${f.project.id}`);
    await openSearch(page);
    await type(page).selectOption('result');
    await expect(scope(page)).toHaveValue('all');
    await expectRows(page, []);
    expect(f.requests).toEqual([]);
    await search(page).fill(`  ${f.query.toUpperCase()}  `);
    await expectRows(page, f.originalOrder.slice(0, 30));
    await expectCount(page, 30);
    await expectMetadata(page, f.personal[0]!, '个人任务');
    await expectMetadata(page, f.other[0]!, f.otherProject.name);
    expect(f.requests[0]).toMatchObject({
      type: 'result',
      scope: null,
      projectId: null,
      cursor: null,
    });
    await scope(page).selectOption(projectScope(f.project));
    await expectRows(page, f.selected.slice(0, 30));
    await expectCount(page, 30);
    await expect(snippet(row(page, f.selected[0]!))).toHaveCount(0);
    await append(page, f.selected.slice(0, 60));
    await expectCount(page, 60);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(
      page,
      f,
      f.selected[30]!,
      'artifacts/240-current-result-search-dark.png',
      false,
      false,
    );
    await append(page, f.selected);
    await expectCount(page, 61, true);
    const selectedReads = f.requests.filter((request) => request.scope === 'project');
    expect(selectedReads.map((request) => request.type)).toEqual(Array(3).fill('result'));
    expect(selectedReads.map((request) => request.projectId)).toEqual(Array(3).fill(f.project.id));
    expect(selectedReads.map((request) => Boolean(request.cursor))).toEqual([false, true, true]);
    expect(new Set(selectedReads.slice(1).map((request) => request.cursor)).size).toBe(2);
    const finalResult = f.selected.at(-1)!;
    await row(page, finalResult).focus();
    await row(page, finalResult).press('Enter');
    await expectDetail(page, f, finalResult);
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openResults(page, f);
    await expectRows(page, f.selected.slice(0, 30));
    await append(page, f.selected.slice(0, 60), true);
    await append(page, f.selected, true);
    await expectCount(page, 61, true);
    await capture(
      page,
      f,
      finalResult,
      'artifacts/241-current-result-search-mobile-light.png',
      true,
      true,
    );
    await row(page, finalResult).tap();
    await expectDetail(page, f, finalResult);
  });
});

test('Task默认入口保留，当前成果标题正文和父任务标题编号独立命中且范围准确', async ({
  page,
  currentResults: f,
}) => {
  await page.goto('/');
  await openSearch(page);
  await expectTaskRows(page, []);
  for (const name of ['新建任务', '打开工作台', '查看项目', '查看成果', '资源与设置'])
    await expect(dialog(page).getByRole('button', { name, exact: true })).toBeVisible();
  expect(f.requests).toEqual([]);
  await search(page).fill(f.descriptionQuery);
  await expectTaskRows(page, f.taskOrder.slice(0, 30));
  await expect(
    dialog(page).getByRole('status', { name: '任务搜索分页状态', exact: true }),
  ).toHaveText('已显示 30 项任务，可继续加载');
  await expect(
    dialog(page).getByRole('button', { name: '加载更多任务', exact: true }),
  ).toBeEnabled();
  expect(f.requests.at(-1)).toMatchObject({ type: null, scope: null, cursor: null });
  await search(page).fill(f.parentQuery);
  await expectTaskRows(page, [f.parentEntry.task]);
  await search(page).fill(f.parentEntry.task.shortId.toLowerCase());
  await expectTaskRows(page, [f.parentEntry.task]);
  await taskResults(page).locator(`[data-task-id="${f.parentEntry.task.id}"]`).press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tasks/${f.parentEntry.task.id}$`));
  await expect(
    page.getByRole('heading', { name: f.parentEntry.task.title, exact: true }),
  ).toBeVisible();
  await openSearch(page);
  await type(page).selectOption('result');
  await scope(page).selectOption('personal');
  await expectRows(page, []);
  const beforeQuery = f.requests.length;
  await search(page).fill(f.query);
  await expectRows(page, f.personal);
  await expectCount(page, 2, true);
  expect(f.requests.slice(beforeQuery)).toEqual([
    { type: 'result', q: f.query, scope: 'personal', projectId: null, cursor: null },
  ]);
  for (const result of f.personal) await expectMetadata(page, result, '个人任务');
  await scope(page).selectOption(projectScope(f.emptyProject));
  await expectRows(page, []);
  await expect(status(page)).toHaveText('没有找到匹配的成果。');
  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, f.selected.slice(0, 30));
  for (const [q, entry, bodyOnly] of [
    [`  ${f.titleQuery.toUpperCase()}  `, f.titleEntry, false],
    [f.alternateQuery, f.alternate, true],
    [f.parentQuery.toLowerCase(), f.parentEntry, false],
    [f.boundaryEntry.task.shortId.toLowerCase(), f.boundaryEntry, false],
  ] as const) {
    await search(page).fill(q);
    await expectRows(page, [entry.result]);
    await expectCount(page, 1, true);
    const hit = (await f.ordered(q))[0]!;
    await expectMetadata(page, hit, f.project.name);
    await expect(snippet(row(page, hit))).toHaveCount(bodyOnly ? 1 : 0);
    if (bodyOnly)
      await expect(snippet(row(page, hit)).locator('mark')).toHaveText(f.alternateQuery);
    expect(f.requests.at(-1)).toMatchObject({
      type: 'result',
      q: q.trim(),
      scope: 'project',
      projectId: f.project.id,
      cursor: null,
    });
  }
  // Task description is not a Result field; concatenating distinct title/body
  // fields would also incorrectly create the second match below.
  for (const q of [f.descriptionQuery, `${f.boundaryTitle} ${f.boundaryBody}`]) {
    await search(page).fill(q);
    await expectRows(page, []);
    await expect(status(page)).toHaveText('没有找到匹配的成果。');
    await expect(more(page)).toHaveCount(0);
  }
  await search(page).fill(f.query);
  await expectRows(page, f.selected.slice(0, 30));
  await scope(page).selectOption('all');
  await expectRows(page, f.originalOrder.slice(0, 30));
  expect(f.requests.at(-1)).toMatchObject({
    type: 'result',
    scope: null,
    projectId: null,
    cursor: null,
  });
});

test('暂留真实首批追加200与普通500后切换类型查询范围及关闭，不混入旧行错误且重复加载只有一次读取', async ({
  page,
  currentResults: f,
}) => {
  type Gate = ReturnType<typeof f.routes.gate>;
  let hold: { gate: Gate; cursor: boolean; failure?: boolean } | null = null;
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const selected =
      url.searchParams.get('type') === 'result' &&
      url.searchParams.get('q') === f.query &&
      url.searchParams.get('projectId') === f.project.id;
    const captured =
      selected && hold && url.searchParams.has('cursor') === hold.cursor ? hold : null;
    if (captured) {
      hold = null;
      captured.gate.captured = (await response.json()) as ResultSearchPage;
      await captured.gate.wait;
      if (captured.failure)
        await route.fulfill({
          response,
          status: 500,
          json: { error: { code: 'TEMPORARY_FAILURE', message: '旧项目搜索暂时不可用' } },
        });
      else await route.fulfill({ response });
      captured.gate.settled = true;
    } else await route.fulfill({ response });
  });
  const first = f.routes.gate();
  hold = { gate: first, cursor: false };
  await page.goto('/');
  await openResults(page, f);
  await expect.poll(() => first.captured).not.toBeNull();
  expect(first.captured!.items.map((result) => result.id)).toEqual(
    f.selected.slice(0, 30).map((result) => result.id),
  );
  await type(page).selectOption('task');
  const selectedTasks = f.taskOrder.filter((task) => task.projectId === f.project.id);
  await expectTaskRows(page, selectedTasks.slice(0, 30));
  first.release();
  await expect.poll(() => first.settled).toBe(true);
  await expectTaskRows(page, selectedTasks.slice(0, 30));
  await expect(type(page)).toHaveValue('task');
  await expect(search(page)).toHaveValue(f.query);
  await expect(
    dialog(page).getByRole('combobox', { name: '任务搜索范围', exact: true }),
  ).toHaveValue(projectScope(f.project));

  await type(page).selectOption('result');
  await expectRows(page, f.selected.slice(0, 30));
  const later = f.routes.gate();
  hold = { gate: later, cursor: true };
  const beforeMore = f.requests.filter((request) => request.cursor).length;
  await more(page).evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
    button.click();
  });
  await expect.poll(() => later.captured).not.toBeNull();
  expect(later.captured!.items.map((result) => result.id)).toEqual(
    f.selected.slice(30).map((result) => result.id),
  );
  await expect(dialog(page).getByRole('button', { name: '加载中…', exact: true })).toBeDisabled();
  await expect(status(page)).toHaveText('已显示 30 项成果，正在加载更多…');
  await expectRows(page, f.selected.slice(0, 30));
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(beforeMore + 1);
  await scope(page).selectOption('personal');
  await expectRows(page, f.personal);
  later.release();
  await expect.poll(() => later.settled).toBe(true);
  await expectRows(page, f.personal);
  await expectCount(page, 2, true);

  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, f.selected.slice(0, 30));
  await search(page).fill(f.alternateQuery);
  await expectRows(page, [f.alternate.result]);
  const changedQuery = f.routes.gate();
  hold = { gate: changedQuery, cursor: false };
  await search(page).fill(f.query);
  await expect.poll(() => changedQuery.captured).not.toBeNull();
  await search(page).fill(f.alternateQuery);
  await expectRows(page, [f.alternate.result]);
  changedQuery.release();
  await expect.poll(() => changedQuery.settled).toBe(true);
  await expectRows(page, [f.alternate.result]);
  await expectCount(page, 1, true);
  await expect(search(page)).toHaveValue(f.alternateQuery);

  await search(page).fill(f.query);
  await expectRows(page, f.selected.slice(0, 30));
  const closed = f.routes.gate();
  hold = { gate: closed, cursor: true };
  await more(page).click();
  await expect.poll(() => closed.captured).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await openResults(page, f);
  await expectRows(page, f.selected.slice(0, 30));
  closed.release();
  await expect.poll(() => closed.settled).toBe(true);
  await expectRows(page, f.selected.slice(0, 30));
  await expectCount(page, 30);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await append(page, f.selected);
  await expectCount(page, 31, true);

  // Hold an ordinary selected-project read, then deliver its temporary failure
  // only after another visible project's real successful page has taken over.
  await scope(page).selectOption('personal');
  await expectRows(page, f.personal);
  const failed = f.routes.gate();
  hold = { gate: failed, cursor: false, failure: true };
  await scope(page).selectOption(projectScope(f.project));
  await expect.poll(() => failed.captured).not.toBeNull();
  expect(failed.captured!.items.map((result) => result.id)).toEqual(
    f.selected.slice(0, 30).map((result) => result.id),
  );
  await scope(page).selectOption(projectScope(f.otherProject));
  await expectRows(page, f.other.slice(0, 30));
  await expectCount(page, 30);
  const currentReads = f.requests.length;
  failed.release();
  await expect.poll(() => failed.settled).toBe(true);
  await expectRows(page, f.other.slice(0, 30));
  await expectCount(page, 30);
  await expect(type(page)).toHaveValue('result');
  await expect(scope(page)).toHaveValue(projectScope(f.otherProject));
  await expect(search(page)).toHaveValue(f.query);
  await expect(results(page)).toHaveAttribute('aria-busy', 'false');
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await expect(restart(page)).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: '重试搜索', exact: true })).toHaveCount(0);
  expect(f.requests).toHaveLength(currentReads);
  await append(page, f.other);
  await expectCount(page, 31, true);
  expect(f.requests.at(-1)).toMatchObject({
    type: 'result',
    q: f.query,
    scope: 'project',
    projectId: f.otherProject.id,
  });
  expect(f.requests.at(-1)!.cursor).toBeTruthy();
});

test('当前成果首批与追加500可重试，失效游标清空旧页并以原始读取重新开始', async ({
  page,
  currentResults: f,
}) => {
  let failure: 'first' | 'more' | 'INVALID_CURSOR' | 'SEARCH_RESULTS_CHANGED' | null = 'first';
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const hasCursor = url.searchParams.has('cursor');
    const code = failure;
    const inject =
      url.searchParams.get('type') === 'result' &&
      code &&
      (code === 'first' ? !hasCursor : hasCursor);
    if (inject) {
      failure = null;
      const original = (await response.json()) as ResultSearchPage;
      expect(original.items.map((result) => result.id)).toEqual(
        (hasCursor ? f.selected.slice(30) : f.selected.slice(0, 30)).map((result) => result.id),
      );
      await route.fulfill({
        response,
        status: code === 'INVALID_CURSOR' ? 400 : code === 'SEARCH_RESULTS_CHANGED' ? 409 : 500,
        json: {
          error: {
            code: code === 'first' || code === 'more' ? 'TEMPORARY_FAILURE' : code,
            message:
              code === 'first' || code === 'more' ? '搜索暂时不可用' : '搜索结果已失效，请重新搜索',
          },
        },
      });
    } else await route.fulfill({ response });
  });
  await page.goto('/');
  await openResults(page, f);
  await expect(dialog(page).getByRole('alert')).toHaveText('搜索暂时不可用');
  await expectRows(page, []);
  await expect(more(page)).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '重试搜索', exact: true }).click();
  await expectRows(page, f.selected.slice(0, 30));
  await expectCount(page, 30);
  expect(f.requests.slice(0, 2).map((request) => request.cursor)).toEqual([null, null]);
  failure = 'more';
  await more(page).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('搜索暂时不可用');
  await expectRows(page, f.selected.slice(0, 30));
  await expect(status(page)).toHaveText('已显示 30 项成果，可重试加载更多');
  const failedCursor = f.requests.at(-1)!.cursor;
  expect(failedCursor).toBeTruthy();
  await dialog(page).getByRole('button', { name: '重试加载更多', exact: true }).click();
  await expectRows(page, f.selected);
  await expectCount(page, 31, true);
  expect(f.requests.at(-1)!.cursor).toBe(failedCursor);
  for (const code of ['INVALID_CURSOR', 'SEARCH_RESULTS_CHANGED'] as const) {
    await search(page).fill(f.alternateQuery);
    await expectRows(page, [f.alternate.result]);
    await search(page).fill(f.query);
    await expectRows(page, f.selected.slice(0, 30));
    failure = code;
    await more(page).click();
    await expect(restart(page)).toBeFocused();
    await expectRows(page, []);
    await expect(status(page)).toHaveText('搜索结果已失效，请重新搜索。');
    await expect(more(page)).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: '重试加载更多', exact: true }),
    ).toHaveCount(0);
    await expect(type(page)).toHaveValue('result');
    await expect(search(page)).toHaveValue(f.query);
    await expect(scope(page)).toHaveValue(projectScope(f.project));
    await restart(page).press('Enter');
    await expectRows(page, f.selected.slice(0, 30));
    await expectCount(page, 30);
    expect(f.requests.at(-1)).toMatchObject({
      type: 'result',
      q: f.query,
      scope: 'project',
      projectId: f.project.id,
      cursor: null,
    });
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await append(page, f.selected);
    await expectCount(page, 31, true);
  }
});

test('当前父任务标题经真实SSE重置成果页，无关任务字段和项目资料保留页与焦点', async ({
  page,
  currentResults: f,
}) => {
  await page.goto('/');
  await expect(page.locator('.workbench-connection')).toHaveAttribute('title', '任务事件已连接');
  await openResults(page, f);
  await expectRows(page, f.selected.slice(0, 30));
  await append(page, f.selected);
  await expectCount(page, 31, true);
  const finalResult = f.selected.at(-1)!;
  await expect(row(page, finalResult)).toBeFocused();
  async function unchangedAfter(
    edit: () => Promise<unknown>,
    contains: (current: Workbench) => boolean,
  ) {
    const priorReads = f.requests.length;
    // Both promises are observed immediately even if the explicit edit fails.
    const updated = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== '/api/v1/workbench' || response.status() !== 200)
        return false;
      return contains((await response.json()) as Workbench);
    });
    await Promise.all([updated, edit()]);
    // A mistaken reset schedules its GET 150ms after the real SSE feed read.
    await page.waitForTimeout(200);
    await expectRows(page, f.selected);
    await expectCount(page, 31, true);
    await expect(row(page, finalResult)).toBeFocused();
    expect(f.requests).toHaveLength(priorReads);
  }
  const selectedTask = f.selected[0]!.task;
  await unchangedAfter(
    () =>
      f.editTask(selectedTask.id, {
        attention: '普通注意事项',
        description: '当前父任务说明不参与成果匹配',
      }),
    (current) =>
      current.tasks.some(
        (task) => task.id === selectedTask.id && task.attention === '普通注意事项',
      ),
  );
  const otherTask = f.other[0]!.task;
  await unchangedAfter(
    () => f.editTask(otherTask.id, { title: '另一项目更新后的源任务' }),
    (current) =>
      current.tasks.some(
        (task) => task.id === otherTask.id && task.title === '另一项目更新后的源任务',
      ),
  );
  await unchangedAfter(
    () => f.editProject(f.project.id, { description: '普通项目资料更新，不改变成果来源名称' }),
    (current) =>
      current.projects.some(
        (project) =>
          project.id === f.project.id &&
          project.description === '普通项目资料更新，不改变成果来源名称',
      ),
  );
  await unchangedAfter(
    () => f.editProject(f.otherProject.id, { name: '另一个项目的新名称' }),
    (current) =>
      current.projects.some(
        (project) => project.id === f.otherProject.id && project.name === '另一个项目的新名称',
      ),
  );
  const priorReads = f.requests.length;
  const saved = await f.editTask(selectedTask.id, { title: '当前来源任务标题已更新' });
  const current = (await f.ordered()).filter((result) => result.task.projectId === f.project.id);
  await expectRows(page, current.slice(0, 30));
  await expectCount(page, 30);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue(f.query);
  await expect(type(page)).toHaveValue('result');
  await expect(scope(page)).toHaveValue(projectScope(f.project));
  await expect
    .poll(() => f.requests.slice(priorReads))
    .toEqual([
      { type: 'result', q: f.query, scope: 'project', projectId: f.project.id, cursor: null },
    ]);
  const changed = current.find((result) => result.task.id === saved.id)!;
  expect(changed.task.title).toBe(saved.title);
  await expectMetadata(page, changed, f.project.name);
  await append(page, current);
  await expectCount(page, 31, true);
  await expectBodyHit(page, current.at(-1)!, f.query);
});
