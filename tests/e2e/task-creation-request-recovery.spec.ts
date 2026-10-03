import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { teamFixture, PASSWORD, type Account } from '../helpers/team.js';
import { prepareScreenshot } from '../helpers/task-reliability.js';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';

const origin = 'http://127.0.0.1:4344';
type Scope = 'private' | 'project';
type Entry = 'workbench' | 'project' | 'command';
type Packet = { path: string; body: string | null; key: string };
type Payload = { title: string; description: string; projectId: string | null };
type Disposable = { dispose(failed: boolean): Promise<void> };
const fresh = (page: Page) => page.getByRole('dialog', { name: '开始一项工作', exact: true });
const recovery = (page: Page) => page.getByRole('dialog', { name: '确认任务创建', exact: true });
const pending = (page: Page) => recovery(page).getByLabel('任务创建请求待确认', { exact: true });
const accepted = (page: Page) => recovery(page).getByLabel('任务创建请求已确认', { exact: true });
const recover = (page: Page) =>
  recovery(page).getByRole('button', { name: '确认原创建结果', exact: true });
const refresh = (page: Page) =>
  recovery(page).getByRole('button', { name: '刷新已创建任务', exact: true });
const dismiss = (page: Page) =>
  recovery(page).getByRole('button', { name: '暂时关闭', exact: true });
const submit = (page: Page) => fresh(page).getByRole('button', { name: '创建任务', exact: true });
const contentEditor = (page: Page) =>
  page.getByRole('dialog', { name: '编辑工作说明', exact: true });
const workbench = `${origin}/api/v1/workbench`;
const packet = (request: Request): Packet => ({
  path: new URL(request.url()).pathname,
  body: request.postData(),
  key: request.headers()['idempotency-key'] ?? '',
});

