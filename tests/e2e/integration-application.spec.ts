import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  IntegrationApplicationReport,
  IntegrationReport,
  IntegrationView,
} from '../../packages/contracts/src/integrations.js';
import { integrationFixture } from '../helpers/integrations.js';

// These browser fixtures publish protocol metadata, not actual filesystem writes.
// The local writer and recovery evidence are covered by the runner integration tests.
const origin = 'http://127.0.0.1:4318';
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: '确认选择性应用', exact: true });
const consent = (page: Page) => editor(page).getByRole('checkbox', { name: /我已核对固定来源/ });
const submit = (page: Page) =>
  editor(page).getByRole('button', { name: '确认所选应用范围', exact: true });
const getView = async (f: Fixture, id: string) =>
  (await f.api.call(`${f.integrationPath}/${id}`, f.alice)).json() as IntegrationView;
async function ready(f: Fixture, allActions = false) {
  const v = await f.create(),
    report = f.report(v) as IntegrationReport;
  if (allActions) {
    const plan = report.plan!,
      modify = plan.files.find((file) => file.action === 'modify')!,
      add = plan.files.find((file) => file.action === 'add')!;
    plan.files.push(
      { ...add, path: 'other.txt' },
      {
        path: 'removed.txt',
        action: 'delete',
        base: modify.base,
        source: null,
        target: modify.base,
        conflict: null,
      },
      {
        path: 'present.txt',
        action: 'already_present',
        base: modify.base,
        source: modify.source,
        target: modify.source,
        conflict: null,
      },
      {
        path: 'conflict.txt',
        action: 'conflict',
        base: modify.base,
        source: modify.source,
        target: { ...modify.base!, objectId: 'e'.repeat(modify.base!.objectId.length) },
        conflict: 'both_changed',
      },
    );
    plan.changedFiles = plan.files.length;
    plan.conflicts = 1;
    plan.alreadyPresent = 1;
  }
  const published = await f.protocol('publish', report);
  expect(published.statusCode, published.body).toBe(200);
  return getView(f, v.operation.id);
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
async function choose(page: Page) {
  await records(page).getByRole('button', { name: '选择文件应用', exact: true }).click();
  await editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }).check();
  await consent(page).check();
  await expect(submit(page)).toBeEnabled();
}
async function queue(f: Fixture, v: IntegrationView) {
  const response = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, f.alice, {
    expectedRevision: v.operation.revision,
    expectedTaskRevision: v.taskRevision,
    reportHash: v.reportHash,
    paths: ['new.txt'],
    confirmApplication: true,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as IntegrationView;
}
async function publish(
  f: Fixture,
  v: IntegrationView,
  stage: IntegrationApplicationReport['stage'],
  appliedPaths: string[] = [],
) {
  const a = v.operation.application!;
  const response = await f.protocol('apply-publish', {
    integrationId: v.operation.id,
    applicationId: a.id,
    inputHash: a.inputHash,
    sequence: stage === 'applying' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    appliedPaths,
    reason:
      stage === 'needs_attention'
        ? 'interrupted'
        : stage === 'failed'
          ? 'application_failed'
          : null,
    confirmPublication: true,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}

test('文件应用只允许新增，选择变化重置确认；重复点击、丢失回执和关闭重开沿用原请求', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin, 'sha256');
  try {
    const v = await ready(f, true);
    const beforeTask = f.as(() => f.api.store.getTask(f.task.id));
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件应用', exact: true }).click();
    await expect(editor(page).getByLabel('固定应用基线')).toContainText(f.source.commit);
    await expect(editor(page).getByLabel('固定应用基线')).toContainText(f.target.commit);
    await expect(editor(page).getByLabel('固定应用基线')).toContainText(f.tr.request.id);
    for (const name of ['README.md', 'removed.txt', 'present.txt', 'conflict.txt']) {
      await expect(
        editor(page).getByRole('checkbox', { name: `选择 ${name}`, exact: true }),
      ).toBeDisabled();
    }
    await editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }).check();
    await consent(page).check();
    await editor(page).getByRole('checkbox', { name: '选择 other.txt', exact: true }).check();
    await expect(consent(page)).not.toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('checkbox', { name: '选择 other.txt', exact: true }).uncheck();
    await consent(page).check();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/118-integration-application-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() =>
        editor(page)
          .locator('form')
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        editor(page)
          .locator('form')
          .evaluate((element) => element.clientWidth),
      )
      .toBeGreaterThan(320);
    await page.screenshot({ path: 'artifacts/119-integration-application-mobile-light.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const attempts: { key: string; body: string | null }[] = [];
    let drop = true;
    await page.route(
      `${origin}/api/v1/${f.integrationPath}/${v.operation.id}/apply`,
      async (route) => {
        attempts.push({
          key: route.request().headers()['idempotency-key']!,
          body: route.request().postData(),
        });
        if (drop) {
          drop = false;
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      },
    );
    await submit(page).evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(editor(page).getByLabel('应用请求待确认')).toBeVisible();
    expect(attempts).toHaveLength(1);
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).toBeDisabled();
    await editor(page)
      .locator('.dialog-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page).getByLabel('文件应用状态')).toContainText(
      '等待本人在目标节点确认应用',
    );
    await expect(
      records(page).getByRole('button', { name: '取消应用请求', exact: true }),
    ).toHaveCount(0);
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await records(page).getByRole('button', { name: '继续确认应用请求', exact: true }).click();
    await expect(editor(page).getByLabel('应用请求待确认')).toBeVisible();
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).toBeChecked();
    await editor(page).getByRole('button', { name: '确认上次应用请求', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(JSON.parse(attempts[0]!.body!)).toEqual({
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: ['new.txt'],
      confirmApplication: true,
    });
    const queued = await getView(f, v.operation.id);
    await expect(records(page).getByLabel('文件应用状态')).toContainText(
      `runner:integration-apply -- --operation ${v.operation.id}`,
    );
    await publish(f, queued, 'applying');
    await expect(records(page).getByLabel('文件应用状态')).toContainText('可能已经写入');
    await expect(
      records(page).getByRole('button', { name: '取消应用请求', exact: true }),
    ).toHaveCount(0);
    await expect(records(page)).not.toContainText('代码尚未应用');
    await publish(f, queued, 'completed', ['new.txt']);
    await expect(records(page).getByLabel('文件应用状态')).toContainText('未标记任务完成');
    await expect(records(page).getByLabel('已确认写入路径')).toContainText('new.txt');
    await expect(records(page).getByLabel('文件整合预检')).toContainText('冲突 1');
    const completed = await getView(f, v.operation.id);
    expect(completed.operation.applied).toBe(true);
    expect(completed.operation.report).toEqual(v.operation.report);
    expect(completed.operation.report!.plan!.applied).toBe(false);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(beforeTask);
  } finally {
    await close(page, f);
  }
});

test('临时读取错误保留选择，任务修订变化冻结基线直到明确核对；关闭未提交选择不创建请求', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    await open(page, f);
    await choose(page);
    const url = `${origin}/api/v1/${f.integrationPath}/${v.operation.id}`;
    await page.route(url, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '应用状态临时不可读' } }),
      }),
    );
    await expect(editor(page)).toContainText('应用状态临时不可读');
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).toBeChecked();
    await expect(consent(page)).toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await page.unroute(url);
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    await editor(page).getByRole('button', { name: '重读应用状态', exact: true }).click();
    await expect(editor(page)).toContainText('明确重新核对后才能提交');
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('button', { name: '重新核对应用基线', exact: true }).click();
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await expect(submit(page)).toBeEnabled();
    await editor(page)
      .locator('.dialog-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    expect((await getView(f, v.operation.id)).operation.application).toBeNull();
    await records(page).getByRole('button', { name: '选择文件应用', exact: true }).click();
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).not.toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toBeVisible();
  } finally {
    await close(page, f);
  }
});

