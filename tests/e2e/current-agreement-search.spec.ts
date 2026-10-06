import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  Message,
  Project,
  Task,
  TaskDetail,
  Workbench,
} from '../../packages/contracts/src/index.js';
import type {
  AgreementPreview,
  ProjectAgreement,
} from '../../packages/contracts/src/project-agreements.js';
import type { AgreementSearchPage } from '../../packages/contracts/src/agreement-search.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: '搜索与快捷操作', exact: true });
const search = (page: Page) => dialog(page).getByRole('textbox', { name: '全局搜索', exact: true });
const type = (page: Page) => dialog(page).getByRole('combobox', { name: '搜索类型', exact: true });
const scope = (page: Page) =>
  dialog(page).getByRole('combobox', { name: '约定搜索范围', exact: true });
const results = (page: Page) =>
  dialog(page).getByRole('region', { name: '约定搜索结果', exact: true });
const rows = (page: Page) => results(page).getByRole('button');
const row = (page: Page, agreement: ProjectAgreement) =>
  results(page).locator(`button[data-agreement-id="${agreement.id}"]`);
const status = (page: Page) =>
  dialog(page).getByRole('status', { name: '约定搜索分页状态', exact: true });
const more = (page: Page) =>
  dialog(page).getByRole('button', { name: '加载更多约定', exact: true });
const restart = (page: Page) => dialog(page).getByRole('button', { name: '重新搜索', exact: true });
const snippet = (target: Locator) => target.getByLabel('约定正文匹配片段', { exact: true });
const projectScope = (project: Project) => `project:${project.id}`;
const stateText = { active: '有效', inactive: '已停用', superseded: '已替代' };
const personalMessage = '项目约定不支持无项目个人范围，请选择全部或项目。';
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

// Hold only ordinary reads. Teardown owns every intercepted operation and
// releases real responses before draining/unrouting, including failed tests.
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
        captured: null as AgreementSearchPage | null,
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
      } else throw new AggregateError(errors, '当前约定搜索读取夹具清理失败');
    },
  };
}

