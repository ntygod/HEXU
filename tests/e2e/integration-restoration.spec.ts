import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IntegrationView } from '../../packages/contracts/src/integrations.js';
import type {
  IntegrationFileRestorationReport,
  IntegrationFileRestorationRecoveryReport,
} from '../../packages/contracts/src/integration-restorations.js';
import { integrationFixture } from '../helpers/integrations.js';

// Real service/HTTP flows using deterministic protocol metadata, never filesystem restore evidence.
// Local byte/inode safety is covered separately by the runner restoration tests.
const origin = 'http://127.0.0.1:4318';
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '确认恢复原应用文件', exact: true });
const cancelEditor = (page: Page) =>
  page.getByRole('dialog', { name: '确认取消文件恢复', exact: true });
const status = (page: Page) =>
  records(page).getByRole('region', { name: '文件恢复状态', exact: true });
const consent = (page: Page) =>
  editor(page).getByRole('checkbox', { name: /^我已核对原应用、完成报告、目标与全部路径/ });
const submit = (page: Page) =>
  editor(page).getByRole('button', { name: '确认全部文件恢复', exact: true });
const endpoint = (f: Fixture, v: IntegrationView) =>
  `${f.integrationPath}/${v.operation.id}/restore`;
async function getView(f: Fixture, id: string) {
  const response = await f.api.call(`${f.integrationPath}/${id}`, f.alice);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as IntegrationView;
}
const createBody = (v: IntegrationView) => ({
  applicationId: v.operation.application!.id,
  applicationInputHash: v.operation.application!.inputHash,
  completedReportHash: v.completedReportHash,
  paths: v.operation.application!.paths,
  expectedRevision: v.operation.revision,
  expectedTaskRevision: v.taskRevision,
  confirmFileRestoration: true,
});
async function completed(f: Fixture, stage: 'completed' | 'needs_attention' = 'completed') {
  const initial = await f.create(),
    report = f.report(initial),
    add = report.plan.files.find((file) => file.path === 'new.txt')!;
  report.plan.files.push({ ...add, path: 'nested/second.txt' });
  report.plan.changedFiles++;
  const published = await f.protocol('publish', report);
  expect(published.statusCode, published.body).toBe(200);
  const ready = await getView(f, initial.operation.id),
    applied = await f.api.call(`${f.integrationPath}/${initial.operation.id}/apply`, f.alice, {
      expectedRevision: ready.operation.revision,
      expectedTaskRevision: ready.taskRevision,
      reportHash: ready.reportHash,
      paths: ['nested/second.txt', 'new.txt'],
      confirmApplication: true,
    });
  expect(applied.statusCode, applied.body).toBe(200);
  const queued = applied.json() as IntegrationView,
    a = queued.operation.application!;
  for (const state of ['applying', stage] as const) {
    const response = await f.protocol('apply-publish', {
      integrationId: initial.operation.id,
      applicationId: a.id,
      inputHash: a.inputHash,
      sequence: state === 'applying' ? 1 : 2,
      stage: state,
      observedAt: new Date().toISOString(),
      appliedPaths: state === 'applying' ? [] : a.paths,
      reason: state === 'needs_attention' ? 'interrupted' : null,
      confirmPublication: true,
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  return getView(f, initial.operation.id);
}
async function queue(f: Fixture, v: IntegrationView) {
  const response = await f.api.call(endpoint(f, v), f.alice, createBody(v));
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as IntegrationView;
}
async function publish(
  f: Fixture,
  v: IntegrationView,
  stage: IntegrationFileRestorationReport['stage'],
  paths: string[] = [],
) {
  const r = v.restoration!;
  const report: IntegrationFileRestorationReport = {
    version: 1,
    kind: 'integration_file_restoration',
    integrationId: v.operation.id,
    applicationId: r.applicationId,
    restorationId: r.id,
    inputHash: r.inputHash,
    originalApplicationEvidenceHash: 'e'.repeat(64),
    sequence: stage === 'restoring' ? 1 : 2,
    stage,
    observedAt: new Date().toISOString(),
    restoredPaths: paths,
    reason:
      stage === 'needs_attention'
        ? 'interrupted'
        : stage === 'failed'
          ? 'restoration_failed'
          : null,
    confirmPublication: true,
  };
  const response = await f.protocol('restoration-publish', report);
  expect(response.statusCode, response.body).toBe(200);
}
async function settle(f: Fixture, v: IntegrationView) {
  const r = v.restoration!;
  const report: IntegrationFileRestorationRecoveryReport = {
    version: 1,
    kind: 'local_integration_restoration_settlement',
    integrationId: v.operation.id,
    applicationId: r.applicationId,
    restorationId: r.id,
    recoveryId: randomUUID(),
    integrationInputHash: v.operation.inputHash,
    applicationInputHash: r.applicationInputHash,
    restorationInputHash: r.inputHash,
    originalApplicationEvidenceHash: 'e'.repeat(64),
    restorationEvidenceHash: 'f'.repeat(64),
    pendingReportHash: null,
    stoppedConfirmedAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    disposition: 'preserve_files',
    processEvidence: 'operator_confirmed_stopped',
    lease: 'released',
    filesVerified: false,
    recordedRestoredCount: 0,
    unresolvedWriteIntent: true,
    confirmPublication: true,
  };
  const response = await f.protocol('restoration-recovery-publish', report);
  expect(response.statusCode, response.body).toBe(200);
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
  await records(page).getByRole('button', { name: '恢复原应用文件', exact: true }).click();
  await expect(submit(page)).toBeDisabled();
  await consent(page).check();
  await expect(submit(page)).toBeEnabled();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
async function closeEditor(page: Page, cancel = false) {
  await (cancel ? cancelEditor(page) : editor(page))
    .locator('.dialog-footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
}
async function reopenRecords(page: Page) {
  await records(page).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '整合预检', exact: true }).click();
}

test('文件恢复固定原应用全量范围，过期材料不阻断目标权限；重复点击和未知回执关闭重开保留原body/key', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin);
  try {
    const v = await completed(f),
      beforeTask = f.as(() => f.api.store.getTask(f.task.id));
    // Expired metadata fixture: restoration must not require source or target object retention.
    f.api.store.db
      .prepare("UPDATE checkpoint_retentions SET state='expired' WHERE id IN (?,?)")
      .run(f.sr.request.id, f.tr.request.id);
    const expired = await getView(f, v.operation.id);
    expect(expired.available).toBe(false);
    expect(expired.canRestoreFiles).toBe(true);
    await open(page, f);
    await choose(page);
    await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(
      v.operation.application!.id,
    );
    await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(v.completedReportHash!);
    await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(f.target.commit);
    await expect(editor(page).getByRole('checkbox')).toHaveCount(1);
    for (const path of v.operation.application!.paths)
      await expect(editor(page).getByLabel('原应用完整恢复路径')).toContainText(path);
    await expect(editor(page)).toContainText('不能强制覆盖后来的用户修改');
    await expect(editor(page)).toContainText('文件内容与Git可执行位');
    await expect(editor(page)).toContainText('不承诺原inode');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/129-integration-file-restoration-dark.png',
      fullPage: true,
    });
    const attempts: { key: string; body: string | null }[] = [];
    let drop = true;
    await page.route(`${origin}/api/v1/${endpoint(f, v)}`, async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await submit(page).evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(editor(page).getByLabel('文件恢复请求待确认')).toBeVisible();
    expect(attempts).toHaveLength(1);
    await expect(consent(page)).toBeDisabled();
    await closeEditor(page);
    await expect(status(page)).toContainText('等待本人本机确认文件恢复');
    await expect(
      records(page).getByRole('button', { name: '取消文件恢复请求', exact: true }),
    ).toHaveCount(0);
    await reopenRecords(page);
    await records(page).getByRole('button', { name: '继续确认文件恢复请求', exact: true }).click();
    await expect(consent(page)).toBeChecked();
    await expect(editor(page).getByLabel('文件恢复请求待确认')).toBeVisible();
    await editor(page).getByRole('button', { name: '确认上次文件恢复请求', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(JSON.parse(attempts[0]!.body!)).toEqual(createBody(v));
    const q = await getView(f, v.operation.id);
    await expect(status(page).getByLabel('本机文件恢复命令')).toContainText(
      `--restoration '${q.restoration!.id}'`,
    );
    await expect(status(page)).toContainText('全新私有备份绝对目录');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() => records(page).evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect.poll(() => status(page).evaluate((el) => el.clientWidth)).toBeGreaterThan(280);
    await expect
      .poll(() =>
        status(page)
          .getByLabel('本机文件恢复命令')
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: 'artifacts/130-integration-file-restoration-command-mobile-light.png',
      fullPage: true,
    });
    await publish(f, q, 'restoring');
    await expect(status(page)).toContainText('可能已部分恢复');
    await expect(
      records(page).getByRole('button', { name: '取消文件恢复请求', exact: true }),
    ).toHaveCount(0);
    await publish(f, q, 'completed', q.restoration!.paths);
    await expect(status(page)).toContainText('原应用文件已恢复');
    await expect(status(page)).toContainText('原应用创建的空目录仍保留');
    await expect(records(page).getByLabel('文件应用状态')).toContainText('原应用当时的完成报告');
    expect((await getView(f, v.operation.id)).operation).toEqual(v.operation);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(beforeTask);
  } finally {
    await close(page, f);
  }
});

test('读取和明确请求错误保留恢复确认；Task修订变化冻结基线，关闭未提交不创建恢复', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin);
  try {
    const v = await completed(f);
    await open(page, f);
    await choose(page);
    const readUrl = `${origin}/api/v1/${f.integrationPath}/${v.operation.id}`;
    await page.route(readUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '文件恢复状态暂时不可读' } }),
      }),
    );
    await expect(editor(page)).toContainText('文件恢复状态暂时不可读');
    await expect(consent(page)).toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await page.unroute(readUrl);
    f.as(() =>
      f.api.store.changeTask(
        f.task.id,
        'done',
        f.api.store.getTask(f.task.id).revision,
        'keep',
        randomUUID(),
      ),
    );
    await editor(page).getByRole('button', { name: '重读文件恢复状态', exact: true }).click();
    await expect(editor(page)).toContainText('明确重新核对后才能提交');
    await expect(consent(page)).toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('button', { name: '重新核对文件恢复基线', exact: true }).click();
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await expect(submit(page)).toBeEnabled();
    const createUrl = `${origin}/api/v1/${endpoint(f, v)}`;
    await page.route(createUrl, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '文件恢复请求测试冲突' } }),
      }),
    );
    await submit(page).click();
    await expect(editor(page)).toContainText('文件恢复请求测试冲突');
    await expect(editor(page).getByLabel('文件恢复请求待确认')).toHaveCount(0);
    await expect(consent(page)).toBeChecked();
    await page.unroute(createUrl);
    await closeEditor(page);
    expect((await getView(f, v.operation.id)).restoration).toBeNull();
    await records(page).getByRole('button', { name: '恢复原应用文件', exact: true }).click();
    await expect(consent(page)).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toBeVisible();
    expect((await getView(f, v.operation.id)).restoration).toBeNull();
  } finally {
    await close(page, f);
  }
});

