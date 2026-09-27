import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'AI 草稿', exact: true });
const content = '采用第一段\n保留第二段\n采用第三段';
async function fixture(page: Page, privateTask = false) {
  const project = privateTask
    ? null
    : await post(page, 'spaces/space-demo/projects', {
        name: '草稿采用 ' + randomUUID().slice(0, 5),
      });
  const task = await post(page, 'spaces/space-demo/tasks', {
    title: '整理工作建议',
    projectId: project?.id ?? null,
    description: '现有工作说明',
  });
  const run = await post(page, `tasks/${task.id}/runs`, {
    provider: 'mock',
    requestedTool: 'claude-code',
    scenario: 'success',
    expectedRevision: task.revision,
    prompt: '虚构草稿浏览器测试',
  });
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/runs/${run.id}`)).json()).state)
    .toBe('succeeded');
  const detail = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  const message = detail.messages.find((m: { actorType: string }) => m.actorType === 'agent');
  expect(message).toBeTruthy();
  return { project, task: detail.task, message, run };
}
async function saved(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const preview = await (
    await page.request.get(`/api/v1/tasks/${f.task.id}/messages/${f.message.id}/draft-preview`)
  ).json();
  return post(page, `tasks/${f.task.id}/ai-drafts`, {
    title: '可选择的建议',
    content,
    sourceMessageId: f.message.id,
    expectedSourceHash: preview.origin.hash,
  });
}
async function openDraft(page: Page, taskId: string, title = '可选择的建议') {
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('button', { name: 'AI 草稿', exact: true }).click();
  await dialog(page)
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByLabel('草稿正文', { exact: true })).toHaveValue(content);
}
async function selectRange(page: Page, start: number, end: number) {
  await page.getByLabel('选择草稿片段', { exact: true }).evaluate(
    (field: HTMLTextAreaElement, range) => {
      field.focus();
      field.setSelectionRange(range.start, range.end);
      field.dispatchEvent(new Event('select', { bubbles: true }));
    },
    { start, end },
  );
  await page.getByRole('button', { name: '添加所选片段', exact: true }).click();
}

test('AI 回复整理为草稿、编辑并局部采用，保留原文和历史，深浅色与手机可用', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/tasks/${f.task.id}`);
  await page.getByLabel('任务评论', { exact: true }).fill('还没有发送的讨论');
  await page
    .locator('.message')
    .filter({ hasText: f.message.body })
    .getByRole('button', { name: '整理为草稿', exact: true })
    .click();
  await page.getByLabel('草稿标题', { exact: true }).fill('整理后的实现建议');
  await page.getByLabel('草稿正文', { exact: true }).fill(content);
  await page.getByRole('button', { name: '保存 AI 草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择片段采用', exact: true })).toBeEnabled();
  await page.getByLabel('草稿标题', { exact: true }).fill('修订后的实现建议');
  await expect(page.getByRole('button', { name: '选择片段采用', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存草稿修订', exact: true }).click();
  await page.getByRole('button', { name: '选择片段采用', exact: true }).click();
  await selectRange(page, 0, 5);
  await selectRange(page, 12, 17);
  const comparison = page.getByLabel('采用前后预览', { exact: true });
  await expect(comparison).toContainText('现有工作说明');
  await expect(comparison).not.toContainText('保留第二段');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/64-draft-adoption-dark.png', fullPage: true });
  await page.getByRole('button', { name: '采用所选片段', exact: true }).click();
  await expect(page.getByLabel('草稿历史与采用记录', { exact: true })).toBeVisible();
  const detail = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(detail.task.description).toBe('现有工作说明\n\n采用第一段\n\n采用第三段');
  expect(detail.task.status).toBe(f.task.status);
  expect(detail.messages.find((m: { id: string }) => m.id === f.message.id).body).toBe(
    f.message.body,
  );
  expect(detail.runs).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('还没有发送的讨论');
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByRole('button', { name: 'AI 草稿', exact: true }).click();
  await dialog(page)
    .getByRole('button', { name: /修订后的实现建议/ })
    .click();
  await page.getByRole('button', { name: '草稿与采用记录', exact: true }).click();
  await dialog(page).locator('.draft-record').first().locator('summary').first().click();
  await page.screenshot({ path: 'artifacts/65-draft-history-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/66-draft-history-mobile.png', fullPage: true });
  expect(await dialog(page).evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('读取故障与草稿/目标冲突保留编辑和片段，只在明确比较后采用最新基线', async ({ page }) => {
  const f = await fixture(page),
    draft = await saved(page, f);
  await openDraft(page, f.task.id);
  await page.getByLabel('草稿正文', { exact: true }).fill('我的本地编辑');
  let failRead = true;
  await page.route(`**/api/v1/tasks/${f.task.id}/ai-drafts/${draft.id}`, async (route) => {
    if (route.request().method() === 'GET' && failRead)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARY', message: '草稿临时读取失败', retryable: true },
        }),
      });
    else await route.continue();
  });
  await post(page, `tasks/${f.task.id}/messages`, { body: '引起页面重读' });
  await expect(dialog(page)).toContainText('草稿临时读取失败');
  await expect(page.getByLabel('草稿正文', { exact: true })).toHaveValue('我的本地编辑');
  failRead = false;
  await page.getByRole('button', { name: '重读当前草稿', exact: true }).click();
  await expect(dialog(page)).not.toContainText('草稿临时读取失败');
  const changed = await page.request.patch(`/api/v1/tasks/${f.task.id}/ai-drafts/${draft.id}`, {
    headers: headers(),
    data: { expectedRevision: 1, title: draft.title, content: '同事的草稿修订' },
  });
  expect(changed.ok()).toBe(true);
  await expect(page.getByLabel('草稿版本冲突', { exact: true })).toBeVisible();
  await expect(page.getByLabel('草稿正文', { exact: true })).toHaveValue('我的本地编辑');
  await expect(page.getByRole('button', { name: '保存草稿修订', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '以最新草稿为基线，保留我的编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存草稿修订', exact: true }).click();
  await page.getByRole('button', { name: '选择片段采用', exact: true }).click();
  await page.getByRole('button', { name: '选择整个草稿', exact: true }).click();
  await expect(page.getByLabel('采用前后预览', { exact: true })).toContainText('现有工作说明');
  const targetChange = await page.request.patch(`/api/v1/tasks/${f.task.id}`, {
    headers: headers(),
    data: { expectedRevision: f.task.revision, description: '同事补充的目标说明' },
  });
  expect(targetChange.ok()).toBe(true);
  await expect(page.getByLabel('采用目标冲突', { exact: true })).toBeVisible();
  await expect(page.getByLabel('待采用片段', { exact: true })).toContainText('我的本地编辑');
  await expect(page.getByRole('button', { name: '采用所选片段', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '以最新目标为基线，保留所选片段', exact: true }).click();
  await page.getByRole('button', { name: '采用所选片段', exact: true }).click();
  await expect(page.getByLabel('草稿历史与采用记录', { exact: true })).toBeVisible();
  const current = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(current.task.description).toBe('同事补充的目标说明\n\n我的本地编辑');
});

test('采用回执丢失只确认同一片段和目标请求，不重复追加或创建执行', async ({ page }) => {
  const f = await fixture(page),
    draft = await saved(page, f);
  await openDraft(page, f.task.id);
  await page.getByRole('button', { name: '选择片段采用', exact: true }).click();
  await selectRange(page, 0, 5);
  let drop = true;
  const attempts: { key: string; body: unknown }[] = [];
  await page.route(
    `**/api/v1/tasks/${f.task.id}/ai-drafts/${draft.id}/adoptions`,
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postDataJSON(),
      });
      if (drop) {
        drop = false;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    },
  );
  await page.getByRole('button', { name: '采用所选片段', exact: true }).click();
  await expect(page.getByLabel('草稿操作待确认', { exact: true })).toBeVisible();
  await expect(page.getByLabel('采用目标', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '确认上次草稿操作', exact: true }).click();
  await expect(page.getByLabel('草稿历史与采用记录', { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  const detail = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(detail.task.description).toBe('现有工作说明\n\n采用第一段');
  expect(detail.runs).toHaveLength(1);
  expect(
    (
      await (
        await page.request.get(`/api/v1/tasks/${f.task.id}/ai-drafts/${draft.id}/adoptions`)
      ).json()
    ).items,
  ).toHaveLength(1);
});

test('明确替换同项目资料保留任务说明，私有草稿只能采用到自己任务', async ({ page }) => {
  const f = await fixture(page);
  await saved(page, f);
  const source = await post(page, `projects/${f.project.id}/sources`, {
    kind: 'text',
    title: '实现笔记',
    content: '旧资料正文',
  });
  await openDraft(page, f.task.id);
  await page.getByRole('button', { name: '选择片段采用', exact: true }).click();
  await selectRange(page, 0, 5);
  await page.getByLabel('采用目标', { exact: true }).selectOption(`source:${source.id}`);
  await page.getByLabel('采用方式', { exact: true }).selectOption('replace');
  await expect(page.getByLabel('采用前后预览', { exact: true })).toContainText('旧资料正文');
  await page.getByRole('button', { name: '采用所选片段', exact: true }).click();
  await expect(page.getByLabel('草稿历史与采用记录', { exact: true })).toBeVisible();
  const sourceAfter = await (
    await page.request.get(`/api/v1/projects/${f.project.id}/sources/${source.id}`)
  ).json();
  expect(sourceAfter.content).toBe('采用第一段');
  expect(sourceAfter.revision).toBe(2);
  expect(
    (await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json()).task.description,
  ).toBe('现有工作说明');
  await page.keyboard.press('Escape');
  const personal = await fixture(page, true);
  await saved(page, personal);
  await openDraft(page, personal.task.id);
  await page.getByRole('button', { name: '选择片段采用', exact: true }).click();
  await expect(page.getByLabel('采用目标', { exact: true }).locator('option')).toHaveCount(1);
  await expect(dialog(page)).toContainText('私有草稿只可采用到当前任务说明');
});
