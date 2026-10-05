import {
  test as base,
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
} from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type {
  Project,
  Result,
  Task,
  TaskDetail,
  TaskStatus,
} from '../../packages/contracts/src/index.js';
import type {
  ProjectTaskOrder,
  ProjectTaskMove,
  ProjectTaskMoveReceipt,
} from '../../packages/contracts/src/project-task-order.js';
import { teamFixture } from '../helpers/team.js';
import { prepareScreenshot } from '../helpers/task-reliability.js';

const origin = 'http://127.0.0.1:4346';
type Packet = { path: string; body: string | null; key: string };
type Disposable = { dispose(failed: boolean): Promise<void> };
const statusFilter = (page: Page) => page.getByLabel('任务状态筛选', { exact: true });
const attentionFilter = (page: Page) => page.getByLabel('关注内容筛选', { exact: true });
const ownerFilter = (page: Page) => page.getByLabel('负责人筛选', { exact: true });
const participantFilter = (page: Page) => page.getByLabel('参与者筛选', { exact: true });
const searchFilter = (page: Page) => page.getByLabel('筛选项目任务', { exact: true });
const listLinks = (page: Page) => page.locator('.work-task-list .work-task-row');
const boardLinks = (page: Page) => page.locator('.project-task-card > a');
const panel = (page: Page) => page.getByRole('region', { name: '项目任务排序', exact: true });
const begin = (page: Page) => page.getByRole('button', { name: '整理顺序', exact: true });
const close = (page: Page) => panel(page).getByRole('button', { name: '关闭排序', exact: true });
const recover = (page: Page) =>
  panel(page).getByRole('button', { name: '确认上次排序', exact: true });
const refresh = (page: Page) =>
  panel(page).getByRole('button', { name: '读取最新顺序', exact: true });
const menu = (page: Page, task: Task) =>
  page.getByRole('button', { name: `更多排序 ${task.shortId}`, exact: true });
const handle = (page: Page, task: Task) =>
  page.getByRole('button', { name: `拖动 ${task.shortId}`, exact: true });
const step = (page: Page, task: Task, direction: '上移' | '下移') =>
  page.getByRole('button', { name: `${direction} ${task.shortId}`, exact: true });
const selection = (page: Page) => page.getByRole('form', { name: '移动任务', exact: true });
const card = (page: Page, task: Task) =>
  page.locator('.project-task-card').filter({ has: page.locator(`a[href="/tasks/${task.id}"]`) });
