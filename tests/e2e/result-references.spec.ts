import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { teamFixture, type Account } from '../helpers/team.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import type { Task } from '../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../packages/contracts/src/results.js';
import type {
  ResultReference,
  ResultReferencePage,
} from '../../packages/contracts/src/result-references.js';
import type { MemberResultVersionReceipt } from '../../packages/contracts/src/member-result-versions.js';

const origin = 'http://127.0.0.1:4332';
async function fixture() {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair(),
      project = await api.project(alice);
    await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const task = (await api.task(alice, project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() =>
      api.store.createResult(task.id, '取消行为说明', 'FIXED_VERSION_ONE_BODY', randomUUID()),
    );
    const version = as(() => new ResultRevisions(api.store).current(result));
    const path = (revision = version) => `results/${result.id}/versions/${revision.id}/references`;
    const list = async (revision = version) => {
      const response = await api.call(path(revision) + '?limit=50', alice);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as ResultReferencePage;
    };
    const register = async (title: string, revision = version, account: Account = alice) => {
      const response = await api.call(path(revision), account, {
        action: 'register',
        expectedResultRevision: revision.revision,
        kind: 'report',
        title,
        url: `https://reports.example.invalid/${encodeURIComponent(title)}#summary`,
        environment: '测试环境',
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as ResultReference;
    };
    const withdraw = async (reference: ResultReference, account: Account = alice) => {
      const response = await api.call(`${path()}/${reference.id}/lifecycle`, account, {
        action: 'withdraw',
        expectedResultRevision: reference.resultRevision,
        expectedRevision: reference.revision,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as ResultReference;
    };
    const saveVersion = async () => {
      const current = as(() => new ResultRevisions(api.store).detail(result.id).version);
      const response = await api.call(`results/${result.id}/versions`, alice, {
        expectedRevision: current.revision,
        expectedRevisionId: current.id,
        title: '补充后的取消行为说明',
        body: 'FIXED_VERSION_TWO_BODY',
      });
      expect(response.statusCode, response.body).toBe(201);
      const receipt = response.json() as MemberResultVersionReceipt;
      return as(() => new ResultRevisions(api.store).get(result.id, receipt.revisionId));
    };
    return {
      api,
      alice,
      bob,
      project,
      task,
      result,
      version,
      as,
      path,
      list,
      register,
      withdraw,
      saveVersion,
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const url = (f: Fixture, revision = f.version) =>
  `${origin}/results/${f.result.id}/versions/${revision.id}`;
const endpoint = (f: Fixture, revision = f.version) => `${origin}/api/v1/${f.path(revision)}`;
const section = (page: Page) => page.getByRole('region', { name: '此版本的报告与发布链接' });
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '登记报告或发布链接', exact: true });
const withdrawal = (page: Page) =>
  page.getByRole('dialog', { name: '撤下这条链接登记', exact: true });
const row = (page: Page, reference: ResultReference) =>
  section(page).locator(`[data-reference-id="${reference.id}"]`);
const packet = (request: Request) => ({
  path: request.url(),
  body: request.postData(),
  key: request.headers()['idempotency-key'],
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function open(page: Page, f: Fixture, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4332, host: '127.0.0.1' });
  const account = bob ? f.bob : f.alice;
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
  await page.addInitScript(
    ({ userId, spaceId }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', 'dark');
    },
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(url(f));
  await expect(section(page)).toBeVisible();
}
async function edit(page: Page) {
  await section(page)
    .getByRole('button', {
      name: /^(登记报告或发布链接|继续编辑链接登记|确认原链接登记)$/,
    })
    .click();
  await expect(editor(page)).toBeVisible();
}
async function fill(
  page: Page,
  title: string,
  address = 'https://reports.example.invalid/release-1#summary',
) {
  await editor(page).getByLabel('链接标题', { exact: true }).fill(title);
  await editor(page).getByLabel('稳定链接', { exact: true }).fill(address);
}
async function switchVersion(page: Page, f: Fixture, version: ResultRevision) {
  await page.getByLabel('查看固定版本').selectOption(version.id);
  await expect(page).toHaveURL(url(f, version));
  await expect(section(page)).toContainText(`只关联当前v${version.revision}`);
}
async function close(page: Page, f: Fixture, preserveFailure = false) {
  const errors: unknown[] = [];
  for (const cleanup of [
    () => page.unrouteAll({ behavior: 'ignoreErrors' }),
    () => page.context().close(),
    () => f.api.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;
  if (!preserveFailure) throw new AggregateError(errors, '链接登记浏览器夹具清理失败');
  test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
}

test('成员明确登记与撤下固定v1的发布链接，新v2不抢来源；键盘、明暗色与手机可用且不执行部署', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const writes: ReturnType<typeof packet>[] = [],
      external: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') writes.push(packet(request));
      if (new URL(request.url()).origin !== origin) external.push(request.url());
    });
    await open(page, f, true);
    const taskBefore = f.as(() => f.api.store.getTask(f.task.id));
    await edit(page);
    await expect(editor(page).getByLabel('链接类型', { exact: true })).toBeFocused();
    await editor(page).getByLabel('链接类型', { exact: true }).press('ArrowDown');
    await expect(editor(page).getByLabel('链接类型', { exact: true })).toHaveValue('release');
    await page.keyboard.press('Tab');
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toBeFocused();
    await fill(
      page,
      '取消行为发布说明',
      'https://releases.example.invalid/release-1?token=fictional',
    );
    await editor(page).getByLabel('环境说明（可选）').fill('测试环境，等待成员核对');
    await editor(page).getByRole('button', { name: '确认登记到v1', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('不含查询参数');
    expect(writes).toHaveLength(0);
    await editor(page)
      .getByLabel('稳定链接', { exact: true })
      .fill('https://releases.example.invalid/release-1#changes');
    const v2 = await f.saveVersion();
    await expect(page.getByLabel('查看固定版本').locator('option')).toHaveCount(2);
    await expect(editor(page).getByLabel('链接的固定成果版本')).toContainText('取消行为说明 · v1');
    await expect(editor(page)).toContainText('不读取外部内容或触发部署');
    await mkdir('artifacts', { recursive: true });
    await editor(page).screenshot({ path: 'artifacts/162-result-reference-editor-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await editor(page).screenshot({
      path: 'artifacts/163-result-reference-editor-mobile-light.png',
    });
    expect(
      await editor(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(
      (await editor(page).getByLabel('稳定链接', { exact: true }).boundingBox())!.width,
    ).toBeGreaterThan(240);
    const confirm = editor(page).getByRole('button', { name: '确认登记到v1', exact: true });
    const reachable = async () => {
      await confirm.scrollIntoViewIfNeeded();
      const box = (await confirm.boundingBox())!,
        modal = (await editor(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(modal.x);
      expect(box.x + box.width).toBeLessThanOrEqual(modal.x + modal.width);
      expect(box.y).toBeGreaterThanOrEqual(modal.y);
      expect(box.y + box.height).toBeLessThanOrEqual(modal.y + modal.height);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(
        await confirm.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      ).toBe(true);
    };
    // The first mobile capture retains the validation message and top fields.
    // Inspect the real scrollable footer too, then exercise interruption and pointer use.
    await reachable();
    await editor(page).screenshot({
      path: 'artifacts/163b-result-reference-editor-mobile-actions.png',
    });
    await page.keyboard.press('Escape');
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      '取消行为发布说明',
    );
    await expect(editor(page).getByLabel('稳定链接', { exact: true })).toHaveValue(
      'https://releases.example.invalid/release-1#changes',
    );
    await reachable();
    await confirm.click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page).toHaveURL(url(f));
    const references = await f.list();
    expect(references.items).toHaveLength(1);
    const reference = references.items[0]!;
    expect(reference).toMatchObject({
      resultRevisionId: f.version.id,
      resultRevision: 1,
      kind: 'release',
      status: 'active',
      availability: 'unverified',
      publication: 'unverified',
      source: { kind: 'member', actor: { id: f.bob.user.id, name: f.bob.user.name } },
    });
    await expect(row(page, reference)).toContainText(`${f.bob.user.name} 手动登记`);
    await expect(row(page, reference)).toContainText('外部内容与发布状态未核验');
    const link = row(page, reference).getByRole('link');
    await expect(link).toHaveAttribute('href', reference.url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await switchVersion(page, f, v2);
    await expect(section(page)).toContainText('此版本没有链接登记');
    await switchVersion(page, f, f.version);
    await row(page, reference).getByRole('button', { name: '撤下登记', exact: true }).click();
    await expect(withdrawal(page).getByLabel('准备撤下的固定登记')).toContainText(
      '取消行为说明 · v1',
    );
    await withdrawal(page).getByRole('button', { name: '取消', exact: true }).press('Enter');
    await expect(withdrawal(page)).toHaveCount(0);
    expect((await f.list()).items[0]!.status).toBe('active');
    await row(page, reference).getByRole('button', { name: '撤下登记', exact: true }).click();
    await withdrawal(page)
      .getByRole('button', { name: '确认撤下登记', exact: true })
      .press('Enter');
    await expect(withdrawal(page)).toHaveCount(0);
    await expect(row(page, reference)).toContainText('已撤下');
    await expect(row(page, reference).getByRole('link')).toHaveCount(0);
    await row(page, reference).getByText('查看原登记地址', { exact: true }).click();
    await expect(row(page, reference)).toContainText(reference.url);
    await expect(row(page, reference)).toContainText('撤下登记；原记录保留');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await section(page).scrollIntoViewIfNeeded();
    await section(page).screenshot({
      path: 'artifacts/164-result-reference-history-mobile.png',
    });
    expect((await section(page).boundingBox())!.width).toBeGreaterThan(280);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect((await f.list(v2)).items).toHaveLength(0);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(taskBefore);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
    expect(f.as(() => new ResultRevisions(f.api.store).get(f.result.id, f.version.id))).toEqual(
      f.version,
    );
    expect(f.as(() => new ResultRevisions(f.api.store).detail(f.result.id)).revisions).toHaveLength(
      2,
    );
    expect(writes.map((write) => write.path)).toEqual([
      endpoint(f),
      `${endpoint(f)}/${reference.id}/lifecycle`,
    ]);
    expect(external).toEqual([]);
    await page.reload();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await expect(row(page, reference)).toContainText('已撤下');
  } finally {
    await close(page, f);
  }
});

test('链接草稿按版本及成果隔离，SPA返回保留而硬刷新清除；短暂读取失败保留，拒绝后重读不得复活', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const v2 = await f.saveVersion();
    const other = f.as(() =>
      f.api.store.createResult(f.task.id, '另一份成果', 'OTHER_RESULT', randomUUID()),
    );
    await open(page, f);
    await edit(page);
    await fill(page, 'VERSION_ONE_DRAFT');
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    await fill(page, 'VERSION_TWO_DRAFT');
    await page.keyboard.press('Escape');
    await page.goBack();
    await expect(page).toHaveURL(url(f));
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await edit(page);
    await expect(editor(page).getByLabel('链接的固定成果版本')).toContainText('取消行为说明 · v1');
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_ONE_DRAFT',
    );
    await page.keyboard.press('Escape');
    await page.goForward();
    await expect(page).toHaveURL(url(f, v2));
    await expect(page.getByLabel('查看固定版本')).toHaveValue(v2.id);
    await edit(page);
    await expect(editor(page).getByLabel('链接的固定成果版本')).toContainText(
      '补充后的取消行为说明 · v2',
    );
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_TWO_DRAFT',
    );
    await page.keyboard.press('Escape');
    await page.locator('a[href="/results"]').first().click();
    await page.locator(`.work-result-card[href="/results/${other.id}"]`).click();
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    await fill(page, 'OTHER_RESULT_DRAFT');
    await page.keyboard.press('Escape');
    await page.locator('a[href="/results"]').first().click();
    await page.locator(`.work-result-card[href="/results/${f.result.id}"]`).click();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(v2.id);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_TWO_DRAFT',
    );
    await page.keyboard.press('Escape');
    await switchVersion(page, f, f.version);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_ONE_DRAFT',
    );
    let status: 0 | 503 | 403 = 503;
    await page.route(endpoint(f), async (route) => {
      if (route.request().method() === 'GET' && status)
        await route.fulfill({
          status,
          json: {
            error: { message: status === 503 ? '链接临时读取失败' : '此版本链接读取已拒绝' },
          },
        });
      else await route.continue();
    });
    await expect(section(page).getByRole('alert')).toContainText('链接临时读取失败');
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_ONE_DRAFT',
    );
    await page.keyboard.press('Escape');
    status = 0;
    await section(page).getByRole('button', { name: '重读链接登记' }).click();
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_ONE_DRAFT',
    );
    status = 403;
    await expect(section(page).getByRole('alert')).toContainText('此版本链接读取已拒绝');
    await expect(editor(page)).toHaveCount(0);
    await expect(
      section(page).getByRole('button', { name: /^(登记报告或发布链接|继续编辑链接登记)$/ }),
    ).toBeDisabled();
    status = 0;
    await section(page).getByRole('button', { name: '重读链接登记' }).click();
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    await expect(editor(page).getByLabel('稳定链接', { exact: true })).toHaveValue('');
    await fill(page, 'HARD_REFRESH_MUST_CLEAR');
    await page.keyboard.press('Escape');
    await page.reload();
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    await editor(page).getByRole('button', { name: '放弃未提交登记' }).click();
    await switchVersion(page, f, v2);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    expect((await f.list()).items).toHaveLength(0);
    expect((await f.list(v2)).items).toHaveLength(0);
  } finally {
    await close(page, f);
  }
});

test('真实成员降权清除所有版本草稿，重新授权后晚到写入拒绝不得恢复正文或待确认包', async ({
  page,
}) => {
  const f = await fixture(),
    held = gate(),
    reached = gate(),
    finished = gate();
  try {
    const v2 = await f.saveVersion();
    await page.route(endpoint(f), async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      reached.resolve();
      await held.promise;
      try {
        await route.fulfill({ status: 409, json: { error: { message: '晚到旧登记拒绝' } } });
      } finally {
        finished.resolve();
      }
    });
    await open(page, f, true);
    await switchVersion(page, f, v2);
    await edit(page);
    await fill(page, 'REVOKED_VERSION_TWO');
    await page.keyboard.press('Escape');
    await switchVersion(page, f, f.version);
    await edit(page);
    await fill(page, 'REVOKED_PENDING_VERSION_ONE');
    await editor(page).getByRole('button', { name: '确认登记到v1', exact: true }).click();
    await reached.promise;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await expect(
      section(page).getByRole('button', { name: '登记报告或发布链接', exact: true }),
    ).toBeDisabled();
    const denied = await f.api.call(f.path(), f.bob, {
      action: 'register',
      expectedResultRevision: 1,
      kind: 'report',
      title: 'DENIED_WRITE',
      url: 'https://reports.example.invalid/denied',
    });
    expect(denied.statusCode).toBe(403);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    held.resolve();
    await finished.promise;
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toBeEnabled();
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    await expect(editor(page).getByLabel('原链接登记待确认')).toHaveCount(0);
    await expect(editor(page).getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    expect((await f.list()).items).toHaveLength(0);
  } finally {
    held.resolve();
    await close(page, f);
  }
});

test('登记丢ACK后重放同一包只返回已撤下的当前投影；撤下丢ACK也保留原修订与幂等键', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const attempts: ReturnType<typeof packet>[] = [];
    let drop = true;
    await page.route(endpoint(f), async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      attempts.push(packet(route.request()));
      const response = await route.fetch();
      if (drop) {
        drop = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await open(page, f);
    await edit(page);
    await fill(page, 'ORIGINAL_REGISTER_PACKET');
    await editor(page).getByRole('button', { name: '确认登记到v1', exact: true }).click();
    await expect(editor(page).getByLabel('原链接登记待确认')).toBeVisible();
    await expect(
      editor(page).getByRole('button', { name: '确认原登记是否已保存', exact: true }),
    ).toBeEnabled();
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toBeDisabled();
    const reference = (await f.list()).items[0]!;
    await f.withdraw(reference, f.bob);
    const v2 = await f.saveVersion();
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await switchVersion(page, f, f.version);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'ORIGINAL_REGISTER_PACKET',
    );
    await editor(page).getByRole('button', { name: '确认原登记是否已保存', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]!.key).toBeTruthy();
    expect(JSON.parse(attempts[0]!.body!)).toMatchObject({
      expectedResultRevision: 1,
      title: 'ORIGINAL_REGISTER_PACKET',
    });
    await expect(
      page.getByText('原登记已撤下，确认回执没有恢复链接', { exact: true }),
    ).toBeVisible();
    await expect(row(page, reference)).toContainText('已撤下');
    await expect(row(page, reference).getByRole('link')).toHaveCount(0);
    expect((await f.list()).items).toHaveLength(1);
    expect((await f.list()).items[0]).toMatchObject({
      id: reference.id,
      revision: 2,
      status: 'withdrawn',
    });
    expect((await f.list(v2)).items).toHaveLength(0);

    const second = await f.register('WITHDRAW_ORIGINAL_PACKET');
    const withdrawalAttempts: ReturnType<typeof packet>[] = [];
    let dropWithdrawal = true;
    await page.route(`${endpoint(f)}/${second.id}/lifecycle`, async (route) => {
      withdrawalAttempts.push(packet(route.request()));
      const response = await route.fetch();
      if (dropWithdrawal) {
        dropWithdrawal = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await row(page, second).getByRole('button', { name: '撤下登记', exact: true }).click();
    await withdrawal(page).getByRole('button', { name: '确认撤下登记', exact: true }).click();
    await expect(withdrawal(page).getByLabel('原撤下请求待确认')).toBeVisible();
    await expect(
      withdrawal(page).getByRole('button', { name: '确认原请求是否已撤下', exact: true }),
    ).toBeEnabled();
    await expect(row(page, second)).toContainText('已撤下');
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await switchVersion(page, f, f.version);
    await row(page, second).getByRole('button', { name: '确认原撤下请求', exact: true }).click();
    await withdrawal(page)
      .getByRole('button', { name: '确认原请求是否已撤下', exact: true })
      .click();
    await expect(withdrawal(page)).toHaveCount(0);
    expect(withdrawalAttempts).toHaveLength(2);
    expect(withdrawalAttempts[1]).toEqual(withdrawalAttempts[0]);
    expect(JSON.parse(withdrawalAttempts[0]!.body!)).toEqual({
      action: 'withdraw',
      expectedResultRevision: 1,
      expectedRevision: 1,
    });
    const final = (await f.list()).items;
    expect(final).toHaveLength(2);
    expect(final.every((item) => item.status === 'withdrawn' && item.revision === 2)).toBe(true);
    await expect(
      row(page, second).getByRole('button', { name: '确认原撤下请求', exact: true }),
    ).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});

test('链接分页真实读取前后页，撤下记录保留；旧页晚到拒绝不清空新版编辑或污染返回后的第一页', async ({
  page,
}) => {
  const f = await fixture(),
    held = gate(),
    reached = gate();
  const pendingReads: Promise<void>[] = [];
  let failed = false,
    holdReads = true;
  try {
    const references: ResultReference[] = [];
    for (let index = 1; index <= 23; index++)
      references.push(await f.register(`PAGED_REPORT_${String(index).padStart(2, '0')}`));
    await f.withdraw(references[22]!);
    const v2 = await f.saveVersion();
    await open(page, f);
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(20);
    await expect(row(page, references[22]!)).toContainText('已撤下');
    const pagination = section(page).getByRole('navigation', { name: '链接登记分页' });
    await expect(pagination.getByRole('button', { name: '较新的登记' })).toBeDisabled();
    await pagination.getByRole('button', { name: '较早的登记' }).click();
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(3);
    await expect(pagination).toContainText('第2页');
    await expect(pagination.getByRole('button', { name: '较早的登记' })).toBeDisabled();
    await expect(row(page, references[0]!)).toBeVisible();
    await pagination.getByRole('button', { name: '较新的登记' }).click();
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(20);
    const pattern = `${endpoint(f)}?cursor=*`;
    const delayOldPage = async (route: Route) => {
      if (!holdReads) return route.continue();
      const response = held.promise.then(() =>
        route.fulfill({ status: 403, json: { error: { message: '旧分页读取已取消' } } }),
      );
      pendingReads.push(response);
      reached.resolve();
      await response;
    };
    await page.route(pattern, delayOldPage);
    await pagination.getByRole('button', { name: '较早的登记' }).click();
    await reached.promise;
    await expect(section(page).getByRole('status')).toContainText('正在读取此版本的链接');
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(0);
    await switchVersion(page, f, v2);
    holdReads = false;
    await edit(page);
    await fill(page, 'NEW_VERSION_DRAFT_SURVIVES_OLD_READ');
    // Keep the interceptor installed until its old Routes have been fulfilled.
    // New reads already pass through because this session no longer captures.
    held.resolve();
    await Promise.all(pendingReads);
    await page.unroute(pattern, delayOldPage);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'NEW_VERSION_DRAFT_SURVIVES_OLD_READ',
    );
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(0);
    await expect(section(page).getByRole('navigation', { name: '链接登记分页' })).toHaveCount(0);
    await switchVersion(page, f, f.version);
    await expect(section(page).locator('[data-reference-id]')).toHaveCount(20);
    await expect(pagination).toContainText('第1页');
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue('');
    expect((await f.list()).items).toHaveLength(23);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    holdReads = false;
    held.resolve();
    try {
      const settled = await Promise.allSettled(pendingReads);
      const errors = settled.filter((item) => item.status === 'rejected');
      if (errors.length && !failed) {
        failed = true;
        throw new AggregateError(
          errors.map((item) => item.reason),
          '旧链接分页读取未完成',
        );
      }
    } finally {
      await close(page, f, failed);
    }
  }
});

test('挂起登记后SPA转到另一版本不抢导航；原包在新编辑器确认后旧响应不能清掉后来草稿', async ({
  page,
}) => {
  const f = await fixture(),
    held = gate(),
    reached = gate(),
    finished = gate();
  try {
    const v2 = await f.saveVersion();
    const attempts: ReturnType<typeof packet>[] = [];
    let first = true;
    await page.route(endpoint(f), async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      attempts.push(packet(route.request()));
      const response = await route.fetch();
      if (first) {
        first = false;
        reached.resolve();
        await held.promise;
        try {
          await route.fulfill({ response });
        } finally {
          finished.resolve();
        }
      } else await route.fulfill({ response });
    });
    await open(page, f);
    await edit(page);
    await fill(page, 'FIRST_PENDING_REGISTRATION');
    await editor(page).getByRole('button', { name: '确认登记到v1', exact: true }).click();
    await reached.promise;
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await edit(page);
    await fill(page, 'VERSION_TWO_LOCAL_DRAFT');
    await page.keyboard.press('Escape');
    await switchVersion(page, f, f.version);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'FIRST_PENDING_REGISTRATION',
    );
    await editor(page).getByRole('button', { name: '确认原登记是否已保存', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await edit(page);
    await fill(page, 'FRESH_DRAFT_AFTER_CONFIRMATION');
    await page.keyboard.press('Escape');
    await switchVersion(page, f, v2);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_TWO_LOCAL_DRAFT',
    );
    const lateResponse = page.waitForResponse(
      (response) => response.url() === endpoint(f) && response.request().method() === 'POST',
    );
    held.resolve();
    await finished.promise;
    await (await lateResponse).finished();
    await expect(page).toHaveURL(url(f, v2));
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'VERSION_TWO_LOCAL_DRAFT',
    );
    await expect(editor(page).getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await switchVersion(page, f, f.version);
    await edit(page);
    await expect(editor(page).getByLabel('链接标题', { exact: true })).toHaveValue(
      'FRESH_DRAFT_AFTER_CONFIRMATION',
    );
    await expect(editor(page).getByLabel('原链接登记待确认')).toHaveCount(0);
    const references = (await f.list()).items;
    expect(references).toHaveLength(1);
    expect(references[0]!.title).toBe('FIRST_PENDING_REGISTRATION');
    expect((await f.list(v2)).items).toHaveLength(0);
  } finally {
    held.resolve();
    await close(page, f);
  }
});
