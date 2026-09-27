import { test, expect, type Page, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:4313';
const password = 'Fictional Assistance Browser Password 2026!';
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
  const identity = { email: 'assistance-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...identity,
      name: '林舟（协助测试）',
      code: 'fictional-assistance-browser-setup-code-0123456789',
    });
  else await post(page, 'identity/sign-in', identity);
  const owner = (await (await page.request.get(origin + '/api/v1/identity')).json()).user;
  const space = await post(page, 'spaces', { name: '有限材料协助 ' + randomUUID().slice(0, 4) });
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
async function openCreate(page: Page) {
  await page.getByRole('button', { name: '请同事协助', exact: true }).click();
  await expect(page.getByLabel('选择协助片段', { exact: true })).toHaveValue(
    shared + '\n' + hidden,
  );
}
async function selectExcerpt(page: Page) {
  const field = page.getByLabel('选择协助片段', { exact: true });
  await field.focus();
  await field.press('Control+Home');
  for (let i = 0; i < shared.length; i++) await field.press('Shift+ArrowRight');
  await expect
    .poll(() => field.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd]))
    .toEqual([0, shared.length]);
  await page.getByRole('button', { name: '使用所选片段', exact: true }).click();
  await expect(page.getByLabel('协助分享预览', { exact: true })).toContainText(shared);
  await expect(page.getByLabel('协助分享预览', { exact: true })).not.toContainText(hidden);
}
async function configure(page: Page, recipientId: string) {
  await page.getByLabel('协助问题', { exact: true }).fill('请帮我判断这个报错');
  await selectExcerpt(page);
  await page.getByLabel('协助接收者', { exact: true }).selectOption(recipientId);
  await page.getByLabel('我已核对接收者与本次分享内容', { exact: true }).check();
}
async function createUI(page: Page, f: Awaited<ReturnType<typeof prepare>>) {
  await openCreate(page);
  await configure(page, f.recipient.id);
  await page.getByRole('button', { name: '发送协助请求', exact: true }).click();
  await expect(page.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
  const list = await (await get(page, 'assistances?box=sent&state=all', f.space.id)).json();
  return list.items[0].id as string;
}

test('从原任务局部分享给无项目权限同事，收件入口与回复回到任务，深浅色和手机可用', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    await page.getByLabel('任务评论', { exact: true }).fill('尚未发送的任务讨论');
    await openCreate(page);
    await configure(page, f.recipient.id);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/67-assistance-share-dark.png', fullPage: true });
    await page.getByRole('button', { name: '发送协助请求', exact: true }).click();
    await expect(page.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('尚未发送的任务讨论');
    await f.member.getByRole('link', { name: /打开我的协助/ }).click();
    await f.member.getByRole('link', { name: /请帮我判断这个报错/ }).click();
    await expect(f.member.getByLabel('已分享的固定片段', { exact: true })).toContainText(shared);
    await expect(f.member.locator('body')).not.toContainText(hidden);
    await expect(f.member.locator('body')).not.toContainText('未分享任务标题');
    expect((await get(f.member, `tasks/${f.task.id}`, f.space.id)).status()).toBe(404);
    await f.member
      .getByLabel('协助回复', { exact: true })
      .fill('建议先核对请求超时，不需要重启原执行。');
    await f.member.getByRole('button', { name: '发送协助回复', exact: true }).click();
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText(
      '建议先核对请求超时',
    );
    await f.member.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await f.member.screenshot({ path: 'artifacts/68-assistance-reply-light.png', fullPage: true });
    await f.member.setViewportSize({ width: 390, height: 844 });
    await f.member.screenshot({ path: 'artifacts/69-assistance-mobile.png', fullPage: true });
    expect(
      await f.member.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await page.getByRole('button', { name: '协助记录', exact: true }).click();
    await page.getByRole('button', { name: /请帮我判断这个报错/ }).click();
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText(
      '建议先核对请求超时',
    );
    const after = await (await get(page, `tasks/${f.task.id}`, f.space.id)).json();
    expect(after.task.description).toBe(f.task.description);
    expect(after.task.revision).toBe(f.task.revision);
    expect(after.runs).toHaveLength(0);
  } finally {
    await f.context.close();
  }
});

test('私有消息只分享固定片段，撤销后清除接收者内容和未发送回复，刷新不能恢复', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser, true);
  try {
    const id = await createUI(page, f);
    await f.member.goto(origin + `/assistances/${id}`);
    await f.member.getByLabel('协助回复', { exact: true }).fill('不能继续保留的未发送回复');
    await expect(f.member.locator('body')).not.toContainText('未分享任务标题');
    await page.getByRole('button', { name: '撤销分享', exact: true }).click();
    await expect(page.getByLabel('协助状态确认', { exact: true })).toContainText('无法收回');
    await page.getByRole('button', { name: '确认撤销分享', exact: true }).click();
    await expect(f.member.locator('body')).toContainText('协助不存在或访问已撤销');
    await expect(f.member.getByLabel('协助回复', { exact: true })).toHaveCount(0);
    await expect(f.member.locator('body')).not.toContainText(shared);
    await f.member.reload();
    await expect(f.member.locator('body')).toContainText('协助不存在或访问已撤销');
    expect((await get(f.member, `tasks/${f.task.id}`, f.space.id)).status()).toBe(404);
    const records = await (
      await get(page, `tasks/${f.task.id}/assistances?state=all`, f.space.id)
    ).json();
    expect(records.items[0].state).toBe('cancelled');
  } finally {
    await f.context.close();
  }
});

