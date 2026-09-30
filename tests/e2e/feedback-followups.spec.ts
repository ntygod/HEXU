import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { codeFeedbackFixture } from '../helpers/code-feedback.js';
import { codeSnapshot } from '../helpers/result-code.js';
import type { Message } from '../../packages/contracts/src/index.js';
const origin = 'http://127.0.0.1:4330';
type Fixture = Awaited<ReturnType<typeof codeFeedbackFixture>>;
const card = (page: Page, message: Message) => page.locator(`[data-message-id="${message.id}"]`);
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '由反馈建立后续任务', exact: true });
const list = (page: Page) => page.getByRole('dialog', { name: '这条反馈的后续任务', exact: true });
const path = (message: Message) =>
  `results/${message.resultId}/versions/${message.resultRevisionId}/feedback/${message.id}/follow-ups`;
const resultUrl = (message: Message) =>
  `${origin}/results/${message.resultId}/versions/${message.resultRevisionId}/messages/${message.id}`;
const tasks = (f: Fixture) => f.as(() => f.api.store.tasks());
const followups = (f: Fixture, message: Message) =>
  tasks(f).filter((task) => task.feedbackOrigin?.messageId === message.id);
async function source(f: Fixture, body = 'ORIGINAL_FOLLOWUP_FEEDBACK') {
  const r = await f.api.call(f.feedbackPath, f.alice, { ...f.input, body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Message;
}
async function open(page: Page, f: Fixture, message: Message, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4330, host: '127.0.0.1' });
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
  await page.goto(resultUrl(message));
}
async function edit(page: Page, message: Message) {
  await card(page, message)
    .getByRole('button', { name: /^(后续任务|确认原后续任务请求)$/ })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  if (await list(page).count())
    await list(page)
      .getByRole('button', { name: /^(建立后续任务|继续编辑后续任务草稿|确认原创建请求)$/ })
      .click();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('项目反馈显式建立当前操作者负责的todo任务，原任务不重开；键盘手机与固定版本双向关系', async ({
  page,
}) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const message = await source(f);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    const original = f.as(() => f.api.store.getTask(f.task.id));
    const before = tasks(f).length;
    await open(page, f, message, true);
    await edit(page, message);
    const e = editor(page);
    await expect(e.getByLabel('新任务范围与负责人')).toContainText(f.project.name);
    await expect(e.getByLabel('新任务范围与负责人')).toContainText('测试乙（当前操作者）');
    await e.getByLabel('后续任务标题', { exact: true }).fill('补充分页取消逻辑');
    await e.getByLabel('后续任务说明', { exact: true }).fill('EDITED_FOLLOWUP_WORK');
    await e.getByText('查看原反馈全文', { exact: true }).click();
    await expect(e.getByLabel('后续任务原反馈')).toContainText(message.body);
    await mkdir('artifacts', { recursive: true });
    await e.screenshot({ path: 'artifacts/156-feedback-followup-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await e.screenshot({ path: 'artifacts/157-feedback-followup-mobile-light.png' });
    expect(await e.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    expect((await e.getByLabel('后续任务说明').boundingBox())!.width).toBeGreaterThan(240);
    await e.getByLabel('后续任务说明').press('Control+Enter');
    await expect(e).toHaveCount(0);
    await expect.poll(() => followups(f, message).length).toBe(1);
    const next = followups(f, message)[0]!;
    expect(tasks(f)).toHaveLength(before + 1);
    expect(next.ownerUserId).toBe(f.bob.user.id);
    expect(next.createdByUserId).toBe(f.bob.user.id);
    expect(next.projectId).toBe(f.project.id);
    expect(next.status).toBe('todo');
    expect(next.description).toBe('EDITED_FOLLOWUP_WORK');
    expect(next.feedbackOrigin!.body).toBe(message.body);
    expect(next.feedbackOrigin!.codeAnchor).toEqual(message.codeAnchor);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(original);
    expect(f.as(() => f.api.store.runs(next.id))).toHaveLength(0);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
    await card(page, message)
      .getByRole('link', { name: /打开后续任务：/ })
      .click();
    await expect(page).toHaveURL(`${origin}/tasks/${next.id}`);
    await expect(page.getByRole('heading', { name: next.title, exact: true })).toBeVisible();
    const fixed = page.getByLabel('后续任务的固定来源');
    await fixed.locator(':scope > summary').click();
    await expect(fixed).toContainText(message.body);
    await expect(fixed).toContainText('方案 A 成果 v1');
    await fixed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/158-feedback-followup-origin-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const later = await f.save(await codeSnapshot([{ name: 'README.md', text: 'later\n' }]));
    await fixed.getByRole('link', { name: '查看原版本中的反馈', exact: true }).click();
    await expect(page).toHaveURL(resultUrl(message));
    await expect(page.getByLabel('查看固定版本')).not.toHaveValue(later.revisionId);
    await card(page, message).getByRole('button', { name: '后续任务', exact: true }).click();
    await expect(
      list(page).getByRole('link', { name: `${next.shortId} · ${next.title}`, exact: true }),
    ).toBeVisible();
  } finally {
    await close(page, f);
  }
});
test('打开预览和取消不新建任务，草稿按原反馈隔离，放弃后不恢复旧编辑', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const first = await source(f, '第一个反馈'),
      second = await source(f, '第二个反馈');
    const before = tasks(f).length;
    await open(page, f, first);
    await edit(page, first);
    await editor(page).getByLabel('后续任务标题').fill('未提交的独立草稿');
    await editor(page).getByLabel('后续任务说明').fill('保留这份编辑');
    await page.keyboard.press('Escape');
    expect(tasks(f)).toHaveLength(before);
    await edit(page, second);
    await expect(editor(page).getByLabel('后续任务说明')).toHaveValue(second.body);
    await expect(editor(page).getByLabel('后续任务标题')).not.toHaveValue('未提交的独立草稿');
    await page.keyboard.press('Escape');
    await edit(page, first);
    await expect(editor(page).getByLabel('后续任务标题')).toHaveValue('未提交的独立草稿');
    await expect(editor(page).getByLabel('后续任务说明')).toHaveValue('保留这份编辑');
    await editor(page).getByRole('button', { name: '放弃未提交草稿' }).click();
    await expect(list(page)).toBeVisible();
    await list(page).getByRole('button', { name: '建立后续任务', exact: true }).click();
    await expect(editor(page).getByLabel('后续任务说明')).toHaveValue(first.body);
    expect(tasks(f)).toHaveLength(before);
  } finally {
    await close(page, f);
  }
});
test('创建丢ACK后确认原title/body/key，返回已有任务当前投影，不重复或覆盖后来编辑', async ({
  page,
}) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const message = await source(f);
    let drop = true;
    const attempts: { body: string | null; key: string }[] = [];
    await page.route(`${origin}/api/v1/${path(message)}`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      attempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key']!,
      });
      const response = await route.fetch();
      if (drop) {
        drop = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await open(page, f, message);
    await edit(page, message);
    await editor(page).getByLabel('后续任务标题').fill('原创建标题');
    await editor(page).getByLabel('后续任务说明').fill('原创建说明');
    await editor(page).getByRole('button', { name: '创建后续任务', exact: true }).click();
    await expect(editor(page).getByLabel('后续任务原请求待确认')).toBeVisible();
    await expect(editor(page).getByLabel('后续任务标题')).toBeDisabled();
    expect(followups(f, message)).toHaveLength(1);
    const next = followups(f, message)[0]!;
    const patch = await f.api.call(
      `tasks/${next.id}`,
      f.alice,
      { expectedRevision: next.revision, title: '后来修改的标题', description: '后来修改的说明' },
      randomUUID(),
      'PATCH',
    );
    expect(patch.statusCode).toBe(200);
    await page.keyboard.press('Escape');
    await edit(page, message);
    await expect(editor(page).getByLabel('后续任务标题')).toHaveValue('原创建标题');
    await editor(page).getByRole('button', { name: '确认原后续任务是否已创建' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(followups(f, message)).toHaveLength(1);
    expect(followups(f, message)[0]!.title).toBe('后来修改的标题');
    expect(followups(f, message)[0]!.description).toBe('后来修改的说明');
    expect(followups(f, message)[0]!.feedbackOrigin).toEqual(next.feedbackOrigin);
    await expect(
      card(page, message).getByRole('link', { name: /打开后续任务：.*后来修改的标题/ }),
    ).toBeVisible();
  } finally {
    await close(page, f);
  }
});
test('降权清掉后续任务草稿，晚到失败不复活；查看关系不增加创建权', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  let release = () => {},
    observe = () => {};
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    sent = new Promise<void>((resolve) => {
      observe = resolve;
    });
  try {
    const message = await source(f);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await page.route(`${origin}/api/v1/${path(message)}`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      observe();
      await blocked;
      await route.fulfill({ status: 409, json: { error: { message: '晚到创建失败' } } });
    });
    await open(page, f, message, true);
    await edit(page, message);
    await editor(page).getByLabel('后续任务标题').fill('不应复活的标题');
    await editor(page).getByRole('button', { name: '创建后续任务', exact: true }).click();
    await sent;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await expect(list(page)).toBeVisible();
    await expect(list(page).getByRole('button', { name: /建立后续任务|继续编辑/ })).toHaveCount(0);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await list(page).getByRole('button', { name: '建立后续任务', exact: true }).click();
    await expect(editor(page).getByLabel('后续任务标题')).not.toHaveValue('不应复活的标题');
    await expect(editor(page).getByLabel('后续任务标题')).toBeDisabled();
    const replied = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/${path(message)}` && r.status() === 409,
    );
    release();
    await (await replied).finished();
    await expect(editor(page).getByLabel('后续任务标题')).toBeEnabled();
    await expect(editor(page).getByLabel('后续任务标题')).not.toHaveValue('不应复活的标题');
    expect(followups(f, message)).toHaveLength(0);
  } finally {
    release();
    await close(page, f);
  }
});
test('私有文字版本反馈只建立同空间本人私有任务，不把内容或关系提供给项目同事', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const original = await f.api.task(f.alice, null, '私有原任务');
    const result = f.as(() =>
      f.api.store.createResult(original.id, '私有文字成果', '私有说明', randomUUID()),
    );
    const detail = (await f.api.call(`results/${result.id}`, f.alice)).json();
    const response = await f.api.call(`tasks/${original.id}/messages`, f.alice, {
      body: 'PRIVATE_FEEDBACK_SECRET',
      resultId: result.id,
      resultRevisionId: detail.version.id,
    });
    expect(response.statusCode).toBe(201);
    const message = response.json() as Message;
    await open(page, f, message);
    await edit(page, message);
    await expect(editor(page).getByLabel('新任务范围与负责人')).toContainText(
      '仅自己可见，沿用原私有范围',
    );
    await editor(page).getByLabel('后续任务标题').fill('私有后续工作');
    await editor(page).getByLabel('后续任务说明').fill('PRIVATE_FOLLOWUP_WORK');
    await editor(page).getByRole('button', { name: '创建后续任务', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    const next = followups(f, message)[0]!;
    expect(next.projectId).toBeNull();
    expect(next.visibility).toBe('private');
    expect(next.spaceId).toBe(original.spaceId);
    expect(next.ownerUserId).toBe(f.alice.user.id);
    expect(next.feedbackOrigin!.sourceTaskId).toBe(original.id);
    expect((await f.api.call(`tasks/${next.id}`, f.bob)).statusCode).toBe(404);
    const listDenied = await f.api.call(path(message), f.bob);
    expect(listDenied.statusCode).toBe(404);
    expect(listDenied.body).not.toContain('PRIVATE_');
    await card(page, message)
      .getByRole('link', { name: /打开后续任务：/ })
      .click();
    await expect(page.locator('.w1-task-scope')).toContainText('仅自己可见');
    await expect(page.getByLabel('后续任务的固定来源')).toContainText('私有文字成果 v1');
    expect(f.as(() => f.api.store.runs(next.id))).toHaveLength(0);
  } finally {
    await close(page, f);
  }
});
