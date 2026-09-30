import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { codeFeedbackFixture } from '../helpers/code-feedback.js';
import { codeSnapshot } from '../helpers/result-code.js';
import type { Message } from '../../packages/contracts/src/index.js';
const origin = 'http://127.0.0.1:4327';
type Fixture = Awaited<ReturnType<typeof codeFeedbackFixture>>;
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '对固定代码提出反馈', exact: true });
const code = (page: Page) => page.getByLabel('固定代码与差异');
const file = (page: Page, name = 'README.md') =>
  code(page)
    .locator('.result-code-file')
    .filter({ has: page.getByText(name, { exact: true }) });
const messages = (f: Fixture) =>
  f.as(() => f.api.store.messages(f.task.id)).filter((m) => m.codeAnchor);
const url = (f: Fixture, revision = f.saved.revisionId) =>
  `${origin}/results/${f.saved.resultId}/versions/${revision}`;
async function open(page: Page, f: Fixture, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4327, host: '127.0.0.1' });
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
    ({ userId, spaceId }) => sessionStorage.setItem(`hexu-space:${userId}`, spaceId),
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(url(f));
}
async function edit(page: Page, name = 'README.md') {
  const panel = code(page).locator('.result-code-diff');
  if (!(await panel.evaluate((e) => (e as HTMLDetailsElement).open)))
    await panel.locator(':scope > summary').click();
  const target = file(page, name);
  if (!(await target.evaluate((e) => (e as HTMLDetailsElement).open)))
    await target.locator(':scope > summary').click();
  await target.getByRole('button', { name: '对这个文件提出反馈', exact: true }).click();
}
async function fill(page: Page, body = '请说明第2–3行的变化') {
  const e = editor(page);
  await e.getByLabel('反馈代码侧', { exact: true }).selectOption('after');
  await e.getByRole('checkbox', { name: '指定此侧的行范围' }).check();
  await e.getByLabel('反馈开始行', { exact: true }).fill('2');
  await e.getByLabel('反馈结束行', { exact: true }).fill('3');
  await e.getByLabel('固定代码反馈内容', { exact: true }).fill(body);
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('固定代码反馈明确范围与作者，键盘发送、深浅手机确认和原位置链接不调度执行', async ({
  page,
}) => {
  const f = await codeFeedbackFixture(origin);
  try {
    await open(page, f);
    await edit(page);
    const e = editor(page);
    await expect(e.getByLabel('反馈代码侧', { exact: true })).toHaveValue('');
    await expect(e.getByRole('checkbox')).not.toBeChecked();
    await expect(e.getByRole('button', { name: '发送代码反馈' })).toBeDisabled();
    await fill(page);
    await mkdir('artifacts', { recursive: true });
    await e.screenshot({ path: 'artifacts/147-code-feedback-editor-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await e.evaluate((el) => {
      el.scrollTop = 0;
    });
    await e.screenshot({ path: 'artifacts/148-code-feedback-editor-mobile-light.png' });
    expect(await e.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await e.getByLabel('固定代码反馈内容').boundingBox())!.width).toBeGreaterThan(240);
    const start = await e.getByLabel('反馈开始行').boundingBox();
    const end = await e.getByLabel('反馈结束行').boundingBox();
    expect(Math.abs(start!.y - end!.y)).toBeLessThan(2);
    await e.getByLabel('固定代码反馈内容').press('Control+Enter');
    await expect(e).toHaveCount(0);
    await expect.poll(() => messages(f).length).toBe(1);
    const m = messages(f)[0]!;
    expect(m.createdByUserId).toBe(f.alice.user.id);
    expect(m.resultRevisionId).toBe(f.saved.revisionId);
    expect(m.codeAnchor!.range).toEqual({ start: 2, end: 3 });
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
    await page.getByRole('link', { name: '查看已保存反馈的代码位置', exact: true }).click();
    await expect(page).toHaveURL(url(f) + `/feedback/${m.id}`);
    await expect(file(page).getByLabel('固定反馈位置')).toContainText('所选文件第2–3行');
    const target = file(page).locator('[data-code-feedback-focus]');
    await expect(target).toBeFocused();
    await expect(target).toContainText('two edited');
    await expect(file(page).locator('.code-diff-feedback-focus')).toHaveCount(2);
    await page.screenshot({ path: 'artifacts/149-code-feedback-fixed-location-mobile.png' });
    // Polling and newer Task feedback must not keep forcing the reader back to the range.
    await page.evaluate(() => scrollTo(0, 0));
    const refreshed = page.waitForResponse(
      (r) =>
        r.url() === `${origin}/api/v1/results/${f.saved.resultId}/versions/${f.saved.revisionId}` &&
        r.status() === 200,
    );
    await refreshed;
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally {
    await close(page, f);
  }
});
test('未发送范围草稿跨关闭重开保留，不默认改投另一文件；明确清除不创建消息', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    await open(page, f);
    await edit(page);
    await fill(page, '保留这份未发送反馈');
    await editor(page).getByLabel('反馈结束行').fill('4');
    await expect(editor(page).getByRole('button', { name: '发送代码反馈' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    expect(messages(f)).toHaveLength(0);
    await edit(page, 'added.txt');
    await expect(editor(page)).toContainText('README.md');
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('保留这份未发送反馈');
    await expect(editor(page).getByLabel('反馈结束行')).toHaveValue('4');
    await editor(page).getByRole('button', { name: '清除未发送草稿' }).click();
    expect(messages(f)).toHaveLength(0);
    await expect(page.getByLabel('固定代码反馈草稿')).toHaveCount(0);
    await edit(page, 'added.txt');
    await expect(editor(page)).toContainText('added.txt');
    await expect(editor(page).getByLabel('反馈代码侧')).toHaveValue('');
  } finally {
    await close(page, f);
  }
});
test('丢ACK跨关闭和版本导航继续确认原body/key，后来版本不接收原文件反馈', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const attempts: { key: string; body: string | null }[] = [];
    let drop = true;
    await page.route(`${origin}/api/v1/${f.feedbackPath}`, async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      const response = await route.fetch();
      if (drop) {
        drop = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await open(page, f);
    await edit(page);
    await fill(page, '原范围的固定反馈');
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await expect(editor(page).getByLabel('代码反馈待确认')).toBeVisible();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toBeDisabled();
    expect(messages(f)).toHaveLength(1);
    await editor(page).getByRole('button', { name: '返回固定文件' }).click();
    const second = await f.save(await codeSnapshot([{ name: 'README.md', text: 'second\n' }]));
    await expect(
      page.getByLabel('查看固定版本').locator(`option[value="${second.revisionId}"]`),
    ).toHaveCount(1);
    await page.getByLabel('查看固定版本').selectOption(second.revisionId);
    await expect(page.getByLabel('固定代码反馈草稿')).toHaveCount(0);
    await page.getByLabel('查看固定版本').selectOption(f.saved.revisionId);
    await page.getByRole('button', { name: '继续固定文件反馈' }).click();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('原范围的固定反馈');
    await expect(editor(page)).toContainText('固定成果v1');
    await editor(page).getByRole('button', { name: '确认原反馈是否已发送' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(messages(f)).toHaveLength(1);
    expect(messages(f)[0]!.resultRevisionId).toBe(f.saved.revisionId);
  } finally {
    await close(page, f);
  }
});
test('旧版反馈从原Task跳回固定文件，刷新与新版本不漂移；临时读错保留，降权清空草稿', async ({
  page,
}) => {
  const f = await codeFeedbackFixture(origin);
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const r = await f.api.call(f.feedbackPath, f.bob, f.input);
    expect(r.statusCode, r.body).toBe(201);
    const m = r.json() as Message;
    const second = await f.save(await codeSnapshot([{ name: 'README.md', text: 'new version\n' }]));
    await open(page, f, true);
    await page.goto(`${origin}/tasks/${f.task.id}`);
    await page.getByRole('link', { name: /查看固定代码反馈位置：README.md/ }).click();
    await expect(page).toHaveURL(url(f) + `/feedback/${m.id}`);
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.saved.revisionId);
    await expect(page.getByText('正在查看历史版本 v1', { exact: false })).toBeVisible();
    await expect(file(page).locator('[data-code-feedback-focus]')).toContainText('two edited');
    await page.reload();
    await expect(file(page).getByLabel('固定反馈位置')).toBeVisible();
    await expect(page.getByLabel('查看固定版本')).not.toHaveValue(second.revisionId);
    await file(page).getByRole('button', { name: '对这个文件提出反馈' }).click();
    await fill(page, '降权应清除的范围草稿');
    const path = `${origin}/api/v1/results/${f.saved.resultId}/versions/${f.saved.revisionId}`;
    await page.route(path, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '历史代码暂时不可读' } } }),
    );
    await expect(page.getByText('历史代码暂时不可读', { exact: false })).toBeVisible();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('降权应清除的范围草稿');
    await page.unroute(path);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByLabel('固定代码反馈草稿')).toHaveCount(0);
    await expect(file(page).getByRole('button', { name: '对这个文件提出反馈' })).toHaveCount(0);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await file(page).getByRole('button', { name: '对这个文件提出反馈' }).click();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('');
    await expect(editor(page).getByLabel('反馈代码侧')).toHaveValue('');
  } finally {
    await close(page, f);
  }
});
test('未共享正文仅定位文件，缺失反馈ID不跳最新或读取仓库', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    await open(page, f);
    await edit(page, 'binary.dat');
    await editor(page).getByLabel('反馈代码侧').selectOption('after');
    await expect(editor(page)).toContainText('正文未共享，仅可定位文件');
    await expect(editor(page).getByRole('checkbox')).toBeDisabled();
    await editor(page).getByLabel('固定代码反馈内容').fill('请说明这个二进制文件用途');
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(messages(f)[0]!.codeAnchor!.range).toBeNull();
    await page.getByRole('link', { name: '查看已保存反馈的代码位置', exact: true }).click();
    await expect(file(page, 'binary.dat').getByLabel('固定反馈位置')).toContainText('整个文件');
    await expect(file(page, 'binary.dat')).toContainText('二进制或非UTF-8');
    await page.goto(url(f) + '/feedback/does-not-belong');
    await expect(page.getByRole('alert')).toContainText('此固定版本没有该代码反馈位置');
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.saved.revisionId);
  } finally {
    await close(page, f);
  }
});
test('复杂diff回退时仍从原共享正文定位固定行段，权限撤销清除定位内容', async ({ page }) => {
  const f = await codeFeedbackFixture(origin, {
    before: await codeSnapshot([{ name: 'README.md', text: 'old\n'.repeat(600) }]),
    after: await codeSnapshot([{ name: 'README.md', text: 'new\n'.repeat(600) }]),
  });
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await open(page, f, true);
    await edit(page);
    await fill(page, '第300行附近的反馈');
    await editor(page).getByLabel('反馈开始行').fill('300');
    await editor(page).getByLabel('反馈结束行').fill('301');
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await expect(editor(page)).toHaveCount(0);
    await page.getByRole('link', { name: '查看已保存反馈的代码位置', exact: true }).click();
    await expect(
      file(page).getByRole('region', { name: '完整正文中的固定反馈范围' }),
    ).toContainText('300  new');
    await expect(
      file(page).getByRole('region', { name: '完整正文中的固定反馈范围' }),
    ).toContainText('301  new');
    await expect(file(page)).toContainText('超过本次行比较计算上限');
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    await expect(page.getByRole('heading', { name: '无法打开成果' })).toBeVisible();
    await expect(code(page)).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});

