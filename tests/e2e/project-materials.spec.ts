import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': randomUUID() });
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post('/api/v1/' + path, { headers: headers(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(page: Page, content = 'MATERIAL_SELECTED_V1\n正文末行\n') {
  const project = await post(page, 'spaces/space-demo/projects', {
      name: '项目选材 ' + randomUUID().slice(0, 5),
    }),
    task = await post(page, 'spaces/space-demo/tasks', {
      title: '按确认材料处理任务',
      projectId: project.id,
    });
  const source = await post(page, `projects/${project.id}/sources`, {
    kind: 'text',
    title: '接口参考',
    content,
  });
  await post(page, `projects/${project.id}/sources`, {
    kind: 'text',
    title: '不采用的资料',
    content: 'MATERIAL_NOT_SELECTED',
  });
  return { project, task, source };
}
async function open(page: Page, taskId: string, prompt = 'FIXTURE_CAPTURE_INPUT') {
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '使用本机原生工具', exact: true }).click();
  await page.getByLabel('接下来做什么', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: '选择项目材料', exact: true }).click();
}
const consent = (page: Page) => page.getByRole('checkbox', { name: /我允许本次/ });
const start = (page: Page) => page.getByRole('button', { name: '开始原生执行', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: '使用本机原生工具', exact: true });

test('原生选材显示固定版本、实际启动及完整输入，未选资料不发送，深浅色和手机可用', async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page, f.task.id);
  await page.getByLabel('选取资料：接口参考', { exact: true }).check();
  await expect(panel(page).getByText(/查看固定版本预览/)).toBeVisible();
  await consent(page).check();
  await page.getByLabel('摘录范围：接口参考', { exact: true }).selectOption('1000');
  await expect(consent(page)).not.toBeChecked();
  await consent(page).check();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/60-project-material-picker-dark.png', fullPage: true });
  await start(page).click();
  await expect(page.getByText('本次原生已结束', { exact: true })).toBeVisible();
  const current = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json(),
    run = current.runs[0];
  const view = await (await page.request.get(`/api/v1/runs/${run.id}/materials`)).json();
  expect(view.state).toBe('started');
  expect(view.bundle.snapshot.items).toHaveLength(1);
  expect(view.bundle.contextText).toContain('MATERIAL_SELECTED_V1');
  expect(view.bundle.contextText).not.toContain('MATERIAL_NOT_SELECTED');
  await expect(page.getByLabel('执行项目选材', { exact: true })).toContainText('执行器已确认启动');
  const changed = await page.request.patch(
    `/api/v1/projects/${f.project.id}/sources/${f.source.id}`,
    {
      headers: headers(),
      data: {
        expectedRevision: 1,
        title: f.source.title,
        content: 'MATERIAL_NEWER_VERSION',
        url: null,
      },
    },
  );
  expect(changed.ok()).toBe(true);
  await page.reload();
  const recorded = await (await page.request.get(`/api/v1/runs/${run.id}/materials`)).json();
  expect(recorded.bundle).toEqual(view.bundle);
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByText('查看当时固定的项目材料', { exact: true }).click();
  await page.screenshot({ path: 'artifacts/61-run-materials-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/62-run-materials-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('资料版本变化保留要求并要求核对，预算超限明确阻止启动，摘录不会静默丢失', async ({ page }) => {
  const f = await fixture(page, '甲'.repeat(8000));
  await post(page, `projects/${f.project.id}/sources`, {
    kind: 'text',
    title: '另一份大资料',
    content: '乙'.repeat(8000),
  });
  await open(page, f.task.id, '本次要求保持不变');
  await page.getByLabel('选取资料：接口参考', { exact: true }).check();
  await page.getByLabel('选取资料：另一份大资料', { exact: true }).check();
  await expect(panel(page)).toContainText('项目补充材料超过 10000 字符');
  await expect(start(page)).toBeDisabled();
  await page.getByLabel('摘录范围：接口参考', { exact: true }).selectOption('1000');
  await page.getByLabel('摘录范围：另一份大资料', { exact: true }).selectOption('1000');
  await panel(page)
    .getByText(/查看固定版本预览/)
    .click();
  await expect(panel(page)).toContainText('7000 字符未包含');
  await consent(page).check();
  const response = await page.request.patch(
    `/api/v1/projects/${f.project.id}/sources/${f.source.id}`,
    {
      headers: headers(),
      data: { expectedRevision: 1, title: f.source.title, content: '新版资料内容', url: null },
    },
  );
  expect(response.ok()).toBe(true);
  await expect(panel(page)).toContainText('所选资料或约定的版本、可用状态已变化');
  await expect(start(page)).toBeDisabled();
  await expect(page.getByLabel('接下来做什么', { exact: true })).toHaveValue('本次要求保持不变');
  await page.getByRole('button', { name: '核对并采用所选材料最新版本', exact: true }).click();
  await expect(panel(page)).not.toContainText('所选资料或约定的版本、可用状态已变化');
  await expect(consent(page)).not.toBeChecked();
  await expect(page.getByLabel('已选项目材料', { exact: true })).toContainText('已选 r2');
  expect((await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json()).runs).toHaveLength(
    0,
  );
  await page.keyboard.press('Escape');
});

