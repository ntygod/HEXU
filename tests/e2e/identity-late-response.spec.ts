import { test, expect, type Page, type Route } from '@playwright/test';
import { teamFixture, PASSWORD, type Account } from '../helpers/team.js';
import type { Task } from '../../packages/contracts/src/index.js';

const origin = 'http://127.0.0.1:4345';
const identity = `${origin}/api/v1/identity`;
const workbench = `${origin}/api/v1/workbench`;
const fresh = (page: Page) => page.getByRole('dialog', { name: '开始一项工作', exact: true });
const space = (page: Page) => page.getByLabel('当前工作空间', { exact: true });
const nextInput = { title: '新身份的任务输入', description: '旧回应不能清除此处的未发送说明' };

async function fixture() {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, project.id, '迟到回应的原任务')) as Task;
    const grant = await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    return { api, alice, bob, project, task };
  } catch (error) {
    await api.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Held = Awaited<ReturnType<typeof hold>>;

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
async function hold(page: Page, url: string, beforeFetch = true) {
  const requestGate = gate(),
    responseGate = gate();
  if (!beforeFetch) requestGate.release();
  let capturing = true;
  const records: { status?: number; value?: unknown }[] = [];
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '迟到响应夹具失败');
  };
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    const record: (typeof records)[number] = {};
    records.push(record);
    const operation = (async () => {
      // Preserve the actual outgoing Cookie/space, including across later sign-in.
      const headers = await route.request().allHeaders();
      await requestGate.promise;
      const response = await route.fetch({ headers });
      record.status = response.status();
      record.value = await response.json();
      await responseGate.promise;
      await route.fulfill({ response });
    })().catch((error) => errors.push(error));
    pending.push(operation.then(() => {}));
    await operation;
  };
  await page.route(url, handler);
  return {
    records,
    async reached(status?: number) {
      await expect
        .poll(() => {
          check();
          return status === undefined
            ? records.length
            : records.filter((record) => record.status === status).length;
        })
        .toBeGreaterThan(0);
    },
    stopCapture() {
      capturing = false;
    },
    send() {
      requestGate.release();
    },
    async deliver() {
      capturing = false;
      requestGate.release();
      responseGate.release();
      await Promise.all(pending);
      check();
    },
    async dispose() {
      await this.deliver();
      await page.unroute(url, handler);
    },
  };
}
async function run(page: Page, scenario: (f: Fixture, held: Held[]) => Promise<void>) {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await scenario(f, held);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const close of [
      ...held.map((request) => () => request.dispose()),
      () => page.unrouteAll({ behavior: 'wait' }),
      () => page.context().close(),
      () => f.api.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      if (failed) console.error('迟到响应清理错误（保留原失败）', errors);
      else throw new AggregateError(errors, '迟到响应夹具清理失败');
    }
  }
}
async function open(page: Page, f: Fixture) {
  await f.api.app.listen({ port: 4345, host: '127.0.0.1' });
  await page.context().addCookies(
    f.bob.cookie.split('; ').map((cookie) => {
      const split = cookie.indexOf('=');
      return {
        name: cookie.slice(0, split),
        value: cookie.slice(split + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
  const cursor = f.api.store.db.prepare('SELECT MAX(sequence) AS value FROM outbox').get() as {
    value: number;
  };
  await page.addInitScript(
    ({ userId, spaceId, cursor }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      const NativeEventSource = window.EventSource;
      const streams: EventSource[] = [];
      const events: string[] = [];
      Object.assign(window, { __identityStreams: streams, __identityEvents: events });
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          const target = new URL(url, location.href);
          target.searchParams.set('after', String(cursor));
          super(target, options);
          streams.push(this);
        }
      };
      for (const event of ['hexu-auth-required', 'hexu-space-revoked'])
        window.addEventListener(event, () => events.push(event));
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, cursor: cursor.value },
  );
  // Isolate the HTTP response boundary; existing team/creation suites cover live SSE.
  await page.route(`${origin}/api/v1/events**`, (route) => route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(space(page)).toHaveValue(f.bob.spaceId);
}
async function settings(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '资源与设置', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
}
async function signOut(page: Page) {
  await settings(page);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录工作台', exact: true })).toBeVisible();
}
async function signIn(page: Page, account: Account, email: string) {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await space(page).selectOption(account.spaceId);
  await expect(space(page)).toHaveValue(account.spaceId);
}
async function draft(page: Page) {
  await page.getByRole('button', { name: '打开命令面板', exact: true }).click();
  await page
    .getByRole('dialog', { name: '搜索与快捷操作', exact: true })
    .getByRole('button', { name: '新建任务', exact: true })
    .click();
  await fresh(page).getByLabel('要做什么', { exact: true }).fill(nextInput.title);
  await fresh(page).getByLabel('补充说明').fill(nextInput.description);
}
async function events(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __identityEvents: string[] }).__identityEvents,
  );
}
async function unchanged(page: Page, account: Account, spaceId: string, before: string[]) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // Observe immediately after delivery; retrying assertions could hide a teardown.
  expect(await events(page)).toEqual(before);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await space(page).inputValue()).toBe(spaceId);
  expect(await page.locator('.workbench-profile').getAttribute('title')).toBe(account.user.name);
  expect(await fresh(page).isVisible()).toBe(true);
  expect(await fresh(page).getByLabel('要做什么', { exact: true }).inputValue()).toBe(
    nextInput.title,
  );
  expect(await fresh(page).getByLabel('补充说明').inputValue()).toBe(nextInput.description);
  expect(await fresh(page).getByRole('button', { name: '创建任务', exact: true }).isEnabled()).toBe(
    true,
  );
}
async function start(page: Page, f: Fixture) {
  await page.locator(`a.context-link[href="/projects/${f.project.id}"]`).click();
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await page.getByLabel(`${f.task.shortId} 状态`, { exact: true }).selectOption('in_progress');
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
    test(`普通任务${source}的真实${denial === 'session' ? '401' : '空间撤权403'}迟到不清新账号或空间`, async ({
      page,
    }) => {
      await run(page, async (f, held) => {
        await open(page, f);
        const url = source === 'POST' ? `${origin}/api/v1/tasks/${f.task.id}/start` : workbench;
        const old = await hold(page, url);
        held.push(old);
        const writes: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().endsWith(`/tasks/${f.task.id}/start`))
            writes.push(request.postData()!);
        });
        await start(page, f);
        await old.reached();
        old.stopCapture();
        if (denial === 'session') await signOut(page);
        else {
          await space(page).selectOption(`personal-${f.bob.user.id}`);
          await expect(space(page)).toHaveValue(`personal-${f.bob.user.id}`);
          await expire(f, 'space');
        }
        old.send();
        await old.reached(denial === 'session' ? 401 : 403);
        if (denial === 'space')
          expect(old.records[0]!.value).toMatchObject({ error: { code: 'SPACE_ACCESS_REVOKED' } });
        if (denial === 'session') await signIn(page, f.alice, 'alice@example.invalid');
        await draft(page);
        const before = await events(page);
        const rows = f.api.store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
        const delivered = page.waitForResponse(
          (response) =>
            response.url() === url && response.status() === (denial === 'session' ? 401 : 403),
        );
        await old.deliver();
        await (await delivered).finished();
        await unchanged(
          page,
          denial === 'session' ? f.alice : f.bob,
          denial === 'session' ? f.alice.spaceId : `personal-${f.bob.user.id}`,
          before,
        );
        expect(old.records).toHaveLength(1);
        expect(writes).toHaveLength(1);
        expect(f.api.store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all()).toEqual(rows);
      });
    });
  }
}

