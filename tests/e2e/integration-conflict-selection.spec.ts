import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  IntegrationReport,
  IntegrationView,
} from '../../packages/contracts/src/integrations.js';
import type { IntegrationConflictChoice } from '../../packages/contracts/src/integration-conflict-selection.js';
import type { IntegrationTrialDifferenceDetail } from '../../packages/contracts/src/integration-trial.js';
import {
  integrationTrialCommand,
  sortTrialPaths,
} from '../../apps/web/src/integration-trial-command.js';
import { buildIntegrationTrialDifference } from '../../apps/runner/src/agent/integration-trial-difference.js';
import { codeHash } from '../../packages/db/src/result-code.js';
import { integrationFixture } from '../helpers/integrations.js';

// Real Fastify/SQLite authorization and immutable-report flows with deterministic
// node protocol evidence. Local materialization/writeback are covered by runner tests.
// Browser execution is CI-only: do not retry the locally denied Chromium/loopback paths.
const origin = 'http://127.0.0.1:4321';
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: '准备独立试应用', exact: true });
const history = (page: Page) =>
  records(page).getByRole('region', { name: '试应用候选差异', exact: true });
const choice = (page: Page, path: string) =>
  editor(page).getByRole('combobox', { name: `冲突选择 ${path}`, exact: true });
const consent = (page: Page) =>
  editor(page).getByRole('checkbox', { name: /我已核对固定来源、原目标/ });
const generate = (page: Page) =>
  editor(page).getByRole('button', { name: '生成本机试应用命令', exact: true });
const localCommand = (page: Page) =>
  editor(page).getByRole('region', { name: '本机试应用命令', exact: true });
const writeEditor = (page: Page) =>
  page.getByRole('dialog', { name: '确认选择性应用', exact: true });
const writeConsent = (page: Page) =>
  writeEditor(page).getByRole('checkbox', { name: /我已核对这个固定候选/ });
const writeSubmit = (page: Page) =>
  writeEditor(page).getByRole('button', { name: '确认所选应用范围', exact: true });
const oddPath = "notes/it's $(printf literal); target.txt";
const error = (route: Route, status: number, message: string) =>
  route.fulfill({ status, json: { error: { message } } });
const viewUrl = (f: Fixture, v: IntegrationView) =>
  `${origin}/api/v1/${f.integrationPath}/${v.operation.id}`;