test('原生执行丢失回执只确认原请求，不因运行状态变化改成另一份执行或接续', async ({ page }) => {
  const f = await fixture(page);
  await open(page, f.task.id);
  await page.getByLabel('选取资料：接口参考', { exact: true }).check();
  await consent(page).check();
  let drop = true;
  const requests: { key: string; body: unknown }[] = [];
  await page.route(`**/api/v1/tasks/${f.task.id}/runs`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({
      key: route.request().headers()['idempotency-key']!,
      body: route.request().postDataJSON(),
    });
    if (drop) {
      drop = false;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await start(page).click();
  await expect(page.getByLabel('执行请求待确认', { exact: true })).toBeVisible();
  await expect(page.getByLabel('接下来做什么', { exact: true })).toBeDisabled();
  await expect(start(page)).toBeDisabled();
  await page.getByRole('button', { name: '确认上次执行请求', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.key).toBeTruthy();
  expect(requests[0]).toEqual(requests[1]);
  await expect
    .poll(async () => {
      const d = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
      return d.runs[0]?.state;
    })
    .toBe('succeeded');
  const data = await (await page.request.get(`/api/v1/tasks/${f.task.id}`)).json();
  expect(data.runs).toHaveLength(1);
  expect(data.runs[0].materialBundleId).toBeTruthy();
});

test('原生等待固定所选项目材料，版本变化暂停安排且不停止源执行，原快照可查看', async ({ page }) => {
  const f = await fixture(page);
  const native = await (await page.request.get('/api/v1/native')).json();
  const source = await post(page, `tasks/${f.task.id}/runs`, {
    provider: 'native',
    requestedTool: 'claude-code',
    workingCopyId: native.workspaces[0].id,
    prompt: 'FIXTURE_HANG',
    confirmExecution: true,
    expectedRevision: 1,
  });
  try {
    await page.goto(`/tasks/${f.task.id}`);
    await page.getByRole('button', { name: '准备接续', exact: true }).click();
    await page.getByLabel('接下来做什么', { exact: true }).fill('FIXTURE_CAPTURE_INPUT');
    await page.getByLabel('如何处理原执行', { exact: true }).selectOption('wait');
    await page.getByRole('button', { name: '选择项目材料', exact: true }).click();
    await page.getByLabel('选取资料：接口参考', { exact: true }).check();
    await consent(page).check();
    await page.getByRole('button', { name: '原执行结束后继续', exact: true }).click();
    await expect(page.getByLabel('接续项目选材', { exact: true })).toContainText(
      '本次确认的项目材料已固定',
    );
    const before = (
      await (await page.request.get(`/api/v1/tasks/${f.task.id}/continuations`)).json()
    ).items[0];
    await page.request.patch(`/api/v1/projects/${f.project.id}/sources/${f.source.id}`, {
      headers: headers(),
      data: {
        expectedRevision: 1,
        title: f.source.title,
        content: 'SOURCE_CHANGED_WHILE_WAITING',
        url: null,
      },
    });
    await expect(page.locator('.continuation-status-title strong')).toHaveText('需要处理');
    const operation = (
      await (await page.request.get(`/api/v1/tasks/${f.task.id}/continuations`)).json()
    ).items[0];
    expect(operation.materialBundleId).toBe(before.materialBundleId);
    expect((await (await page.request.get(`/api/v1/runs/${source.id}`)).json()).state).toBe(
      'running',
    );
    const bundle = await (
      await page.request.get(
        `/api/v1/tasks/${f.task.id}/material-bundles/${operation.materialBundleId}`,
      )
    ).json();
    expect(bundle.snapshot.text).toContain('MATERIAL_SELECTED_V1');
    expect(bundle.snapshot.text).not.toContain('SOURCE_CHANGED_WHILE_WAITING');
    expect(bundle.runId).toBeNull();
  } finally {
    const plans = await (await page.request.get(`/api/v1/tasks/${f.task.id}/continuations`)).json();
    for (const op of plans.items ?? [])
      if (['waiting_for_stop', 'preparing'].includes(op.state))
        await post(page, `operations/${op.id}/cancel`, { expectedRevision: op.revision });
    await post(page, `runs/${source.id}/stop`, {});
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/v1/runs/${source.id}`)).json()).native
            .terminationConfirmed,
      )
      .toBe(true);
  }
});