test('明确请求错误保留编辑并可重试，排队应用可取消且不丢历史预检', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    await open(page, f);
    await choose(page);
    const url = `${origin}/api/v1/${f.integrationPath}/${v.operation.id}/apply`;
    await page.route(url, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '应用请求测试冲突' } }),
      }),
    );
    await submit(page).click();
    await expect(editor(page)).toContainText('应用请求测试冲突');
    await expect(editor(page).getByLabel('应用请求待确认')).toHaveCount(0);
    await expect(
      editor(page).getByRole('checkbox', { name: '选择 new.txt', exact: true }),
    ).toBeChecked();
    await page.unroute(url);
    await submit(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('等待本人本机确认应用');
    await records(page).getByRole('button', { name: '取消应用请求', exact: true }).click();
    await expect(records(page)).toContainText('已取消应用请求');
    await expect(records(page).getByLabel('文件整合预检')).toBeVisible();
    await expect(
      records(page).getByRole('button', { name: '选择文件应用', exact: true }),
    ).toHaveCount(0);
    const cancelled = await getView(f, v.operation.id);
    expect(cancelled.operation.state).toBe('cancelled');
    expect(cancelled.operation.application!.reports).toEqual([]);
  } finally {
    await close(page, f);
  }
});

for (const deniedBy of ['read', 'command'] as const)
  test(`应用${deniedBy === 'read' ? '读取' : '提交'}撤权清除内容，重新打开不恢复旧选择`, async ({
    page,
  }) => {
    const f = await integrationFixture(origin);
    try {
      const v = await ready(f);
      await open(page, f);
      await choose(page);
      await page.route(
        `${origin}/api/v1/${f.integrationPath}/${v.operation.id}${deniedBy === 'command' ? '/apply' : ''}`,
        (route) =>
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: '测试权限已撤销' } }),
          }),
      );
      if (deniedBy === 'command') await submit(page).click();
      await expect(editor(page)).toHaveCount(0);
      await expect(records(page)).toContainText('整合内容已清除');
      await records(page).getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '整合预检', exact: true }).click();
      await expect(records(page)).toContainText('整合内容已清除');
      await expect(records(page)).not.toContainText(f.source.commit);
      await expect(
        records(page).getByRole('button', { name: '继续确认应用请求', exact: true }),
      ).toHaveCount(0);
      expect((await getView(f, v.operation.id)).operation.application).toBeNull();
    } finally {
      await close(page, f);
    }
  });

test('应用中断展示部分写入和处理边界，不能取消或误报未写入', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await queue(f, await ready(f));
    await publish(f, v, 'applying');
    await publish(f, v, 'needs_attention', ['new.txt']);
    await open(page, f);
    await expect(records(page)).toContainText('应用需要本机处理');
    await expect(records(page).getByLabel('文件应用状态')).toContainText('可能已部分写入');
    await expect(records(page).getByLabel('已确认写入路径')).toContainText('new.txt');
    await expect(records(page)).not.toContainText('代码尚未应用');
    await expect(
      records(page).getByRole('button', { name: '取消应用请求', exact: true }),
    ).toHaveCount(0);
    await expect(records(page).getByLabel('文件整合预检')).toBeVisible();
  } finally {
    await close(page, f);
  }
});
