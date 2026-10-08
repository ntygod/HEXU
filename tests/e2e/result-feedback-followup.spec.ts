import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  Message,
  Project,
  Result,
  Task,
  TaskDetail,
} from '../../packages/contracts/src/index.js';
import type { ResultDetail } from '../../packages/contracts/src/results.js';

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/${path}`, {
    headers: { 'x-hexu-client': 'web', 'idempotency-key': randomUUID() },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1/${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(page: Page, options: { private?: boolean; long?: boolean } = {}) {
  const project = await post<Project>(page, 'spaces/space-demo/projects', {
    name: '版本反馈后续任务',
    description: '普通人工协作，不启动执行。',
  });
  const task = await post<Task>(page, 'spaces/space-demo/tasks', {
    title: '原任务保持不变',
    description: '已有工作',
    projectId: options.private ? null : project.id,
  });
  const result = await post<Result>(page, `tasks/${task.id}/results`, {
    title: '固定接口成果',
    body: '此版本的已保存说明',
  });
  const detail = await get<ResultDetail>(page, `results/${result.id}`);
  const message = await post<Message>(page, `tasks/${task.id}/messages`, {
    body: options.long ? '中'.repeat(12000) : '请为可选字段补充空值处理。',
    resultId: result.id,
    resultRevisionId: detail.version.id,
  });
  await post(page, `tasks/${task.id}/messages`, {
    body: '未指定版本的旧反馈不自动采用',
    resultId: result.id,
  });
  const before = await get<TaskDetail>(page, `tasks/${task.id}`);
  const url = `/results/${result.id}/versions/${detail.version.id}`;
  await page.goto(url);
  await expect(page.getByLabel('后续任务来源反馈')).toBeVisible();
  return { project, task, result, version: detail.version, message, before, url };
}
async function openDraft(page: Page, message: Message) {
  await page.getByLabel('后续任务来源反馈').selectOption(message.id);
  await page.getByRole('button', { name: '建立后续任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('选择固定反馈、取消重开和重复提交只创建一个同项目任务，原任务保持不变', async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByLabel('后续任务来源反馈').locator('option')).toHaveCount(2);
  let dialog = await openDraft(page, f.message);
  await expect(dialog.getByLabel('放在哪里')).toBeDisabled();
  await expect(dialog.getByLabel('放在哪里')).toHaveValue(f.project.id);
  const description = await dialog.getByLabel('补充说明').inputValue();
  expect(description).toContain(f.url);
  expect(description).toContain(f.message.id);
  expect(description).toContain(f.message.body);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  dialog = await openDraft(page, f.message);
  const writes: { key: string | undefined; body: unknown }[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/v1/spaces/space-demo/tasks'
    )
      writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
  });
  await dialog.locator('form').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  expect(writes).toHaveLength(1);
  const createdId = new URL(page.url()).pathname.split('/').at(-1)!;
  const created = await get<TaskDetail>(page, `tasks/${createdId}`);
  expect(created.task.projectId).toBe(f.project.id);
  expect(created.task.description).toBe(description);
  expect(created.task.status).toBe('todo');
  expect(created.runs).toEqual([]);
  expect(await get<TaskDetail>(page, `tasks/${f.task.id}`)).toEqual(f.before);
});

test('关闭未知创建后从反馈入口恢复同键同正文，不复制第二份任务', async ({ page }) => {
  const f = await fixture(page);
  let loseReply = true;
  const writes: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/v1/spaces/space-demo/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    const response = await route.fetch();
    if (loseReply) {
      loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEST_LOST', message: '测试丢失回包', retryable: true },
        }),
      });
    }
    return route.fulfill({ response });
  });
  let dialog = await openDraft(page, f.message);
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认原创建结果', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '暂时关闭', exact: true }).click();
  dialog = await openDraft(page, f.message);
  await expect(dialog.getByLabel('要做什么')).toBeDisabled();
  await dialog.getByRole('button', { name: '确认原创建结果', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  const tasks = await get<{ items: Task[] }>(
    page,
    `spaces/space-demo/tasks?projectId=${f.project.id}`,
  );
  expect(tasks.items.filter((item) => item.id !== f.task.id)).toHaveLength(1);
});

test('未提交导航后返回不恢复草稿，超长反馈必须明确精简', async ({ page }) => {
  const f = await fixture(page, { long: true });
  let dialog = await openDraft(page, f.message);
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  expect((await dialog.getByLabel('补充说明').inputValue()).endsWith(f.message.body)).toBe(true);
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/projects/${f.project.id}`);
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('后续任务来源反馈')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  dialog = await openDraft(page, f.message);
  await dialog.getByLabel('补充说明').fill('已明确精简的修改要求');
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await get<TaskDetail>(page, `tasks/${f.task.id}`)).toEqual(f.before);
});

test('私有成果不提供携带反馈的新任务入口', async ({ page }) => {
  await fixture(page, { private: true });
  await expect(page.getByLabel('后续任务来源反馈')).toBeDisabled();
  await expect(page.getByRole('button', { name: '建立后续任务', exact: true })).toBeDisabled();
  await expect(
    page.getByText('当前仅支持项目可见成果；个人或私有成果暂不支持此入口。'),
  ).toBeVisible();
});