test('降权清除后晚到的已知失败不会复活原草稿', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observe = () => {};
  const sent = new Promise<void>((resolve) => {
    observe = resolve;
  });
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    const endpoint = `${origin}/api/v1/${f.feedbackPath}`;
    await page.route(endpoint, async (route) => {
      observe();
      await blocked;
      await route.fulfill({ status: 409, json: { error: { message: '晚到的原请求失败' } } });
    });
    await open(page, f, true);
    await edit(page);
    await fill(page, '撤权后不可复活的旧草稿');
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await sent;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByLabel('固定代码反馈草稿')).toHaveCount(0);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await file(page).getByRole('button', { name: '对这个文件提出反馈' }).click();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('');
    await expect(editor(page).getByLabel('固定代码反馈内容')).toBeDisabled();
    const replied = page.waitForResponse((r) => r.url() === endpoint && r.status() === 409);
    release();
    await (await replied).finished();
    // Enabled proves the old request's finally block has completed, without an arbitrary sleep.
    await expect(editor(page).getByLabel('固定代码反馈内容')).toBeEnabled();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('');
    await expect(editor(page).getByLabel('反馈代码侧')).toHaveValue('');
    await expect(page.getByText('晚到的原请求失败', { exact: true })).toHaveCount(0);
    expect(messages(f)).toHaveLength(0);
  } finally {
    release();
    await close(page, f);
  }
});

