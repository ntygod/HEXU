import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  IntegrationRecoveryReport,
  IntegrationView,
} from '../../packages/contracts/src/integrations.js';
import { integrationFixture } from '../helpers/integrations.js';

// Protocol metadata only. Browser execution is separate from the real local recovery tests.
const origin = 'http://127.0.0.1:4318';
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const observation = (page: Page) =>
  records(page).getByRole('region', { name: '本机保留文件结算观察', exact: true });
async function prepare(f: Fixture, state: 'queued' | 'applying' | 'needs_attention' | 'completed') {
  const created = await f.create();
  const preflight = await f.protocol('publish', f.report(created));
  expect(preflight.statusCode, preflight.body).toBe(200);
  const ready = (
    await f.api.call(`${f.integrationPath}/${created.operation.id}`, f.alice)
  ).json() as IntegrationView;
  const applied = await f.api.call(`${f.integrationPath}/${created.operation.id}/apply`, f.alice, {
    expectedRevision: ready.operation.revision,
    expectedTaskRevision: ready.taskRevision,
    reportHash: ready.reportHash,
    paths: ['new.txt'],
    confirmApplication: true,
  });
  expect(applied.statusCode, applied.body).toBe(200);
  const queued = applied.json() as IntegrationView,
    a = queued.operation.application!;
  for (const stage of state === 'queued'
    ? []
    : state === 'applying'
      ? ['applying']
      : ['applying', state]) {
    const result = await f.protocol('apply-publish', {
      integrationId: queued.operation.id,
      applicationId: a.id,
      inputHash: a.inputHash,
      sequence: stage === 'applying' ? 1 : 2,
      stage,
      observedAt: new Date().toISOString(),
      appliedPaths: stage === 'applying' ? [] : a.paths,
      reason: stage === 'needs_attention' ? 'interrupted' : null,
      confirmPublication: true,
    });
    expect(result.statusCode, result.body).toBe(200);
  }
  return (
    await f.api.call(`${f.integrationPath}/${created.operation.id}`, f.alice)
  ).json() as IntegrationView;
}
async function recover(f: Fixture, v: IntegrationView) {
  const report: IntegrationRecoveryReport = {
    version: 1,
    kind: 'local_integration_settlement',
    integrationId: v.operation.id,
    applicationId: v.operation.application!.id,
    recoveryId: randomUUID(),
    integrationInputHash: v.operation.inputHash,
    applicationInputHash: v.operation.application!.inputHash,
    originalApplicationEvidenceHash: 'e'.repeat(64),
    stoppedConfirmedAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedAddedCount: 1,
    unresolvedWriteIntent: true,
    confirmPublication: true,
  };
  const result = await f.protocol('recovery-publish', report);
  expect(result.statusCode, result.body).toBe(200);
  return report;
}
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4318, host: '127.0.0.1' });
  await page.context().addCookies(
    f.alice.cookie.split('; ').map((cookie) => {
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
    { userId: f.alice.user.id, spaceId: f.alice.spaceId },
  );
  await page.goto(`${origin}/tasks/${f.task.id}`);
  await page.getByRole('button', { name: '整合预检', exact: true }).click();
}
async function close(page: Page, f: Fixture) {
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
async function expectObservation(page: Page) {
  const section = observation(page);
  await expect(section).toBeVisible();
  await expect(section).toContainText(
    '原目标节点所有者当时明确确认原应用进程及全部子进程、遗留孤儿进程均已停止',
  );
  await expect(section).toContainText('进程均已停止');
  await expect(section).toContainText('仅本次应用的占用已释放');
  await expect(section).toContainText('保留全部文件，未重新核验文件内容或应用成功');
  await expect(section).toContainText('此历史观察不代表目录当前可用，也不授权再次应用');
  await expect(section).toContainText('原本机记录含 1 个新增文件记录');
  await expect(section).toContainText('仍有未决写入意图');
  await expect(
    records(page).getByRole('button', { name: '选择文件应用', exact: true }),
  ).toHaveCount(0);
  await expect(
    records(page).getByRole('button', { name: '取消应用请求', exact: true }),
  ).toHaveCount(0);
}

test('原取消记录收到后续本机结算观察时不宣称未开始写入', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await prepare(f, 'queued');
    const cancelled = await f.api.call(`${f.integrationPath}/${v.operation.id}/cancel`, f.alice, {
      expectedRevision: v.operation.revision,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await recover(f, v);
    await open(page, f);
    await expectObservation(page);
    await expect(records(page).getByText('已取消应用请求', { exact: true }).first()).toBeVisible();
    const application = records(page).getByRole('region', { name: '文件应用状态', exact: true });
    await expect(application).toContainText(
      '此处保留原应用取消记录与历史；不能据此断言本机未开始写入',
    );
    await expect(application).not.toContainText('已在节点进入应用阶段前取消');
    const after = (
      await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)
    ).json() as IntegrationView;
    expect(after.operation).toEqual(cancelled.json().operation);
  } finally {
    await close(page, f);
  }
});

test('保留文件结算观察显示在原待处理报告旁，刷新/关闭重开不改原状态或重新提供应用', async ({
  page,
}) => {
  const f = await integrationFixture(origin);
  try {
    const v = await prepare(f, 'needs_attention');
    await open(page, f);
    await expect(records(page).getByText('应用需要本机处理', { exact: true })).toBeVisible();
    await expect(observation(page)).toHaveCount(0);
    await recover(f, v);
    await expectObservation(page);
    await expect(records(page).getByText('应用需要本机处理', { exact: true })).toBeVisible();
    await expect(
      records(page).getByRole('region', { name: '文件应用状态', exact: true }),
    ).toContainText('原应用报告仍为需要本机处理');
    await expect(records(page).getByLabel('已确认写入路径')).toContainText('new.txt');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expectObservation(page);
    await page.reload();
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expectObservation(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() => records(page).evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => observation(page).evaluate((element) => element.clientWidth))
      .toBeGreaterThan(280);
    const after = (
      await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)
    ).json() as IntegrationView;
    expect(after.operation).toEqual(v.operation);
    expect(after.canApply).toBe(false);
  } finally {
    await close(page, f);
  }
});

for (const [state, label] of [
  ['queued', '等待本人本机确认应用'],
  ['applying', '应用进行中 · 等待节点结算'],
  ['completed', '所选文件已应用'],
] as const) {
  test(`${state}原应用状态与本机结算历史独立呈现`, async ({ page }) => {
    const f = await integrationFixture(origin);
    try {
      const v = await prepare(f, state);
      await recover(f, v);
      await open(page, f);
      await expectObservation(page);
      await expect(records(page).getByText(label, { exact: true })).toBeVisible();
      if (state === 'queued')
        await expect(records(page).getByText(/npm run runner:integration-apply/)).toHaveCount(0);
      if (state !== 'completed')
        await expect(records(page).getByText('所选文件已应用', { exact: true })).toHaveCount(0);
      const after = (
        await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)
      ).json() as IntegrationView;
      expect(after.operation).toEqual(v.operation);
      expect(after.operation.applied).toBe(state === 'completed');
    } finally {
      await close(page, f);
    }
  });
}