test('明确恢复错误可重试；取消回执丢失后关闭重开仍只确认原取消请求', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await completed(f);
    await open(page, f);
    await choose(page);
    const createUrl = `${origin}/api/v1/${endpoint(f, v)}`;
    await page.route(createUrl, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '可重试的文件恢复冲突' } }),
      }),
    );
    await submit(page).click();
    await expect(editor(page)).toContainText('可重试的文件恢复冲突');
    await page.unroute(createUrl);
    await submit(page).click();
    await expect(editor(page)).toHaveCount(0);
    const q = await getView(f, v.operation.id),
      attempts: { key: string; body: string | null }[] = [];
    let drop = true;
    await page.route(`${createUrl}/cancel`, async (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postData(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await records(page).getByRole('button', { name: '取消文件恢复请求', exact: true }).click();
    await expect(cancelEditor(page)).toContainText('不停止本机进程');
    await cancelEditor(page)
      .getByRole('button', { name: '确认取消文件恢复请求', exact: true })
      .click();
    await expect(cancelEditor(page).getByLabel('取消文件恢复请求待确认')).toBeVisible();
    await closeEditor(page, true);
    await reopenRecords(page);
    await records(page)
      .getByRole('button', { name: '继续确认取消文件恢复请求', exact: true })
      .click();
    await cancelEditor(page)
      .getByRole('button', { name: '确认上次取消文件恢复请求', exact: true })
      .click();
    await expect(cancelEditor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(JSON.parse(attempts[0]!.body!)).toEqual({
      restorationId: q.restoration!.id,
      expectedRevision: q.restoration!.revision,
      expectedTaskRevision: q.taskRevision,
    });
    await expect(status(page)).toContainText('已取消文件恢复请求');
    await expect(status(page)).toContainText('不能据此断言本机从未开始写入');
    await expect(
      records(page).getByRole('button', { name: '恢复原应用文件', exact: true }),
    ).toHaveCount(0);
    await expect(records(page).getByLabel('文件整合预检')).toBeVisible();
    expect((await getView(f, v.operation.id)).operation).toEqual(v.operation);
  } finally {
    await close(page, f);
  }
});

for (const deniedBy of ['read', 'command'] as const) {
  test(`文件恢复${deniedBy === 'read' ? '读取' : '提交'}撤权清除基线和待确认内容`, async ({
    page,
  }) => {
    const f = await integrationFixture(origin);
    try {
      const v = await completed(f);
      await open(page, f);
      await choose(page);
      await page.route(
        `${origin}/api/v1/${f.integrationPath}/${v.operation.id}${deniedBy === 'command' ? '/restore' : ''}`,
        (route) =>
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: '文件恢复权限已撤销' } }),
          }),
      );
      if (deniedBy === 'command') await submit(page).click();
      await expect(editor(page)).toHaveCount(0);
      await expect(records(page)).toContainText('整合内容已清除');
      await reopenRecords(page);
      await expect(records(page)).not.toContainText(v.operation.application!.id);
      await expect(
        records(page).getByRole('button', { name: '继续确认文件恢复请求', exact: true }),
      ).toHaveCount(0);
      expect((await getView(f, v.operation.id)).restoration).toBeNull();
    } finally {
      await close(page, f);
    }
  });
}