async function ready(f: Fixture, structural = false) {
  const initial = await f.create(),
    report = f.report(initial) as IntegrationReport;
  const plan = report.plan!,
    conflict = plan.files.find((file) => file.path === 'README.md')!;
  expect(conflict.conflict).toBe('both_changed');
  plan.files.push(
    { ...conflict, path: 'deleted-source.txt', source: null },
    { ...conflict, path: 'deleted-target.txt', target: null },
    { ...conflict, path: oddPath },
  );
  if (structural) plan.files.push({ ...conflict, path: 'structural', conflict: 'path_collision' });
  plan.changedFiles = plan.files.length;
  plan.conflicts = plan.files.filter((file) => file.conflict).length;
  const result = await f.protocol('publish', report);
  expect(result.statusCode, result.body).toBe(200);
  return (
    await f.api.call(`${f.integrationPath}/${initial.operation.id}`, f.alice)
  ).json() as IntegrationView;
}
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4321, host: '127.0.0.1' });
  await page.context().addCookies(
    f.alice.cookie.split('; ').map((cookie) => {
      const split = cookie.indexOf('=');
      return {
        name: cookie.slice(0, split),
        value: cookie.slice(split + 1),
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
  await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
  await choice(page, 'README.md').selectOption('take_source');
  await choice(page, oddPath).selectOption('keep_target');
  await consent(page).check();
  await expect(generate(page)).toBeEnabled();
}
async function close(page: Page, f: Fixture, preserveFailure = false) {
  const errors: unknown[] = [];
  for (const cleanup of [
    async () => {
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    () => page.context().close(),
    () => f.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (!preserveFailure) throw new AggregateError(errors, '冲突选择浏览器夹具清理失败');
    test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
  }
}
async function publish(
  f: Fixture,
  v: IntegrationView,
  choices: IntegrationConflictChoice[],
  safe: string[] = [],
) {
  const at = new Date().toISOString();
  const report = buildIntegrationTrialDifference(
    {
      version: 2,
      kind: 'integration_trial_difference',
      integrationId: v.operation.id,
      trialId: randomUUID(),
      integrationInputHash: v.operation.inputHash,
      preflightReportHash: v.reportHash!,
      manifestHash: 'a'.repeat(64),
      selection: 'explicit_conflict_choices',
      selectedPaths: sortTrialPaths([
        ...safe,
        ...choices.filter((item) => item.choice === 'take_source').map((item) => item.path),
      ]),
      conflictChoices: [...choices].sort((a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
      ),
      materializedAt: at,
      comparedAt: at,
      trialOnly: true,
      applied: false,
      writeAuthorized: false,
      confirmPublication: true,
    },
    v.operation.report!.plan!,
    new Map(f.target.objects.map((o) => [o.id, o.data])),
    new Map(f.source.objects.map((o) => [o.id, o.data])),
  );
  const response = await f.protocol('trial-diff-publish', report);
  expect(response.statusCode, response.body).toBe(200);
  return {
    report,
    hash: codeHash(report),
    receivedAt: response.json().receivedAt,
  } satisfies IntegrationTrialDifferenceDetail;
}

test('整文件冲突不默认选择；来源删除与保留目标后果明确，命令字面量安全且窄屏可用', async ({
  page,
}) => {
  const f = await integrationFixture(origin, 'sha1', { targetText: 'USER TARGET VERSION' });
  try {
    const v = await ready(f, true),
      writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/integrations')) writes.push(r.url());
    });
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    for (const path of ['README.md', 'deleted-source.txt', 'deleted-target.txt', oddPath])
      await expect(choice(page, path)).toHaveValue('');
    await expect(generate(page)).toBeDisabled();
    await expect(consent(page)).toBeDisabled();
    await expect(
      editor(page).getByRole('checkbox', { name: '试应用 structural', exact: true }),
    ).toBeDisabled();
    await choice(page, 'deleted-source.txt').selectOption('take_source');
    await expect(editor(page)).toContainText(
      '采用来源的删除：候选中移除目标文件；另行写回时也会移出该文件',
    );
    await choice(page, 'deleted-target.txt').selectOption('take_source');
    await expect(editor(page)).toContainText('候选中新增此路径');
    await choice(page, oddPath).selectOption('keep_target');
    await expect(editor(page)).toContainText('不写入、备份或恢复此路径');
    await editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }).check();
    await consent(page).check();
    await generate(page).click();
    await expect(localCommand(page).locator('pre').first()).toHaveText(
      integrationTrialCommand(
        v.operation.id,
        ['new.txt'],
        [
          { path: 'deleted-source.txt', choice: 'take_source' },
          { path: 'deleted-target.txt', choice: 'take_source' },
          { path: oddPath, choice: 'keep_target' },
        ],
      ),
    );
    await expect(editor(page)).toContainText(
      '本次实际变化 3 个文件；明确保留目标 1 项；仍有 2 项冲突未处理',
    );
    await choice(page, 'README.md').selectOption('keep_target');
    await expect(consent(page)).not.toBeChecked();
    await expect(localCommand(page)).toHaveCount(0);
    await choice(page, 'README.md').selectOption('');
    await mkdir('artifacts', { recursive: true });
    await editor(page).getByRole('group', { name: '选择试应用文件' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/131-integration-conflict-choices-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() =>
        editor(page)
          .locator('form')
          .evaluate((e) => e.scrollWidth - e.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        editor(page)
          .locator('form')
          .evaluate((e) => e.clientWidth),
      )
      .toBeGreaterThan(320);
    await page.screenshot({ path: 'artifacts/132-integration-conflict-choices-mobile-light.png' });
    await page.keyboard.press('Escape');
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    await expect(choice(page, oddPath)).toHaveValue('');
    await expect(choice(page, 'deleted-source.txt')).toHaveValue('');
    await expect(consent(page)).not.toBeChecked();
    expect(writes).toEqual([]);
    expect(
      (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).json().operation,
    ).toEqual(v.operation);
  } finally {
    await close(page, f);
  }
});

test('全部保留目标可生成并共享零变化候选，历史保留决策但写回禁用', async ({ page }) => {
  const f = await integrationFixture(origin, 'sha1', { targetText: 'USER TARGET VERSION' });
  try {
    const v = await ready(f);
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    const choices: IntegrationConflictChoice[] = [
      'README.md',
      'deleted-source.txt',
      'deleted-target.txt',
      oddPath,
    ].map((path) => ({ path, choice: 'keep_target' }));
    for (const item of choices) await choice(page, item.path).selectOption(item.choice);
    await expect(editor(page)).toContainText('保持目标缺失，不新增此路径');
    await expect(editor(page)).toContainText('本次为 0 变化候选');
    await consent(page).check();
    await generate(page).click();
    await expect(localCommand(page).locator('pre').first()).toHaveText(
      integrationTrialCommand(v.operation.id, [], choices),
    );
    await page.keyboard.press('Escape');
    const detail = await publish(f, v, choices);
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      detail.report.trialId,
    );
    const decisions = history(page).getByRole('region', { name: '固定冲突决策', exact: true });
    await expect(decisions.getByRole('list', { name: '完整冲突决策' }).locator('li')).toHaveCount(
      4,
    );
    await expect(decisions).toContainText('实际变化 0 个文件 · 明确保留目标 4 项');
    await expect(decisions).toContainText('不能写回');
    await expect(decisions).toContainText('不表示全部冲突已解决');
    await expect(
      history(page).getByRole('button', { name: '确认写回此候选', exact: true }),
    ).toBeDisabled();
    await mkdir('artifacts', { recursive: true });
    await decisions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/133-integration-conflict-zero-delta-history.png' });
    expect(
      (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).json().operation
        .application,
    ).toBeNull();
  } finally {
    await close(page, f);
  }
});

test('冲突选择与命令在短暂读取失败和旧修订下保留，重核不声称重算目标', async ({ page }) => {
  const f = await integrationFixture(origin, 'sha1', { targetText: 'USER TARGET VERSION' });
  try {
    const v = await ready(f);
    await open(page, f);
    await choose(page);
    await generate(page).click();
    const fixedCommand = await localCommand(page).locator('pre').first().textContent(),
      url = viewUrl(f, v);
    await page.route(url, (route) => error(route, 503, '冲突状态暂时不可读'));
    await expect(editor(page)).toContainText('冲突状态暂时不可读');
    await expect(choice(page, 'README.md')).toHaveValue('take_source');
    await expect(choice(page, oddPath)).toHaveValue('keep_target');
    await expect(localCommand(page).locator('pre').first()).toHaveText(fixedCommand!);
    await expect(generate(page)).toBeDisabled();
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
    await editor(page).getByRole('button', { name: '重读试应用状态' }).click();
    await expect(editor(page)).toContainText('明确重新核对后才能生成命令');
    await expect(choice(page, oddPath)).toHaveValue('keep_target');
    await editor(page).getByRole('button', { name: '重新核对试应用基线' }).click();
    await expect(choice(page, 'README.md')).toHaveValue('take_source');
    await expect(choice(page, oddPath)).toHaveValue('keep_target');
    await expect(consent(page)).not.toBeChecked();
    await expect(localCommand(page)).toHaveCount(0);
    await expect(editor(page).getByRole('region', { name: '固定试应用基线' })).toContainText(
      f.target.commit,
    );
    await consent(page).check();
    await expect(generate(page)).toBeEnabled();
  } finally {
    await close(page, f);
  }
});

test('旧读取迟到撤权不卸载重开的冲突编辑器；当前撤权清除决策与命令', async ({ page }) => {
  const f = await integrationFixture(origin, 'sha1', { targetText: 'USER TARGET VERSION' });
  let failed = false;
  let holdReads = true;
  let release = () => {};
  const pendingReads: Promise<void>[] = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const v = await ready(f),
      url = viewUrl(f, v);
    await page.route(url, async (route) => {
      if (!holdReads || route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      // SSE 刷新可取消并重发读取；关闭旧编辑器前，所有旧读取都必须保持挂起。
      const pending = gate.then(() => error(route, 403, '旧读取撤权'));
      pendingReads.push(pending);
      await pending;
    });
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    await expect.poll(() => pendingReads.length).toBeGreaterThan(0);
    await expect(generate(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    holdReads = false;
    await choose(page);
    release();
    await Promise.all(pendingReads);
    await expect(choice(page, 'README.md')).toHaveValue('take_source');
    await expect(choice(page, oddPath)).toHaveValue('keep_target');
    await expect(consent(page)).toBeChecked();
    await expect(generate(page)).toBeEnabled();
    await expect(editor(page)).not.toContainText('旧读取撤权');
    await generate(page).click();
    await page.unroute(url);
    await page.route(url, (route) => error(route, 403, '当前冲突选择权限已撤销'));
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('整合内容已清除');
    await expect(records(page)).not.toContainText(oddPath);
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(url);
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expect(records(page)).toContainText('整合内容已清除');
    await expect(
      records(page).getByRole('button', { name: '选择文件试应用', exact: true }),
    ).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    holdReads = false;
    release();
    await Promise.allSettled(pendingReads);
    await close(page, f, failed);
  }
});

test('新候选不替换旧冲突决策，固定写回只提交实际变化且未知回执保持原body与key', async ({
  page,
}) => {
  const f = await integrationFixture(origin, 'sha1', { targetText: 'USER TARGET VERSION' });
  try {
    const v = await ready(f),
      choices: IntegrationConflictChoice[] = [
        { path: 'README.md', choice: 'take_source' },
        { path: 'deleted-source.txt', choice: 'take_source' },
        { path: oddPath, choice: 'keep_target' },
      ];
    const first = await publish(f, v, choices);
    await open(page, f);
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      first.report.trialId,
    );
    const newer = await publish(f, v, [{ path: 'README.md', choice: 'keep_target' }], ['new.txt']);
    await expect(history(page)).toContainText('有更新的已共享候选');
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      first.report.trialId,
    );
    await expect(
      history(page).getByRole('region', { name: '固定冲突决策', exact: true }),
    ).toContainText('实际变化 2 个文件 · 明确保留目标 1 项');
    await expect(history(page)).toContainText('固定预检仍有 1 项冲突未处理');
    const url = `${viewUrl(f, v)}/apply`,
      attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(url, async (route) => {
      attempts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      if (attempts.length === 1) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await history(page).getByRole('button', { name: '确认写回此候选', exact: true }).click();
    await expect(writeEditor(page).getByRole('region', { name: '固定写回候选' })).toContainText(
      first.report.trialId,
    );
    await expect(
      writeEditor(page).getByRole('region', { name: '固定冲突决策', exact: true }),
    ).toContainText('不进入写回、原文件备份或后续恢复路径');
    const kept = writeEditor(page).getByRole('checkbox', { name: `选择 ${oddPath}`, exact: true });
    await expect(kept).not.toBeChecked();
    await expect(kept).toBeDisabled();
    for (const path of first.report.selectedPaths)
      await expect(
        writeEditor(page).getByRole('checkbox', { name: `选择 ${path}`, exact: true }),
      ).toBeChecked();
    await writeConsent(page).check();
    await writeSubmit(page).click();
    await expect(
      writeEditor(page).getByRole('region', { name: '应用请求待确认', exact: true }),
    ).toBeVisible();
    await writeEditor(page)
      .locator('.dialog-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await records(page).getByRole('button', { name: '继续确认应用请求', exact: true }).click();
    await expect(writeEditor(page).getByRole('region', { name: '固定写回候选' })).toContainText(
      first.report.trialId,
    );
    await expect(writeEditor(page)).not.toContainText(newer.report.trialId);
    await writeEditor(page).getByRole('button', { name: '确认上次应用请求', exact: true }).click();
    await expect(writeEditor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]!.key).toBeTruthy();
    const after = (
      await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)
    ).json() as IntegrationView;
    expect(after.operation.application!.paths).toEqual(['README.md', 'deleted-source.txt']);
    expect(after.operation.application!.candidate!.trialId).toBe(first.report.trialId);
    expect(after.operation.report).toEqual(v.operation.report);
  } finally {
    await close(page, f);
  }
});
