import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { codeFeedbackFixture } from '../helpers/code-feedback.js';
import { codeSnapshot } from '../helpers/result-code.js';
import type { Message } from '../../packages/contracts/src/index.js';
const origin = 'http://127.0.0.1:4328';
type Fixture = Awaited<ReturnType<typeof codeFeedbackFixture>>;
const editor = (page: Page) => page.getByRole('dialog', { name: '回复这条成果反馈', exact: true });
const card = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
const url = (f: Fixture, revision = f.saved.revisionId) =>
  `${origin}/results/${f.saved.resultId}/versions/${revision}`;
const endpoint = (f: Fixture, message: Message) =>
  `${origin}/api/v1/results/${f.saved.resultId}/versions/${f.saved.revisionId}/feedback/${message.id}/replies`;
const replies = (f: Fixture) =>
  f.as(() => f.api.store.messages(f.task.id)).filter((message) => message.replyTo);
async function source(f: Fixture, body = '请解释第2–3行的变更') {
  const response = await f.api.call(f.feedbackPath, f.alice, { ...f.input, body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Message;
}
async function open(page: Page, f: Fixture, message: Message, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4328, host: '127.0.0.1' });
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
  await page.goto(url(f) + `/messages/${message.id}`);
  await expect(card(page, message.id)).toBeFocused();
}
async function edit(page: Page, message: Message) {
  await card(page, message.id)
    .getByRole('button', { name: /^(回复这条反馈|继续回复这条反馈|确认这条反馈的原回复)$/ })
    .click();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('回复明确归属原作者与代码位置，键盘发送和深浅手机阅读，原任务可回旧版本', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const original = await source(f);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await open(page, f, original, true);
    await edit(page, original);
    const e = editor(page);
    await expect(e.getByLabel('正在回复的原反馈')).toContainText(original.actorName);
    await expect(e.getByLabel('正在回复的原反馈')).toContainText('README.md · 所选文件 · 第2–3行');
    await e.getByLabel('具体反馈回复内容').fill('这两行保留原权限，补充了失败提示。');
    await mkdir('artifacts', { recursive: true });
    await e.screenshot({ path: 'artifacts/150-feedback-reply-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await e.screenshot({ path: 'artifacts/151-feedback-reply-mobile-light.png' });
    expect(await e.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    expect((await e.getByLabel('具体反馈回复内容').boundingBox())!.width).toBeGreaterThan(240);
    await e.getByLabel('具体反馈回复内容').press('Control+Enter');
    await expect(e).toHaveCount(0);
    await expect.poll(() => replies(f).length).toBe(1);
    const reply = replies(f)[0]!;
    expect(reply.createdByUserId).toBe(f.bob.user.id);
    expect(reply.replyTo!.messageId).toBe(original.id);
    expect(reply.replyTo!.actorName).toBe(original.actorName);
    expect(reply.codeAnchor).toEqual(original.codeAnchor);
    expect(reply.resultRevisionId).toBe(f.saved.revisionId);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
    await card(page, original.id).getByRole('link', { name: '查看刚保存的回复' }).click();
    await expect(page).toHaveURL(url(f) + `/messages/${reply.id}`);
    await expect(card(page, reply.id)).toBeFocused();
    await expect(card(page, reply.id).getByLabel('此回复对应的原反馈')).toContainText(
      original.body,
    );
    await page.screenshot({ path: 'artifacts/152-feedback-reply-location-mobile.png' });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForResponse(
      (r) =>
        r.url() === `${origin}/api/v1/results/${f.saved.resultId}/versions/${f.saved.revisionId}` &&
        r.status() === 200,
    );
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const second = await f.save(await codeSnapshot([{ name: 'README.md', text: 'new\n' }]));
    await page.goto(`${origin}/tasks/${f.task.id}`);
    await card(page, reply.id)
      .getByRole('link', { name: /查看原反馈/ })
      .click();
    await expect(page).toHaveURL(url(f) + `/messages/${original.id}`);
    await expect(page.getByLabel('查看固定版本')).not.toHaveValue(second.revisionId);
    await expect(card(page, original.id)).toBeFocused();
    await page.reload();
    await expect(card(page, original.id)).toBeFocused();
  } finally {
    await close(page, f);
  }
});
test('回复草稿按原消息和版本隔离，关闭导航保留，清除不发送', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const first = await source(f, '第一个问题'),
      second = await source(f, '第二个问题');
    await open(page, f, first);
    await edit(page, first);
    await editor(page).getByLabel('具体反馈回复内容').fill('只回复第一个问题');
    await editor(page).getByRole('link', { name: '查看原版本中的完整反馈' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(card(page, first.id)).toBeFocused();
    await expect(card(page, first.id)).toContainText('第一个问题');
    await edit(page, first);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('只回复第一个问题');
    await page.keyboard.press('Escape');
    await edit(page, second);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('');
    await expect(editor(page).getByLabel('正在回复的原反馈')).toContainText('第二个问题');
    await editor(page).getByRole('button', { name: '返回原反馈' }).click();
    const version = await f.save(await codeSnapshot([{ name: 'README.md', text: 'later\n' }]));
    await expect(
      page.getByLabel('查看固定版本').locator(`option[value="${version.revisionId}"]`),
    ).toHaveCount(1);
    await page.getByLabel('查看固定版本').selectOption(version.revisionId);
    await expect(card(page, first.id)).toHaveCount(0);
    await page.getByLabel('查看固定版本').selectOption(f.saved.revisionId);
    await edit(page, first);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('只回复第一个问题');
    await editor(page).getByRole('button', { name: '清除未发送回复' }).click();
    await edit(page, first);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('');
    expect(replies(f)).toHaveLength(0);
  } finally {
    await close(page, f);
  }
});
test('丢失回复回执后跨关闭和任务导航确认原body/key，不重复或改投新反馈', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const original = await source(f),
      attempts: { body: string | null; key: string }[] = [];
    let drop = true;
    await page.route(endpoint(f, original), async (route) => {
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
    await open(page, f, original);
    await edit(page, original);
    await editor(page).getByLabel('具体反馈回复内容').fill('保持原回复');
    await editor(page).getByRole('button', { name: '发送这条回复' }).click();
    await expect(editor(page).getByLabel('原反馈回复待确认')).toBeVisible();
    await expect(editor(page).getByLabel('具体反馈回复内容')).toBeDisabled();
    expect(replies(f)).toHaveLength(1);
    await editor(page).getByRole('button', { name: '返回原反馈' }).click();
    await page.getByRole('link', { name: '继续处理', exact: true }).click();
    await edit(page, original);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('保持原回复');
    await editor(page).getByRole('button', { name: '确认原回复是否已保存' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(replies(f)).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
test('晚到回复失败不复活降权清掉的草稿，重新授权可新建回复', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  let release = () => {},
    observe = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    observe = resolve;
  });
  try {
    const original = await source(f);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await page.route(endpoint(f, original), async (route) => {
      observe();
      await blocked;
      await route.fulfill({ status: 409, json: { error: { message: '晚到回复失败' } } });
    });
    await open(page, f, original, true);
    await edit(page, original);
    await editor(page).getByLabel('具体反馈回复内容').fill('不可复活的回复');
    await editor(page).getByRole('button', { name: '发送这条回复' }).click();
    await sent;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await expect(card(page, original.id).getByRole('button', { name: /这条反馈/ })).toHaveCount(0);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await edit(page, original);
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('');
    await expect(editor(page).getByLabel('具体反馈回复内容')).toBeDisabled();
    const replied = page.waitForResponse(
      (r) => r.url() === endpoint(f, original) && r.status() === 409,
    );
    release();
    await (await replied).finished();
    await expect(editor(page).getByLabel('具体反馈回复内容')).toBeEnabled();
    await expect(editor(page).getByLabel('具体反馈回复内容')).toHaveValue('');
    await expect(page.getByText('晚到回复失败', { exact: true })).toHaveCount(0);
    expect(replies(f)).toHaveLength(0);
  } finally {
    release();
    await close(page, f);
  }
});
test('普通版本反馈与回复的回复显示直接来源，不冒造代码位置；未知消息不漂移', async ({ page }) => {
  const f = await codeFeedbackFixture(origin);
  try {
    const plain = f.as(() =>
      f.api.store.addMessage(
        f.task.id,
        '普通文字反馈',
        f.saved.resultId,
        'plain-reply-source',
        f.saved.revisionId,
      ),
    );
    await open(page, f, plain);
    await edit(page, plain);
    await expect(editor(page)).not.toContainText('原位置：');
    await editor(page).getByLabel('具体反馈回复内容').fill('普通文字回答');
    await editor(page).getByRole('button', { name: '发送这条回复' }).click();
    await expect(editor(page)).toHaveCount(0);
    const first = replies(f)[0]!;
    await expect(card(page, first.id)).toBeVisible();
    expect(first.codeAnchor).toBeUndefined();
    await edit(page, first);
    await expect(editor(page).getByLabel('正在回复的原反馈')).toContainText('普通文字回答');
    await editor(page).getByLabel('具体反馈回复内容').fill('继续解释这条回答');
    await editor(page).getByRole('button', { name: '发送这条回复' }).click();
    await expect(editor(page)).toHaveCount(0);
    const second = replies(f)[1]!;
    expect(second.replyTo!.messageId).toBe(first.id);
    expect(second.codeAnchor).toBeUndefined();
    await card(page, first.id).getByRole('link', { name: '查看刚保存的回复' }).click();
    await expect(card(page, second.id)).toBeFocused();
    await page.goto(url(f) + '/messages/not-this-version');
    await expect(page.getByRole('alert')).toContainText('此固定版本没有该反馈消息');
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.saved.revisionId);
  } finally {
    await close(page, f);
  }
});
