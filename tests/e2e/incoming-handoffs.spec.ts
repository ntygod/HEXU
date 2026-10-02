import { test, expect, type Frame, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { teamFixture, PASSWORD, type Account } from '../helpers/team.js';
import type { Task } from '../../packages/contracts/src/index.js';
import type { HandoffState, HandoffView } from '../../packages/contracts/src/handoffs.js';
import type {
  IncomingHandoffPage,
  IncomingHandoffSummary,
} from '../../packages/contracts/src/incoming-handoffs.js';

const origin = 'http://127.0.0.1:4347';
const endpoint = `${origin}/api/v1/incoming-handoffs`;
const home = (cursor = '') =>
  `${origin}/${cursor ? `?incomingCursor=${encodeURIComponent(cursor)}` : ''}`;
const targetPath = (taskId: string, handoffId: string) => `/tasks/${taskId}/handoffs/${handoffId}`;
const targetEndpoint = (taskId: string, handoffId: string) => `${endpoint}/${taskId}/${handoffId}`;
const list = (page: Page) => page.getByRole('region', { name: '发给我的待接手邀请', exact: true });
const rows = (page: Page) => list(page).locator('[data-handoff-id]');
const row = (page: Page, id: string) => list(page).locator(`[data-handoff-id="${id}"]`);
const drawer = (page: Page) => page.getByRole('dialog', { name: '待接手邀请摘要', exact: true });
const summary = (page: Page) =>
  drawer(page).getByRole('region', { name: '待接手邀请摘要', exact: true });
const pageIds = (page: Page) =>
  rows(page).evaluateAll((elements) =>
    elements.map((item) => item.getAttribute('data-handoff-id')),
  );

interface SyntheticInvitation {
  id: string;
  taskId: string;
  spaceId: string;
  projectId: string;
  state: HandoffState;
  revision: number;
  sender: { id: string; name: string };
  material: { recipient: { id: string; name: string } };
  summary: string;
  remainingWork: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

async function fixture(count = 1) {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const member = await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'view',
    });
    expect(member.statusCode, member.body).toBe(200);
    const task = (await api.task(alice, project.id, '邀请接收与任务继续')) as Task;
    let sequence = 0;
    const seed = (
      patch: Partial<SyntheticInvitation> = {},
      target = task,
      recipient = bob,
    ): SyntheticInvitation => {
      const createdAt = new Date(Date.now() - 60_000 + sequence++ * 1000).toISOString();
      const invitation: SyntheticInvitation = {
        id: randomUUID(),
        taskId: target.id,
        spaceId: target.spaceId,
        projectId: target.projectId!,
        state: 'offered',
        revision: 1,
        sender: { id: alice.user.id, name: alice.user.name },
        material: { recipient: { id: recipient.user.id, name: recipient.user.name } },
        summary: `待接手说明 ${String(sequence).padStart(2, '0')}`,
        remainingWork: '核对取消后的回执，再补充接口说明。',
        environment: '沿用项目现有 Node 24 环境。',
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        ...patch,
      };
      // This discovery fixture deliberately has no transfer, material, node or
      // native filesystem. Only the invitation metadata being read is seeded.
      api.store.db.exec('PRAGMA foreign_keys=OFF');
      try {
        api.store.db
          .prepare(
            'INSERT INTO handoffs(id,task_id,space_id,transfer_id,sender_id,recipient_id,state,revision,expires_at,body) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            invitation.id,
            invitation.taskId,
            invitation.spaceId,
            randomUUID(),
            invitation.sender.id,
            invitation.material.recipient.id,
            invitation.state,
            invitation.revision,
            invitation.expiresAt,
            JSON.stringify(invitation),
          );
      } finally {
        api.store.db.exec('PRAGMA foreign_keys=ON');
      }
      return invitation;
    };
    const invitations = Array.from({ length: count }, () => seed());
    const incoming = async (cursor = '', account: Account = bob) => {
      const response = await api.call(
        `incoming-handoffs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        account,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as IncomingHandoffPage;
    };
    const detail = async (invitation: SyntheticInvitation, account: Account = bob) => {
      const response = await api.call(
        `incoming-handoffs/${invitation.taskId}/${invitation.id}`,
        account,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as IncomingHandoffSummary;
    };
    const change = (invitation: SyntheticInvitation, patch: Partial<SyntheticInvitation>) => {
      Object.assign(invitation, patch);
      api.store.db
        .prepare('UPDATE handoffs SET state=?,revision=?,expires_at=?,body=? WHERE id=?')
        .run(
          invitation.state,
          invitation.revision,
          invitation.expiresAt,
          JSON.stringify(invitation),
          invitation.id,
        );
    };
    const notify = (invitation: SyntheticInvitation, kind: string) => {
      api.store.db
        .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
        .run(invitation.taskId, kind, new Date().toISOString(), invitation.spaceId);
    };
    const snapshot = () =>
      Object.fromEntries(
        [
          'tasks',
          'runs',
          'handoffs',
          'handoff_events',
          'handoff_acceptances',
          'checkpoint_transfers',
          'idempotency_records',
          'outbox',
        ].map((table) => [
          table,
          api.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    return {
      api,
      alice,
      bob,
      project,
      task,
      seed,
      invitations,
      incoming,
      detail,
      change,
      notify,
      snapshot,
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function completeIncomingAfterAbort(page: Page, requestUrl: string) {
  // Limit this transport fixture to one selected incoming-summary GET. Native
  // cancellation remains intact for identity, Task detail, handling and every
  // unrelated request. Consumed bodies prove that late success/error reaches
  // the client callbacks instead of stopping at native fetch's AbortError.
  await page.addInitScript((requestUrl) => {
    const nativeFetch = window.fetch.bind(window);
    const completedBodies: Record<string, number> = {};
    Object.defineProperty(window, 'hexuCompletedIncomingBodies', { get: () => completedBodies });
    window.fetch = async (resource, init) => {
      const url = new URL(
        resource instanceof Request ? resource.url : String(resource),
        location.href,
      );
      const method = init?.method ?? (resource instanceof Request ? resource.method : 'GET');
      if (
        url.origin !== location.origin ||
        url.href !== requestUrl ||
        method.toUpperCase() !== 'GET'
      )
        return nativeFetch(resource, init);
      const response = await nativeFetch(resource, {
        ...init,
        signal: new AbortController().signal,
      });
      const json = response.json.bind(response);
      response.json = async () => {
        try {
          return await json();
        } finally {
          completedBodies[url.href] = (completedBodies[url.href] ?? 0) + 1;
        }
      };
      return response;
    };
  }, requestUrl);
}
const completedIncomingBodies = (page: Page, requestUrl: string) =>
  page.evaluate(
    (url) => Number(Reflect.get(window, 'hexuCompletedIncomingBodies')?.[url] ?? 0),
    requestUrl,
  );

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type HeldRead = {
  count(): number;
  reached: Promise<void>;
  stop(): void;
  drain(): Promise<void>;
};
async function holdReads(
  page: Page,
  heldReads: HeldRead[],
  pattern: Parameters<Page['route']>[0],
  status: number,
  json: unknown,
) {
  const held = gate(),
    reached = gate(),
    pending: Promise<void>[] = [];
  let capturing = true;
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    // Capture every read in this old page/target session, including replacements
    // caused by real SSE updates. A single-route gate can hide stale responses.
    const response = held.promise.then(() => route.fulfill({ status, json }));
    pending.push(response);
    void response.catch(() => {});
    reached.resolve();
    await response;
  };
  const session: HeldRead = {
    count: () => pending.length,
    reached: reached.promise,
    stop: () => {
      capturing = false;
      held.resolve();
    },
    drain: async () => {
      session.stop();
      const settled = await Promise.allSettled(pending);
      // Never unroute before all captured Routes have finished fulfilling.
      if (!page.isClosed()) await page.unroute(pattern, handler);
      const errors = settled.filter((item) => item.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((item) => item.reason),
          '延迟摘要读取未完成',
        );
    },
  };
  heldReads.push(session);
  await page.route(pattern, handler);
  return session;
}
async function drainConsumedReads(page: Page, held: HeldRead, requestUrl: string) {
  const completedBefore = await completedIncomingBodies(page, requestUrl);
  const expected = completedBefore + held.count();
  expect(held.count()).toBeGreaterThan(0);
  await held.drain();
  await expect.poll(() => completedIncomingBodies(page, requestUrl)).toBe(expected);
}
async function usingFixture(
  page: Page,
  count: number,
  run: (f: Fixture, heldReads: HeldRead[]) => Promise<void>,
) {
  const f = await fixture(count),
    heldReads: HeldRead[] = [];
  let failed = false;
  try {
    await run(f, heldReads);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const held of heldReads) held.stop();
    const errors: unknown[] = [];
    for (const cleanup of [
      ...heldReads.map((held) => () => held.drain()),
      async () => {
        if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
      },
      () => page.context().close(),
      () => f.api.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    // Page closure during an assertion timeout must never leak the HTTP/SSE
    // fixture or replace the original assertion with a secondary cleanup error.
    if (errors.length) {
      if (!failed) throw new AggregateError(errors, '待接手邀请浏览器夹具清理失败');
      test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
    }
  }
}
async function open(page: Page, f: Fixture, path = '/', account = f.bob) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4347, host: '127.0.0.1' });
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
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
  await page.addInitScript(
    ({ userId, spaceId }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', 'dark');
    },
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(origin + path);
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(account.spaceId);
}
async function navigate(page: Page, path: string) {
  await page.evaluate((next) => {
    history.pushState({}, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(origin + path);
}
async function subscribeAfterSetupEvents(page: Page, f: Fixture) {
  // These cases need an already-loaded visibility session. Start the real SSE
  // subscription after fixture setup, whose historical events would otherwise
  // schedule a Workbench replacement during the polling/deadline assertion.
  // Later events and the server's live session/permission checks remain real.
  const { sequence } = f.api.store.db
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM outbox')
    .get() as { sequence: number };
  expect(Number.isSafeInteger(sequence)).toBe(true);
  await page.route(
    (url) => url.origin === origin && url.pathname === '/api/v1/events',
    (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('after', String(sequence));
      return route.continue({ url: url.href });
    },
  );
}
async function refreshWorkbench(f: Fixture, marker: string) {
  const response = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, { body: marker });
  expect(response.statusCode, response.body).toBe(201);
}
function audit(page: Page) {
  const legacy: string[] = [],
    writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      /\/api\/v1\/tasks\/[^/]+\/handoffs(?:\/|$)/.test(path) ||
      /\/(?:runner\/v1|checkpoints|checkpoint-transfers|retentions|handoff-workspace)(?:\/|$)/.test(
        path,
      )
    )
      legacy.push(path);
    if (
      path.startsWith('/api/v1/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      !path.startsWith('/api/v1/identity/')
    )
      writes.push(`${request.method()} ${path}`);
  });
  return {
    legacy,
    writes,
    readOnly: () => {
      expect(legacy).toEqual([]);
      expect(writes).toEqual([]);
    },
  };
}

test('当前空间只展示本人仍可访问的有效邀请，有限分页和前后退不触发旧接口或写入', async ({
  page,
}) => {
  await usingFixture(page, 23, async (f) => {
    f.seed({ summary: 'OTHER_RECIPIENT_ONLY' }, f.task, f.alice);
    f.seed({ state: 'withdrawn', summary: 'WITHDRAWN_ONLY' });
    f.seed({ expiresAt: new Date(Date.now() - 60_000).toISOString(), summary: 'EXPIRED_ONLY' });
    const privateTask = (await f.api.task(f.alice, null, 'PRIVATE_TASK_ONLY')) as Task;
    f.seed({ summary: 'PRIVATE_INVITATION_ONLY' }, privateTask);
    const first = await f.incoming(),
      second = await f.incoming(first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    const before = f.snapshot(),
      calls = audit(page);
    await open(page, f);
    await expect(rows(page)).toHaveCount(20);
    expect(await pageIds(page)).toEqual(first.items.map((item) => item.id));
    await expect(list(page)).not.toContainText(
      /OTHER_RECIPIENT_ONLY|WITHDRAWN_ONLY|EXPIRED_ONLY|PRIVATE_INVITATION_ONLY/,
    );
    await page.getByRole('button', { name: '团队概览', exact: true }).click();
    await expect(rows(page)).toHaveCount(20);
    await page.getByRole('button', { name: '我的工作', exact: true }).click();
    await list(page).getByRole('link', { name: '较早邀请', exact: true }).press('Enter');
    await expect(page).toHaveURL(home(first.nextCursor!));
    await expect(rows(page)).toHaveCount(3);
    expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
    await expect(list(page).getByRole('link', { name: '较早邀请', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(rows(page)).toHaveCount(3);
    await page.goBack();
    await expect(page).toHaveURL(home());
    await expect(rows(page)).toHaveCount(20);
    await page.goForward();
    await expect(rows(page)).toHaveCount(3);
    await list(page).getByRole('link', { name: '返回第一页', exact: true }).click();
    await expect(page).toHaveURL(home());
    await expect(rows(page)).toHaveCount(20);
    await list(page).getByRole('button', { name: '刷新待接手邀请', exact: true }).click();
    await expect(rows(page)).toHaveCount(20);
    calls.readOnly();
    expect(f.snapshot()).toEqual(before);
  });
});

test('第20条以外的精确邀请支持刷新、后退前进和关闭，摘要不挂载旧卡片', async ({ page }) => {
  await usingFixture(page, 24, async (f) => {
    const first = await f.incoming(),
      second = await f.incoming(first.nextCursor!);
    const target = second.items.at(-1)!;
    expect(first.items.some((item) => item.id === target.id)).toBe(false);
    const taskDetailReads: string[] = [];
    let summaryPhase = true;
    page.on('request', (request) => {
      if (
        summaryPhase &&
        request.method() === 'GET' &&
        new URL(request.url()).pathname === `/api/v1/tasks/${target.task.id}`
      )
        taskDetailReads.push(request.url());
    });
    const before = f.snapshot(),
      calls = audit(page);
    await open(page, f);
    await list(page).getByRole('link', { name: '较早邀请', exact: true }).click();
    await row(page, target.id)
      .getByRole('link', { name: '查看邀请摘要', exact: true })
      .press('Enter');
    await expect(page).toHaveURL(origin + targetPath(target.task.id, target.id));
    await expect(summary(page)).toContainText(target.summary);
    await expect(drawer(page).getByRole('article', { name: '接手邀请记录' })).toHaveCount(0);
    await expect(drawer(page).getByRole('region', { name: '固定接手材料' })).toHaveCount(0);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(summary(page)).toContainText(target.summary);
    await page.goBack();
    await expect(page).toHaveURL(home(first.nextCursor!));
    await expect(rows(page)).toHaveCount(4);
    await page.goForward();
    await expect(summary(page)).toContainText(target.summary);
    // Exact navigation, reload, and history restoration are pure discovery.
    // The normal Task workspace is allowed to read detail only after close.
    expect(taskDetailReads).toEqual([]);
    summaryPhase = false;
    await drawer(page).getByRole('button', { name: '关闭', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${origin}/tasks/${target.task.id}`);
    await expect(drawer(page)).toHaveCount(0);
    await navigate(page, targetPath(target.task.id, target.id));
    await expect(summary(page)).toContainText(target.summary);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/tasks/${target.task.id}`);
    calls.readOnly();
    expect(f.snapshot()).toEqual(before);
  });
});

test('暗色工作台与390px浅色精确摘要展示实际目标，键盘可关闭且没有横向溢出', async ({ page }) => {
  await usingFixture(page, 2, async (f) => {
    const calls = audit(page),
      target = f.invitations[0]!;
    await open(page, f);
    await expect(rows(page)).toHaveCount(2);
    await list(page).scrollIntoViewIfNeeded();
    await expect(
      list(page).getByRole('heading', { name: '发给我的待接手邀请', exact: true }),
    ).toBeVisible();
    await expect(row(page, target.id)).toContainText(target.summary);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await mkdir('artifacts', { recursive: true });
    await list(page).screenshot({ path: 'artifacts/197-incoming-handoffs-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await row(page, target.id)
      .getByRole('link', { name: '查看邀请摘要', exact: true })
      .press('Enter');
    await expect(summary(page)).toContainText(target.summary);
    const handling = drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true });
    const close = drawer(page).getByRole('button', { name: '关闭', exact: true });
    await handling.scrollIntoViewIfNeeded();
    await expect(handling).toBeVisible();
    await expect(close).toBeInViewport();
    await expect(handling).toBeInViewport();
    expect((await summary(page).boundingBox())!.width).toBeGreaterThan(280);
    expect(
      await drawer(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await drawer(page).screenshot({
      path: 'artifacts/198-incoming-handoff-summary-mobile-light.png',
    });
    await handling.focus();
    await expect(handling).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    calls.readOnly();
  });
});

test('明确处理才读取精确旧邀请卡，重复处理入口和刷新都不自动接受或准备现场', async ({ page }) => {
  await usingFixture(page, 24, async (f) => {
    const target = f.invitations[0]!,
      path = targetPath(target.taskId, target.id);
    const legacyEndpoint = `${origin}/api/v1/tasks/${target.taskId}/handoffs/${target.id}`;
    let summaryReads = 0;
    page.on('request', (request) => {
      if (request.url() === targetEndpoint(target.taskId, target.id)) summaryReads++;
    });
    // Only the established Card response is a synthetic fixture. This test is
    // navigation coverage and intentionally does not revalidate material files.
    const view: HandoffView = {
      handoff: {
        ...target,
        taskTitle: f.task.title,
        taskRevision: f.task.revision,
        material: {
          transferId: randomUUID(),
          transferHash: '1'.repeat(64),
          checkpointId: randomUUID(),
          retentionId: randomUUID(),
          commit: '2'.repeat(40),
          snapshotHash: '3'.repeat(64),
          coverage: {
            objects: 3,
            trees: 1,
            files: 1,
            bytes: 24,
            lfsPointers: 0,
            gitlinks: 0,
            symlinks: 0,
          },
          expiresAt: target.expiresAt,
          receivedAt: target.createdAt,
          sourceNodeId: randomUUID(),
          targetNodeId: randomUUID(),
          targetNodeName: '合成接收节点',
          recipient: target.material.recipient,
        },
      },
      taskChanged: false,
      materialAvailable: false,
      canReject: false,
      canWithdraw: false,
      canAccept: false,
    };
    await page.route(
      (url) => url.pathname.startsWith(`/api/v1/tasks/${target.taskId}/handoffs`),
      (route) =>
        route.request().url() === legacyEndpoint
          ? route.fulfill({ json: view })
          : route.fulfill({
              status: 404,
              json: { error: { code: 'NOT_FOUND', message: '此导航夹具没有旧邀请子资源' } },
            }),
    );
    const before = f.snapshot(),
      calls = audit(page);
    await open(page, f, path);
    await expect(summary(page)).toContainText(target.summary);
    calls.readOnly();
    await drawer(page)
      .getByRole('button', { name: '查看并处理邀请', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    const handlingDrawer = page.getByRole('dialog', { name: '任务接手邀请', exact: true });
    await expect(handlingDrawer.getByRole('article', { name: '接手邀请记录' })).toHaveCount(1);
    await expect(handlingDrawer.getByRole('article', { name: '接手邀请记录' })).toContainText(
      target.summary,
    );
    await expect(handlingDrawer.getByRole('region', { name: '固定接手材料' })).toBeVisible();
    expect(calls.legacy.length).toBeGreaterThan(0);
    expect(calls.legacy.every((item) => origin + item === legacyEndpoint)).toBe(true);
    expect(calls.writes).toEqual([]);
    await expect(page).toHaveURL(origin + path);
    // The explicitly opened old Card may finish a read while reload is still
    // navigating. Audit the new summary from the main document commit, before
    // its application requests; retain the original full-flow audit as well.
    let reloadedCalls: ReturnType<typeof audit> | undefined;
    const committed = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      reloadedCalls = audit(page);
      page.off('framenavigated', committed);
    };
    page.on('framenavigated', committed);
    try {
      await page.reload();
    } finally {
      page.off('framenavigated', committed);
    }
    expect(reloadedCalls).toBeDefined();
    await expect(summary(page)).toContainText(target.summary);
    await expect(drawer(page).getByRole('article', { name: '接手邀请记录' })).toHaveCount(0);
    reloadedCalls!.readOnly();
    expect(calls.legacy.every((item) => origin + item === legacyEndpoint)).toBe(true);
    expect(calls.writes).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    await drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }).click();
    await expect(handlingDrawer.getByRole('article', { name: '接手邀请记录' })).toHaveCount(1);
    const readsBeforeClosing = summaryReads;
    // Once explicitly handling, the existing card owns lifecycle changes. The
    // pending-only discovery summary must not mount again and hide that card.
    f.change(target, { state: 'withdrawn', revision: 2 });
    view.handoff.state = 'withdrawn';
    view.handoff.revision = 2;
    f.notify(target, 'handoff.withdrawn');
    const afterLifecycle = f.snapshot();
    await expect(handlingDrawer.getByRole('article', { name: '接手邀请记录' })).toContainText(
      '已撤回',
    );
    await expect(drawer(page)).toHaveCount(0);
    expect(summaryReads).toBe(readsBeforeClosing);
    expect(calls.legacy.every((item) => origin + item === legacyEndpoint)).toBe(true);
    expect(calls.writes).toEqual([]);
    expect(f.snapshot()).toEqual(afterLifecycle);
  });
});

for (const status of [200, 403]) {
  test(`切换分页后旧页${status}及SSE替代读取晚到不覆盖当前摘要`, async ({ page }) => {
    await usingFixture(page, 21, async (f, heldReads) => {
      const first = await f.incoming(),
        second = await f.incoming(first.nextCursor!);
      const calls = audit(page);
      const oldPageUrl = `${endpoint}?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`;
      await completeIncomingAfterAbort(page, oldPageUrl);
      await open(page, f);
      await expect(rows(page)).toHaveCount(20);
      const held = await holdReads(
        page,
        heldReads,
        (url) => url.pathname === '/api/v1/incoming-handoffs' && url.searchParams.has('cursor'),
        status,
        status === 200 ? second : { error: { code: 'FORBIDDEN', message: '旧页读取已拒绝' } },
      );
      await list(page).getByRole('link', { name: '较早邀请', exact: true }).click();
      await held.reached;
      const before = held.count();
      await refreshWorkbench(f, `分页读取中的真实事件 ${status}`);
      await expect.poll(() => held.count()).toBeGreaterThan(before);
      await expect(rows(page)).toHaveCount(0);
      const current = await holdReads(
        page,
        heldReads,
        (url) => url.pathname === '/api/v1/incoming-handoffs' && !url.searchParams.has('cursor'),
        200,
        first,
      );
      await page.goBack();
      await expect(page).toHaveURL(home());
      await current.reached;
      await expect(list(page).getByRole('status')).toContainText('正在读取待接手邀请');
      await drainConsumedReads(page, held, oldPageUrl);
      await expect(rows(page)).toHaveCount(0);
      await expect(list(page).getByRole('alert')).toHaveCount(0);
      await expect(list(page).getByRole('status')).toContainText('正在读取待接手邀请');
      await current.drain();
      await expect(rows(page)).toHaveCount(20);
      expect(await pageIds(page)).toEqual(first.items.map((item) => item.id));
      await page.goForward();
      await expect(rows(page)).toHaveCount(1);
      expect(await pageIds(page)).toEqual(second.items.map((item) => item.id));
      calls.readOnly();
    });
  });
}

for (const status of [200, 404]) {
  test(`关闭并切换精确目标后旧邀请${status}及SSE替代读取晚到不复活摘要`, async ({ page }) => {
    await usingFixture(page, 2, async (f, heldReads) => {
      const old = f.invitations[0]!,
        current = f.invitations[1]!;
      const oldSummary = await f.detail(old),
        calls = audit(page);
      await completeIncomingAfterAbort(page, targetEndpoint(old.taskId, old.id));
      await open(page, f);
      await expect(rows(page)).toHaveCount(2);
      const held = await holdReads(
        page,
        heldReads,
        targetEndpoint(old.taskId, old.id),
        status,
        status === 200 ? oldSummary : { error: { code: 'NOT_FOUND', message: '旧邀请不可用' } },
      );
      await row(page, old.id).getByRole('link', { name: '查看邀请摘要', exact: true }).click();
      await held.reached;
      const before = held.count();
      await refreshWorkbench(f, `精确摘要读取中的真实事件 ${status}`);
      await expect.poll(() => held.count()).toBeGreaterThan(before);
      await expect(summary(page)).not.toContainText(old.summary);
      await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
      await expect(drawer(page)).toHaveCount(0);
      const currentRead = await holdReads(
        page,
        heldReads,
        targetEndpoint(current.taskId, current.id),
        200,
        await f.detail(current),
      );
      await navigate(page, targetPath(current.taskId, current.id));
      await currentRead.reached;
      await expect(summary(page).getByRole('status')).toContainText('正在读取邀请摘要');
      await drainConsumedReads(page, held, targetEndpoint(old.taskId, old.id));
      await expect(summary(page).getByRole('status')).toContainText('正在读取邀请摘要');
      await expect(summary(page)).not.toContainText(current.summary);
      await expect(summary(page)).not.toContainText(old.summary);
      await expect(drawer(page).getByRole('alert')).toHaveCount(0);
      await expect(
        drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
      ).toBeDisabled();
      await expect(page).toHaveURL(origin + targetPath(current.taskId, current.id));
      await currentRead.drain();
      await expect(summary(page)).toContainText(current.summary);
      calls.readOnly();
    });
  });
}

for (const unavailable of ['withdrawn', 'expired', 'accepted'] as const) {
  test(`${{ withdrawn: '撤回', expired: '期限已过', accepted: '已接受' }[unavailable]}时真实SSE清空已打开摘要，重新进入也不调用旧接口`, async ({
    page,
  }) => {
    await usingFixture(page, 1, async (f) => {
      const target = f.invitations[0]!,
        calls = audit(page);
      await open(page, f, targetPath(target.taskId, target.id));
      await expect(summary(page)).toContainText(target.summary);
      if (unavailable !== 'expired') f.change(target, { state: unavailable, revision: 2 });
      else f.change(target, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const invitationBefore = f.api.store.db
        .prepare('SELECT * FROM handoffs WHERE id=?')
        .get(target.id);
      f.notify(target, `handoff.${unavailable}`);
      await expect(drawer(page)).not.toContainText(target.summary);
      await expect(
        drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
      ).toBeDisabled();
      await page.reload();
      await expect(drawer(page).getByRole('alert')).toBeVisible();
      await expect(drawer(page)).not.toContainText(target.summary);
      await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
      await navigate(page, '/');
      await expect(rows(page)).toHaveCount(0);
      const response = await f.api.call(`incoming-handoffs/${target.taskId}/${target.id}`, f.bob);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
      expect(f.api.store.db.prepare('SELECT * FROM handoffs WHERE id=?').get(target.id)).toEqual(
        invitationBefore,
      );
      calls.readOnly();
    });
  });
}

test('同一精确目标经过真实撤权再授权仍保持清空，明确刷新后才恢复摘要', async ({ page }) => {
  await usingFixture(page, 1, async (f) => {
    const target = f.invitations[0]!,
      calls = audit(page);
    await open(page, f, targetPath(target.taskId, target.id));
    await expect(summary(page)).toContainText(target.summary);
    const revoked = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: null,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(page.locator('body')).not.toContainText(target.summary);
    await expect(page.locator('body')).not.toContainText(f.task.title);
    const denied = await f.api.call(`incoming-handoffs/${target.taskId}/${target.id}`, f.bob);
    expect(denied.statusCode).toBe(404);
    const restored = await f.api.call(
      `projects/${f.project.id}/members/${f.bob.user.id}`,
      f.alice,
      { role: 'view' },
    );
    expect(restored.statusCode, restored.body).toBe(200);
    await expect(
      drawer(page).getByRole('button', { name: '刷新邀请摘要', exact: true }),
    ).toBeEnabled();
    await expect(drawer(page).getByRole('alert')).toContainText('先前摘要已清除');
    await expect(summary(page)).not.toContainText(target.summary);
    await expect(page).toHaveURL(origin + targetPath(target.taskId, target.id));
    await drawer(page).getByRole('button', { name: '刷新邀请摘要', exact: true }).click();
    await expect(summary(page)).toContainText(target.summary);
    await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
    await navigate(page, '/');
    await expect(rows(page)).toHaveCount(1);
    await expect(drawer(page)).toHaveCount(0);
    calls.readOnly();
  });
});

test('切换空间清除分页和旧摘要，旧空间所有晚到读取不能进入个人空间', async ({ page }) => {
  await usingFixture(page, 21, async (f, heldReads) => {
    const first = await f.incoming(),
      second = await f.incoming(first.nextCursor!);
    const calls = audit(page);
    await open(page, f);
    await expect(rows(page)).toHaveCount(20);
    const held = await holdReads(
      page,
      heldReads,
      (url) => url.pathname === '/api/v1/incoming-handoffs' && url.searchParams.has('cursor'),
      200,
      second,
    );
    await list(page).getByRole('link', { name: '较早邀请', exact: true }).click();
    await held.reached;
    await page
      .getByLabel('当前工作空间', { exact: true })
      .selectOption(`personal-${f.bob.user.id}`);
    await expect(page).toHaveURL(home());
    await expect(rows(page)).toHaveCount(0);
    await held.drain();
    await expect(page.locator('body')).not.toContainText(second.items[0]!.summary);
    await expect(drawer(page)).toHaveCount(0);
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(f.bob.spaceId);
    await expect(rows(page)).toHaveCount(20);
    expect(await pageIds(page)).toEqual(first.items.map((item) => item.id));
    await expect(page).toHaveURL(home());
    calls.readOnly();
  });
});

test('真实会话失效清除打开和在途摘要，换账号登录不恢复原接收者内容', async ({ page }) => {
  await usingFixture(page, 1, async (f, heldReads) => {
    const target = f.invitations[0]!,
      targetSummary = await f.detail(target),
      calls = audit(page);
    await subscribeAfterSetupEvents(page, f);
    await open(page, f, targetPath(target.taskId, target.id));
    await expect(summary(page)).toContainText(target.summary);
    const held = await holdReads(
      page,
      heldReads,
      targetEndpoint(target.taskId, target.id),
      200,
      targetSummary,
    );
    await refreshWorkbench(f, '会话撤销前的真实可见性事件');
    await held.reached;
    expect(held.count()).toBeGreaterThan(0);
    await expect(drawer(page).getByRole('status')).toContainText('正在读取邀请摘要');
    const revoked = await f.api.call('identity/revoke-sessions', f.bob, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(page.getByRole('heading', { name: '欢迎回到合序', exact: true })).toBeVisible();
    await held.drain();
    await expect(page.locator('body')).not.toContainText(target.summary);
    await expect(drawer(page)).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill(f.alice.user.email);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(f.alice.spaceId);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(target.summary);
    await expect(drawer(page)).toHaveCount(0);
    calls.readOnly();
  });
});

test('列表初次故障不冒充空列表，当前页短暂故障保留摘要，重复重试和无效游标可恢复', async ({
  page,
}) => {
  await usingFixture(page, 1, async (f, heldReads) => {
    const first = await f.incoming(),
      target = first.items[0]!,
      calls = audit(page);
    const pattern = (url: URL) => url.pathname === '/api/v1/incoming-handoffs';
    let failing = true;
    await page.route(pattern, (route) =>
      failing
        ? route.fulfill({
            status: 503,
            json: { error: { code: 'READ_FAILED', message: '邀请列表暂时读取失败' } },
          })
        : route.continue(),
    );
    await open(page, f);
    await expect(list(page).getByRole('alert')).toContainText('邀请列表暂时读取失败');
    await expect(rows(page)).toHaveCount(0);
    await expect(list(page)).not.toContainText('当前没有发给你的待接手邀请');
    const held = await holdReads(page, heldReads, pattern, 200, first);
    await list(page)
      .getByRole('button', { name: '重试读取待接手邀请', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await held.reached;
    await expect(list(page).getByRole('status')).toContainText('正在读取待接手邀请');
    await expect(rows(page)).toHaveCount(0);
    failing = false;
    await held.drain();
    await expect(row(page, target.id)).toContainText(target.summary);
    // Fault only the next background poll of this same visibility session.
    // Explicit refresh/SSE replacement is intentionally a different boundary.
    failing = true;
    await expect(list(page).getByRole('alert')).toContainText('邀请列表暂时读取失败');
    await expect(row(page, target.id)).toContainText(target.summary);
    await list(page).getByRole('button', { name: '刷新待接手邀请', exact: true }).click();
    await expect(list(page).getByRole('alert')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    failing = false;
    await navigate(page, '/?incomingCursor=invalid');
    await expect(list(page).getByRole('alert')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(list(page)).not.toContainText('此页没有可查看的待接手邀请');
    await list(page).getByRole('link', { name: '返回第一页', exact: true }).click();
    await expect(row(page, target.id)).toContainText(target.summary);
    calls.readOnly();
  });
});

test('当前精确摘要短暂故障保留可读内容但禁用处理，拒绝后只在明确刷新时重开', async ({ page }) => {
  await usingFixture(page, 1, async (f, heldReads) => {
    const target = f.invitations[0]!,
      value = await f.detail(target),
      calls = audit(page);
    await subscribeAfterSetupEvents(page, f);
    await open(page, f, targetPath(target.taskId, target.id));
    await expect(summary(page)).toContainText(target.summary);
    let status = 503;
    const pattern = targetEndpoint(target.taskId, target.id);
    await page.route(pattern, (route) =>
      status
        ? route.fulfill({
            status,
            json: {
              error: {
                code: status === 503 ? 'READ_FAILED' : 'NOT_FOUND',
                message: '邀请摘要暂时读取失败',
              },
            },
          })
        : route.continue(),
    );
    await expect(drawer(page).getByRole('alert')).toContainText('邀请摘要暂时读取失败');
    await expect(summary(page)).toContainText(target.summary);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeDisabled();
    const held = await holdReads(page, heldReads, pattern, 200, value);
    await drawer(page)
      .getByRole('button', { name: '重试读取邀请摘要', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await held.reached;
    await expect(summary(page)).not.toContainText(target.summary);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeDisabled();
    status = 0;
    await held.drain();
    await expect(summary(page)).toContainText(target.summary);
    status = 404;
    await expect(drawer(page).getByRole('alert')).toContainText('先前摘要已清除');
    await expect(summary(page)).not.toContainText(target.summary);
    status = 0;
    const refreshed = page.waitForResponse(
      (response) => response.url() === `${origin}/api/v1/workbench` && response.status() === 200,
    );
    await refreshWorkbench(f, '当前目标拒绝后新的可见性事件');
    await refreshed;
    await expect(drawer(page).getByRole('alert')).toContainText('先前摘要已清除');
    await expect(summary(page)).not.toContainText(target.summary);
    await drawer(page).getByRole('button', { name: '刷新邀请摘要', exact: true }).click();
    await expect(summary(page)).toContainText(target.summary);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeEnabled();
    calls.readOnly();
  });
});

test('本地期限经过时清除已加载摘要，晚到成功读取不能使过期目标复活', async ({ page }) => {
  await usingFixture(page, 1, async (f, heldReads) => {
    const start = Date.now(),
      target = f.invitations[0]!,
      calls = audit(page);
    f.change(target, { expiresAt: new Date(start + 60_000).toISOString() });
    const value = await f.detail(target),
      before = f.snapshot();
    await completeIncomingAfterAbort(page, targetEndpoint(target.taskId, target.id));
    await page.clock.install({ time: new Date(start) });
    await subscribeAfterSetupEvents(page, f);
    await open(page, f, targetPath(target.taskId, target.id));
    await expect(summary(page)).toContainText(target.summary);
    const held = await holdReads(
      page,
      heldReads,
      targetEndpoint(target.taskId, target.id),
      200,
      value,
    );
    await page.clock.fastForward(3001);
    await held.reached;
    expect(held.count()).toBeGreaterThan(0);
    // This is a same-session background poll, not a visibility replacement.
    await expect(summary(page)).toContainText(target.summary);
    await page.clock.fastForward(57_000);
    await expect(drawer(page).getByRole('alert')).toContainText('先前摘要已清除');
    await expect(summary(page)).not.toContainText(target.summary);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeDisabled();
    await drainConsumedReads(page, held, targetEndpoint(target.taskId, target.id));
    await expect(drawer(page).getByRole('alert')).toContainText('先前摘要已清除');
    await expect(summary(page)).not.toContainText(target.summary);
    await expect(
      drawer(page).getByRole('button', { name: '查看并处理邀请', exact: true }),
    ).toBeDisabled();
    // The browser deadline is presentation-only: it cannot persist lifecycle
    // expiry or change any task, acceptance, material, or execution record.
    calls.readOnly();
    expect(f.snapshot()).toEqual(before);
  });
});

test('已加载第二页的游标锚点失效后清除旧摘要，返回第一页仍保留其他URL参数', async ({ page }) => {
  await usingFixture(page, 21, async (f) => {
    const first = await f.incoming(),
      second = await f.incoming(first.nextCursor!);
    const anchor = f.invitations.find((item) => item.id === first.items.at(-1)!.id)!;
    const calls = audit(page);
    await open(page, f, `/?keep=1&incomingCursor=${encodeURIComponent(first.nextCursor!)}`);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, second.items[0]!.id)).toContainText(second.items[0]!.summary);
    // No event/new visibility key: the next poll of this loaded page itself
    // returns INVALID_CURSOR and must not retain the previous page as current.
    f.change(anchor, { state: 'withdrawn', revision: 2 });
    await expect(list(page).getByRole('alert')).toContainText('邀请列表位置已无效');
    await expect(rows(page)).toHaveCount(0);
    await list(page).getByRole('link', { name: '返回第一页', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/?keep=1`);
    await expect(rows(page)).toHaveCount(20);
    calls.readOnly();
  });
});

for (const query of ['incomingCursor=', 'incomingCursor=first&incomingCursor=second']) {
  test(`无效分页URL ${query} 不默读第一页，明确返回才读取当前空间`, async ({ page }) => {
    await usingFixture(page, 1, async (f) => {
      const reads: string[] = [],
        calls = audit(page);
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/incoming-handoffs')
          reads.push(request.url());
      });
      await open(page, f, `/?${query}&keep=1`);
      await expect(list(page).getByRole('alert')).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
      expect(reads).toEqual([]);
      await list(page).getByRole('link', { name: '返回第一页', exact: true }).click();
      await expect(page).toHaveURL(`${origin}/?keep=1`);
      await expect(rows(page)).toHaveCount(1);
      expect(reads.length).toBeGreaterThan(0);
      calls.readOnly();
    });
  });
}