const packet = (request: Request): Packet => ({
  path: new URL(request.url()).pathname,
  body: request.postData(),
  key: request.headers()['idempotency-key'] ?? '',
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function reportCleanup(errors: unknown[], failed: boolean) {
  if (!errors.length) return;
  if (failed)
    for (const error of errors)
      base.info().annotations.push({ type: 'cleanup-error', description: String(error) });
  else throw new AggregateError(errors, '项目排序夹具清理失败');
}

async function fixture(page: Page) {
  const api = await teamFixture(origin);
  const disposables: Disposable[] = [];
  const pages = [page];
  try {
    // One ordinary current owner; no role changes, identity faults, Run, native
    // files or branch producers. Every change below is deliberate fixture data.
    const owner = await api.space(await api.setup());
    async function read<T>(path: string): Promise<T> {
      const response = await api.call(path, owner);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<T>();
    }
    async function post<T>(path: string, body: unknown): Promise<T> {
      const response = await api.call(path, owner, body);
      expect([200, 201], response.body).toContain(response.statusCode);
      return response.json<T>();
    }
    const project = await post<Project>(`spaces/${owner.spaceId}/projects`, {
      name: '发布准备 · 任务先后安排',
      description: '列表与看板共用一份排序，原任务内容与状态保持各自记录。',
    });
    const tasks: Task[] = [];
    async function create(title: string, matches = true, status: TaskStatus = 'todo') {
      let task = await post<Task>(`spaces/${owner.spaceId}/tasks`, {
        projectId: project.id,
        title,
        description: matches ? '验收 alpha，核对本轮交付说明。' : '背景 beta，保留已有资料。',
      });
      if (status !== 'todo')
        task = await post<Task>(
          `tasks/${task.id}/${{ in_progress: 'start', done: 'complete', cancelled: 'cancel' }[status]}`,
          { expectedRevision: task.revision, activeRunAction: 'keep' },
        );
      if (matches) {
        await post(`tasks/${task.id}/participants`, {
          expectedRevision: 1,
          action: 'add',
          userId: owner.user.id,
        });
        const current = await read<TaskDetail>(`tasks/${task.id}`);
        const response = await api.call(
          `tasks/${task.id}`,
          owner,
          { expectedRevision: current.task.revision, attention: '核对发布前的普通说明' },
          undefined,
          'PATCH',
        );
        expect(response.statusCode, response.body).toBe(200);
      }
      const saved = await read<TaskDetail>(`tasks/${task.id}`);
      expect(saved.task.status).toBe(status);
      expect(saved.runs).toEqual([]);
      tasks.push(saved.task);
      return saved.task;
    }
    const a = await create('核对接口清单');
    const hiddenA = await create('整理背景资料', false);
    const b = await create('核对接口样例');
    const hiddenB = await create('整理已有约定', false);
    const c = await create('核对界面文案');
    const progress = await create('核对联调说明', false, 'in_progress');
    const done = await create('核对已交付说明', false, 'done');
    const cancelled = await create('撤回旧安排', false, 'cancelled');
    const result = await post<Result>(`tasks/${a.id}/results`, {
      title: '原有文字成果',
      body: '排序前保存的正文，不制造执行或改写成果版本。',
    });
    const otherProject = await post<Project>(`spaces/${owner.spaceId}/projects`, {
      name: '另一项目的当前安排',
    });
    const otherTask = await post<Task>(`spaces/${owner.spaceId}/tasks`, {
      projectId: otherProject.id,
      title: '保留另一项目自己的顺序',
    });
    function bodies() {
      return Object.fromEntries(
        ['projects', 'tasks', 'results', 'runs'].map((table) => [
          table,
          api.store.db.prepare(`SELECT id, body FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    }
    const before = bodies();
    const beforeTask = await read<TaskDetail>(`tasks/${a.id}`);
    const path = (projectId = project.id) => `projects/${projectId}/task-order`;
    const url = (projectId = project.id) => `${origin}/api/v1/${path(projectId)}`;
    const order = (projectId = project.id) => read<ProjectTaskOrder>(path(projectId));
    const initial = await order();
    expect(initial).toMatchObject({
      projectId: project.id,
      revision: 1,
      taskIds: [...tasks].reverse().map((task) => task.id),
    });
    expect(initial.baseline).toMatch(/^[a-f0-9]{64}$/);
    // Start after the actual fixture events, not an invented cursor. All later
    // real ordering events still reach both pages through the normal stream.
    const eventCursor = (
      api.store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM outbox').get() as {
        value: number;
      }
    ).value;
    const writes: Packet[] = [];
    async function prepare(target: Page, theme: 'dark' | 'light' = 'dark') {
      if (!pages.includes(target)) pages.push(target);
      await target.context().addCookies(
        owner.cookie.split('; ').map((cookie) => {
          const index = cookie.indexOf('=');
          return {
            name: cookie.slice(0, index),
            value: cookie.slice(index + 1),
            url: origin,
            httpOnly: true,
            sameSite: 'Lax' as const,
          };
        }),
      );
      await target.emulateMedia({ reducedMotion: 'reduce' });
      // A new Page does not inherit sessionStorage. Both pages explicitly use
      // the owner's existing team choice, as a normal navigation precondition.
      await target.addInitScript(
        ({ userId, spaceId, theme, eventCursor }) => {
          sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
          localStorage.setItem('hexu-theme', theme);
          const NativeEventSource = window.EventSource;
          window.EventSource = class extends NativeEventSource {
            constructor(url: string | URL, options?: EventSourceInit) {
              const target = new URL(url, location.href);
              target.searchParams.set('after', String(eventCursor));
              super(target, options);
            }
          };
        },
        { userId: owner.user.id, spaceId: owner.spaceId, theme, eventCursor },
      );
      target.on('request', (request) => {
        if (['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(packet(request));
      });
    }
    await api.app.listen({ port: 4346, host: '127.0.0.1' });
    await prepare(page);
    return {
      api,
      owner,
      project,
      tasks,
      a,
      b,
      c,
      hiddenA,
      hiddenB,
      progress,
      done,
      cancelled,
      result,
      otherProject,
      otherTask,
      read,
      post,
      path,
      url,
      order,
      initial,
      writes,
      disposables,
      prepare,
      bodies,
      async open(target = page, query = 'view=list', projectId = project.id) {
        const ready = target.waitForResponse(
          (response) =>
            response.url() === url(projectId) &&
            response.request().method() === 'GET' &&
            response.status() === 200,
        );
        await target.goto(`${origin}/projects/${projectId}?${query}`);
        await ready;
        await expect(begin(target)).toBeEnabled();
      },
      async unchanged(expected = before) {
        expect(bodies()).toEqual(expected);
        expect(await read<TaskDetail>(`tasks/${a.id}`)).toEqual(beforeTask);
        expect(writes.every((write) => write.path === `/api/v1/${path()}/move`)).toBe(true);
      },
      async dispose(failed: boolean) {
        const errors: unknown[] = [];
        for (const disposable of [...disposables].reverse()) {
          try {
            await disposable.dispose(failed);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const target of pages) {
          try {
            await target.close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await api.close();
        } catch (error) {
          errors.push(error);
        }
        reportCleanup(errors, failed);
      },
    };
  } catch (error) {
    try {
      await page.close();
      await api.close();
    } catch (cleanup) {
      reportCleanup([cleanup], true);
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ ordering: Fixture }>({
  ordering: async ({ page }, use) => {
    const f = await fixture(page);
    let failed = false;
    try {
      await use(f);
      failed = test.info().status !== test.info().expectedStatus;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.dispose(failed);
    }
  },
});

async function routeFixture(
  page: Page,
  f: Fixture,
  url: string,
  handle: (route: Route) => Promise<void>,
  release: () => void = () => {},
) {
  let capturing = true;
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const handler = (route: Route) => {
    const work = (async () => {
      if (capturing) await handle(route);
      else await route.continue();
    })();
    active.add(work);
    // Observe rejection immediately; cleanup must not mask the original failure.
    void work.then(
      () => active.delete(work),
      (error: unknown) => {
        errors.push(error);
        active.delete(work);
      },
    );
    return work;
  };
  await page.route(url, handler);
  let disposed = false;
  const disposable = {
    async dispose(failed: boolean) {
      if (disposed) return;
      disposed = true;
      capturing = false;
      release();
      while (active.size) await Promise.allSettled([...active]);
      try {
        await page.unroute(url, handler);
      } catch (error) {
        errors.push(error);
      }
      reportCleanup(errors, failed);
    },
  };
  f.disposables.push(disposable);
  return disposable;
}

async function expectIds(links: Locator, tasks: Task[]) {
  await expect(links).toHaveCount(tasks.length);
  await expect
    .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href'))))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`));
}
async function activate(page: Page) {
  await begin(page).click();
  await expect(close(page)).toBeVisible();
}
async function choose(page: Page, task: Task, direction: '上移' | '下移', keyboard = false) {
  const action = step(page, task, direction);
  await expect(action).toBeEnabled();
  if (keyboard) await action.focus();
  return action;
}
async function move(
  page: Page,
  f: Fixture,
  task: Task,
  direction: '上移' | '下移',
  keyboard = false,
) {
  const action = await choose(page, task, direction, keyboard);
  const ack = page.waitForResponse(
    (response) =>
      response.url() === `${f.url()}/move` &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  const ready = page.waitForResponse(
    (response) =>
      response.url() === f.url() &&
      response.request().method() === 'GET' &&
      response.status() === 200,
  );
  if (keyboard) await action.press('Enter');
  else await action.click();
  const result = (await (await ack).json()) as ProjectTaskMoveReceipt;
  await ready;
  await expect(menu(page, task)).toBeEnabled();
  expect(result).toMatchObject({ projectId: f.project.id, taskId: task.id, changed: true });
  expect(Object.keys(result).sort()).toEqual([
    'anchorTaskId',
    'baseline',
    'changed',
    'placement',
    'projectId',
    'revision',
    'taskId',
  ]);
  return result;
}
async function doubleActivate(control: Locator) {
  await control.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
}
function failure(route: Route) {
  return route.fulfill({
    status: 500,
    json: { error: { code: 'INTERNAL_ERROR', message: '测试：排序暂时读取失败。' } },
  });
}
async function screenshot(
  page: Page,
  target: Locator,
  content: Locator,
  filename: string,
  mobile = false,
) {
  await mkdir('artifacts', { recursive: true });
  await prepareScreenshot(page, target, content);
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 32);
  await page.screenshot({ path: `artifacts/${filename}` });
}

function moved(ids: string[], task: Task, anchor: Task, placement: 'before' | 'after') {
  const next = ids.filter((id) => id !== task.id);
  next.splice(next.indexOf(anchor.id) + (placement === 'after' ? 1 : 0), 0, task.id);
  return next;
}
async function selectMove(page: Page, task: Task, anchor: Task, placement: 'before' | 'after') {
  await menu(page, task).click();
  await selection(page).getByLabel('移动到任务', { exact: true }).selectOption(anchor.id);
  await selection(page).getByLabel('相对位置', { exact: true }).selectOption(placement);
  return selection(page).getByRole('button', { name: '应用移动', exact: true });
}
async function refreshOrder(page: Page, f: Fixture) {
  const ready = page.waitForResponse(
    (response) =>
      response.url() === f.url() &&
      response.request().method() === 'GET' &&
      response.status() === 200,
  );
  await refresh(page).click();
  await ready;
}
async function expectSelections(page: Page, f: Fixture) {
  await expect(statusFilter(page)).toHaveValue('todo');
  await expect(attentionFilter(page)).toHaveValue('present');
  await expect(ownerFilter(page)).toHaveValue(f.owner.user.id);
  await expect(participantFilter(page)).toHaveValue(f.owner.user.id);
  await expect(searchFilter(page)).toHaveValue('alpha');
}
async function filterMatches(page: Page, f: Fixture) {
  await statusFilter(page).selectOption('todo');
  await attentionFilter(page).selectOption('present');
  await ownerFilter(page).selectOption(f.owner.user.id);
  await participantFilter(page).selectOption(f.owner.user.id);
  await searchFilter(page).fill('alpha');
  await expectSelections(page, f);
  await expectIds(listLinks(page), [f.c, f.b, f.a]);
}
async function navigateProject(page: Page, project: Project) {
  const link = page.locator(`a.context-link[href="/projects/${project.id}"]`);
  if (!(await link.isVisible()))
    await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
  await link.click();
  await expect(page).toHaveURL(`${origin}/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
}

// Before first CI: 251 desktop list with saved order, controls, count and notice;
// 252 light mobile controls with actual visibility, hit target and width checks;
// 253 board after a genuine same-column drag. Scroll the subject rather than
// requiring distant page header/footer content to share the viewport.

test('项目排序通过键盘和菜单真实保存，刷新及列表看板一致，原正文保持不变', async ({
  page,
  ordering: f,
}) => {
  await f.open();
  await filterMatches(page, f);
  await activate(page);
  const first = await move(page, f, f.a, '上移', true);
  await expect(step(page, f.a, '上移')).toBeFocused();
  const afterKeyboard = moved(f.initial.taskIds, f.a, f.b, 'before');
  expect(await f.order()).toMatchObject({ revision: 2, taskIds: afterKeyboard });
  expect(first).toMatchObject({ anchorTaskId: f.b.id, placement: 'before', revision: 2 });
  await expectIds(listLinks(page), [f.c, f.a, f.b]);

  const apply = await selectMove(page, f.b, f.c, 'before');
  const captured = deferred();
  const release = deferred();
  const capture = await routeFixture(
    page,
    f,
    `${f.url()}/move`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    release.resolve,
  );
  const accepted = page.waitForResponse(
    (response) => response.url() === `${f.url()}/move` && response.status() === 200,
  );
  const ready = page.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 200,
  );
  await apply.click();
  await captured.promise;
  await ownerFilter(page).focus();
  await expect(ownerFilter(page)).toBeFocused();
  release.resolve();
  await accepted;
  await ready;
  const afterMenu = moved(afterKeyboard, f.b, f.c, 'before');
  expect(await f.order()).toMatchObject({ revision: 3, taskIds: afterMenu });
  await expectIds(listLinks(page), [f.b, f.c, f.a]);
  await expect(page.locator('.project-toolbar')).toContainText('3 项任务');
  await expect(
    panel(page).getByText('排序已保存，已读取当前顺序。', { exact: true }),
  ).toBeVisible();
  // Finishing a move may restore a blurred action, but must not steal focus
  // after the user has deliberately focused another control in this view.
  await expect(ownerFilter(page)).toBeFocused();
  await capture.dispose(false);
  await page.locator('.project-toolbar').scrollIntoViewIfNeeded();
  await screenshot(
    page,
    menu(page, f.b),
    page.locator('.work-task-list'),
    '251-project-task-order-list-dark.png',
  );
  await expect(
    page.locator('.project-toolbar').getByText('3 项任务', { exact: true }),
  ).toBeInViewport();
  await expect(
    panel(page).getByText('排序已保存，已读取当前顺序。', { exact: true }),
  ).toBeInViewport();

  await page.reload();
  await expectIds(listLinks(page), [f.b, f.c, f.a]);
  await expectSelections(page, f);
  await expect(begin(page)).toBeEnabled();
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), [f.b, f.c, f.a]);
  for (const task of [f.a, f.b, f.c]) {
    await expect(page.getByLabel(`${task.shortId} 状态`, { exact: true })).toBeEnabled();
    await expect(card(page, task).getByRole('link')).toHaveAttribute('href', `/tasks/${task.id}`);
  }
  await card(page, f.a).getByRole('link').click();
  await expect(page).toHaveURL(`${origin}/tasks/${f.a.id}`);
  expect(f.writes).toHaveLength(2);
  await f.unchanged();
});

test('筛选后的移动保留隐藏项相对顺序，关闭和切视图保留选择，取消列只读', async ({
  page,
  ordering: f,
}) => {
  await f.open(page, 'view=list&keep=stable#order-anchor');
  await filterMatches(page, f);
  await activate(page);
  await move(page, f, f.a, '上移');
  const after = moved(f.initial.taskIds, f.a, f.b, 'before');
  const visible = new Set([f.a.id, f.b.id, f.c.id]);
  expect((await f.order()).taskIds).toEqual(after);
  expect(after.filter((id) => !visible.has(id))).toEqual(
    f.initial.taskIds.filter((id) => !visible.has(id)),
  );
  await close(page).click();
  await expectIds(listLinks(page), [f.c, f.a, f.b]);
  await expect(page.locator('.work-task-list > .work-task-row')).toHaveCount(3);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expectIds(boardLinks(page), [f.c, f.a, f.b]);
  await expectSelections(page, f);
  expect(new URL(page.url()).searchParams.get('keep')).toBe('stable');
  expect(new URL(page.url()).hash).toBe('#order-anchor');
  await page.reload();
  await expectIds(boardLinks(page), [f.c, f.a, f.b]);
  await expectSelections(page, f);

  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await statusFilter(page).selectOption('cancelled');
  await expectIds(boardLinks(page), [f.cancelled]);
  await activate(page);
  await expect(menu(page, f.cancelled)).toHaveCount(0);
  await expect(handle(page, f.cancelled)).toHaveCount(0);
  await expect(page.getByLabel(`${f.cancelled.shortId} 状态`, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expectIds(listLinks(page), [f.cancelled]);
  await expect(menu(page, f.cancelled)).toHaveCount(0);
  await listLinks(page).click();
  await expect(page).toHaveURL(`${origin}/tasks/${f.cancelled.id}`);
  expect(f.writes).toHaveLength(1);
  await f.unchanged();
});

test('看板真实拖动只在同列保存，跨列不写状态，移动后的控制可见可用', async ({
  page,
  ordering: f,
}) => {
  await f.open(page, '');
  await activate(page);
  await expect(handle(page, f.a)).toHaveAttribute('draggable', 'true');
  await handle(page, f.a).dragTo(card(page, f.progress), { targetPosition: { x: 30, y: 12 } });
  expect(f.writes).toEqual([]);
  expect(await f.order()).toEqual(f.initial);
  const accepted = page.waitForResponse(
    (response) => response.url() === `${f.url()}/move` && response.status() === 200,
  );
  const ready = page.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 200,
  );
  await handle(page, f.a).dragTo(card(page, f.c), { targetPosition: { x: 30, y: 12 } });
  const receipt = (await (await accepted).json()) as ProjectTaskMoveReceipt;
  await ready;
  expect(receipt).toMatchObject({
    taskId: f.a.id,
    anchorTaskId: f.c.id,
    placement: 'before',
    changed: true,
  });
  expect((await f.order()).taskIds).toEqual(moved(f.initial.taskIds, f.a, f.c, 'before'));
  await statusFilter(page).selectOption('todo');
  await searchFilter(page).fill('alpha');
  await expectIds(boardLinks(page), [f.a, f.c, f.b]);
  await screenshot(
    page,
    handle(page, f.a),
    page.locator('.project-board'),
    '253-project-task-order-board-dark.png',
  );
  expect(f.writes).toHaveLength(1);
  await f.unchanged();
});

test('同一当前负责人双页竞争返回真实409，显示刷新后的顺序再明确重新移动', async ({
  page,
  context,
  ordering: f,
}) => {
  const second = await context.newPage();
  await f.prepare(second);
  await f.open(page, 'view=list&status=todo&q=alpha');
  await f.open(second, 'view=list&status=todo&q=alpha');
  await expectIds(listLinks(page), [f.c, f.b, f.a]);
  await expectIds(listLinks(second), [f.c, f.b, f.a]);
  await activate(page);
  await activate(second);
  const intercepted = deferred();
  const release = deferred();
  let held = false;
  const capture = await routeFixture(
    second,
    f,
    `${f.url()}/move`,
    async (route) => {
      if (!held) {
        held = true;
        intercepted.resolve();
        await release.promise;
      }
      await route.continue();
    },
    release.resolve,
  );
  await step(second, f.a, '上移').click();
  await intercepted.promise;
  expect(f.writes).toHaveLength(1);
  const stale = f.writes[0]!;
  expect(JSON.parse(stale.body!) as ProjectTaskMove).toMatchObject({
    expectedRevision: 1,
    expectedBaseline: f.initial.baseline,
    taskId: f.a.id,
    anchorTaskId: f.b.id,
  });
  await move(page, f, f.b, '上移');
  const firstSaved = moved(f.initial.taskIds, f.b, f.c, 'before');
  const conflict = second.waitForResponse(
    (response) => response.url() === `${f.url()}/move` && response.status() === 409,
  );
  const refreshed = second.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 200,
  );
  release.resolve();
  await conflict;
  await refreshed;
  await expect(panel(second)).toContainText('排序已被其他操作改变。本次未应用');
  expect((await f.order()).taskIds).toEqual(firstSaved);
  expect(f.writes).toHaveLength(2);
  await expectIds(listLinks(second), [f.b, f.c, f.a]);
  await move(second, f, f.a, '上移');
  expect((await f.order()).taskIds).toEqual(moved(firstSaved, f.a, f.c, 'before'));
  expect(f.writes).toHaveLength(3);
  expect(f.writes[2]!.key).not.toBe(stale.key);
  expect(JSON.parse(f.writes[2]!.body!)).toMatchObject({
    expectedRevision: 2,
    taskId: f.a.id,
    anchorTaskId: f.c.id,
  });
  await capture.dispose(false);
  await f.unchanged();
});

for (const committed of [false, true]) {
  test(`普通${committed ? '提交后回包丢失' : '连接失败未达服务'}保留原键原包，重复点击关闭和筛选不绕过待确认请求`, async ({
    page,
    ordering: f,
  }) => {
    await f.open(page, 'view=list&status=todo&q=alpha');
    await activate(page);
    let attempts = 0;
    const capture = await routeFixture(page, f, `${f.url()}/move`, async (route) => {
      ++attempts;
      if (attempts === 1) {
        if (committed) {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
        }
        await route.abort('connectionfailed');
      } else await route.continue();
    });
    await doubleActivate(step(page, f.a, '上移'));
    await expect(recover(page)).toBeEnabled();
    expect(f.writes).toHaveLength(1);
    const original = f.writes[0]!;
    const body: ProjectTaskMove = {
      taskId: f.a.id,
      anchorTaskId: f.b.id,
      placement: 'before',
      expectedRevision: 1,
      expectedBaseline: f.initial.baseline,
    };
    expect(JSON.parse(original.body!)).toEqual(body);
    expect(original.key).toMatch(/^[\w.:-]+$/);
    expect((await f.order()).revision).toBe(committed ? 2 : 1);
    await expect(step(page, f.b, '上移')).toBeDisabled();
    await close(page).click();
    await expect(recover(page)).toHaveCount(0);
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await attentionFilter(page).selectOption('present');
    await searchFilter(page).fill('核对');
    await activate(page);
    await expect(recover(page)).toBeEnabled();
    await expect(panel(page)).toContainText(f.a.title);
    await expect(panel(page)).toContainText(f.b.title);
    await expect(menu(page, f.c)).toBeDisabled();
    const ack = page.waitForResponse(
      (response) => response.url() === `${f.url()}/move` && response.status() === 200,
    );
    const ready = page.waitForResponse(
      (response) => response.url() === f.url() && response.status() === 200,
    );
    await doubleActivate(recover(page));
    await ack;
    await ready;
    await expect(recover(page)).toHaveCount(0);
    await expectIds(boardLinks(page), [f.c, f.a, f.b]);
    expect(f.writes).toEqual([original, original]);
    expect(await f.order()).toMatchObject({
      revision: 2,
      taskIds: moved(f.initial.taskIds, f.a, f.b, 'before'),
    });
    expect(attempts).toBe(2);
    await capture.dispose(false);
    await f.unchanged();
  });
}

test('移动ACK后的读取500只重新GET，关闭切视图后仍不再次POST', async ({ page, ordering: f }) => {
  await f.open(page, 'view=list&status=todo&q=alpha');
  await activate(page);
  let reads = 0;
  let failReads = true;
  const capture = await routeFixture(page, f, f.url(), async (route) => {
    expect(route.request().method()).toBe('GET');
    ++reads;
    if (failReads) await failure(route);
    else await route.continue();
  });
  const ack = page.waitForResponse(
    (response) => response.url() === `${f.url()}/move` && response.status() === 200,
  );
  await step(page, f.a, '上移').click();
  await ack;
  await expect(refresh(page)).toBeEnabled();
  await expect(panel(page)).toContainText('上次排序已保存');
  await expect(recover(page)).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
  await close(page).click();
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await attentionFilter(page).selectOption('present');
  await activate(page);
  await expect(refresh(page)).toBeEnabled();
  await expect(panel(page)).toContainText(f.a.title);
  failReads = false;
  await refreshOrder(page, f);
  await expect(refresh(page)).toHaveCount(0);
  await expectIds(boardLinks(page), [f.c, f.a, f.b]);
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(f.writes).toHaveLength(1);
  expect(await f.order()).toMatchObject({
    revision: 2,
    taskIds: moved(f.initial.taskIds, f.a, f.b, 'before'),
  });
  await capture.dispose(false);
  await f.unchanged();
});

for (const status of [200, 500]) {
  test(`离开项目后迟到的排序读取${status}不替换另一项目当前内容`, async ({ page, ordering: f }) => {
    await f.open(page, 'view=list&status=todo&q=alpha');
    const captured = deferred();
    const release = deferred();
    let capturedReads = 0;
    const capture = await routeFixture(
      page,
      f,
      f.url(),
      async (route) => {
        // Own the entire capture phase so a second refresh cannot silently make
        // the intended held read cease being the current old-project request.
        ++capturedReads;
        const response = status === 200 ? await route.fetch() : null;
        if (response) expect(response.status()).toBe(200);
        captured.resolve();
        await release.promise;
        if (response) await route.fulfill({ response });
        else await failure(route);
      },
      release.resolve,
    );
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await captured.promise;
    const ready = page.waitForResponse(
      (response) => response.url() === f.url(f.otherProject.id) && response.status() === 200,
    );
    await navigateProject(page, f.otherProject);
    await ready;
    await expectIds(boardLinks(page), [f.otherTask]);
    const late = page.waitForResponse(
      (response) => response.url() === f.url() && response.status() === status,
    );
    release.resolve();
    await late;
    await capture.dispose(false);
    expect(capturedReads).toBeGreaterThanOrEqual(1);
    await expectIds(boardLinks(page), [f.otherTask]);
    await expect(panel(page)).not.toContainText('读取任务顺序失败');
    await expect(panel(page)).not.toContainText(f.a.title);
    await expect(begin(page)).toBeEnabled();
    expect(await f.order(f.otherProject.id)).toMatchObject({
      revision: 1,
      taskIds: [f.otherTask.id],
    });
    expect(await f.order()).toEqual(f.initial);
    expect(f.writes).toEqual([]);
    await f.unchanged();
  });

  test(`离开项目后迟到的移动${status}不污染另一项目，返回时只显示该项目真实顺序`, async ({
    page,
    ordering: f,
  }) => {
    await f.open(page, 'view=list&status=todo&q=alpha');
    await activate(page);
    const captured = deferred();
    const release = deferred();
    const capture = await routeFixture(
      page,
      f,
      `${f.url()}/move`,
      async (route) => {
        const response = status === 200 ? await route.fetch() : null;
        if (response) expect(response.status()).toBe(200);
        captured.resolve();
        await release.promise;
        if (response) await route.fulfill({ response });
        else await failure(route);
      },
      release.resolve,
    );
    await step(page, f.a, '上移').click();
    await captured.promise;
    const ready = page.waitForResponse(
      (response) => response.url() === f.url(f.otherProject.id) && response.status() === 200,
    );
    await navigateProject(page, f.otherProject);
    await ready;
    await expectIds(boardLinks(page), [f.otherTask]);
    const late = page.waitForResponse(
      (response) => response.url() === `${f.url()}/move` && response.status() === status,
    );
    release.resolve();
    await late;
    await capture.dispose(false);
    await activate(page);
    await expectIds(boardLinks(page), [f.otherTask]);
    await expect(recover(page)).toHaveCount(0);
    await expect(refresh(page)).toHaveCount(0);
    await expect(panel(page)).not.toContainText(f.a.title);
    expect(await f.order(f.otherProject.id)).toMatchObject({
      revision: 1,
      taskIds: [f.otherTask.id],
    });
    const backReady = page.waitForResponse(
      (response) => response.url() === f.url() && response.status() === 200,
    );
    await navigateProject(page, f.project);
    await backReady;
    await statusFilter(page).selectOption('todo');
    await searchFilter(page).fill('alpha');
    await expectIds(boardLinks(page), status === 200 ? [f.c, f.a, f.b] : [f.c, f.b, f.a]);
    await activate(page);
    await expect(recover(page)).toHaveCount(0);
    expect(f.writes).toHaveLength(1);
    expect((await f.order()).revision).toBe(status === 200 ? 2 : 1);
    await f.unchanged();
  });
}

test('窄屏排序控件与菜单有可点击的44像素目标且内容不溢出', async ({ page, ordering: f }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('hexu-theme', 'light'));
  await f.open(page, 'view=list&status=todo&q=alpha');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await activate(page);
  await move(page, f, f.a, '上移', true);
  await expectIds(listLinks(page), [f.c, f.a, f.b]);
  const target = menu(page, f.a);
  const row = page.locator(`.project-task-order-row[data-task-id="${f.a.id}"]`);
  for (const action of [
    handle(page, f.a),
    step(page, f.a, '上移'),
    step(page, f.a, '下移'),
    target,
  ]) {
    await prepareScreenshot(page, action, row);
    const box = (await action.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await screenshot(page, target, row, '252-project-task-order-mobile-light.png', true);
  const apply = await selectMove(page, f.a, f.b, 'after');
  await prepareScreenshot(page, apply, selection(page));
  expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await selection(page).getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(target).toBeFocused();
  await expectIds(listLinks(page), [f.c, f.a, f.b]);
  expect(f.writes).toHaveLength(1);
  await f.unchanged();
});

test('同集合后台读取500保留行和菜单选择，明确重读后旧菜单基线仍真实冲突', async ({
  page,
  ordering: f,
}) => {
  await f.open(page, 'view=list&status=todo&q=alpha');
  await expect(page.locator('.workbench-connection')).toContainText('事件已连接');
  await activate(page);
  const apply = await selectMove(page, f.a, f.b, 'before');
  const placement = selection(page).getByLabel('相对位置', { exact: true });
  await placement.focus();
  const captured = deferred();
  const release = deferred();
  const capture = await routeFixture(
    page,
    f,
    f.url(),
    async (route) => {
      captured.resolve();
      await release.promise;
      await failure(route);
    },
    release.resolve,
  );
  const external = await f.post<ProjectTaskMoveReceipt>(`${f.path()}/move`, {
    taskId: f.b.id,
    anchorTaskId: f.c.id,
    placement: 'before',
    expectedRevision: f.initial.revision,
    expectedBaseline: f.initial.baseline,
  });
  expect(external.revision).toBe(2);
  await captured.promise;
  await expectIds(listLinks(page), [f.c, f.b, f.a]);
  await expect(selection(page)).toBeVisible();
  await expect(placement).toBeFocused();
  const failed = page.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 500,
  );
  release.resolve();
  await failed;
  await expect(panel(page)).toContainText('读取任务顺序失败');
  await expectIds(listLinks(page), [f.c, f.b, f.a]);
  await expect(selection(page).getByLabel('移动到任务', { exact: true })).toHaveValue(f.b.id);
  await expect(selection(page).getByLabel('移动到任务', { exact: true })).toBeEnabled();
  await expect(placement).toHaveValue('before');
  await expect(placement).toBeEnabled();
  await expect(placement).toBeFocused();
  await expect(apply).toBeDisabled();
  expect(f.writes).toEqual([]);
  await capture.dispose(false);
  const ready = page.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 200,
  );
  const retry = panel(page).getByRole('button', { name: '重试读取顺序', exact: true });
  await retry.focus();
  await retry.press('Enter');
  await ready;
  await expectIds(listLinks(page), [f.b, f.c, f.a]);
  await expect(apply).toBeEnabled();
  const conflict = page.waitForResponse(
    (response) => response.url() === `${f.url()}/move` && response.status() === 409,
  );
  const latest = page.waitForResponse(
    (response) => response.url() === f.url() && response.status() === 200,
  );
  await apply.click();
  await conflict;
  await latest;
  await expect(panel(page)).toContainText('排序已被其他操作改变。本次未应用');
  expect(f.writes).toHaveLength(1);
  expect(JSON.parse(f.writes[0]!.body!)).toMatchObject({
    expectedRevision: 1,
    expectedBaseline: f.initial.baseline,
    taskId: f.a.id,
    anchorTaskId: f.b.id,
  });
  expect((await f.order()).revision).toBe(2);
  await move(page, f, f.a, '上移');
  await expectIds(listLinks(page), [f.b, f.a, f.c]);
  expect(JSON.parse(f.writes[1]!.body!)).toMatchObject({
    expectedRevision: 2,
    taskId: f.a.id,
    anchorTaskId: f.c.id,
  });
  await f.unchanged();
});

for (const status of [200, 500]) {
  test(`关闭再打开后旧已接受请求的读取${status}不覆盖新的排序或恢复提示`, async ({
    page,
    ordering: f,
  }) => {
    await f.open(page, 'view=list&status=todo&q=alpha');
    await expect(page.locator('.workbench-connection')).toContainText('事件已连接');
    await activate(page);
    const captured = deferred();
    const release = deferred();
    let hold = true;
    const capturedRevisions: number[] = [];
    const capture = await routeFixture(
      page,
      f,
      f.url(),
      async (route) => {
        if (!hold) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const revision = ((await response.json()) as ProjectTaskOrder).revision;
        capturedRevisions.push(revision);
        if (revision === 2) captured.resolve();
        await release.promise;
        if (status === 200) await route.fulfill({ response });
        else await failure(route);
      },
      release.resolve,
    );
    const accepted = page.waitForResponse(
      (response) => response.url() === `${f.url()}/move` && response.status() === 200,
    );
    await step(page, f.a, '上移').click();
    await accepted;
    await captured.promise;
    await expect(panel(page)).toContainText('上次排序已保存');
    const second = await f.order();
    expect(second.revision).toBe(2);
    // Hold the entire old interaction, including a refresh caused by the
    // ordinary second move. Only after close may fresh reads complete.
    const external = await f.post<ProjectTaskMoveReceipt>(`${f.path()}/move`, {
      taskId: f.c.id,
      anchorTaskId: f.b.id,
      placement: 'after',
      expectedRevision: second.revision,
      expectedBaseline: second.baseline,
    });
    expect(external.revision).toBe(3);
    await close(page).click();
    hold = false;
    const current = page.waitForResponse(
      async (response) =>
        response.url() === f.url() &&
        response.status() === 200 &&
        ((await response.json()) as ProjectTaskOrder).revision === 3,
    );
    await activate(page);
    await current;
    await expectIds(listLinks(page), [f.a, f.b, f.c]);
    await expect(panel(page)).toContainText('排序修订 3');
    await expect(recover(page)).toHaveCount(0);
    await expect(refresh(page)).toHaveCount(0);
    const late = page.waitForResponse(
      (response) => response.url() === f.url() && response.status() === status,
    );
    release.resolve();
    await late;
    await capture.dispose(false);
    expect(capturedRevisions).toContain(2);
    expect(capturedRevisions.every((revision) => revision === 2 || revision === 3)).toBe(true);
    await expectIds(listLinks(page), [f.a, f.b, f.c]);
    await expect(panel(page)).toContainText('排序修订 3');
    await expect(panel(page)).not.toContainText('读取任务顺序失败');
    await expect(recover(page)).toHaveCount(0);
    await expect(refresh(page)).toHaveCount(0);
    await expect(menu(page, f.a)).toBeEnabled();
    expect(f.writes).toHaveLength(1);
    expect((await f.order()).revision).toBe(3);
    await f.unchanged();
  });
}