for (const [state, label] of [
  ['needs_attention', '文件恢复需要本机处理'],
  ['failed', '文件恢复失败'],
] as const) {
  test(`${state}文件恢复报告和保留结算观察独立呈现，不改写原应用完成状态`, async ({ page }) => {
    const f = await integrationFixture(origin);
    try {
      const original = await completed(f),
        q = await queue(f, original);
      await publish(f, q, 'restoring');
      await publish(f, q, state);
      const before = await getView(f, original.operation.id);
      await open(page, f);
      await expect(status(page)).toContainText(label);
      await expect(status(page)).toContainText('已记录恢复 0 个文件');
      await expect(records(page).getByText('所选文件已应用', { exact: true })).toBeVisible();
      await status(page).getByText('在原节点核对文件恢复状态', { exact: true }).click();
      await expect(status(page).getByLabel('文件恢复保留结算命令')).toContainText(
        `--restoration '${q.restoration!.id}'`,
      );
      await expect(status(page).getByLabel('文件恢复保留结算命令')).toContainText(
        '不证明文件已恢复',
      );
      await settle(f, q);
      const observation = records(page).getByRole('region', {
        name: '文件恢复保留结算观察',
        exact: true,
      });
      await expect(observation).toContainText('未重新核验文件内容或恢复成功');
      await expect(observation).toContainText('仍有未决写入意图');
      await expect(status(page)).toContainText(label);
      await expect(status(page)).not.toContainText('原应用文件已恢复');
      await expect(
        records(page).getByRole('button', { name: '恢复原应用文件', exact: true }),
      ).toHaveCount(0);
      await expect(
        records(page).getByRole('button', { name: '取消文件恢复请求', exact: true }),
      ).toHaveCount(0);
      await reopenRecords(page);
      await expect(observation).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: '整合预检', exact: true }).click();
      await expect(observation).toBeVisible();
      const after = await getView(f, original.operation.id);
      expect(after.operation).toEqual(original.operation);
      expect(after.restoration!.state).toBe(before.restoration!.state);
      expect(after.restoration!.reports).toEqual(before.restoration!.reports);
    } finally {
      await close(page, f);
    }
  });
}