test('创建和回复丢失回执只确认原请求，保持原接收者与片段，不重复协助或回复', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    await openCreate(page);
    await configure(page, f.recipient.id);
    let drop = true;
    const attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(`**/api/v1/tasks/${f.task.id}/assistances`, async (route) => {
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
    await page.getByRole('button', { name: '发送协助请求', exact: true }).click();
    await expect(page.getByLabel('协助操作待确认', { exact: true })).toBeVisible();
    await expect(page.getByLabel('协助接收者', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次协助操作', exact: true }).click();
    await expect(page.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const list = await (await get(page, 'assistances?box=sent', f.space.id)).json();
    expect(list.items).toHaveLength(1);
    const id = list.items[0].id;
    await f.member.goto(origin + `/assistances/${id}`);
    drop = true;
    const replies: typeof attempts = [];
    await f.member.route(`**/api/v1/assistances/${id}/replies`, async (route) => {
      replies.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      if (drop) {
        drop = false;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await f.member.getByLabel('协助回复', { exact: true }).fill('只保存一次的建议');
    await f.member.getByRole('button', { name: '发送协助回复', exact: true }).click();
    await expect(f.member.getByLabel('协助操作待确认', { exact: true })).toBeVisible();
    await post(
      page,
      `assistances/${id}/replies`,
      { expectedRevision: 2, body: '发起者后来补充的问题' },
      f.space.id,
    );
    await f.member.getByRole('button', { name: '确认上次协助操作', exact: true }).click();
    await expect(f.member.getByLabel('协助操作待确认', { exact: true })).toHaveCount(0);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual(replies[1]);
    const detail = await (await get(page, `assistances/${id}`, f.space.id)).json();
    expect(detail.replies).toHaveLength(2);
    expect(
      detail.replies.filter((r: { body: string }) => r.body === '只保存一次的建议'),
    ).toHaveLength(1);
  } finally {
    await f.context.close();
  }
});

test('临时读取故障和来源/回复版本冲突保留草稿，明确核对后才发送', async ({ page, browser }) => {
  const f = await prepare(page, browser);
  try {
    await openCreate(page);
    await configure(page, f.recipient.id);
    let fail = true;
    await page.route(
      `**/api/v1/tasks/${f.task.id}/messages/${f.message.id}/assistance-preview`,
      async (route) => {
        if (fail)
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'TEMPORARY', message: '协助来源临时不可读' } }),
          });
        else await route.continue();
      },
    );
    await expect(page.getByRole('dialog')).toContainText('协助来源临时不可读');
    await expect(page.getByLabel('协助问题', { exact: true })).toHaveValue('请帮我判断这个报错');
    await expect(page.getByLabel('协助分享预览', { exact: true })).toContainText(shared);
    fail = false;
    await page.getByRole('button', { name: '重新读取来源', exact: true }).click();
    const changed = await page.request.patch(`${origin}/api/v1/tasks/${f.task.id}`, {
      headers: headers(f.space.id),
      data: { expectedRevision: 1, description: '后来修改的任务说明' },
    });
    expect(changed.ok()).toBe(true);
    await expect(page.getByLabel('协助来源冲突', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送协助请求', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '核对最新来源并重新选择', exact: true }).click();
    await selectExcerpt(page);
    await page.getByLabel('我已核对接收者与本次分享内容', { exact: true }).check();
    await page.getByRole('button', { name: '发送协助请求', exact: true }).click();
    await expect(page.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
    const id = (await (await get(page, 'assistances?box=sent', f.space.id)).json()).items[0].id;
    await f.member.goto(origin + `/assistances/${id}`);
    await f.member.getByLabel('协助回复', { exact: true }).fill('我的未发送建议');
    await post(
      page,
      `assistances/${id}/replies`,
      { expectedRevision: 1, body: '补充一个问题' },
      f.space.id,
    );
    await expect(f.member.getByLabel('协助版本冲突', { exact: true })).toBeVisible();
    await expect(f.member.getByLabel('协助回复', { exact: true })).toHaveValue('我的未发送建议');
    await expect(
      f.member.getByRole('button', { name: '发送协助回复', exact: true }),
    ).toBeDisabled();
    await f.member.getByRole('button', { name: '已查看更新，保留我的输入', exact: true }).click();
    await f.member.getByRole('button', { name: '发送协助回复', exact: true }).click();
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText(
      '我的未发送建议',
    );
    // Wait for the requester's actual view to observe the reply before closing its revision.
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText('我的未发送建议');
    await page.getByRole('button', { name: '结束协助', exact: true }).click();
    await page.getByRole('button', { name: '确认结束协助', exact: true }).click();
    await expect(f.member.getByLabel('协助回复', { exact: true })).toHaveCount(0);
    await expect(f.member.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
  } finally {
    await f.context.close();
  }
});

test('发起者项目访问撤销会终止旧协助，重新加入项目不复活受邀链接', async ({ page, browser }) => {
  const f = await prepare(page, browser);
  try {
    await post(
      page,
      `projects/${f.project.id}/members/${f.recipient.id}`,
      { role: 'edit' },
      f.space.id,
    );
    await f.member.goto(origin + `/tasks/${f.task.id}`);
    await openCreate(f.member);
    await configure(f.member, f.owner.id);
    await f.member.getByRole('button', { name: '发送协助请求', exact: true }).click();
    await expect(f.member.getByLabel('已分享的固定片段', { exact: true })).toBeVisible();
    const id = (await (await get(f.member, 'assistances?box=sent', f.space.id)).json()).items[0].id;
    await page.goto(origin + `/assistances/${id}`);
    await page.getByLabel('协助回复', { exact: true }).fill('撤销后不应保留');
    await post(
      page,
      `projects/${f.project.id}/members/${f.recipient.id}`,
      { role: null },
      f.space.id,
    );
    await expect(page.locator('body')).toContainText('协助不存在或访问已撤销');
    await expect(page.getByLabel('协助回复', { exact: true })).toHaveCount(0);
    await post(
      page,
      `projects/${f.project.id}/members/${f.recipient.id}`,
      { role: 'edit' },
      f.space.id,
    );
    await page.reload();
    await expect(page.locator('body')).toContainText('协助不存在或访问已撤销');
    expect((await get(page, `assistances/${id}`, f.space.id)).status()).toBe(404);
  } finally {
    await f.context.close();
  }
});

test('翻看更早回复和历史读故障不丢输入，结束回执先到状态也可确认原请求', async ({
  page,
  browser,
}) => {
  const f = await prepare(page, browser);
  try {
    const id = await createUI(page, f);
    for (let index = 1; index <= 21; index++)
      await post(
        page,
        `assistances/${id}/replies`,
        { expectedRevision: index, body: `历史问题 ${index}` },
        f.space.id,
      );
    await f.member.goto(origin + `/assistances/${id}`);
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText('历史问题 21');
    const editor = f.member.getByLabel('协助回复', { exact: true });
    await editor.fill('查看历史时仍保留的回复');
    let failHistory = true;
    await f.member.route(`**/api/v1/assistances/${id}?before=*`, async (route) => {
      if (failHistory)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'TEMPORARY', message: '更早回复暂时不可读' } }),
        });
      else await route.continue();
    });
    await f.member.getByRole('button', { name: '查看更早回复', exact: true }).click();
    await expect(f.member.locator('body')).toContainText('更早回复暂时不可读');
    await expect(editor).toHaveValue('查看历史时仍保留的回复');
    failHistory = false;
    await f.member.getByRole('button', { name: '重读更早回复', exact: true }).click();
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText('历史问题 1');
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).not.toContainText(
      '历史问题 21',
    );
    await post(
      page,
      `assistances/${id}/replies`,
      { expectedRevision: 22, body: '查看历史期间的新问题' },
      f.space.id,
    );
    await expect(f.member.getByLabel('协助版本冲突', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue('查看历史时仍保留的回复');
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).not.toContainText(
      '查看历史期间的新问题',
    );
    await f.member.getByRole('button', { name: '查看最新回复并保留输入', exact: true }).click();
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText(
      '查看历史期间的新问题',
    );
    await expect(editor).toHaveValue('查看历史时仍保留的回复');
    await f.member.getByRole('button', { name: '已查看更新，保留我的输入', exact: true }).click();
    await f.member.getByRole('button', { name: '发送协助回复', exact: true }).click();
    await expect(f.member.getByLabel('协助回复记录', { exact: true })).toContainText(
      '查看历史时仍保留的回复',
    );
    const attempts: { key: string | undefined; body: unknown }[] = [];
    let drop = true;
    await page.route(`**/api/v1/assistances/${id}/state`, async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      if (drop) {
        drop = false;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText(
      '查看历史时仍保留的回复',
    );
    await page.getByRole('button', { name: '结束协助', exact: true }).click();
    await page.getByRole('button', { name: '确认结束协助', exact: true }).click();
    await expect(page.getByLabel('协助操作待确认', { exact: true })).toBeVisible();
    await expect(page.getByText('已结束', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看更早回复', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次协助操作', exact: true }).click();
    await expect(page.getByLabel('协助操作待确认', { exact: true })).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const result = await (await get(page, `assistances/${id}`, f.space.id)).json();
    expect(result.assistance.state).toBe('closed');
    expect(result.assistance.revision).toBe(25);
  } finally {
    await f.context.close();
  }
});