test('同一账号退出再登录原空间后，旧任务401也不能清除新草稿', async ({ page }) => {
  await run(page, async (f, held) => {
    await open(page, f);
    const old = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/start`);
    held.push(old);
    await start(page, f);
    await old.reached();
    old.stopCapture();
    await signOut(page);
    old.send();
    await old.reached(401);
    await signIn(page, f.bob, 'bob@example.invalid');
    await draft(page);
    const before = await events(page);
    await old.deliver();
    await unchanged(page, f.bob, f.bob.spaceId, before);
  });
});

for (const denial of ['session', 'space'] as const) {
  test(`当前普通任务${denial === 'session' ? '401仍恢复登录入口' : 'GET空间撤权403仍清除旧空间'}`, async ({
    page,
  }) => {
    await run(page, async (f, held) => {
      await open(page, f);
      const current = await hold(
        page,
        denial === 'session' ? `${origin}/api/v1/tasks/${f.task.id}/start` : workbench,
      );
      held.push(current);
      await start(page, f);
      await current.reached();
      current.stopCapture();
      await draft(page);
      await expire(f, denial);
      current.send();
      await current.reached(denial === 'session' ? 401 : 403);
      await current.deliver();
      await expect(fresh(page)).toHaveCount(0);
      if (denial === 'session') {
        await expect(page.getByRole('button', { name: '登录工作台', exact: true })).toBeVisible();
        expect(await events(page)).toContain('hexu-auth-required');
      } else {
        await expect(space(page)).toHaveValue(`personal-${f.bob.user.id}`);
        expect(await events(page)).toContain('hexu-space-revoked');
        await draft(page);
      }
    });
  });
}

for (const reset of ['space', 'identity'] as const) {
  test(`旧身份查询成功迟到不覆盖之后的${reset === 'space' ? '空间选择' : '新账号'}`, async ({
    page,
  }) => {
    await run(page, async (f, held) => {
      await open(page, f);
      await settings(page);
      const old = await hold(page, identity, false);
      held.push(old);
      await page.getByLabel('团队空间名称', { exact: true }).fill('旧身份查询中的新空间');
      await page.getByRole('button', { name: '创建空间', exact: true }).click();
      await old.reached(200);
      old.stopCapture();
      expect(old.records[0]!.value).toMatchObject({ user: { id: f.bob.user.id } });
      if (reset === 'identity') {
        await page.getByRole('button', { name: '退出登录', exact: true }).click();
        await expect(page.getByRole('button', { name: '登录工作台', exact: true })).toBeVisible();
        await signIn(page, f.alice, 'alice@example.invalid');
      } else {
        await space(page).selectOption(`personal-${f.bob.user.id}`);
        await expect(space(page)).toHaveValue(`personal-${f.bob.user.id}`);
      }
      await draft(page);
      const before = await events(page);
      await old.deliver();
      await unchanged(
        page,
        reset === 'identity' ? f.alice : f.bob,
        reset === 'identity' ? f.alice.spaceId : `personal-${f.bob.user.id}`,
        before,
      );
    });
  });
}
