import { test, expect, type Page, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:4315';
const password = 'Fictional Adoption Browser Password 2026!';
const shared = '请查看这个错误';
const hidden = '不分享的另一段内部说明';
const headers = (spaceId?: string) => ({
  origin,
  'x-hexu-client': 'web',
  'idempotency-key': randomUUID(),
  ...(spaceId ? { 'x-hexu-space': spaceId } : {}),
});
async function post(page: Page, path: string, body: unknown, spaceId?: string) {
  const r = await page.request.post(`${origin}/api/v1/${path}`, {
    headers: headers(spaceId),
    data: body,
  });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function get(page: Page, path: string, spaceId: string) {
  return page.request.get(`${origin}/api/v1/${path}`, { headers: headers(spaceId) });
}
async function prepare(page: Page, browser: Browser, privateTask = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    member = await context.newPage();
  const initial = await (await page.request.get(origin + '/api/v1/identity')).json();
  const identity = { email: 'adoption-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...identity,
      name: '林舟（协助测试）',
      code: 'fictional-adoption-browser-setup-code-0123456789',
    });
  else await post(page, 'identity/sign-in', identity);
  const owner = (await (await page.request.get(origin + '/api/v1/identity')).json()).user;
  const space = await post(page, 'spaces', { name: '协助建议采用 ' + randomUUID().slice(0, 4) });
  const invitation = await post(
    page,
    `spaces/${space.id}/invitations`,
    { email: `assist-${randomUUID()}@example.invalid` },
    space.id,
  );
  await post(member, 'identity/join', { token: invitation.token, name: '协助同事', password });
  const recipient = (await (await member.request.get(origin + '/api/v1/identity')).json()).user;
  const project = privateTask
    ? null
    : await post(page, `spaces/${space.id}/projects`, { name: '不可见项目名称' }, space.id);
  const task = await post(
    page,
    `spaces/${space.id}/tasks`,
    {
      title: '未分享任务标题',
      description: '未分享的完整任务说明',
      projectId: project?.id ?? null,
    },
    space.id,
  );
  const message = await post(
    page,
    `tasks/${task.id}/messages`,
    { body: shared + '\n' + hidden },
    space.id,
  );
  for (const p of [page, member]) {
    await p.goto(origin);
    await p.getByLabel('当前工作空间', { exact: true }).selectOption(space.id);
    await expect(p.getByLabel('当前工作空间', { exact: true })).toHaveValue(space.id);
  }
  await page.goto(origin + `/tasks/${task.id}`);
  return { member, context, space, project, task, message, recipient, owner };
}
const advice = '建议甲\r\n不要采用的文字\r\n建议乙🙂';
async function withReply(page: Page, f: Awaited<ReturnType<typeof prepare>>) {
  const p = await (
    await get(page, `tasks/${f.task.id}/messages/${f.message.id}/assistance-preview`, f.space.id)
  ).json();
  const d = await post(
    page,
    `tasks/${f.task.id}/assistances`,
    {
      sourceMessageId: f.message.id,
      expectedSourceHash: p.sourceHash,
      expectedTaskRevision: p.taskRevision,
      range: { start: 0, end: shared.length },
      recipientId: f.recipient.id,
      question: '只采用有用建议',
      shareConfirmed: true,
    },
    f.space.id,
  );
  const id = d.assistance.id as string;
  const reply = await post(
    f.member,
    `assistances/${id}/replies`,
    { expectedRevision: 1, body: advice },
    f.space.id,
  );
  await page.getByRole('button', { name: '协助记录', exact: true }).click();
  await page.getByRole('button', { name: /只采用有用建议/ }).click();
  await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText('建议甲');
  return { id, reply: reply.replies[0], path: `tasks/${f.task.id}/assistances/${id}` };
}
async function openAdoption(page: Page) {
  await page.getByRole('button', { name: '采用此条建议', exact: true }).click();
  await expect(page.getByLabel('选择建议片段', { exact: true })).toHaveValue(
    advice.replaceAll('\r\n', '\n'),
  );
}
async function selectFirst(page: Page) {
  const field = page.getByLabel('选择建议片段', { exact: true });
  await field.focus();
  await field.press('Control+Home');
  for (let i = 0; i < 3; i++) await field.press('Shift+ArrowRight');
  await expect
    .poll(() => field.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd]))
    .toEqual([0, 3]);
  await page.getByRole('button', { name: '添加建议片段', exact: true }).click();
}
async function selectLast(page: Page) {
  const field = page.getByLabel('选择建议片段', { exact: true });
  await field.focus();
  await field.press('Control+End');
  for (let i = 0; i < 4; i++) await field.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: '添加建议片段', exact: true }).click();
  await expect(page.getByLabel('已选建议片段', { exact: true })).toContainText('建议乙🙂');
}
test('真人建议多片段采用保留 CRLF/表情原文，任务内预览与历史深浅色手机可用', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    await page.getByLabel('任务评论', { exact: true }).fill('保留原任务未发送讨论');
    const a = await withReply(page, f);
    await openAdoption(page);
    await selectFirst(page);
    await selectLast(page);
    await expect(page.getByLabel('已选建议片段', { exact: true })).not.toContainText(
      '不要采用的文字',
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/73-assistance-adoption-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/75-assistance-adoption-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.getByRole('button', { name: '确认采用建议片段', exact: true }).click();
    await expect(page.getByLabel('建议采用成功', { exact: true })).toBeVisible();
    const detail = await (await get(page, `tasks/${f.task.id}`, f.space.id)).json();
    expect(detail.task.description).toBe(f.task.description + '\n\n建议甲\n\n建议乙🙂');
    expect(detail.task.status).toBe(f.task.status);
    expect(detail.runs).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('保留原任务未发送讨论');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.goto(origin + `/assistances/${a.id}`);
    await page.getByRole('button', { name: '查看建议采用记录', exact: true }).click();
    await page.getByText('查看采用前后与来源', { exact: true }).click();
    await expect(page.getByLabel('协助建议采用记录', { exact: true })).toContainText(
      '不要采用的文字',
    );
    await page.screenshot({
      path: 'artifacts/74-assistance-adoption-history-light.png',
      fullPage: true,
    });
    await page.reload();
    await page.getByRole('button', { name: '查看建议采用记录', exact: true }).click();
    await expect(page.getByLabel('协助建议采用记录', { exact: true })).toContainText(
      '追加任务说明',
    );
  } finally {
    await f.context.close();
  }
});
test('目标与协助版本冲突、临时读故障保留所选建议，回执丢失只确认原请求一次', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    const a = await withReply(page, f);
    await openAdoption(page);
    await selectFirst(page);
    const patch = await page.request.patch(`${origin}/api/v1/tasks/${f.task.id}`, {
      headers: headers(f.space.id),
      data: { expectedRevision: f.task.revision, description: '外部更新不能丢失' },
    });
    expect(patch.ok(), await patch.text()).toBe(true);
    await post(
      f.member,
      `assistances/${a.id}/replies`,
      { expectedRevision: 2, body: '后来补充意见' },
      f.space.id,
    );
    await expect(page.getByLabel('建议采用版本冲突', { exact: true })).toContainText(
      '外部更新不能丢失',
    );
    await expect(
      page.getByRole('button', { name: '确认采用建议片段', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '已核对更新，保留建议片段', exact: true }).click();
    const url = `**/api/v1/${a.path}/replies/${a.reply.id}/adoption-preview`;
    await page.route(url, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '暂时无法读取采用预览' }),
      }),
    );
    await expect(page.getByLabel('协助建议采用', { exact: true })).toContainText(
      '读取恢复前不能新采用',
    );
    await expect(page.getByLabel('已选建议片段', { exact: true })).toContainText('建议甲');
    await page.unroute(url);
    await page.getByRole('button', { name: '重读采用预览', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认采用建议片段', exact: true })).toBeEnabled();
    const attempts: unknown[] = [];
    let drop = true;
    await page.route(`**/api/v1/${a.path}/adoptions`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      if (drop) {
        drop = false;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: '确认采用建议片段', exact: true }).click();
    await expect(page.getByLabel('建议采用待确认', { exact: true })).toBeVisible();
    await expect(page.getByLabel('建议采用方式', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次建议采用', exact: true }).click();
    await expect(page.getByLabel('建议采用成功', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const history = await (await get(page, a.path + '/adoptions', f.space.id)).json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0].target.afterContent).toBe('外部更新不能丢失\n\n建议甲');
  } finally {
    await f.context.close();
  }
});
test('私有协助接收者没有采用入口或目标历史，结束后原任务所有者仍可明确替换', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser, true);
  try {
    const a = await withReply(page, f);
    await f.member.goto(origin + `/assistances/${a.id}`);
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText('建议甲');
    await expect(f.member.getByRole('button', { name: '采用此条建议', exact: true })).toHaveCount(
      0,
    );
    await expect(
      f.member.getByRole('button', { name: '查看建议采用记录', exact: true }),
    ).toHaveCount(0);
    expect((await get(f.member, a.path + '/adoptions', f.space.id)).status()).toBe(404);
    await post(
      page,
      `assistances/${a.id}/state`,
      { expectedRevision: 2, action: 'close' },
      f.space.id,
    );
    await expect(page.getByText('已结束', { exact: true })).toBeVisible();
    await openAdoption(page);
    await selectLast(page);
    await page.getByLabel('建议采用方式', { exact: true }).selectOption('replace');
    await expect(page.getByLabel('建议采用前后预览', { exact: true })).toContainText(
      f.task.description,
    );
    await page.getByRole('button', { name: '确认采用建议片段', exact: true }).click();
    await expect(page.getByLabel('建议采用成功', { exact: true })).toBeVisible();
    expect(
      (await (await get(page, `tasks/${f.task.id}`, f.space.id)).json()).task.description,
    ).toBe('建议乙🙂');
    await f.member.reload();
    await expect(f.member.locator('body')).not.toContainText(f.task.description);
  } finally {
    await f.context.close();
  }
});
test('采用编辑在项目降权时清除且恢复不复活，撤销后不能新采用但保留原记录', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    const a = await withReply(page, f);
    await openAdoption(page);
    await selectFirst(page);
    await post(
      page,
      `projects/${f.project.id}/members/${f.recipient.id}`,
      { role: 'manage' },
      f.space.id,
    );
    await post(
      f.member,
      `projects/${f.project.id}/members/${f.owner.id}`,
      { role: 'view' },
      f.space.id,
    );
    await expect(page.getByLabel('选择建议片段', { exact: true })).toHaveCount(0);
    await post(
      f.member,
      `projects/${f.project.id}/members/${f.owner.id}`,
      { role: 'edit' },
      f.space.id,
    );
    await expect(page.getByRole('button', { name: '采用此条建议', exact: true })).toBeVisible();
    await expect(page.getByLabel('选择建议片段', { exact: true })).toHaveCount(0);
    await openAdoption(page);
    await expect(page.getByLabel('已选建议片段', { exact: true })).toContainText('已选 0 个片段');
    await selectFirst(page);
    await post(
      page,
      `assistances/${a.id}/state`,
      { expectedRevision: 2, action: 'cancel' },
      f.space.id,
    );
    await expect(page.getByLabel('协助建议采用', { exact: true })).toContainText('不能新采用');
    await expect(
      page.getByRole('button', { name: '确认采用建议片段', exact: true }),
    ).toBeDisabled();
    expect((await (await get(page, a.path + '/adoptions', f.space.id)).json()).items).toHaveLength(
      0,
    );
  } finally {
    await f.context.close();
  }
});