async function fixture() {
  const api = await teamFixture(origin);
  try {
    // Real accounts and ordinary Task HTTP only; no execution or model fixtures.
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, project.id, '另一项工作的说明')) as Task;
    const response = await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    expect(response.statusCode, response.body).toBe(200);
    return { api, alice, bob, project, task, close: api.close };
  } catch (error) {
    try {
      await api.close();
    } catch (cause) {
      reportCleanup([cause], true);
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const endpoint = (f: Fixture) => `${origin}/api/v1/spaces/${f.bob.spaceId}/tasks`;
const payload = (f: Fixture, scope: Scope): Payload => ({
  title: `  ${scope === 'private' ? '个人' : '项目'}任务的原始标题  `,
  description: '  第一段说明\n保留正文中的换行与 “引号”  ',
  projectId: scope === 'project' ? f.project.id : null,
});
function effects(f: Fixture) {
  return {
    tasks: f.api.store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(),
    counter: f.api.store.db
      .prepare("SELECT value FROM metadata WHERE key='task_counter'")
      .get() as { value: string },
    events: f.api.store.db
      .prepare("SELECT * FROM outbox WHERE kind='task.created' ORDER BY sequence")
      .all(),
    receipts: f.api.store.db
      .prepare('SELECT * FROM idempotency_records WHERE scope=? ORDER BY rowid')
      .all(`${f.bob.user.id}:${f.bob.spaceId}:task.create`) as { key: string; result: string }[],
  };
}
async function oneCreation(
  f: Fixture,
  before: ReturnType<typeof effects>,
  original: Packet,
  body: Payload,
) {
  await expect.poll(() => effects(f).receipts.length).toBe(before.receipts.length + 1);
  const after = effects(f);
  expect(after.tasks).toHaveLength(before.tasks.length + 1);
  expect(after.tasks.slice(0, -1)).toEqual(before.tasks);
  expect(Number(after.counter.value)).toBe(Number(before.counter.value) + 1);
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(after.events.slice(0, -1)).toEqual(before.events);
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.receipts.slice(0, -1)).toEqual(before.receipts);
  const receipt = after.receipts.at(-1)!;
  expect(receipt.key).toBe(original.key);
  const task = JSON.parse(receipt.result) as Task;
  expect(task).toMatchObject({
    title: body.title.trim(),
    description: body.description.trim(),
    projectId: body.projectId,
    spaceId: f.bob.spaceId,
    visibility: body.projectId ? 'project' : 'private',
    ownerUserId: f.bob.user.id,
    createdByUserId: f.bob.user.id,
    status: 'todo',
    attention: null,
    revision: 1,
  });
  expect(after.tasks.at(-1)).toMatchObject({ id: task.id, body: receipt.result });
  expect(after.events.at(-1)).toMatchObject({ kind: 'task.created', task_id: task.id });
  expect(
    f.api.store.as({ user: f.bob.user, spaceId: f.bob.spaceId }, () => f.api.store.runs(task.id)),
  ).toEqual([]);
  return task;
}
function writes(page: Page, f: Fixture) {
  const records: Packet[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === endpoint(f)) records.push(packet(request));
  });
  return records;
}
function originalPacket(records: Packet[], f: Fixture, body: Payload) {
  expect(records).toHaveLength(1);
  expect(records[0]!.path).toBe(`/api/v1/spaces/${f.bob.spaceId}/tasks`);
  expect(records[0]!.key).toMatch(/^[\w.:-]+$/);
  // The browser freezes the submitted text; normalization belongs to the server.
  expect(JSON.parse(records[0]!.body!)).toEqual(body);
}
async function install(page: Page, account: Account) {
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
      const i = cookie.indexOf('=');
      return {
        name: cookie.slice(0, i),
        value: cookie.slice(i + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
}
async function open(
  page: Page,
  f: Fixture,
  options: { theme?: 'dark' | 'light'; live?: boolean } = {},
) {
  const theme = options.theme ?? 'dark';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4344, host: '127.0.0.1' });
  await install(page, f.bob);
  const cursor = (
    f.api.store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM outbox').get() as {
      value: number;
    }
  ).value;
  await page.addInitScript(
    ({ userId, spaceId, theme, cursor, live }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
      if (!live) {
        // Stable request-boundary scenarios start after fixture setup events. The
        // stream remains real; dedicated revocation tests use the native constructor.
        const NativeEventSource = window.EventSource;
        const streams: EventSource[] = [];
        Object.defineProperty(window, '__taskCreationStreams', { value: streams });
        window.EventSource = class extends NativeEventSource {
          constructor(url: string | URL, options?: EventSourceInit) {
            const target = new URL(url, location.href);
            target.searchParams.set('after', String(cursor));
            super(target, options);
            streams.push(this);
          }
        };
      }
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, theme, cursor, live: options.live ?? false },
  );
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('.workbench-connection')).toContainText('事件已连接');
  if (options.live) await observePatch(page, f, '已确认实时事件连接的工作说明');
}
async function stopEventsForHttpBoundary(page: Page) {
  // These controls isolate actual HTTP authority failures from the independent
  // SSE invalidation path. Dedicated live-SSE tests never call this helper.
  await page.evaluate(() => {
    for (const stream of (window as unknown as { __taskCreationStreams: EventSource[] })
      .__taskCreationStreams)
      stream.close();
  });
}
async function navigate(page: Page, f: Fixture, target: 'workbench' | 'project' | 'task') {
  if (target === 'workbench') {
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '工作台', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
    return;
  }
  if (await page.getByRole('button', { name: '展开项目导航', exact: true }).count())
    await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
  await page
    .locator(
      target === 'project'
        ? `a.context-link[href="/projects/${f.project.id}"]`
        : `a.context-task[href="/tasks/${f.task.id}"]`,
    )
    .click();
  await expect(page).toHaveURL(
    `${origin}/${target === 'project' ? 'projects/' + f.project.id : 'tasks/' + f.task.id}`,
  );
}
async function entry(page: Page, f: Fixture, from: Entry) {
  if (from === 'command') {
    await page.getByRole('button', { name: '打开命令面板', exact: true }).click();
    await page
      .getByRole('dialog', { name: '搜索与快捷操作', exact: true })
      .getByRole('button', { name: '新建任务', exact: true })
      .click();
  } else {
    await navigate(page, f, from);
    await page
      .locator('.work-page-heading')
      .getByRole('button', { name: '新建任务', exact: true })
      .click();
  }
}
async function fill(page: Page, body: Payload) {
  await expect(fresh(page)).toBeVisible();
  await fresh(page).getByLabel('要做什么', { exact: true }).fill(body.title);
  await fresh(page)
    .getByRole('combobox', { name: '放在哪里', exact: true })
    .selectOption(body.projectId ?? '');
  await fresh(page).getByLabel('补充说明').fill(body.description);
}
async function locked(page: Page, body: Payload) {
  for (const [name, value] of [
    ['要做什么', body.title],
    ['补充说明', body.description],
  ]) {
    const field = recovery(page).getByLabel(name!);
    await expect(field).toBeDisabled();
    await expect(field).toHaveValue(value!);
  }
  const project = recovery(page).getByRole('combobox', { name: '放在哪里', exact: true });
  await expect(project).toBeDisabled();
  await expect(project).toHaveValue(body.projectId ?? '');
  await expect(fresh(page)).toHaveCount(0);
  await expect(recovery(page).getByRole('button', { name: '创建任务', exact: true })).toHaveCount(
    0,
  );
}
async function twice(button: ReturnType<Page['getByRole']>) {
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
}
async function makeUnknown(page: Page, f: Fixture, body: Payload, from: Entry = 'workbench') {
  const abort = (route: Route) => route.abort('failed');
  await page.route(endpoint(f), abort);
  await entry(page, f, from);
  await fill(page, body);
  await twice(submit(page));
  await expect(pending(page)).toBeVisible();
  await expect(recover(page)).toBeEnabled();
  await locked(page, body);
  // On failure, run() owns route cleanup and preserves the primary test error.
  await page.unroute(endpoint(f), abort);
}
async function role(f: Fixture, value: 'edit' | 'view' | null) {
  const response = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
    role: value,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function patch(f: Fixture, title: string) {
  const current = f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
    f.api.store.getTask(f.task.id),
  );
  const response = await f.api.call(
    `tasks/${f.task.id}`,
    f.alice,
    { expectedRevision: current.revision, title },
    randomUUID(),
    'PATCH',
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function observePatch(page: Page, f: Fixture, title: string) {
  const observed = page.waitForResponse(async (response) => {
    if (response.url() !== workbench || response.status() !== 200) return false;
    const body = (await response.json()) as Workbench;
    return body.tasks.some((task) => task.id === f.task.id && task.title === title);
  });
  await patch(f, title);
  await (await observed).finished();
  await expect(page.locator(`a.context-task[href="/tasks/${f.task.id}"] strong`)).toHaveText(title);
}
function reportCleanup(errors: unknown[], failed: boolean) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, '普通任务创建恢复夹具清理失败');
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function hold(
  page: Page,
  pattern: string,
  options: { beforeFetch?: boolean; loseResponse?: boolean; denyRead?: boolean } = {},
) {
  const requestGate = gate(),
    responseGate = gate();
  if (!options.beforeFetch) requestGate.resolve();
  let capturing = true;
  const captured: (Packet & { status?: number; result?: unknown })[] = [];
  const work: Promise<void>[] = [],
    errors: unknown[] = [];
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '延迟创建请求失败');
  };
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    const record: (typeof captured)[number] = packet(route.request());
    captured.push(record);
    // Observe rejection immediately. Cleanup drains every captured request before
    // removing routes, closing the browser context, or closing the real service.
    const pending = (async () => {
      const headers = await route.request().allHeaders();
      await requestGate.promise;
      // Keep the original principal/space even when the browser signs into a
      // different account before this held request reaches the real service.
      const response = await route.fetch({ headers });
      record.status = response.status();
      record.result = await response.json();
      await responseGate.promise;
      if (options.loseResponse) await route.abort('failed');
      else if (options.denyRead)
        await route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: '工作台访问已被拒绝' } },
        });
      else await route.fulfill({ response });
    })().catch((error) => {
      errors.push(error);
    });
    work.push(pending);
    await pending;
  };
  await page.route(pattern, handler);
  return {
    captured,
    async reached(status?: number) {
      await expect
        .poll(() => {
          check();
          return status === undefined
            ? captured.length
            : captured.filter((item) => item.status === status).length;
        })
        .toBeGreaterThan(0);
    },
    stopCapture() {
      capturing = false;
    },
    releaseRequest() {
      requestGate.resolve();
    },
    async releaseAndDrain() {
      capturing = false;
      requestGate.resolve();
      responseGate.resolve();
      await Promise.all(work);
      check();
    },
    async dispose(failed: boolean) {
      const cleanup: unknown[] = [];
      try {
        await this.releaseAndDrain();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await page.unroute(pattern, handler);
      } catch (error) {
        cleanup.push(error);
      }
      reportCleanup(cleanup, failed);
    },
  };
}
async function run(page: Page, body: (f: Fixture, owned: Disposable[]) => Promise<void>) {
  const f = await fixture(),
    owned: Disposable[] = [];
  let failed = false;
  try {
    await body(f, owned);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const item of owned) {
      try {
        await item.dispose(failed || errors.length > 0);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const close of [
      () => page.unrouteAll({ behavior: 'wait' }),
      () => page.context().close(),
      () => f.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    reportCleanup(errors, failed);
  }
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function clearNotice(page: Page) {
  const close = page.getByRole('button', { name: '关闭通知', exact: true });
  if (await close.count()) await close.click();
}
async function noStoredPacket(page: Page, original: Packet) {
  const stored = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(stored).not.toContain(original.key);
  expect(stored).not.toContain(JSON.parse(original.body!).title);
}
async function screenshot(page: Page, name: string, known = false) {
  await prepareScreenshot(page, known ? refresh(page) : recover(page), recovery(page));
  await expect(recovery(page).getByRole('heading')).toBeVisible();
  await expect(known ? accepted(page) : pending(page)).toBeVisible();
  await expect(known ? accepted(page) : pending(page)).toBeInViewport({ ratio: 1 });
  await expect(dismiss(page)).toBeInViewport({ ratio: 1 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${name}` });
}

for (const scope of ['private', 'project'] as const) {
  test(`${scope}创建发送前断网冻结原正文和键，所有入口与重复点击只恢复同包`, async ({ page }) => {
    await run(page, async (f, owned) => {
      await open(page, f);
      const body = payload(f, scope),
        before = effects(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, body, scope === 'project' ? 'project' : 'workbench');
      originalPacket(outgoing, f, body);
      expect(effects(f)).toEqual(before);
      if (scope === 'project') await screenshot(page, '215-task-creation-unknown-dark.png');
      for (const from of ['project', 'workbench', 'command'] as const) {
        await dismiss(page).click();
        await entry(page, f, from);
        await expect(pending(page)).toBeVisible();
        await locked(page, body);
        expect(outgoing).toHaveLength(1);
      }
      await noStoredPacket(page, outgoing[0]!);
      const retry = await hold(page, endpoint(f), { beforeFetch: true });
      owned.push(retry);
      await twice(recover(page));
      await retry.reached();
      await expect(recover(page)).toBeDisabled();
      await locked(page, body);
      await dismiss(page).click();
      await entry(page, f, scope === 'private' ? 'project' : 'workbench');
      await expect(recover(page)).toBeDisabled();
      await locked(page, body);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      expect(effects(f)).toEqual(before);
      await retry.releaseAndDrain();
      await expect(refresh(page)).toBeEnabled();
      // The reopened presentation did not initiate this POST, so it confirms the
      // known result explicitly instead of receiving the closed editor's navigation.
      await refresh(page).click();
      const task = await oneCreation(f, before, outgoing[0]!, body);
      await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
      await expect(recovery(page)).toHaveCount(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
    });
  });

  test(`${scope}创建提交后丢失回包，真实回执重放只有一个Task、编号、事件和回执`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f);
      const body = payload(f, scope),
        before = effects(f),
        outgoing = writes(page, f),
        receipts: Task[] = [];
      const lose = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        receipts.push((await response.json()) as Task);
        await route.abort('failed');
      };
      await page.route(endpoint(f), lose);
      await entry(page, f, scope === 'project' ? 'project' : 'workbench');
      await fill(page, body);
      await submit(page).click();
      await expect(pending(page)).toBeVisible();
      await expect(recover(page)).toBeEnabled();
      originalPacket(outgoing, f, body);
      const created = await oneCreation(f, before, outgoing[0]!, body),
        committed = effects(f);
      await recover(page).click();
      await expect.poll(() => receipts.length).toBe(2);
      await expect(recover(page)).toBeEnabled();
      expect(receipts).toEqual([created, created]);
      expect(outgoing).toEqual([outgoing[0], outgoing[0]]);
      expect(effects(f)).toEqual(committed);
      await page.unroute(endpoint(f), lose);
      await recover(page).click();
      await expect(page).toHaveURL(`${origin}/tasks/${created.id}`);
      await expect(recovery(page)).toHaveCount(0);
      expect(outgoing).toEqual([outgoing[0], outgoing[0], outgoing[0]]);
      expect(effects(f)).toEqual(committed);
    });
  });
}

test('已接受创建后工作台失败保留已确认结果，浅色窄屏刷新只GET', async ({ page }) => {
  await run(page, async (f) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, f, { theme: 'light' });
    const body = payload(f, 'private'),
      before = effects(f),
      outgoing = writes(page, f);
    let reads = 0;
    const unavailable = (route: Route) => {
      reads++;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'TEMPORARY_FAILURE', message: '工作台暂时不可读' } },
      });
    };
    await page.route(workbench, unavailable);
    await entry(page, f, 'workbench');
    await fill(page, body);
    await submit(page).click();
    await expect(accepted(page)).toBeVisible();
    await expect(refresh(page)).toBeEnabled();
    await expect(recover(page)).toHaveCount(0);
    await locked(page, body);
    originalPacket(outgoing, f, body);
    const task = await oneCreation(f, before, outgoing[0]!, body),
      committed = effects(f);
    await screenshot(page, '216-task-creation-refresh-mobile-light.png', true);
    const previousReads = reads;
    await refresh(page).click();
    await expect(refresh(page)).toBeEnabled();
    expect(reads).toBeGreaterThan(previousReads);
    expect(outgoing).toHaveLength(1);
    expect(effects(f)).toEqual(committed);
    await dismiss(page).click();
    await entry(page, f, 'command');
    await expect(accepted(page)).toBeVisible();
    await expect(recover(page)).toHaveCount(0);
    await page.unroute(workbench, unavailable);
    await refresh(page).click();
    await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    await expect(recovery(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    expect(effects(f)).toEqual(committed);
  });
});

for (const outcome of ['lost', 'accepted'] as const) {
  test(`创建首POST晚${outcome === 'lost' ? '丢失' : 'ACK'}不导航或关闭另一任务的新编辑器，再开任一入口恢复原包`, async ({
    page,
  }) => {
    await run(page, async (f, owned) => {
      await open(page, f);
      const body = payload(f, 'project'),
        before = effects(f),
        outgoing = writes(page, f);
      const post = await hold(page, endpoint(f), { loseResponse: outcome === 'lost' });
      owned.push(post);
      await entry(page, f, 'project');
      await fill(page, body);
      await submit(page).click();
      await post.reached(201);
      await locked(page, body);
      if (outcome === 'accepted') {
        // Browser Back changes the route without first closing the modal.
        await page.goBack();
        await expect(recovery(page)).toHaveCount(0);
      } else await dismiss(page).click();
      await navigate(page, f, 'task');
      await page.getByRole('button', { name: '编辑工作说明', exact: true }).click();
      await contentEditor(page).getByLabel('说明', { exact: true }).fill('另一项工作的后来草稿');
      const settled =
        outcome === 'lost'
          ? page.waitForEvent('requestfailed', (request) => request.url() === endpoint(f))
          : page
              .waitForResponse(
                (response) => response.url() === endpoint(f) && response.status() === 201,
              )
              .then((response) => response.finished());
      await post.releaseAndDrain();
      await settled;
      await painted(page);
      expect(new URL(page.url()).pathname).toBe(`/tasks/${f.task.id}`);
      expect(await contentEditor(page).isVisible()).toBe(true);
      expect(await contentEditor(page).getByLabel('说明', { exact: true }).inputValue()).toBe(
        '另一项工作的后来草稿',
      );
      expect(await page.locator('.toast').count()).toBe(0);
      expect(await recovery(page).count()).toBe(0);
      originalPacket(outgoing, f, body);
      const task = await oneCreation(f, before, outgoing[0]!, body),
        committed = effects(f);
      await page.keyboard.press('Escape');
      await entry(page, f, 'command');
      await locked(page, body);
      if (outcome === 'accepted') {
        await expect(accepted(page)).toBeVisible();
        await expect(recover(page)).toHaveCount(0);
        await refresh(page).click();
      } else {
        await expect(pending(page)).toBeVisible();
        await recover(page).click();
      }
      await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
      expect(outgoing).toEqual(outcome === 'accepted' ? [outgoing[0]] : [outgoing[0], outgoing[0]]);
      expect(effects(f)).toEqual(committed);
    });
  });
}

test('创建ACK拥有的旧GET晚到不覆盖后来任务状态或关闭新编辑器，原创建仅GET恢复', async ({
  page,
}) => {
  await run(page, async (f, owned) => {
    await open(page, f, { live: true });
    const body = payload(f, 'project'),
      before = effects(f),
      outgoing = writes(page, f);
    const post = await hold(page, endpoint(f));
    owned.push(post);
    await entry(page, f, 'project');
    await fill(page, body);
    await submit(page).click();
    await post.reached(201);
    const task = await oneCreation(f, before, outgoing[0]!, body);
    // Consume this genuine commit's SSE before holding all command-owned reads.
    await expect(page.locator(`a.context-task[href="/tasks/${task.id}"]`)).toContainText(
      body.title.trim(),
    );
    const reads = await hold(page, workbench);
    owned.push(reads);
    await post.releaseAndDrain();
    await reads.reached(200);
    reads.stopCapture();
    await dismiss(page).click();
    await navigate(page, f, 'task');
    await observePatch(page, f, '旧创建读取之后的新任务标题');
    await page.getByRole('button', { name: '编辑工作说明', exact: true }).click();
    await contentEditor(page)
      .getByLabel('说明', { exact: true })
      .fill('不能被旧创建读取关闭的草稿');
    const delivered = page.waitForResponse(async (response) => {
      if (response.url() !== workbench || response.status() !== 200) return false;
      const value = (await response.json()) as Workbench;
      return value.tasks.some(
        (item) => item.id === f.task.id && item.title !== '旧创建读取之后的新任务标题',
      );
    });
    await reads.releaseAndDrain();
    await (await delivered).finished();
    await painted(page);
    expect(new URL(page.url()).pathname).toBe(`/tasks/${f.task.id}`);
    expect(await contentEditor(page).getByLabel('说明', { exact: true }).inputValue()).toBe(
      '不能被旧创建读取关闭的草稿',
    );
    expect(
      await page.getByRole('heading', { name: '旧创建读取之后的新任务标题', exact: true }).count(),
    ).toBe(1);
    expect(await page.locator('.toast').count()).toBe(0);
    const committed = effects(f);
    await page.keyboard.press('Escape');
    await entry(page, f, 'command');
    await expect(accepted(page)).toBeVisible();
    await refresh(page).click();
    await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    expect(outgoing).toHaveLength(1);
    expect(effects(f)).toEqual(committed);
  });
});

for (const loss of ['view', null] as const) {
  test(`项目${loss === 'view' ? '降权时打开' : '撤权时已关闭'}的创建包由实时SSE清除，重授不复活`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f, { live: true });
      const body = payload(f, 'project'),
        before = effects(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, body, 'project');
      if (loss === null) await dismiss(page).click();
      await role(f, loss);
      await expect(recovery(page)).toHaveCount(0);
      if (loss === 'view')
        await expect(
          page.locator('.work-page-heading').getByRole('button', { name: '新建任务', exact: true }),
        ).toBeDisabled();
      else
        await expect(page.locator(`a.context-link[href="/projects/${f.project.id}"]`)).toHaveCount(
          0,
        );
      await role(f, 'edit');
      await observePatch(page, f, '重新授权后的实时工作台');
      await clearNotice(page);
      await entry(page, f, 'command');
      await expect(fresh(page)).toBeVisible();
      await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
      await expect(recovery(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(1);
      // Membership changes do not create a Task or advance its short-id counter.
      expect(effects(f).counter).toEqual(before.counter);
      expect(effects(f).events).toEqual(before.events);
      expect(effects(f).receipts).toEqual(before.receipts);
      const now = effects(f),
        next = { ...body, title: '重授后明确提交的新任务' };
      await fill(page, next);
      await submit(page).click();
      await expect(recovery(page)).toHaveCount(0);
      await expect.poll(() => outgoing.length).toBe(2);
      expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
      const task = await oneCreation(f, now, outgoing[1]!, next);
      await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    });
  });
}

for (const outcome of ['success', 'refusal'] as const) {
  test(`撤权后旧创建POST真实${outcome === 'success' ? '成功' : '拒绝'}晚回不关闭重授后的新创建表单`, async ({
    page,
  }) => {
    await run(page, async (f, owned) => {
      await open(page, f, { live: true });
      const body = payload(f, 'project'),
        outgoing = writes(page, f);
      const old = await hold(page, endpoint(f), { beforeFetch: outcome === 'refusal' });
      owned.push(old);
      await entry(page, f, 'project');
      await fill(page, body);
      await submit(page).click();
      await old.reached(outcome === 'success' ? 201 : undefined);
      old.stopCapture();
      await role(f, 'view');
      await expect(recovery(page)).toHaveCount(0);
      await expect(
        page.locator('.work-page-heading').getByRole('button', { name: '新建任务', exact: true }),
      ).toBeDisabled();
      if (outcome === 'refusal') {
        old.releaseRequest();
        await old.reached(403);
      }
      await role(f, 'edit');
      await observePatch(page, f, '重新授权后准备不同的新工作');
      await clearNotice(page);
      await entry(page, f, 'command');
      const next = {
        ...body,
        title: '新创建表单的后来输入',
        description: '旧finally不能改变提交按钮',
      };
      await fill(page, next);
      const before = effects(f);
      const response = page.waitForResponse((reply) => reply.url() === endpoint(f));
      await old.releaseAndDrain();
      await (await response).finished();
      await painted(page);
      expect(await fresh(page).isVisible()).toBe(true);
      expect(await fresh(page).getByLabel('要做什么', { exact: true }).inputValue()).toBe(
        next.title,
      );
      expect(await fresh(page).getByLabel('补充说明').inputValue()).toBe(next.description);
      expect(await submit(page).isEnabled()).toBe(true);
      expect(await recovery(page).count()).toBe(0);
      expect(await page.locator('.toast').count()).toBe(0);
      expect(effects(f)).toEqual(before);
      expect(outgoing).toHaveLength(1);
      await submit(page).click();
      await expect.poll(() => outgoing.length).toBe(2);
      expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
      const task = await oneCreation(f, before, outgoing[1]!, next);
      await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    });
  });
}

test('当前POST真实403早于权限快照也清除创建包，重授后新创建使用新键', async ({ page }) => {
  await run(page, async (f, owned) => {
    await open(page, f, { live: true });
    const body = payload(f, 'project'),
      before = effects(f),
      outgoing = writes(page, f);
    const old = await hold(page, endpoint(f), { beforeFetch: true });
    owned.push(old);
    const unavailable = (route: Route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'TEMPORARY_FAILURE', message: '权限快照暂不可读' } },
      });
    await page.route(workbench, unavailable);
    await entry(page, f, 'project');
    await fill(page, body);
    await submit(page).click();
    await old.reached();
    await role(f, 'view');
    old.stopCapture();
    old.releaseRequest();
    await old.reached(403);
    await old.releaseAndDrain();
    await expect(recovery(page)).toHaveCount(0);
    expect(effects(f)).toEqual(before);
    await page.unroute(workbench, unavailable);
    await role(f, 'edit');
    await observePatch(page, f, '当前权限重新得到确认');
    await clearNotice(page);
    await entry(page, f, 'workbench');
    await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
    const now = effects(f);
    await fill(page, body);
    await submit(page).click();
    await expect.poll(() => outgoing.length).toBe(2);
    expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
    const task = await oneCreation(f, now, outgoing[1]!, body);
    await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
  });
});

for (const reset of ['space', 'identity', 'reload'] as const) {
  test(`已关闭未知创建在${reset === 'space' ? '空间切换' : reset === 'identity' ? '更换账号' : '硬刷新'}后清除，不持久化或自动写入`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f);
      const body = payload(f, 'private'),
        before = effects(f),
        outgoing = writes(page, f);
      await makeUnknown(page, f, body);
      await dismiss(page).click();
      await noStoredPacket(page, outgoing[0]!);
      if (reset === 'space') {
        await page
          .getByLabel('当前工作空间', { exact: true })
          .selectOption(`personal-${f.bob.user.id}`);
        await expect(page.getByLabel('当前工作空间')).toHaveValue(`personal-${f.bob.user.id}`);
        await page.getByLabel('当前工作空间', { exact: true }).selectOption(f.bob.spaceId);
      } else if (reset === 'identity') {
        for (const account of [f.alice, f.bob]) {
          await page
            .getByRole('navigation', { name: '主导航' })
            .getByRole('link', { name: '资源与设置', exact: true })
            .click();
          await page.getByRole('button', { name: '退出登录', exact: true }).click();
          await page
            .getByLabel('邮箱', { exact: true })
            .fill(account === f.alice ? 'alice@example.invalid' : 'bob@example.invalid');
          await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
          await page.getByRole('button', { name: '登录工作台', exact: true }).click();
          await page.getByLabel('当前工作空间', { exact: true }).selectOption(account.spaceId);
          await entry(page, f, 'command');
          await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
          await fresh(page).getByRole('button', { name: '取消', exact: true }).click();
        }
      } else await page.reload();
      await entry(page, f, 'workbench');
      await expect(fresh(page)).toBeVisible();
      await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
      await expect(fresh(page).getByLabel('补充说明')).toHaveValue('');
      await expect(recovery(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(1);
      expect(effects(f)).toEqual(before);
      await noStoredPacket(page, outgoing[0]!);
    });
  });
}

test('畸形创建ACK仍保留未知原包，服务端trim后的真实ACK才允许完成', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const body = payload(f, 'project'),
      before = effects(f),
      outgoing = writes(page, f),
      received: Task[] = [];
    const invalid = [
      (task: Task) => ({ ...task, id: '' }),
      (task: Task) => ({ ...task, spaceId: `personal-${f.bob.user.id}` }),
      (task: Task) => ({ ...task, projectId: null }),
      (task: Task) => ({ ...task, ownerUserId: f.alice.user.id }),
      (task: Task) => ({ ...task, title: task.title + '不是原创建' }),
      (task: Task) => ({ ...task, revision: 2 }),
    ];
    const malformed = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const receipt = (await response.json()) as Task;
      const alter = invalid[received.length]!;
      received.push(receipt);
      await route.fulfill({ status: 201, json: alter(receipt) });
    };
    await page.route(endpoint(f), malformed);
    await entry(page, f, 'project');
    await fill(page, body);
    await submit(page).click();
    for (let i = 0; i < invalid.length; i++) {
      if (i > 0) await recover(page).click();
      await expect.poll(() => received.length).toBe(i + 1);
      await expect(pending(page)).toBeVisible();
      await expect(recovery(page).getByRole('alert')).toContainText('服务未返回可核对的原创建回执');
      await expect(recover(page)).toBeEnabled();
      await expect(accepted(page)).toHaveCount(0);
      await expect(refresh(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(i + 1);
      expect(outgoing.every((item) => JSON.stringify(item) === JSON.stringify(outgoing[0]))).toBe(
        true,
      );
      expect(received.every((item) => JSON.stringify(item) === JSON.stringify(received[0]))).toBe(
        true,
      );
      await oneCreation(f, before, outgoing[0]!, body);
    }
    await page.unroute(endpoint(f), malformed);
    const committed = effects(f),
      task = received[0]!;
    await recover(page).click();
    await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    await expect(recovery(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(invalid.length + 1);
    expect(outgoing.at(-1)).toEqual(outgoing[0]);
    expect(effects(f)).toEqual(committed);
  });
});

for (const loss of ['view', null] as const) {
  test(`未发送的项目创建草稿在实时${loss === 'view' ? '降权' : '撤权'}后清空，不变成个人创建`, async ({
    page,
  }) => {
    await run(page, async (f) => {
      await open(page, f, { live: true });
      const before = effects(f),
        outgoing = writes(page, f),
        body = payload(f, 'project');
      await entry(page, f, 'workbench');
      await fill(page, body);
      await role(f, loss);
      await expect(fresh(page)).toHaveCount(0);
      await expect(recovery(page)).toHaveCount(0);
      expect(outgoing).toHaveLength(0);
      expect(effects(f)).toEqual(before);
      await clearNotice(page);
      await entry(page, f, 'command');
      await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
      await expect(fresh(page).getByLabel('补充说明')).toHaveValue('');
      await expect(submit(page)).toBeDisabled();
      await expect(
        fresh(page).getByRole('combobox', { name: '放在哪里', exact: true }),
      ).toHaveValue('');
      await expect(
        fresh(page)
          .getByRole('combobox', { name: '放在哪里', exact: true })
          .locator(`option[value="${f.project.id}"]`),
      ).toHaveCount(0);
      expect(outgoing).toHaveLength(0);
      expect(effects(f)).toEqual(before);
    });
  });
}

test('真实业务400释放输入供修正，新请求5xx则锁住新原包并按同键恢复', async ({ page }) => {
  await run(page, async (f) => {
    await open(page, f);
    const before = effects(f),
      outgoing = writes(page, f),
      body = payload(f, 'private');
    const invalid = async (route: Route) => {
      // Exercise the real route's definitive validation response. Only this
      // downstream attempt is deliberately invalid; no business write commits.
      const response = await route.fetch({ postData: JSON.stringify({ ...body, title: '' }) });
      expect(response.status()).toBe(400);
      await route.fulfill({ response });
    };
    await page.route(endpoint(f), invalid);
    await entry(page, f, 'workbench');
    await fill(page, body);
    await submit(page).click();
    await expect(fresh(page).getByRole('alert')).toContainText('任务标题需要非空文本');
    await expect(fresh(page).getByLabel('要做什么', { exact: true })).toBeEnabled();
    await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue(body.title);
    await expect(fresh(page).getByLabel('补充说明')).toHaveValue(body.description);
    originalPacket(outgoing, f, body);
    expect(effects(f)).toEqual(before);
    await page.unroute(endpoint(f), invalid);
    const unavailable = (route: Route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'TEMPORARY_FAILURE', message: '创建服务暂时不可用' } },
      });
    await page.route(endpoint(f), unavailable);
    const next = { ...body, title: '修正之后的另一项工作' };
    await fill(page, next);
    await submit(page).click();
    await expect(pending(page)).toBeVisible();
    await expect(recover(page)).toBeEnabled();
    await locked(page, next);
    expect(outgoing).toHaveLength(2);
    expect(outgoing[1]!.key).not.toBe(outgoing[0]!.key);
    expect(JSON.parse(outgoing[1]!.body!)).toEqual(next);
    expect(effects(f)).toEqual(before);
    await page.unroute(endpoint(f), unavailable);
    await recover(page).click();
    const task = await oneCreation(f, before, outgoing[1]!, next);
    await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
    expect(outgoing).toEqual([outgoing[0], outgoing[1], outgoing[1]]);
  });
});

test('旧工作台403晚于较新成功读取不清创建包，当前403永久清除已关闭原包', async ({ page }) => {
  await run(page, async (f, owned) => {
    await open(page, f, { live: true });
    const body = payload(f, 'private'),
      outgoing = writes(page, f);
    await makeUnknown(page, f, body);
    const old = await hold(page, workbench, { denyRead: true });
    owned.push(old);
    await patch(f, '触发较早的拒绝读取');
    await old.reached(200);
    old.stopCapture();
    await observePatch(page, f, '较新读取仍可创建');
    await dismiss(page).click();
    const oldDenial = page.waitForResponse(
      (response) => response.url() === workbench && response.status() === 403,
    );
    await old.releaseAndDrain();
    await (await oldDenial).finished();
    await painted(page);
    await entry(page, f, 'command');
    await expect(pending(page)).toBeVisible();
    await locked(page, body);
    await dismiss(page).click();
    const current = await hold(page, workbench, { denyRead: true });
    owned.push(current);
    await patch(f, '触发当前明确访问拒绝');
    await current.reached(200);
    const currentDenial = page.waitForResponse(
      (response) => response.url() === workbench && response.status() === 403,
    );
    await current.releaseAndDrain();
    await (await currentDenial).finished();
    await painted(page);
    await observePatch(page, f, '恢复可见性后仍未创建');
    await clearNotice(page);
    const before = effects(f);
    await entry(page, f, 'command');
    await expect(fresh(page)).toBeVisible();
    await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
    await expect(fresh(page).getByLabel('补充说明')).toHaveValue('');
    await expect(recovery(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    expect(effects(f)).toEqual(before);
  });
});

test('同一在途创建经其他入口重开后收到当前403只留通用拒绝，不再显示旧项目标题说明', async ({
  page,
}) => {
  await run(page, async (f, owned) => {
    await open(page, f, { live: true });
    const body = payload(f, 'project'),
      before = effects(f),
      outgoing = writes(page, f);
    const old = await hold(page, endpoint(f), { beforeFetch: true });
    owned.push(old);
    const unavailable = (route: Route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'TEMPORARY_FAILURE', message: '权限快照暂不可读' } },
      });
    await page.route(workbench, unavailable);
    await entry(page, f, 'project');
    await fill(page, body);
    await submit(page).click();
    await old.reached();
    await dismiss(page).click();
    await entry(page, f, 'command');
    await expect(recover(page)).toBeDisabled();
    await locked(page, body);
    await role(f, 'view');
    old.stopCapture();
    old.releaseRequest();
    await old.reached(403);
    await old.releaseAndDrain();
    await expect(recovery(page).getByRole('alert')).toHaveText(
      '任务创建权限已失效，请重新查看后再创建',
    );
    await expect(recovery(page).getByLabel('要做什么', { exact: true })).toHaveCount(0);
    await expect(
      recovery(page).getByRole('combobox', { name: '放在哪里', exact: true }),
    ).toHaveCount(0);
    await expect(recovery(page).getByLabel('补充说明')).toHaveCount(0);
    await expect(recovery(page)).not.toContainText(body.title.trim());
    await expect(recovery(page)).not.toContainText(body.description.trim());
    await expect(recover(page)).toHaveCount(0);
    await expect(refresh(page)).toHaveCount(0);
    expect(outgoing).toHaveLength(1);
    expect(effects(f)).toEqual(before);
    await page.unroute(workbench, unavailable);
  });
});

async function signIn(page: Page, account: Account, email: string) {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await page.getByLabel('当前工作空间', { exact: true }).selectOption(account.spaceId);
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(account.spaceId);
}
async function expire(f: Fixture, denial: 'session' | 'space') {
  const response =
    denial === 'session'
      ? await f.api.call('identity/sign-out', f.bob, {})
      : await f.api.call(`spaces/${f.alice.spaceId}/members/${f.bob.user.id}/remove`, f.alice, {});
  expect(response.statusCode, response.body).toBe(200);
}

for (const source of ['POST', 'GET'] as const) {
  for (const denial of ['session', 'space'] as const) {
    test(`旧创建${source}的真实${denial === 'session' ? '401' : '空间撤权403'}晚回不清新身份空间的创建草稿`, async ({
      page,
    }) => {
      await run(page, async (f, owned) => {
        await open(page, f);
        await stopEventsForHttpBoundary(page);
        const body = payload(f, 'private'),
          outgoing = writes(page, f),
          before = effects(f);
        const pattern = source === 'POST' ? endpoint(f) : workbench;
        const old = await hold(page, pattern, { beforeFetch: true });
        owned.push(old);
        await entry(page, f, 'workbench');
        await fill(page, body);
        await submit(page).click();
        await old.reached();
        old.stopCapture();
        if (source === 'GET') await oneCreation(f, before, outgoing[0]!, body);
        await dismiss(page).click();
        if (denial === 'session') {
          await page
            .getByRole('navigation', { name: '主导航' })
            .getByRole('link', { name: '资源与设置', exact: true })
            .click();
          await page.getByRole('button', { name: '退出登录', exact: true }).click();
        } else {
          await page
            .getByLabel('当前工作空间', { exact: true })
            .selectOption(`personal-${f.bob.user.id}`);
          await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(
            `personal-${f.bob.user.id}`,
          );
          await expire(f, 'space');
        }
        old.releaseRequest();
        await old.reached(denial === 'session' ? 401 : 403);
        if (denial === 'space')
          expect(old.captured[0]!.result).toMatchObject({
            error: { code: 'SPACE_ACCESS_REVOKED' },
          });
        if (denial === 'session') await signIn(page, f.alice, 'alice@example.invalid');
        await entry(page, f, 'command');
        const next = {
          title: '当前身份中的新任务输入',
          description: '旧权限回应不能清除这段输入',
          projectId: null,
        };
        await fill(page, next);
        const currentPath = new URL(page.url()).pathname,
          committed = effects(f);
        const delivered = page.waitForResponse(
          (reply) =>
            reply.url() === pattern && reply.status() === (denial === 'session' ? 401 : 403),
        );
        await old.releaseAndDrain();
        await (await delivered).finished();
        await painted(page);
        // Immediate assertions: do not hide a transient teardown with retrying locators.
        expect(new URL(page.url()).pathname).toBe(currentPath);
        expect(await page.getByLabel('当前工作空间', { exact: true }).inputValue()).toBe(
          denial === 'session' ? f.alice.spaceId : `personal-${f.bob.user.id}`,
        );
        expect(await page.locator('.workbench-profile').getAttribute('title')).toBe(
          denial === 'session' ? f.alice.user.name : f.bob.user.name,
        );
        expect(await fresh(page).isVisible()).toBe(true);
        expect(await fresh(page).getByLabel('要做什么', { exact: true }).inputValue()).toBe(
          next.title,
        );
        expect(await fresh(page).getByLabel('补充说明').inputValue()).toBe(next.description);
        expect(await submit(page).isEnabled()).toBe(true);
        expect(await recovery(page).count()).toBe(0);
        expect(outgoing).toHaveLength(1);
        expect(effects(f)).toEqual(committed);
        if (source === 'POST') expect(committed).toEqual(before);
      });
    });
  }
}

for (const denial of ['session', 'space'] as const) {
  test(`当前创建${denial === 'session' ? 'POST401仍退出过期会话' : '所属GET空间撤权403仍清除原空间'}`, async ({
    page,
  }) => {
    await run(page, async (f, owned) => {
      await open(page, f);
      await stopEventsForHttpBoundary(page);
      const body = payload(f, 'private'),
        before = effects(f),
        outgoing = writes(page, f);
      const current = await hold(page, denial === 'session' ? endpoint(f) : workbench, {
        beforeFetch: true,
      });
      owned.push(current);
      await entry(page, f, 'workbench');
      await fill(page, body);
      await submit(page).click();
      await current.reached();
      current.stopCapture();
      if (denial === 'space') await oneCreation(f, before, outgoing[0]!, body);
      await expire(f, denial);
      current.releaseRequest();
      await current.reached(denial === 'session' ? 401 : 403);
      if (denial === 'space')
        expect(current.captured[0]!.result).toMatchObject({
          error: { code: 'SPACE_ACCESS_REVOKED' },
        });
      await current.releaseAndDrain();
      await expect(recovery(page)).toHaveCount(0);
      if (denial === 'session') {
        await expect(page.getByRole('button', { name: '登录工作台', exact: true })).toBeVisible();
        await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveCount(0);
        expect(effects(f)).toEqual(before);
      } else {
        await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(
          `personal-${f.bob.user.id}`,
        );
        await entry(page, f, 'command');
        await expect(fresh(page).getByLabel('要做什么', { exact: true })).toHaveValue('');
        await expect(fresh(page).getByLabel('补充说明')).toHaveValue('');
      }
      expect(outgoing).toHaveLength(1);
    });
  });
}