test('原应用部分写入或未知结果不提供文件恢复入口', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await completed(f, 'needs_attention');
    await open(page, f);
    await expect(records(page).getByLabel('文件应用状态')).toContainText('可能已部分写入');
    await expect(
      records(page).getByRole('button', { name: '恢复原应用文件', exact: true }),
    ).toHaveCount(0);
    expect(v.canRestoreFiles).toBe(false);
    expect(v.restoration).toBeNull();
  } finally {
    await close(page, f);
  }
});

test('原目标、应用证据或操作修订读取变化不替换已打开的恢复基线', async ({ page }) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin);
  try {
    const v = await completed(f);
    await open(page, f);
    const readUrl = `${origin}/api/v1/${f.integrationPath}/${v.operation.id}`;
    for (const change of ['target', 'revision', 'application', 'completed_report'] as const) {
      await choose(page);
      // Simulate a conflicting later read only; the original service record remains immutable.
      await page.route(readUrl, async (route) => {
        const response = await route.fetch(),
          changed = (await response.json()) as IntegrationView;
        if (change === 'target') changed.operation.target.manifest.commit = 'f'.repeat(40);
        if (change === 'revision') changed.operation.revision++;
        if (change === 'application') changed.operation.application!.inputHash = 'd'.repeat(64);
        if (change === 'completed_report') changed.completedReportHash = 'd'.repeat(64);
        await route.fulfill({ response, json: changed });
      });
      await expect(editor(page)).toContainText('明确重新核对后才能提交');
      await expect(submit(page)).toBeDisabled();
      await expect(consent(page)).toBeChecked();
      await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(f.target.commit);
      await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(
        v.operation.application!.inputHash,
      );
      await expect(editor(page).getByLabel('固定文件恢复基线')).toContainText(
        v.completedReportHash!,
      );
      await page.unroute(readUrl);
      await closeEditor(page);
    }
    expect((await getView(f, v.operation.id)).restoration).toBeNull();
  } finally {
    await close(page, f);
  }
});

test('文件恢复进入写入阶段后冻结已经打开的取消基线，不把停止请求当作停止确认', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await queue(f, await completed(f));
    await open(page, f);
    await records(page).getByRole('button', { name: '取消文件恢复请求', exact: true }).click();
    const cancel = cancelEditor(page).getByRole('button', {
      name: '确认取消文件恢复请求',
      exact: true,
    });
    await expect(cancel).toBeEnabled();
    await publish(f, v, 'restoring');
    await expect(cancelEditor(page)).toContainText('明确重新核对后才能提交');
    await expect(cancel).toBeDisabled();
    await cancelEditor(page)
      .getByRole('button', { name: '重新核对文件恢复基线', exact: true })
      .click();
    await expect(cancelEditor(page)).toContainText('当前记录不能取消文件恢复');
    await expect(cancel).toBeDisabled();
    await closeEditor(page, true);
    await expect(status(page)).toContainText('文件恢复进行中');
    expect((await getView(f, v.operation.id)).restoration!.state).toBe('restoring');
  } finally {
    await close(page, f);
  }
});
