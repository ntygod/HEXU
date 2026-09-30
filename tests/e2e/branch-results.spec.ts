import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { branchResultFixture } from '../helpers/branch-results.js';
import { codeSnapshot, recordResultCode } from '../helpers/result-code.js';
import { buildCodeDifference } from '../../apps/runner/src/agent/result-code-diff.js';
import { ResultCodeStore } from '../../packages/db/src/result-code.js';
import { branchContinuationFixture } from '../helpers/branch-continuation.js';
import { integrationFixture } from '../helpers/integrations.js';
import { randomUUID } from 'node:crypto';

test('整合预检固定来源与目标，丢失创建回执只确认原请求，报告与取消可重读', async ({ page }) => {
  const f = await integrationFixture(origin, 'sha256');
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
    await open(page, f);
    await page.goto(`${origin}/results/${f.saved.resultId}`);
    await page.getByRole('button', { name: '准备代码整合', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '准备代码整合预检', exact: true });
    await dialog.getByLabel('目标目录与恢复副本', { exact: true }).selectOption(f.tr.request.id);
    await dialog
      .getByLabel('来源完整对象', { exact: true })
      .selectOption(`retention:${f.sr.request.id}`);
    await expect(dialog.getByLabel('整合来源版本')).toContainText(f.source.commit);
    await expect(dialog).toContainText(f.target.commit);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => dialog.locator('form').evaluate((e) => e.scrollWidth - e.clientWidth))
      .toBeLessThanOrEqual(1);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/117-integration-editor-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const attempts: { key: string; body: string | null }[] = [];
    let drop = true;
    await page.route(`${origin}/api/v1/${f.integrationPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('checkbox', { name: /我已核对固定来源/ }).check();
    await dialog.getByRole('button', { name: '创建只读预检', exact: true }).click();
    await expect(dialog.getByLabel('整合预检请求待确认')).toBeVisible();
    // A later text-only version must not unmount the original pending editor.
    expect(
      (
        await f.api.call(f.path() + '/results', f.alice, {
          ...(await f.draft()),
          title: '后来的文字版',
        })
      ).statusCode,
    ).toBe(201);
    await expect(page.locator('.result-version-picker')).toContainText('后来的文字版');
    await expect(dialog.getByLabel('整合来源版本')).toContainText(f.source.commit);
    await expect(dialog.getByLabel('目标目录与恢复副本', { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '确认上次预检请求', exact: true }).click();
    await expect(dialog).toContainText('等待本人预检');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const items = (await f.api.call(f.integrationPath, f.alice)).json().items;
    expect(items).toHaveLength(1);
    const v = items[0];
    expect((await f.protocol('publish', f.report(v))).statusCode).toBe(200);
    await expect(dialog.getByLabel('文件整合预检')).toContainText('来源改变 2 个文件');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goto(`${origin}/tasks/${f.task.id}`);
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    const records = page.getByRole('dialog', { name: '任务整合预检', exact: true });
    await expect(records.getByLabel('文件整合预检')).toContainText('来源改变 2 个文件');
    await expect(records).toContainText('代码尚未应用');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/115-integration-preflight-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() =>
        records.locator('.integration-form').evaluate((e) => e.scrollWidth - e.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'artifacts/116-integration-preflight-mobile.png' });
    await records.getByRole('button', { name: '取消此预检', exact: true }).click();
    await expect(records).toContainText('已取消预检');
    await expect(records.getByLabel('文件整合预检')).toBeVisible();
    expect(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(1);
  } finally {
    await close(page, f);
  }
});

test('预检编辑短暂读取故障保留选择；新任务修订需明确核对，材料消失后阻止创建', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
    await open(page, f);
    await page.goto(`${origin}/results/${f.saved.resultId}/versions/${f.saved.revisionId}`);
    await page.getByRole('button', { name: '准备代码整合', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '准备代码整合预检', exact: true });
    await dialog.getByLabel('目标目录与恢复副本', { exact: true }).selectOption(f.tr.request.id);
    await dialog
      .getByLabel('来源完整对象', { exact: true })
      .selectOption(`retention:${f.sr.request.id}`);
    await dialog.getByRole('checkbox', { name: /我已核对固定来源/ }).check();
    await page.route(`${origin}/api/v1/${f.integrationPath}/options?*`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '预检选项临时不可读' } }),
      }),
    );
    await expect(dialog).toContainText('预检选项临时不可读');
    await expect(dialog.getByLabel('目标目录与恢复副本', { exact: true })).toHaveValue(
      f.tr.request.id,
    );
    await expect(dialog.getByRole('button', { name: '创建只读预检', exact: true })).toBeDisabled();
    await page.unroute(`${origin}/api/v1/${f.integrationPath}/options?*`);
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    await dialog.getByRole('button', { name: '重读预检选项', exact: true }).click();
    await expect(dialog).toContainText('任务修订或所选材料已变化');
    await dialog.getByRole('button', { name: '重新核对可用目标', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /我已核对固定来源/ })).not.toBeChecked();
    f.retained.report(f.ns[0]!.token, {
      requestId: f.sr.request.id,
      requestHash: f.sr.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    await expect(dialog).toContainText('任务修订或所选材料已变化');
    await expect(dialog.getByRole('button', { name: '创建只读预检', exact: true })).toBeDisabled();
    expect(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM integration_operations').get()!.n,
    ).toBe(0);
  } finally {
    await close(page, f);
  }
});

const origin = 'http://127.0.0.1:4318';
async function open(
  page: Page,
  f: Awaited<ReturnType<typeof branchResultFixture>>,
  account = f.alice,
) {
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
    ({ userId, spaceId }) => sessionStorage.setItem(`hexu-space:${userId}`, spaceId),
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(`${origin}/tasks/${f.task.id}`);
  await page.getByRole('button', { name: '方案分支', exact: true }).click();
  return page.getByRole('article', { name: '方案：方案 A', exact: true });
}
async function fixture() {
  const f = await branchResultFixture(origin);
  const a = f.begin();
  a.start();
  a.send('output', '已处理分页，取消操作仍需完善。');
  a.finish('failed', '协议夹具失败，保留已有输出。');
  await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
  return f;
}
async function close(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  // route.fetch owns HTTP connections in this context as well as the page's SSE.
  // Release both before waiting for the per-case Fastify server to close.
  await page.context().close();
  await f.close();
}

test('选定方案在原节点新会话继续，固定代码提示与未知回执不会重复派发', async ({ page }) => {
  const f = await branchContinuationFixture(origin);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
    await open(page, f);
    await page.getByRole('link', { name: '比较与选择方案', exact: true }).click();
    await page.getByRole('button', { name: '从所选版本继续', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '从选定方案继续', exact: true });
    await expect(dialog.getByLabel('选定方案接续基线')).toContainText(f.target.commit);
    await expect(dialog.getByLabel('选定方案接续基线')).toContainText('有未提交或额外文件');
    await expect(dialog.getByLabel('执行节点', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('授权工作目录', { exact: true })).toBeDisabled();
    await dialog.getByLabel('本次要求', { exact: true }).fill('BROWSER_SELECTED_FOLLOWUP');
    await dialog.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
    await dialog.getByText('查看本次发送的任务材料', { exact: true }).click();
    await expect(dialog.locator('.node-context-preview')).toContainText(f.saved.body.body);
    await expect(dialog.locator('.node-context-preview')).not.toContainText(
      'UNSELECTED_RUN_OUTPUT',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/113-branch-continuation-dark.png' });
    let drop = true;
    const attempts: { key: string; body: string | null }[] = [];
    await page.route(`${origin}/api/v1/tasks/${f.task.id}/runs`, async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await dialog.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect(dialog.getByLabel('执行请求待确认')).toBeVisible();
    await dialog.getByRole('button', { name: '确认上次执行请求', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const runs = f.as(() => f.api.store.runs(f.task.id));
    expect(runs).toHaveLength(2);
    expect(runs[1]!.previousRunId).toBe(f.source.run.id);
    expect(runs[1]!.state).toBe('queued');
    expect(f.read().selection!.resultRevisionId).toBe(f.saved.revisionId);
  } finally {
    await close(page, f);
  }
});

test('继续窗口固定选择基线，变化后保留要求并阻止沿旧选择启动', async ({ page }) => {
  const f = await branchContinuationFixture(origin, false, 'sha256');
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
    await open(page, f);
    await page.getByRole('link', { name: '比较与选择方案', exact: true }).click();
    await page.getByRole('button', { name: '从所选版本继续', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '从选定方案继续', exact: true });
    await dialog.getByLabel('本次要求', { exact: true }).fill('保留本次继续要求');
    await dialog.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    const choice = await f.api.call(f.choicePath, f.alice, {
      ...f.choice,
      expectedSelectionRevision: 1,
      note: '另一位编辑者重新确认同一版本',
    });
    expect(choice.statusCode).toBe(200);
    await expect(
      dialog.getByText(
        '方案选择、成果或来源执行已变化。当前要求已保留，请返回后重新打开并核对接续基线。',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByLabel('本次要求', { exact: true })).toHaveValue('保留本次继续要求');
    await expect(dialog.getByRole('button', { name: '在节点上开始', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '从所选版本继续', exact: true }).click();
    await expect(dialog.getByLabel('本次要求', { exact: true })).toHaveValue('保留本次继续要求');
    await expect(dialog.getByRole('checkbox', { name: /我确认本次目录与模式/ })).not.toBeChecked();
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/114-branch-continuation-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await dialog.locator('.node-execution-form').evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});

test('成果明确选择固定提交，节点共享后可查看两侧文件，缺失和大文件边界保留', async ({ page }) => {
  const before = await codeSnapshot([{ name: 'README.md', text: 'export const pageSize = 20;\n' }]);
  const after = await codeSnapshot([
    {
      name: 'README.md',
      text: 'export const pageSize = 50;\n// <script>not executable</script>\n',
    },
    { name: 'binary.dat', data: Buffer.from([0, 255]) },
    { name: 'large.txt', text: 'a'.repeat(8193) },
  ]);
  const f = await branchResultFixture(origin, before);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const cp = await recordResultCode(f, {
      objectFormat: 'sha1',
      commit: after.commit,
      tree: after.tree,
    });
    await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
    const card = await open(page, f);
    await card.getByRole('button', { name: '保存方案成果', exact: true }).click();
    await card.getByLabel('方案成果标题', { exact: true }).fill('分页代码成果');
    await card
      .getByLabel('方案成果说明', { exact: true })
      .fill('保存选定提交，未提交内容不在此版本。');
    await card.getByLabel('成果代码引用', { exact: true }).selectOption(cp.checkpointId);
    await expect(card.getByLabel('成果代码来源')).toContainText('可能包含执行结束后的人工修改');
    await card.getByRole('button', { name: '保存成果版本', exact: true }).click();
    await expect(card).toContainText('提交引用已固定');
    await card.getByRole('link', { name: '分页代码成果 · v1', exact: true }).click();
    const panel = page.getByLabel('固定代码与差异');
    await expect(panel).toContainText(after.commit);
    await expect(panel).toContainText('尚未共享可读差异');
    await expect(panel).toContainText('提交引用不等于备份');
    const b = f.read().branches[0]!;
    const detail = (await f.api.call(`results/${b.resultId}`, f.alice)).json();
    new ResultCodeStore(f.api.store).publish(
      f.ns[0]!.token,
      buildCodeDifference(
        detail.version.id,
        detail.version.source.code,
        before,
        after,
        new Date().toISOString(),
      ),
    );
    await panel.getByText('查看固定代码差异（3个文件）', { exact: true }).click();
    await panel.locator('summary').filter({ hasText: 'README.md' }).click();
    await expect(panel.getByText('export const pageSize = 20;', { exact: true })).toBeVisible();
    await expect(panel.locator('pre').filter({ hasText: 'pageSize = 50' })).toContainText(
      '<script>not executable</script>',
    );
    await panel.locator('summary').filter({ hasText: 'large.txt' }).click();
    await expect(panel).toContainText('文件超过单侧8 KiB正文范围');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => scrollTo(0, 0));
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/111-result-code-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: 'artifacts/112-result-code-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await expect(panel).toContainText('查看固定代码差异（3个文件）');
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    expect((await f.api.call(`results/${b.resultId}`, f.bob)).json().code.canPublish).toBe(false);
  } finally {
    await close(page, f);
  }
});

test('方案固定版本可查看来源、保留失败事实，旧反馈和刷新始终锚定原版本', async ({ page }) => {
  const f = await fixture();
  try {
    const card = await open(page, f);
    await card.getByRole('button', { name: '保存方案成果', exact: true }).click();
    await expect(card.getByLabel('固定成果来源')).toContainText('执行失败 · 保留部分成果');
    await card.getByLabel('方案成果标题', { exact: true }).fill('分批导出成果');
    await card.getByLabel('方案成果说明', { exact: true }).fill('第一版人工说明');
    await card.getByLabel('方案成果已知限制', { exact: true }).fill('取消操作还需完善');
    await card.getByRole('button', { name: '保存成果版本', exact: true }).click();
    const firstLink = card.getByRole('link', { name: '分批导出成果 · v1', exact: true });
    await expect(firstLink).toHaveAttribute('href', /\/results\/[^/]+\/versions\/[^/]+$/);
    const firstURL = new URL((await firstLink.getAttribute('href'))!, origin).href,
      firstRevisionId = new URL(firstURL).pathname.split('/').at(-1)!;
    await firstLink.click();
    await expect(page).toHaveURL(firstURL);
    await expect(
      page.getByRole('heading', { name: '分批导出成果 · 当前成果', exact: true }),
    ).toBeVisible();
    await page.getByText('查看已固定的共享输出', { exact: true }).click();
    await expect(page.getByLabel('固定成果来源')).toContainText('协议夹具失败，保留已有输出。');
    await expect(page.getByLabel('固定成果来源')).toContainText('代码文件尚未固定');
    expect(
      await page
        .locator('.result-main-surface')
        .evaluate((el) => el.scrollHeight <= el.clientHeight),
    ).toBe(true);
    await page.getByLabel('成果反馈', { exact: true }).fill('第一版需要补充取消说明');
    await page.getByRole('button', { name: '发送反馈', exact: true }).click();
    await expect(page.getByText('第一版需要补充取消说明', { exact: true })).toBeVisible();
    await page.goto(`${origin}/tasks/${f.task.id}`);
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await card.getByRole('button', { name: '保存新成果版本', exact: true }).click();
    await expect(card.getByLabel('方案成果说明', { exact: true })).toHaveValue('第一版人工说明');
    await card.getByLabel('方案成果说明', { exact: true }).fill('第二版补充说明，旧版保持可读');
    await card.getByRole('button', { name: '保存成果版本', exact: true }).click();
    const secondLink = card.getByRole('link', { name: '分批导出成果 · v2', exact: true });
    await expect(secondLink).toHaveAttribute('href', /\/results\/[^/]+\/versions\/[^/]+$/);
    const secondURL = new URL((await secondLink.getAttribute('href'))!, origin).href,
      secondRevisionId = new URL(secondURL).pathname.split('/').at(-1)!,
      secondRead = `${origin}/api/v1${new URL(secondURL).pathname}`;
    const picker = page.getByLabel('查看固定版本', { exact: true });
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route(secondRead, async (route) => {
      await reading;
      await route.continue();
    });
    try {
      await secondLink.click();
      // A missing old feedback or empty option list also matches the loading
      // screen. Exercise that boundary explicitly instead of racing an eager read.
      await expect(page.getByLabel('正在打开成果', { exact: true })).toBeVisible();
      await expect(picker).toHaveCount(0);
    } finally {
      releaseRead();
    }
    await expect(page).toHaveURL(secondURL);
    await expect(picker).toHaveValue(secondRevisionId);
    await expect(page.getByText('第二版补充说明，旧版保持可读', { exact: true })).toBeVisible();
    await page.unroute(secondRead);
    await expect(page.getByText('第一版需要补充取消说明', { exact: true })).toHaveCount(0);
    // Match the immutable ID, never a label derived from a possibly empty list.
    await picker.selectOption({ value: firstRevisionId });
    await expect(page).toHaveURL(firstURL);
    await expect(picker).toHaveValue(firstRevisionId);
    await expect(page.getByText('第一版需要补充取消说明', { exact: true })).toBeVisible();
    await expect(page.getByText('第一版人工说明', { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '分批导出成果 · 版本 1', exact: true }),
    ).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/107-branch-result-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      (await page.locator('.work-page-heading > div').first().boundingBox())!.width,
    ).toBeGreaterThan(250);
    await page.screenshot({ path: 'artifacts/108-branch-result-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).toBe('in_progress');
    expect(f.read().branches[1]!.state).toBe('planned');
  } finally {
    await close(page, f);
  }
});

test('成果编辑保留暂时读错和并发草稿，未知保存仅确认原请求', async ({ page }) => {
  const f = await fixture();
  try {
    const card = await open(page, f),
      path = `${origin}/api/v1/${f.path()}`;
    await card.getByRole('button', { name: '保存方案成果', exact: true }).click();
    await card.getByLabel('方案成果说明', { exact: true }).fill('不能被重读覆盖的草稿');
    let failRead = true;
    await page.route(path + '/result-preview', async (route) => {
      if (failRead)
        await route.fulfill({
          status: 503,
          json: { error: { code: 'FIXTURE_READ', message: '短暂读取失败' } },
        });
      else await route.continue();
    });
    await expect(card.getByRole('button', { name: '重读成果来源', exact: true })).toBeVisible();
    await expect(card.getByLabel('方案成果说明', { exact: true })).toHaveValue(
      '不能被重读覆盖的草稿',
    );
    failRead = false;
    const other = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      body: '其他编辑者的第一版',
    });
    expect(other.statusCode).toBe(201);
    await card.getByRole('button', { name: '重读成果来源', exact: true }).click();
    await expect(card.getByLabel('成果版本变化')).toContainText('其他编辑者的第一版');
    await expect(card.getByLabel('方案成果说明', { exact: true })).toHaveValue(
      '不能被重读覆盖的草稿',
    );
    await card.getByRole('button', { name: '已核对，基于最新版本保存', exact: true }).click();
    let drop = true;
    const attempts: { key: string; body: string | null }[] = [];
    await page.route(path + '/results', async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await card.getByRole('button', { name: '保存成果版本', exact: true }).click();
    await expect(card.getByLabel('成果保存待确认')).toBeVisible();
    await expect(card.getByLabel('方案成果说明', { exact: true })).toBeDisabled();
    await card.getByRole('button', { name: '确认上次成果保存', exact: true }).click();
    await expect(card.getByRole('button', { name: '保存新成果版本', exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(f.read().branches[0]!.result?.revision).toBe(2);
  } finally {
    await close(page, f);
  }
});

test('成果编辑降权清除草稿，仍可读的固定历史保留，撤销读取后页面清空', async ({ page }) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const saved = (await f.api.call(f.path() + '/results', f.alice, await f.draft())).json();
    const card = await open(page, f, f.bob);
    await card.getByRole('button', { name: '保存新成果版本', exact: true }).click();
    await card.getByLabel('方案成果说明', { exact: true }).fill('降权后必须清除');
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(card.getByLabel('方案成果说明', { exact: true })).toHaveCount(0);
    await expect(card.getByRole('link', { name: /成果 · v1/ })).toBeVisible();
    await card.getByRole('link', { name: /成果 · v1/ }).click();
    await expect(page.getByLabel('查看固定版本', { exact: true })).toBeVisible();
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    await expect(page.getByRole('heading', { name: '无法打开成果', exact: true })).toBeVisible();
    await expect(page.getByLabel('固定成果来源')).toHaveCount(0);
    expect(
      (await f.api.call(`results/${saved.resultId}/versions/${saved.revisionId}`, f.bob))
        .statusCode,
    ).toBe(404);
  } finally {
    await close(page, f);
  }
});

test('并排比较明确选用固定版本，新成果不替换选择，刷新和取消保留历史', async ({ page }) => {
  const f = await fixture();
  try {
    const b = f.begin(1, 'codex');
    b.start();
    b.finish();
    for (let i = 0; i < 2; i++)
      expect((await f.api.call(f.path(i) + '/results', f.alice, await f.draft(i))).statusCode).toBe(
        201,
      );
    await open(page, f);
    await page.getByRole('link', { name: '比较与选择方案', exact: true }).click();
    const aColumn = page.getByRole('article', { name: '比较方案：方案 A', exact: true });
    await expect(
      page.getByRole('article', { name: '比较方案：方案 B', exact: true }),
    ).toContainText('Codex');
    await aColumn.getByRole('button', { name: '选用这个版本', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录方案选择', exact: true });
    await dialog.getByLabel('选择说明', { exact: true }).fill('先采用这一版的分页思路');
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click();
    await expect(page.getByLabel('当前方案选择')).toContainText('已选择 方案 A · v1');
    expect(
      (
        await f.api.call(f.path() + '/results', f.alice, {
          ...(await f.draft()),
          body: 'A 的第二版',
        })
      ).statusCode,
    ).toBe(201);
    await expect(aColumn).toContainText('最新为 v2');
    await expect(aColumn).toContainText('已选用此版本');
    await expect(aColumn.getByLabel('方案 A对比版本')).toHaveValue(
      f.read().selection!.resultRevisionId!,
    );
    await page.reload();
    await expect(page.getByLabel('当前方案选择')).toContainText('已选择 方案 A · v1');
    await expect(aColumn).toContainText('已选用此版本');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/109-branch-comparison-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/110-branch-comparison-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await aColumn.boundingBox())!.width).toBeGreaterThan(250);
    await page.getByRole('button', { name: '取消当前选择', exact: true }).click();
    await dialog.getByRole('button', { name: '确认取消选择', exact: true }).click();
    await expect(page.getByLabel('当前方案选择')).toContainText('尚未选择方案');
    await page.getByText('选择历史（2）', { exact: true }).click();
    await expect(page.locator('.branch-choice-history')).toContainText('先采用这一版的分页思路');
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).toBe('in_progress');
  } finally {
    await close(page, f);
  }
});

test('方案选择冲突保留说明，丢失回复只确认原请求，降权不带回旧编辑', async ({ page }) => {
  const f = await fixture();
  try {
    const b = f.begin(1);
    b.start();
    b.finish();
    const saved = [];
    for (let i = 0; i < 2; i++)
      saved.push((await f.api.call(f.path(i) + '/results', f.alice, await f.draft(i))).json());
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await open(page, f, f.bob);
    await page.getByRole('link', { name: '比较与选择方案', exact: true }).click();
    const aColumn = page.getByRole('article', { name: '比较方案：方案 A', exact: true });
    await aColumn.getByRole('button', { name: '选用这个版本', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录方案选择', exact: true });
    await dialog.getByLabel('选择说明', { exact: true }).fill('保留我的选择说明');
    const path = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`;
    expect(
      (
        await f.api.call(path, f.alice, {
          expectedSelectionRevision: 0,
          branchId: f.view.branches[1]!.id,
          resultRevisionId: saved[1].revisionId,
          note: '另一位选择 B',
        })
      ).statusCode,
    ).toBe(200);
    await expect(dialog.getByLabel('方案选择冲突')).toContainText('方案 B · v1');
    await expect(dialog.getByLabel('选择说明', { exact: true })).toHaveValue('保留我的选择说明');
    await dialog.getByRole('button', { name: '已核对最新选择', exact: true }).click();
    let drop = true;
    const requests: { key: string; body: string | null }[] = [];
    await page.route(`${origin}/api/v1/${path}`, async (route) => {
      requests.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click();
    await expect(dialog.getByLabel('方案选择待确认')).toBeVisible();
    await dialog.getByRole('button', { name: '确认上次方案选择', exact: true }).click();
    await expect(page.getByLabel('当前方案选择')).toContainText('已选择 方案 A · v1');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    await page.getByRole('button', { name: '取消当前选择', exact: true }).click();
    await dialog.getByLabel('选择说明', { exact: true }).fill('失去写权限即丢弃');
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '比较方案', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消当前选择', exact: true })).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});
