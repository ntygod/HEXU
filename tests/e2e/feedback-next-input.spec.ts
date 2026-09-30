import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { branchContinuationFixture } from '../helpers/branch-continuation.js';
import { NextInputs } from '../../packages/db/src/next-inputs.js';
import type { Message } from '../../packages/contracts/src/index.js';
import type { NextInput } from '../../packages/contracts/src/next-input.js';
import { recordResultCode, saveResultCode } from '../helpers/result-code.js';
const origin = 'http://127.0.0.1:4329';
type Fixture = Awaited<ReturnType<typeof branchContinuationFixture>>;
const card = (page: Page, message: Message) => page.locator(`[data-message-id="${message.id}"]`);
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '把反馈整理为下一轮要求', exact: true });
const startDialog = (page: Page) =>
  page.getByRole('dialog', { name: '从选定方案继续', exact: true });
const path = (f: Fixture, message: Message) =>
  `results/${f.saved.resultId}/versions/${message.resultRevisionId}/feedback/${message.id}/next-inputs`;
const notes = (f: Fixture) => f.as(() => new NextInputs(f.api.store).list(f.task.id));
async function feedback(
  f: Fixture,
  body = 'ORIGINAL_FEEDBACK_ONLY',
  revision = f.saved.revisionId,
) {
  const r = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
    body,
    resultId: f.saved.resultId,
    resultRevisionId: revision,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Message;
}
async function open(page: Page, f: Fixture, message: Message, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4329, host: '127.0.0.1' });
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
  await page.goto(
    `${origin}/results/${message.resultId}/versions/${message.resultRevisionId}/messages/${message.id}`,
  );
}
async function edit(page: Page, message: Message) {
  await card(page, message)
    .getByRole('button', { name: /^(整理为下一轮要求|继续整理这条反馈|确认原反馈要求是否保存)$/ })
    .click();
}
async function continuation(page: Page, f: Fixture) {
  await page.goto(`${origin}/tasks/${f.task.id}/compare/${f.view.group.id}`);
  await page.getByRole('button', { name: '从所选版本继续', exact: true }).click();
  await expect(startDialog(page).getByLabel('选定方案接续基线')).toContainText(f.target.commit);
  return startDialog(page);
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('反馈原文与编辑要求分开，手机键盘保存不启动；方案明确选材后才派发并真实协议确认启动', async ({
  page,
}) => {
  const f = await branchContinuationFixture(origin);
  try {
    const source = await feedback(f);
    const unselected = await feedback(f, 'SECOND_ORIGINAL_FEEDBACK');
    const unselectedReply = await f.api.call(path(f, unselected), f.alice, {
      body: 'UNSELECTED_EDITED_INPUT',
    });
    expect(unselectedReply.statusCode, unselectedReply.body).toBe(201);
    await open(page, f, source);
    await edit(page, source);
    const e = editor(page);
    await expect(e.getByLabel('从反馈整理的下一轮要求')).toHaveValue(source.body);
    await e.getByText('查看原反馈完整正文', { exact: true }).click();
    await expect(e.getByLabel('原反馈与固定来源')).toContainText(source.body);
    await e.getByLabel('从反馈整理的下一轮要求').fill('EDITED_REQUEST_ONLY');
    await mkdir('artifacts', { recursive: true });
    await e.screenshot({ path: 'artifacts/153-feedback-next-input-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await e.screenshot({ path: 'artifacts/154-feedback-next-input-mobile-light.png' });
    expect(await e.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    expect((await e.getByLabel('从反馈整理的下一轮要求').boundingBox())!.width).toBeGreaterThan(
      240,
    );
    await e.getByLabel('从反馈整理的下一轮要求').press('Control+Enter');
    await expect(e).toHaveCount(0);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
    const saved = notes(f).find((note) => note.origin?.messageId === source.id)!;
    expect(saved.state).toBe('queued');
    expect(saved.body).toBe('EDITED_REQUEST_ONLY');
    expect(saved.origin!.body).toBe(source.body);
    await card(page, source).getByRole('link', { name: '在原任务查看要求与记录' }).click();
    await page.getByRole('button', { name: '下一轮要求', exact: true }).click();
    await page.getByRole('button', { name: /要求与使用记录/ }).click();
    await expect(page.getByRole('dialog', { name: '下一轮要求与记录' })).toContainText(
      'EDITED_REQUEST_ONLY',
    );
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const d = await continuation(page, f);
    const selected = d.getByRole('checkbox', { name: '带入：EDITED_REQUEST_ONLY', exact: true });
    await expect(selected).not.toBeChecked();
    const option = d.locator('.node-input-option').filter({
      has: page.getByRole('checkbox', { name: '带入：EDITED_REQUEST_ONLY', exact: true }),
    });
    await expect(option).toHaveCount(1);
    await option.getByText('原反馈来源 · 方案 A · v1', { exact: true }).click();
    await expect(selected).not.toBeChecked();
    await expect(option).toContainText(source.body);
    await selected.check();
    await d.getByLabel('本次要求', { exact: true }).fill('EXPLICIT_BRANCH_START');
    await d.getByText('查看本次发送的任务材料', { exact: true }).click();
    const preview = await d.locator('.node-context-preview pre').innerText();
    expect(preview).toContain('EDITED_REQUEST_ONLY');
    expect(preview).not.toContain(source.body);
    expect(preview).not.toContain('UNSELECTED_EDITED_INPUT');
    await page.setViewportSize({ width: 390, height: 844 });
    await d.getByLabel('本次要求', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/155-feedback-branch-input-selection-mobile.png' });
    expect(
      await d
        .locator('.node-execution-form')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    let drop = true;
    const attempts: { body: string | null; key: string }[] = [];
    await page.route(`${origin}/api/v1/tasks/${f.task.id}/runs`, async (route) => {
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
    await d.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await d.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect(d.getByLabel('执行请求待确认')).toBeVisible();
    await d.getByRole('button', { name: '确认上次执行请求', exact: true }).click();
    await expect(d).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const run = f.as(() => f.api.store.runs(f.task.id)).at(-1)!;
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(2);
    expect(notes(f).find((note) => note.id === saved.id)!.state).toBe('attached');
    expect(notes(f).find((note) => note.origin?.messageId === unselected.id)!.state).toBe('queued');
    const command = (await f.protocol(0, 'execution-poll', { connectionId: f.ns[0]!.connection }))
      .command!;
    expect(command.context).toBe(preview);
    expect(run.previousRunId).toBe(f.source.run.id);
    await f.protocol(0, 'execution-event', {
      dispatchId: command.id,
      generation: command.generation,
      event: { sequence: 1, kind: 'accepted', text: '', result: null, terminationConfirmed: false },
    });
    expect(
      (
        await f.protocol(0, 'execution-permit', {
          connectionId: f.ns[0]!.connection,
          dispatchId: command.id,
          generation: command.generation,
        })
      ).allowed,
    ).toBe(true);
    await f.protocol(0, 'execution-event', {
      dispatchId: command.id,
      generation: command.generation,
      event: { sequence: 2, kind: 'running', text: '', result: null, terminationConfirmed: false },
    });
    expect(notes(f).find((note) => note.id === saved.id)!.state).toBe('started');
    await f.protocol(0, 'execution-event', {
      dispatchId: command.id,
      generation: command.generation,
      event: {
        sequence: 3,
        kind: 'terminal',
        text: '协议夹具结束',
        result: 'succeeded',
        terminationConfirmed: true,
      },
    });
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).not.toBe('done');
  } finally {
    await close(page, f);
  }
});
test('超长原文只预填有界要求，丢ACK跨关闭确认原body/key，队列修改仍保留来源原文', async ({
  page,
}) => {
  const f = await branchContinuationFixture(origin);
  try {
    const source = await feedback(f, '原'.repeat(2500));
    let drop = true;
    const attempts: { body: string | null; key: string }[] = [];
    await page.route(`${origin}/api/v1/${path(f, source)}`, async (route) => {
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
    await open(page, f, source);
    await edit(page, source);
    await expect(editor(page)).toContainText('仅预填前2000字符以内');
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toHaveValue('原'.repeat(2000));
    await editor(page).getByLabel('从反馈整理的下一轮要求').fill('精炼后的待选要求');
    await editor(page).getByRole('button', { name: '保存为待选择要求' }).click();
    await expect(editor(page).getByLabel('反馈要求原请求待确认')).toBeVisible();
    await editor(page).getByRole('button', { name: '返回原反馈' }).click();
    await edit(page, source);
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toHaveValue('精炼后的待选要求');
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toBeDisabled();
    await editor(page).getByRole('button', { name: '确认这条要求是否已保存' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(notes(f)).toHaveLength(1);
    await card(page, source).getByRole('link', { name: '在原任务查看要求与记录' }).click();
    await page.getByRole('button', { name: '下一轮要求', exact: true }).click();
    await page.getByRole('button', { name: /要求与使用记录/ }).click();
    await page
      .getByRole('dialog', { name: '下一轮要求与记录' })
      .getByRole('button', { name: '编辑要求' })
      .click();
    await page.getByLabel('下一轮要求', { exact: true }).fill('后来明确编辑的要求');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect.poll(() => notes(f)[0]!.body).toBe('后来明确编辑的要求');
    expect(notes(f)[0]!.origin!.body).toBe(source.body);
    expect(notes(f)[0]!.origin!.messageId).toBe(source.id);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
test('只列同方案同版本要求；所选要求编辑或撤回后旧确认失效且不启动', async ({ page }) => {
  const f = await branchContinuationFixture(origin, true);
  try {
    const source = await feedback(f);
    const savedReply = await f.api.call(path(f, source), f.alice, { body: '当前版本要求' });
    expect(savedReply.statusCode).toBe(201);
    const saved = savedReply.json() as NextInput;
    f.as(() =>
      new NextInputs(f.api.store).create(f.peer!.run.id, 'OTHER_BRANCH_REQUIREMENT', randomUUID()),
    );
    const cp = await recordResultCode(f, f.target),
      later = await saveResultCode(f, cp.checkpointId);
    const laterFeedback = await feedback(f, '后来版本反馈', later.revisionId);
    expect(
      (await f.api.call(path(f, laterFeedback), f.alice, { body: 'OTHER_VERSION_REQUIREMENT' }))
        .statusCode,
    ).toBe(201);
    await open(page, f, source);
    const d = await continuation(page, f);
    await expect(
      d.getByRole('checkbox', { name: /OTHER_BRANCH_REQUIREMENT|OTHER_VERSION_REQUIREMENT/ }),
    ).toHaveCount(0);
    await d.getByRole('checkbox', { name: '带入：当前版本要求', exact: true }).check();
    await d.getByLabel('本次要求', { exact: true }).fill('保留本次要求');
    const consent = d.getByRole('checkbox', { name: /我确认本次目录与模式/ });
    await consent.check();
    const changed = await f.api.call(
      `next-inputs/${saved.id}`,
      f.alice,
      { expectedRevision: saved.revision, body: '要求已经更新' },
      randomUUID(),
      'PATCH',
    );
    expect(changed.statusCode).toBe(200);
    await expect(
      d.getByRole('checkbox', { name: '带入：要求已经更新', exact: true }),
    ).toBeChecked();
    await expect(consent).not.toBeChecked();
    await expect(d.getByLabel('本次要求', { exact: true })).toHaveValue('保留本次要求');
    await consent.check();
    expect(
      (
        await f.api.call(`next-inputs/${saved.id}/cancel`, f.alice, {
          expectedRevision: changed.json().revision,
        })
      ).statusCode,
    ).toBe(200);
    await expect(d).toContainText('所选要求已不可用或不再待选');
    await expect(d.getByRole('button', { name: '在节点上开始', exact: true })).toBeDisabled();
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(2);
  } finally {
    await close(page, f);
  }
});
test('草稿关闭保留，降权清除且晚到失败不复活；重新授权可重读原来源', async ({ page }) => {
  const f = await branchContinuationFixture(origin);
  let release = () => {},
    observe = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    observe = resolve;
  });
  try {
    const source = await feedback(f);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await page.route(`${origin}/api/v1/${path(f, source)}`, async (route) => {
      observe();
      await blocked;
      await route.fulfill({ status: 409, json: { error: { message: '迟到的要求保存失败' } } });
    });
    await open(page, f, source, true);
    await edit(page, source);
    await editor(page).getByLabel('从反馈整理的下一轮要求').fill('应保留的编辑');
    await page.keyboard.press('Escape');
    await edit(page, source);
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toHaveValue('应保留的编辑');
    await editor(page).getByRole('button', { name: '保存为待选择要求' }).click();
    await sent;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(editor(page)).toHaveCount(0);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await edit(page, source);
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toHaveValue(source.body);
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toBeDisabled();
    const replied = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/${path(f, source)}` && r.status() === 409,
    );
    release();
    await (await replied).finished();
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toBeEnabled();
    await expect(editor(page).getByLabel('从反馈整理的下一轮要求')).toHaveValue(source.body);
    expect(notes(f)).toHaveLength(0);
  } finally {
    release();
    await close(page, f);
  }
});
test('没有明确node Run的文字成果只说明不支持，不猜执行或保存队列', async ({ page }) => {
  const f = await branchContinuationFixture(origin);
  try {
    const result = f.as(() =>
      f.api.store.createResult(f.task.id, '普通文字成果', '没有方案Run来源', randomUUID()),
    );
    const detail = (await f.api.call(`results/${result.id}`, f.alice)).json();
    const reply = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: '普通版本反馈',
      resultId: result.id,
      resultRevisionId: detail.version.id,
    });
    const message = reply.json() as Message;
    await open(page, f, message);
    await edit(page, message);
    await expect(editor(page).getByRole('status')).toContainText('暂不能整理为下一轮要求');
    await expect(editor(page).getByRole('button', { name: '保存为待选择要求' })).toHaveCount(0);
    expect(notes(f)).toHaveLength(0);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