test('仅文件模式变化的非空正文仍可展开并定位原反馈行', async ({ page }) => {
  const text = Array.from({ length: 25 }, (_, index) => `unchanged line ${index + 1}`).join('\n');
  const f = await codeFeedbackFixture(origin, {
    before: await codeSnapshot([{ name: 'README.md', text }]),
    after: await codeSnapshot([{ name: 'README.md', text, mode: '100755' }]),
  });
  try {
    await open(page, f);
    await edit(page);
    await fill(page, '模式变化时仍需核对这两行');
    await editor(page).getByLabel('反馈开始行').fill('10');
    await editor(page).getByLabel('反馈结束行').fill('11');
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await expect(editor(page)).toHaveCount(0);
    const m = messages(f)[0]!;
    expect(m.codeAnchor!.range).toEqual({ start: 10, end: 11 });
    await page.getByRole('link', { name: '查看已保存反馈的代码位置', exact: true }).click();
    await expect(page).toHaveURL(url(f) + `/feedback/${m.id}`);
    await expect(file(page).getByLabel('文本变化行数')).toHaveText('+0 / −0 行');
    const focused = file(page).locator('[data-code-feedback-focus]');
    await expect(focused).toBeFocused();
    await expect(focused).toContainText('unchanged line 10');
    await expect(file(page).locator('.code-diff-feedback-focus')).toHaveCount(2);
    await expect(file(page).getByRole('button', { name: '收起 19 行未变内容' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(
      file(page).getByRole('cell', { name: 'unchanged line 11', exact: true }),
    ).toBeVisible();
  } finally {
    await close(page, f);
  }
});

test('发送先返回403时清除草稿，后续明确重新获得编辑权可再次反馈', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await open(page, f, true);
    await edit(page);
    await fill(page, '旧权限不应保留的内容');
    // Hold workbench refresh so the real POST denial arrives before the new role snapshot.
    await page.route(`${origin}/api/v1/workbench`, async (route) => {
      await blocked;
      await route.continue();
    });
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    const denied = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/${f.feedbackPath}` && r.status() === 403,
    );
    await editor(page).getByRole('button', { name: '发送代码反馈' }).click();
    await denied;
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByLabel('固定代码反馈草稿')).toHaveCount(0);
    await expect(file(page).getByRole('button', { name: '对这个文件提出反馈' })).toHaveCount(0);
    release();
    await expect(
      page.getByText('你可以查看此项目，修改和回复需要编辑权限。', { exact: true }),
    ).toBeVisible();
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await file(page).getByRole('button', { name: '对这个文件提出反馈' }).click();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toBeEnabled();
    await expect(editor(page).getByLabel('固定代码反馈内容')).toHaveValue('');
    await expect(editor(page).getByLabel('反馈代码侧')).toHaveValue('');
    expect(messages(f)).toHaveLength(0);
  } finally {
    release();
    await close(page, f);
  }
});
