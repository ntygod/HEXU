import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function start(page: Page) {
  const task = await (
    await page.request.post('/api/v1/spaces/space-demo/tasks', {
      headers: headers(),
      data: { title: '持久化接续 · 协议替身测试' },
    })
  ).json();
  const native = await (await page.request.get('/api/v1/native')).json();
  const response = await page.request.post(`/api/v1/tasks/${task.id}/runs`, {
    headers: headers(),
    data: {
      provider: 'native',
      requestedTool: 'claude-code',
      prompt: 'FIXTURE_HANG',
      workingCopyId: native.workspaces[0].id,
      mode: 'edit',
      confirmExecution: true,
      expectedRevision: task.revision,
    },
  });
  expect(response.status()).toBe(201);
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('button', { name: '停止原生执行', exact: true })).toBeVisible();
  return task.id as string;
}
async function prepare(page: Page, policy: 'wait' | 'request_stop', prompt: string) {
  await page.getByRole('button', { name: '准备接续', exact: true }).click();
  await page.locator('.native-tool-choice button').filter({ hasText: 'Codex' }).click();
  await page.getByLabel('本次能力', { exact: true }).selectOption('edit');
  await page.getByLabel('接下来做什么', { exact: true }).fill(prompt);
  await page.getByLabel('如何处理原执行', { exact: true }).selectOption(policy);
  await page.getByRole('checkbox').check();
}
async function cleanup(page: Page, id: string) {
  const operations = await (await page.request.get(`/api/v1/tasks/${id}/continuations`)).json();
  for (const op of operations.items ?? [])
    if (['waiting_for_stop', 'preparing'].includes(op.state))
      await page.request.post(`/api/v1/operations/${op.id}/cancel`, {
        headers: headers(),
        data: { expectedRevision: op.revision },
      });
  const detail = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
  for (const run of detail.runs)
    if (!['succeeded', 'failed', 'cancelled'].includes(run.state))
      await page.request.post(`/api/v1/runs/${run.id}/stop`, { headers: headers(), data: {} });
  await expect
    .poll(async () => {
      const current = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
      return current.runs.every((r: { state: string }) =>
        ['succeeded', 'failed', 'cancelled'].includes(r.state),
      );
    })
    .toBe(true);
}

test('在运行中的任务直接安排停止后跨工具继续，并保留接续记录', async ({ page }) => {
  const id = await start(page);
  try {
    await prepare(page, 'request_stop', 'CODEX_WRITE');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/11-stop-then-continue.png', fullPage: true });
    await page.getByRole('button', { name: '停止后用 Codex 继续', exact: true }).click();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('已创建新执行');
    await expect(
      page.locator('.message-content').filter({ hasText: /Codex fixture result \[REDACTED\]/ }),
    ).toBeVisible();
    const detail = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[0].state).toBe('cancelled');
    expect(detail.runs[0].native.terminationConfirmed).toBe(true);
    expect(detail.runs[1].previousRunId).toBe(detail.runs[0].id);
    expect(detail.task.status).toBe('in_progress');
    await page.reload();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('已创建新执行');
    await page.screenshot({ path: 'artifacts/12-continuation-created.png', fullPage: true });
  } finally {
    await cleanup(page, id);
  }
});

test('等待安排刷新后仍可取消，浅深色和窄屏不溢出', async ({ page }) => {
  const id = await start(page);
  try {
    await prepare(page, 'wait', '请保留此请求，等待原执行结束');
    await page.getByRole('button', { name: '原执行结束后继续', exact: true }).click();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('等待原执行结束');
    await page.reload();
    await expect(page.getByRole('button', { name: '取消接续', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止原生执行', exact: true })).toBeVisible();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/13-continuation-waiting.png', fullPage: true });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/14-continuation-mobile-dark.png', fullPage: true });
    await page.getByRole('button', { name: '取消接续', exact: true }).click();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('接续已取消');
    await page.reload();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('接续已取消');
    const detail = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].state).toBe('running');
  } finally {
    await cleanup(page, id);
  }
});

test('等待时新增人工要求会暂停接续，原因和原要求在刷新后保留', async ({ page }) => {
  const id = await start(page);
  try {
    await prepare(page, 'wait', '保留这个要求，不自动启动');
    await page.getByRole('button', { name: '原执行结束后继续', exact: true }).click();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('等待原执行结束');
    await page
      .getByLabel('任务评论', { exact: true })
      .fill('范围发生变化，先不要自动发送给另一个工具');
    await page.getByRole('button', { name: '发送评论', exact: true }).click();
    await expect(page.locator('.continuation-status-title strong')).toHaveText('需要处理');
    await expect(page.locator('.continuation-blocker')).toContainText('人工说明或讨论已变化');
    await page.reload();
    await expect(page.getByRole('button', { name: '重新配置继续', exact: true })).toBeVisible();
    await page.locator('.continuation-records summary').click();
    await expect(page.locator('.continuation-prompt')).toContainText('保留这个要求，不自动启动');
    await page.screenshot({
      path: 'artifacts/15-continuation-needs-attention.png',
      fullPage: true,
    });
    const detail = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
    expect(detail.runs).toHaveLength(1);
  } finally {
    await cleanup(page, id);
  }
});