async function fixture(page: Page, projectAgreementCount: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
  const token = randomUUID().slice(0, 8);
  const query = `Current-${token} 👩🏽‍💻 <b>核对</b>`;
  const alternateQuery = `OnlyBody-${token}`;
  const titleQuery = `OnlyTitle-${token}`;
  const sourceQuery = `OnlyOrigin-${token}`;
  const historyQuery = `OnlyHistory-${token}`;
  const taskQuery = `OnlyTask-${token}`;
  const projectQuery = `OnlyProject-${token}`;
  const boundaryTitle = `BoundaryTitle-${token}`;
  const boundaryBody = `BoundaryBody-${token}`;
  const projects: Project[] = [];
  for (const name of ['约定范围', '较新约定', '空约定项目'])
    projects.push(
      await post<Project>(page, 'spaces/space-demo/projects', {
        name: `${name} ${token} ${projectQuery}`,
      }),
    );
  const [project, otherProject, emptyProject] = projects as [Project, Project, Project];
  const sources = new Map<string, { task: Task; message: Message; preview: AgreementPreview }>();
  for (const current of [project, otherProject]) {
    const task = await post<Task>(page, 'spaces/space-demo/tasks', {
      projectId: current.id,
      title: `${taskQuery} ${current.name}`,
      description: '当前约定搜索的普通来源任务。',
    });
    const message = await post<Message>(page, `tasks/${task.id}/messages`, {
      body: `${sourceQuery} 来源讨论，仅编辑后的标题和正文参与约定搜索。`,
    });
    const preview = await get<AgreementPreview>(
      page,
      `tasks/${task.id}/messages/${message.id}/agreement-preview`,
    );
    expect(preview.origin.messageId).toBe(message.id);
    expect(preview.origin.excerpt).toContain(sourceQuery);
    sources.set(current.id, { task, message, preview });
  }
  const records = new Map<string, ProjectAgreement>();
  const publicationOrder: string[] = [];
  const expectedAgreements = new Map<string, ProjectAgreement>();
  const expectedTasks = new Map<string, TaskDetail>();
  const path = (agreement: ProjectAgreement) =>
    `projects/${agreement.projectId}/agreements/${agreement.id}`;
  async function remember(agreement: ProjectAgreement) {
    records.set(agreement.id, agreement);
    expectedAgreements.set(agreement.id, agreement);
    return agreement;
  }
  async function publish(
    projectId: string,
    title: string,
    content: string,
    replaces?: ProjectAgreement,
  ) {
    const source = sources.get(projectId)!;
    const preview = await get<AgreementPreview>(
      page,
      `tasks/${source.task.id}/messages/${source.message.id}/agreement-preview`,
    );
    const saved = await post<ProjectAgreement>(page, `projects/${projectId}/agreements`, {
      title,
      content,
      sourceTaskId: source.task.id,
      sourceMessageId: source.message.id,
      expectedSourceHash: preview.origin.hash,
      ...(replaces ? { replaces: { id: replaces.id, expectedRevision: replaces.revision } } : {}),
    });
    expect(saved).toMatchObject({
      projectId,
      title,
      content,
      revision: 1,
      state: 'active',
      origin: preview.origin,
      replacesId: replaces?.id ?? null,
    });
    publicationOrder.push(saved.id);
    if (replaces) {
      const predecessor = await get<ProjectAgreement>(page, path(replaces));
      expect(predecessor).toEqual({
        ...replaces,
        revision: replaces.revision + 1,
        state: 'superseded',
        supersededById: saved.id,
        statusReason: '已由新的项目约定替代',
        updatedAt: predecessor.updatedAt,
        updatedByUserId: saved.createdByUserId,
        updatedByName: saved.createdByName,
      });
      await remember(predecessor);
    }
    return remember(saved);
  }
  async function edit(agreement: ProjectAgreement, changes: { title?: string; content?: string }) {
    const response = await page.request.patch('/api/v1/' + path(agreement), {
      headers: headers(),
      data: {
        expectedRevision: agreement.revision,
        title: agreement.title,
        content: agreement.content,
        ...changes,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const saved = (await response.json()) as ProjectAgreement;
    expect(saved).toEqual({
      ...agreement,
      ...changes,
      revision: agreement.revision + 1,
      contentHash: saved.contentHash,
      updatedAt: saved.updatedAt,
      updatedByUserId: saved.updatedByUserId,
      updatedByName: saved.updatedByName,
    });
    return remember(saved);
  }
  async function lifecycle(agreement: ProjectAgreement, action: 'deactivate' | 'reactivate') {
    const reason = action === 'deactivate' ? '普通夹具明确停用' : '';
    const saved = await post<ProjectAgreement>(page, path(agreement) + '/lifecycle', {
      expectedRevision: agreement.revision,
      action,
      reason,
    });
    expect(saved).toEqual({
      ...agreement,
      revision: agreement.revision + 1,
      state: action === 'deactivate' ? 'inactive' : 'active',
      statusReason: reason || null,
      updatedAt: saved.updatedAt,
      updatedByUserId: saved.updatedByUserId,
      updatedByName: saved.updatedByName,
    });
    return remember(saved);
  }
  const body =
    '开头背景没有检索词。' +
    '普通背景资料。'.repeat(65) +
    `第一处检查 ${query} 原始记录。` +
    '两处之间的背景材料。'.repeat(35) +
    `第二处检查 ${query} 保留原文。`;
  let boundary!: ProjectAgreement,
    titleEntry!: ProjectAgreement,
    inactive!: ProjectAgreement,
    superseded!: ProjectAgreement,
    alternate!: ProjectAgreement;
  // The successor is included in the requested total; a replacement does not
  // erase its predecessor from current-record search.
  for (let index = 0; index < projectAgreementCount - 1; index++) {
    const bodyOnly = index === Math.floor(projectAgreementCount / 2) - 1;
    const agreement = await publish(
      project.id,
      index === 0
        ? `${boundaryTitle} ${historyQuery}`
        : bodyOnly
          ? `正文命中的项目约定 ${index + 1}`
          : `${query} 约定 ${index + 1}${index === 1 ? ` ${titleQuery}` : ''}`,
      (index === 0 ? `${boundaryBody} ${historyQuery} ` : '') +
        body +
        (index === projectAgreementCount - 2 ? ` ${alternateQuery}` : ''),
    );
    if (index === 0)
      boundary = await edit(agreement, {
        title: boundaryTitle,
        content: `${boundaryBody} ${body}`,
      });
    if (index === 1) titleEntry = agreement;
    if (bodyOnly) inactive = await lifecycle(agreement, 'deactivate');
    if (index === 3) {
      await publish(project.id, `${query} 明确替代后的约定`, body, agreement);
      superseded = records.get(agreement.id)!;
    }
    if (index === projectAgreementCount - 2) alternate = agreement;
  }
  // More than a whole newer unscoped page precedes this selected project.
  // A client that filters after pagination cannot produce 30/30/1.
  for (let index = 0; index < 31; index++)
    await publish(otherProject.id, `${query} 较新约定 ${index + 1}`, '其他项目的当前约定正文。');
  for (const { task } of sources.values()) {
    const detail = await get<TaskDetail>(page, `tasks/${task.id}`);
    expect(detail.runs).toEqual([]);
    expect(detail.messages).toHaveLength(1);
    expectedTasks.set(task.id, detail);
  }
  const initial = await get<Workbench>(page, 'workbench');
  const expectedProjects = projects.map(
    (current) => initial.projects.find((item) => item.id === current.id)!,
  );
  function ordered(q = query, projectId?: string) {
    const needle = q.trim().toLocaleLowerCase();
    // Publication order plus exact current records is independent of /search.
    // Editing/lifecycle changes revisions without moving the original row.
    return [...publicationOrder]
      .reverse()
      .map((id) => records.get(id)!)
      .filter(
        (agreement) =>
          (!projectId || agreement.projectId === projectId) &&
          `${agreement.title} ${agreement.content}`.toLocaleLowerCase().includes(needle),
      );
  }
  const selected = ordered(query, project.id),
    other = ordered(query, otherProject.id),
    originalOrder = ordered();
  expect(selected).toHaveLength(projectAgreementCount);
  expect(
    originalOrder.slice(0, 30).every((agreement) => agreement.projectId === otherProject.id),
  ).toBe(true);
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
    sourceQuery,
    historyQuery,
    taskQuery,
    projectQuery,
    boundaryTitle,
    boundaryBody,
    project,
    otherProject,
    emptyProject,
    sources,
    records,
    boundary,
    titleEntry,
    inactive,
    superseded,
    alternate,
    selected,
    other,
    originalOrder,
    requests,
    expectedAgreements,
    ordered,
    edit,
    lifecycle,
    publish,
    routes: readRoutes(page),
    async editTask(task: Task) {
      const before = expectedTasks.get(task.id)!;
      const changes = {
        title: '普通更新后的来源任务',
        description: '此说明不参与约定匹配',
        attention: '普通注意事项',
      };
      const response = await page.request.patch(`/api/v1/tasks/${task.id}`, {
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
      const expected = { ...before, task: { ...saved, participantUserIds } };
      expect(await get<TaskDetail>(page, `tasks/${task.id}`)).toEqual(expected);
      expectedTasks.set(task.id, expected);
      return saved;
    },
    async verifyUnchanged() {
      const agreements = [...records.values()];
      expect(
        await Promise.all(
          agreements.map((agreement) => get<ProjectAgreement>(page, path(agreement))),
        ),
      ).toEqual(agreements.map((agreement) => expectedAgreements.get(agreement.id)));
      expect(
        await Promise.all(
          [...sources.values()].map(({ task }) => get<TaskDetail>(page, `tasks/${task.id}`)),
        ),
      ).toEqual([...sources.values()].map(({ task }) => expectedTasks.get(task.id)));
      const current = await get<Workbench>(page, 'workbench');
      expect(
        projects.map((project) => current.projects.find((item) => item.id === project.id)),
      ).toEqual(expectedProjects);
      expect(browserWrites).toEqual([]);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ currentAgreements: Fixture; projectAgreementCount: number }>({
  projectAgreementCount: [31, { option: true }],
  currentAgreements: async ({ page, projectAgreementCount }, use) => {
    const f = await fixture(page, projectAgreementCount);
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

async function openAgreements(page: Page, f: Fixture) {
  await openSearch(page);
  await type(page).selectOption('agreement');
  await scope(page).selectOption(projectScope(f.project));
  await search(page).fill(f.query);
}

async function expectRows(page: Page, expected: ProjectAgreement[]) {
  await expect(rows(page)).toHaveCount(expected.length);
  await expect
    .poll(() =>
      rows(page).evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-agreement-id')),
      ),
    )
    .toEqual(expected.map((agreement) => agreement.id));
  await expect
    .poll(() => rows(page).locator('strong').allTextContents())
    .toEqual(expected.map((agreement) => agreement.title));
  await expect
    .poll(() => rows(page).locator('.command-agreement-meta > span:first-child').allTextContents())
    .toEqual(expected.map((agreement) => stateText[agreement.state]));
  await expect
    .poll(() => rows(page).locator('.command-agreement-meta > span:last-child').allTextContents())
    .toEqual(expected.map((agreement) => `修订 ${agreement.revision}`));
  expect(
    new Set(
      await rows(page).evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-agreement-id')),
      ),
    ).size,
  ).toBe(expected.length);
  await expect(dialog(page).locator('[data-task-id], [data-result-id]')).toHaveCount(0);
}

async function expectCount(page: Page, count: number, terminal = false) {
  await expect(status(page)).toHaveText(
    `已显示 ${count} 项约定，${terminal ? '已加载全部结果' : '可继续加载'}`,
  );
  if (terminal) await expect(more(page)).toHaveCount(0);
  else await expect(more(page)).toBeEnabled();
}

async function append(page: Page, expected: ProjectAgreement[], touch = false) {
  const before = await rows(page).count();
  if (touch) await more(page).tap();
  else {
    await more(page).focus();
    await more(page).press('Enter');
  }
  await expectRows(page, expected);
  await expect(row(page, expected[before]!)).toBeFocused();
}

async function expectMetadata(page: Page, agreement: ProjectAgreement, project: Project) {
  const target = row(page, agreement);
  await expect(target).toContainText(project.name);
  await expect(target).toContainText(`修订 ${agreement.revision}`);
  await expect(target).toContainText(stateText[agreement.state]);
}

async function expectBodyHit(page: Page, agreement: ProjectAgreement, query: string) {
  expect(agreement.title).not.toContain(query);
  const match = snippet(row(page, agreement));
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

async function capture(page: Page, f: Fixture, path: string, mobile: boolean) {
  const target = row(page, f.inactive);
  await expect(type(page)).toHaveValue('agreement');
  await expect(type(page).locator('option:checked')).toHaveText('约定（当前记录）');
  await expect(scope(page)).toHaveValue(projectScope(f.project));
  await expectMetadata(page, f.inactive, f.project);
  await expectBodyHit(page, f.inactive, f.query);
  const geometry = await target.evaluate((element) => {
    const scroller = element.closest('.command-results');
    if (!scroller) throw new Error('缺少约定搜索滚动容器');
    const content = scroller.getBoundingClientRect(),
      initial = element.getBoundingClientRect();
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
  expect(geometry.row.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry.content.top - 1,
  );
  expect(geometry.row.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.content.bottom + 1,
  );
  for (const control of [
    search(page),
    type(page),
    scope(page),
    target,
    more(page),
    dialog(page).getByRole('button', { name: '关闭', exact: true }),
  ])
    await hitTarget(control, mobile ? 44 : 32);
  for (const visible of [
    dialog(page).locator('.dialog-heading'),
    search(page),
    type(page),
    scope(page),
    target,
    snippet(target),
    status(page),
    more(page),
  ])
    await expect(visible).toBeInViewport({ ratio: 1 });
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
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path });
}

async function expectDetail(page: Page, f: Fixture, agreement: ProjectAgreement) {
  await expect(page).toHaveURL(
    new RegExp(`/projects/${agreement.projectId}\\?tab=agreements&agreement=${agreement.id}$`),
  );
  await expect(dialog(page)).toHaveCount(0);
  const detail = page.getByRole('dialog', { name: '项目约定', exact: true });
  await expect(detail.getByRole('heading', { name: agreement.title, exact: true })).toBeVisible();
  await expect(detail.locator('.agreement-kicker')).toHaveText(
    `${stateText[agreement.state]} · 修订 ${agreement.revision}`,
  );
  await expect(detail.locator('.agreement-text')).toHaveText(agreement.content);
  expect(
    await get<ProjectAgreement>(page, `projects/${agreement.projectId}/agreements/${agreement.id}`),
  ).toEqual(f.expectedAgreements.get(agreement.id));
}

test.describe('当前约定真实三批与截图', () => {
  test.use({ projectAgreementCount: 61, hasTouch: true });
  test('项目先筛选再分页，61项当前状态修订正文片段与深浅色窄屏原抽屉导航', async ({
    page,
    currentAgreements: f,
  }) => {
    await page.goto(`/projects/${f.project.id}`);
    await openSearch(page);
    await type(page).selectOption('agreement');
    await expect(scope(page)).toHaveValue('all');
    await expectRows(page, []);
    expect(f.requests).toEqual([]);
    await search(page).fill(`  ${f.query.toUpperCase()}  `);
    await expectRows(page, f.originalOrder.slice(0, 30));
    await expectCount(page, 30);
    await expectMetadata(page, f.other[0]!, f.otherProject);
    expect(f.requests[0]).toMatchObject({
      type: 'agreement',
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
    for (const agreement of [f.inactive, f.superseded, f.titleEntry])
      await expectMetadata(page, agreement, f.project);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(page, f, 'artifacts/244-current-agreement-search-dark.png', false);
    await append(page, f.selected);
    await expectCount(page, 61, true);
    const selectedReads = f.requests.filter((request) => request.scope === 'project');
    expect(selectedReads.map((request) => request.type)).toEqual(Array(3).fill('agreement'));
    expect(selectedReads.map((request) => request.projectId)).toEqual(Array(3).fill(f.project.id));
    expect(selectedReads.map((request) => Boolean(request.cursor))).toEqual([false, true, true]);
    expect(new Set(selectedReads.slice(1).map((request) => request.cursor)).size).toBe(2);
    await row(page, f.inactive).focus();
    await row(page, f.inactive).press('Enter');
    await expectDetail(page, f, f.inactive);
    await expect(page.getByRole('button', { name: '重新启用约定', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openAgreements(page, f);
    await expectRows(page, f.selected.slice(0, 30));
    await append(page, f.selected.slice(0, 60), true);
    await expectCount(page, 60);
    await capture(page, f, 'artifacts/245-current-agreement-search-mobile-light.png', true);
    await append(page, f.selected, true);
    await expectCount(page, 61, true);
    await row(page, f.superseded).tap();
    await expectDetail(page, f, f.superseded);
    await expect(page.getByRole('button', { name: '查看后续约定', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新启用约定', exact: true })).toHaveCount(0);
  });
});

test('当前标题正文匹配保留，来源旧正文不命中，Task成果保留与无项目个人范围不发请求', async ({
  page,
  currentAgreements: f,
}) => {
  await page.goto('/');
  await openSearch(page);
  for (const name of ['新建任务', '打开工作台', '查看项目', '查看成果', '资源与设置'])
    await expect(dialog(page).getByRole('button', { name, exact: true })).toBeVisible();
  expect(f.requests).toEqual([]);
  await search(page).fill(f.taskQuery);
  const taskResults = dialog(page).getByRole('region', { name: '任务搜索结果', exact: true });
  await expect(taskResults.getByRole('button')).toHaveCount(2);
  expect(f.requests.at(-1)).toMatchObject({ type: null, scope: null, cursor: null });
  await type(page).selectOption('result');
  await expect(
    dialog(page).getByRole('status', { name: '成果搜索分页状态', exact: true }),
  ).toHaveText('没有找到匹配的成果。');
  expect(f.requests.at(-1)).toMatchObject({ type: 'result', q: f.taskQuery, cursor: null });
  await type(page).selectOption('agreement');
  await scope(page).selectOption(projectScope(f.project));
  for (const [q, agreement, bodyOnly] of [
    [`  ${f.titleQuery.toUpperCase()}  `, f.titleEntry, false],
    [f.alternateQuery, f.alternate, true],
  ] as const) {
    await search(page).fill(q);
    await expectRows(page, [agreement]);
    await expectCount(page, 1, true);
    await expectMetadata(page, agreement, f.project);
    await expect(snippet(row(page, agreement))).toHaveCount(bodyOnly ? 1 : 0);
    if (bodyOnly)
      await expect(snippet(row(page, agreement)).locator('mark')).toHaveText(f.alternateQuery);
    expect(f.requests.at(-1)).toMatchObject({
      type: 'agreement',
      q: q.trim(),
      scope: 'project',
      projectId: f.project.id,
      cursor: null,
    });
  }
  expect(f.boundary.title).not.toContain(f.historyQuery);
  expect(f.boundary.content).not.toContain(f.historyQuery);
  expect(f.boundary.revision).toBe(2);
  for (const q of [f.sourceQuery, f.historyQuery, f.taskQuery, f.projectQuery]) {
    const completed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/v1/search' &&
        url.searchParams.get('type') === 'agreement' &&
        url.searchParams.get('q') === q &&
        response.status() === 200
      );
    });
    await Promise.all([completed, search(page).fill(q)]);
    await expectRows(page, []);
    await expect(status(page)).toHaveText('没有找到匹配的约定。');
    await expect(more(page)).toHaveCount(0);
  }
  // Preserve the existing agreement title + separator + content matcher.
  // A cross-field match has no independently matching body snippet.
  await search(page).fill(`${f.boundaryTitle} ${f.boundaryBody}`);
  await expectRows(page, [f.boundary]);
  await expectCount(page, 1, true);
  await expect(snippet(row(page, f.boundary))).toHaveCount(0);
  await search(page).fill(f.query);
  await expectRows(page, f.selected.slice(0, 30));
  await scope(page).selectOption(projectScope(f.emptyProject));
  await expectRows(page, []);
  await expect(status(page)).toHaveText('没有找到匹配的约定。');
  await scope(page).selectOption('all');
  await expectRows(page, f.originalOrder.slice(0, 30));
  await type(page).selectOption('task');
  const taskScope = dialog(page).getByRole('combobox', { name: '任务搜索范围', exact: true });
  await taskScope.selectOption('personal');
  await expect(
    dialog(page).getByRole('status', { name: '任务搜索分页状态', exact: true }),
  ).toHaveText('没有找到匹配的任务。');
  const beforePersonal = f.requests.length;
  await type(page).selectOption('agreement');
  await expect(scope(page)).toHaveValue('personal');
  await expectRows(page, []);
  await expect(status(page)).toHaveText(personalMessage);
  await search(page).fill(f.alternateQuery);
  await expect(status(page)).toHaveText(personalMessage);
  // Wait beyond the ordinary search debounce to prove there is no widening GET.
  await page.waitForTimeout(200);
  expect(f.requests).toHaveLength(beforePersonal);
  await expect(more(page)).toHaveCount(0);
  await expect(restart(page)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const control of [
    search(page),
    type(page),
    scope(page),
    dialog(page).getByRole('button', { name: '关闭', exact: true }),
  ])
    await hitTarget(control, 44);
  for (const visible of [type(page), scope(page), status(page)])
    await expect(visible).toBeInViewport({ ratio: 1 });
  expect((await dialog(page).boundingBox())!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/246-current-agreement-search-personal-mobile.png' });
  expect(f.requests).toHaveLength(beforePersonal);
  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, [f.alternate]);
  expect(f.requests.at(-1)).toEqual({
    type: 'agreement',
    q: f.alternateQuery,
    scope: 'project',
    projectId: f.project.id,
    cursor: null,
  });
});

test('暂留真实200和普通500后切换类型查询范围及关闭隔离旧回应，重复加载只有一次读取', async ({
  page,
  currentAgreements: f,
}) => {
  type Gate = ReturnType<typeof f.routes.gate>;
  let hold: { gate: Gate; cursor: boolean; failure?: boolean } | null = null;
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const selected =
      url.searchParams.get('type') === 'agreement' &&
      url.searchParams.get('q') === f.query &&
      url.searchParams.get('projectId') === f.project.id;
    const captured =
      selected && hold && url.searchParams.has('cursor') === hold.cursor ? hold : null;
    if (captured) {
      hold = null;
      captured.gate.captured = (await response.json()) as AgreementSearchPage;
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
  await openAgreements(page, f);
  await expect.poll(() => first.captured).not.toBeNull();
  expect(first.captured!.items.map((agreement) => agreement.id)).toEqual(
    f.selected.slice(0, 30).map((agreement) => agreement.id),
  );
  await type(page).selectOption('task');
  await expect(
    dialog(page).getByRole('status', { name: '任务搜索分页状态', exact: true }),
  ).toHaveText('没有找到匹配的任务。');
  first.release();
  await expect.poll(() => first.settled).toBe(true);
  await expect(type(page)).toHaveValue('task');
  await expect(search(page)).toHaveValue(f.query);
  await expect(dialog(page).locator('[data-agreement-id]')).toHaveCount(0);
  await expect(
    dialog(page).getByRole('combobox', { name: '任务搜索范围', exact: true }),
  ).toHaveValue(projectScope(f.project));
  await type(page).selectOption('agreement');
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
  expect(later.captured!.items.map((agreement) => agreement.id)).toEqual(
    f.selected.slice(30).map((agreement) => agreement.id),
  );
  await expect(dialog(page).getByRole('button', { name: '加载中…', exact: true })).toBeDisabled();
  await expect(status(page)).toHaveText('已显示 30 项约定，正在加载更多…');
  await expectRows(page, f.selected.slice(0, 30));
  expect(f.requests.filter((request) => request.cursor)).toHaveLength(beforeMore + 1);
  const beforePersonal = f.requests.length;
  await scope(page).selectOption('personal');
  await expectRows(page, []);
  await expect(status(page)).toHaveText(personalMessage);
  later.release();
  await expect.poll(() => later.settled).toBe(true);
  await expectRows(page, []);
  await expect(status(page)).toHaveText(personalMessage);
  expect(f.requests).toHaveLength(beforePersonal);

  await scope(page).selectOption(projectScope(f.project));
  await expectRows(page, f.selected.slice(0, 30));
  await search(page).fill(f.alternateQuery);
  await expectRows(page, [f.alternate]);
  const changedQuery = f.routes.gate();
  hold = { gate: changedQuery, cursor: false };
  await search(page).fill(f.query);
  await expect.poll(() => changedQuery.captured).not.toBeNull();
  await search(page).fill(f.alternateQuery);
  await expectRows(page, [f.alternate]);
  changedQuery.release();
  await expect.poll(() => changedQuery.settled).toBe(true);
  await expectRows(page, [f.alternate]);
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
  await openAgreements(page, f);
  await expectRows(page, f.selected.slice(0, 30));
  closed.release();
  await expect.poll(() => closed.settled).toBe(true);
  await expectRows(page, f.selected.slice(0, 30));
  await expectCount(page, 30);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await append(page, f.selected);
  await expectCount(page, 31, true);

  await scope(page).selectOption(projectScope(f.emptyProject));
  await expectRows(page, []);
  const failed = f.routes.gate();
  hold = { gate: failed, cursor: false, failure: true };
  await scope(page).selectOption(projectScope(f.project));
  await expect.poll(() => failed.captured).not.toBeNull();
  expect(failed.captured!.items.map((agreement) => agreement.id)).toEqual(
    f.selected.slice(0, 30).map((agreement) => agreement.id),
  );
  await scope(page).selectOption(projectScope(f.otherProject));
  await expectRows(page, f.other.slice(0, 30));
  await expectCount(page, 30);
  const currentReads = f.requests.length;
  failed.release();
  await expect.poll(() => failed.settled).toBe(true);
  await expectRows(page, f.other.slice(0, 30));
  await expectCount(page, 30);
  await expect(type(page)).toHaveValue('agreement');
  await expect(scope(page)).toHaveValue(projectScope(f.otherProject));
  await expect(search(page)).toHaveValue(f.query);
  await expect(results(page)).toHaveAttribute('aria-busy', 'false');
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await expect(restart(page)).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: '重试搜索', exact: true })).toHaveCount(0);
  expect(f.requests).toHaveLength(currentReads);
  await append(page, f.other);
  await expectCount(page, 31, true);
});

test('首批和追加500可重试，失效游标清空旧页并保留原类型查询项目重新搜索', async ({
  page,
  currentAgreements: f,
}) => {
  let failure: 'first' | 'more' | 'INVALID_CURSOR' | 'SEARCH_RESULTS_CHANGED' | null = 'first';
  await f.routes.install(async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const hasCursor = url.searchParams.has('cursor'),
      code = failure;
    const inject =
      url.searchParams.get('type') === 'agreement' &&
      code &&
      (code === 'first' ? !hasCursor : hasCursor);
    if (inject) {
      failure = null;
      const original = (await response.json()) as AgreementSearchPage;
      expect(original.items.map((agreement) => agreement.id)).toEqual(
        (hasCursor ? f.selected.slice(30) : f.selected.slice(0, 30)).map(
          (agreement) => agreement.id,
        ),
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
  await openAgreements(page, f);
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
  await expect(status(page)).toHaveText('已显示 30 项约定，可重试加载更多');
  const failedCursor = f.requests.at(-1)!.cursor;
  expect(failedCursor).toBeTruthy();
  await dialog(page).getByRole('button', { name: '重试加载更多', exact: true }).click();
  await expectRows(page, f.selected);
  await expectCount(page, 31, true);
  expect(f.requests.at(-1)!.cursor).toBe(failedCursor);
  for (const code of ['INVALID_CURSOR', 'SEARCH_RESULTS_CHANGED'] as const) {
    await search(page).fill(f.alternateQuery);
    await expectRows(page, [f.alternate]);
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
    await expect(type(page)).toHaveValue('agreement');
    await expect(search(page)).toHaveValue(f.query);
    await expect(scope(page)).toHaveValue(projectScope(f.project));
    await restart(page).press('Enter');
    await expectRows(page, f.selected.slice(0, 30));
    await expectCount(page, 30);
    expect(f.requests.at(-1)).toEqual({
      type: 'agreement',
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

test('真实SSE中本项目编辑停启替代重置页，无关Task和另一项目约定保留页与焦点', async ({
  page,
  currentAgreements: f,
}) => {
  await page.goto('/');
  await expect(page.locator('.workbench-connection')).toHaveAttribute('title', '任务事件已连接');
  await openAgreements(page, f);
  await expectRows(page, f.selected.slice(0, 30));
  await append(page, f.selected);
  await expectCount(page, 31, true);
  const last = f.selected.at(-1)!;
  await expect(row(page, last)).toBeFocused();
  const version = (current: Workbench, projectId: string) =>
    current.projectAgreementVersions?.find((entry) => entry.projectId === projectId)?.version;
  async function unchangedAfter(
    change: () => Promise<unknown>,
    contains: (current: Workbench) => boolean,
  ) {
    const priorReads = f.requests.length;
    const updated = page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === '/api/v1/workbench' &&
        response.status() === 200 &&
        contains((await response.json()) as Workbench),
    );
    await Promise.all([updated, change()]);
    // A mistaken reset schedules its GET 150ms after the real SSE Workbench.
    await page.waitForTimeout(200);
    await expectRows(page, f.selected);
    await expectCount(page, 31, true);
    await expect(row(page, last)).toBeFocused();
    expect(f.requests).toHaveLength(priorReads);
  }
  const task = f.sources.get(f.project.id)!.task;
  await unchangedAfter(
    () => f.editTask(task),
    (current) =>
      current.tasks.some((item) => item.id === task.id && item.title === '普通更新后的来源任务'),
  );
  const otherVersion = version(await get<Workbench>(page, 'workbench'), f.otherProject.id)!;
  await unchangedAfter(
    () => f.edit(f.other[0]!, { title: `${f.query} 另一项目明确编辑` }),
    (current) => version(current, f.otherProject.id) === otherVersion + 1,
  );
  await unchangedAfter(
    () => f.lifecycle(f.records.get(f.other[0]!.id)!, 'deactivate'),
    (current) => version(current, f.otherProject.id) === otherVersion + 2,
  );

  async function resetAfter(change: () => Promise<ProjectAgreement>, increment = 1) {
    const before = await get<Workbench>(page, 'workbench');
    const expectedVersion = version(before, f.project.id)! + increment;
    const priorReads = f.requests.length;
    const updated = page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === '/api/v1/workbench' &&
        response.status() === 200 &&
        version((await response.json()) as Workbench, f.project.id) === expectedVersion,
    );
    const [, saved] = await Promise.all([updated, change()]);
    const current = f.ordered(f.query, f.project.id);
    await expectRows(page, current.slice(0, 30));
    await expectCount(page, 30);
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue(f.query);
    await expect(type(page)).toHaveValue('agreement');
    await expect(scope(page)).toHaveValue(projectScope(f.project));
    await expect
      .poll(() => f.requests.slice(priorReads))
      .toEqual([
        { type: 'agreement', q: f.query, scope: 'project', projectId: f.project.id, cursor: null },
      ]);
    await append(page, current);
    await expectCount(page, current.length, true);
    await expectMetadata(page, saved, f.project);
    return saved;
  }
  let selected = await resetAfter(() =>
    f.edit(f.titleEntry, {
      title: `${f.query} 当前标题明确更新`,
      content: `当前正文明确更新 ${f.query}`,
    }),
  );
  selected = await resetAfter(() => f.lifecycle(selected, 'deactivate'));
  selected = await resetAfter(() => f.lifecycle(selected, 'reactivate'));
  const successor = await resetAfter(
    () => f.publish(f.project.id, `${f.query} 当前替代规则`, `新的当前正文 ${f.query}`, selected),
    2,
  );
  const predecessor = f.records.get(selected.id)!;
  expect(successor.replacesId).toBe(predecessor.id);
  expect(predecessor.state).toBe('superseded');
  expect(predecessor.supersededById).toBe(successor.id);
  await expectMetadata(page, predecessor, f.project);
  await expectRows(page, f.ordered(f.query, f.project.id));
});
