import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  IntegrationReport,
  IntegrationView,
} from '../../packages/contracts/src/integrations.js';
import type {
  IntegrationTrialDifferenceDetail,
  IntegrationTrialDifferenceSummary,
} from '../../packages/contracts/src/integration-trial.js';
import { integrationTrialCommand } from '../../apps/web/src/integration-trial-command.js';
import { integrationFixture } from '../helpers/integrations.js';

// Deterministic browser protocol/rendering fixtures only. They do not create candidate
// directories or prove object verification; real local evidence is tested by the runner suite.
// Browser execution is currently permission-blocked. These cases are typechecked, not run.
const origin = 'http://127.0.0.1:4321';
type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: '准备独立试应用', exact: true });
const history = (page: Page) =>
  records(page).getByRole('region', { name: '试应用候选差异', exact: true });
const consent = (page: Page) =>
  editor(page).getByRole('checkbox', { name: /我已核对固定来源、原目标/ });
const generate = (page: Page) =>
  editor(page).getByRole('button', { name: '生成本机试应用命令', exact: true });
const oddPath = "notes/it's $(printf literal); file.txt";
const error = (route: Route, status: number, message: string) =>
  route.fulfill({ status, json: { error: { message } } });
const viewUrl = (f: Fixture, v: IntegrationView) =>
  `${origin}/api/v1/${f.integrationPath}/${v.operation.id}`;

async function ready(f: Fixture) {
  const initial = await f.create();
  const report = f.report(initial) as IntegrationReport;
  const plan = report.plan!;
  const modify = plan.files.find((file) => file.action === 'modify')!;
  const add = plan.files.find((file) => file.action === 'add')!;
  plan.files.push(
    { ...add, path: oddPath },
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
  const published = await f.protocol('publish', report);
  expect(published.statusCode, published.body).toBe(200);
  const response = await f.api.call(`${f.integrationPath}/${initial.operation.id}`, f.alice);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as IntegrationView;
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
  await editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }).check();
  await consent(page).check();
  await expect(generate(page)).toBeEnabled();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
function candidate(
  v: IntegrationView,
  at: string,
  label: string,
): IntegrationTrialDifferenceDetail {
  const modify = v.operation.report!.plan!.files.find((file) => file.action === 'modify')!;
  const add = v.operation.report!.plan!.files.find((file) => file.action === 'add')!;
  return {
    report: {
      version: 1,
      kind: 'integration_trial_difference',
      integrationId: v.operation.id,
      trialId: randomUUID(),
      integrationInputHash: v.operation.inputHash,
      preflightReportHash: v.reportHash!,
      manifestHash: 'a'.repeat(64),
      selection: 'apply_source',
      selectedPaths: ['README.md', 'new.txt', 'removed.txt'],
      materializedAt: at,
      comparedAt: at,
      trialOnly: true,
      applied: false,
      writeAuthorized: false,
      confirmPublication: true,
      difference: {
        changedFiles: 3,
        omittedFiles: 1,
        files: [
          {
            path: 'README.md',
            before: modify.target,
            after: modify.source,
            display: 'text',
            beforeText: 'BASE',
            afterText: label,
          },
          { path: 'new.txt', before: null, after: add.source, display: 'budget' },
        ],
      },
    },
    hash: 'b'.repeat(64),
    receivedAt: at,
  };
}
function summary(detail: IntegrationTrialDifferenceDetail): IntegrationTrialDifferenceSummary {
  const r = detail.report;
  return {
    trialId: r.trialId,
    hash: detail.hash,
    materializedAt: r.materializedAt,
    comparedAt: r.comparedAt,
    receivedAt: detail.receivedAt,
    selectedPathCount: r.selectedPaths.length,
    changedFiles: r.difference.changedFiles,
    omittedFiles: r.difference.omittedFiles,
  };
}

test('试应用可选新增修改删除，原应用仍只新增；重复生成和取消不提交服务端动作', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    const before = f.as(() => f.api.store.getTask(f.task.id));
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/integrations'))
        writes.push(request.url());
    });
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件应用', exact: true }).click();
    const application = page.getByRole('dialog', { name: '确认选择性应用', exact: true });
    for (const name of ['README.md', 'removed.txt'])
      await expect(
        application.getByRole('checkbox', { name: `选择 ${name}`, exact: true }),
      ).toBeDisabled();
    await page.keyboard.press('Escape');
    await choose(page);
    const fixed = editor(page).getByRole('region', { name: '固定试应用基线' });
    for (const value of [f.source.commit, f.target.commit, f.tr.request.id, v.reportHash!])
      await expect(fixed).toContainText(value);
    for (const name of ['present.txt', 'conflict.txt'])
      await expect(
        editor(page).getByRole('checkbox', { name: `试应用 ${name}`, exact: true }),
      ).toBeDisabled();
    for (const name of ['README.md', 'removed.txt', oddPath])
      await editor(page)
        .getByRole('checkbox', { name: `试应用 ${name}`, exact: true })
        .check();
    await expect(consent(page)).not.toBeChecked();
    await expect(generate(page)).toBeDisabled();
    await consent(page).check();
    await generate(page).evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    const command = editor(page).getByRole('region', { name: '本机试应用命令', exact: true });
    await expect(command.locator('pre').first()).toHaveText(
      integrationTrialCommand(v.operation.id, ['new.txt', 'README.md', 'removed.txt', oddPath]),
    );
    await expect(command).toContainText('页面没有创建服务端试应用请求');
    await expect(command).toContainText('SHARE_TRIAL_DIFF');
    await expect(editor(page).getByRole('textbox')).toHaveCount(0);
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
    await editor(page).getByRole('button', { name: '取消并返回' }).click();
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    await expect(
      editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }),
    ).not.toBeChecked();
    await expect(
      editor(page).getByRole('region', { name: '本机试应用命令', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
    expect(
      (await f.api.call(`${f.integrationPath}/${v.operation.id}`, f.alice)).json().operation,
    ).toEqual(v.operation);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(before);
  } finally {
    await close(page, f);
  }
});

test('暂时读取失败保留选择与命令，变化基线需明确重核并重新确认', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    await open(page, f);
    await choose(page);
    await generate(page).click();
    const url = viewUrl(f, v);
    await page.route(url, (route) => error(route, 503, '试应用状态暂时不可读'));
    await expect(editor(page)).toContainText('试应用状态暂时不可读');
    await expect(
      editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }),
    ).toBeChecked();
    await expect(consent(page)).toBeChecked();
    await expect(
      editor(page).getByRole('region', { name: '本机试应用命令', exact: true }),
    ).toBeVisible();
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
    await expect(generate(page)).toBeDisabled();
    await editor(page).getByRole('button', { name: '重新核对试应用基线' }).click();
    await expect(
      editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }),
    ).toBeChecked();
    await expect(consent(page)).not.toBeChecked();
    await expect(
      editor(page).getByRole('region', { name: '本机试应用命令', exact: true }),
    ).toHaveCount(0);
    await consent(page).check();
    await expect(generate(page)).toBeEnabled();
  } finally {
    await close(page, f);
  }
});

test('已取消读取的迟到撤权结果不能卸载重新打开的选择器', async ({ page }) => {
  const f = await integrationFixture(origin);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const v = await ready(f);
    let seen = 0;
    await page.route(viewUrl(f, v), async (route) => {
      if (++seen === 1) {
        await gate;
        await error(route, 403, '旧读取已撤销').catch(() => {});
      } else await route.continue();
    });
    await open(page, f);
    await records(page).getByRole('button', { name: '选择文件试应用', exact: true }).click();
    await expect.poll(() => seen).toBe(1);
    await page.keyboard.press('Escape');
    await choose(page);
    release();
    await expect(
      editor(page).getByRole('checkbox', { name: '试应用 new.txt', exact: true }),
    ).toBeChecked();
    await expect(generate(page)).toBeEnabled();
    await expect(editor(page)).not.toContainText('旧读取已撤销');
  } finally {
    release();
    await close(page, f);
  }
});

test('试应用读取撤权清除选择和命令，关闭重开不恢复已撤销内容', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    await open(page, f);
    await choose(page);
    await generate(page).click();
    await page.route(viewUrl(f, v), (route) => error(route, 403, '试应用权限已撤销'));
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('整合内容已清除');
    await expect(records(page)).not.toContainText(f.source.commit);
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(viewUrl(f, v));
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expect(records(page)).toContainText('整合内容已清除');
    await expect(
      records(page).getByRole('button', { name: '选择文件试应用', exact: true }),
    ).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});

test('候选历史固定trialId，新候选不替换旧详情；临时错误和材料失效仍保留历史', async ({ page }) => {
  test.setTimeout(60000);
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    const old = candidate(v, '2026-09-28T01:00:00.000Z', '<button>历史候选正文</button>');
    const latest = candidate(v, '2026-09-29T01:00:00.000Z', '较新候选正文');
    const url = `${viewUrl(f, v)}/trials`;
    let items = [summary(old)],
      listFailure = false,
      detailFailure = false;
    await page.route(url, (route) =>
      listFailure ? error(route, 503, '候选列表暂时不可读') : route.fulfill({ json: { items } }),
    );
    await page.route(`${url}/${old.report.trialId}`, (route) =>
      detailFailure ? error(route, 503, '候选详情暂时不可读') : route.fulfill({ json: old }),
    );
    await page.route(`${url}/${latest.report.trialId}`, (route) => route.fulfill({ json: latest }));
    await open(page, f);
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      old.report.trialId,
    );
    await history(page).locator('summary').filter({ hasText: '查看原目标与候选差异' }).click();
    await history(page)
      .locator('.result-code-file summary')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(history(page).getByRole('heading', { name: '− 原目标文件' })).toBeVisible();
    await expect(history(page).getByRole('heading', { name: '+ 候选文件' })).toBeVisible();
    await expect(history(page).locator('pre').last()).toHaveText('<button>历史候选正文</button>');
    await expect(history(page).getByRole('button', { name: '历史候选正文' })).toHaveCount(0);
    await expect(history(page)).toContainText('另有 1 个变化文件未列出');
    await history(page).locator('.result-code-file summary').filter({ hasText: 'new.txt' }).click();
    await expect(history(page)).toContainText('正文未共享');
    await history(page).locator('summary').filter({ hasText: '完整选择范围' }).click();
    await expect(history(page)).toContainText('removed.txt');
    items = [summary(latest), summary(old)];
    await expect(history(page)).toContainText('有更新的已共享候选');
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      old.report.trialId,
    );
    await expect(history(page).locator('pre').last()).toHaveText('<button>历史候选正文</button>');
    listFailure = detailFailure = true;
    await expect(history(page)).toContainText('候选列表暂时不可读');
    await expect(history(page)).toContainText('候选详情暂时不可读');
    await expect(history(page).locator('pre').last()).toHaveText('<button>历史候选正文</button>');
    listFailure = detailFailure = false;
    await history(page).getByRole('button', { name: '重读候选历史' }).click();
    await history(page).getByRole('button', { name: '重读所选候选' }).click();
    await expect(history(page).getByRole('button', { name: '重读所选候选' })).toHaveCount(0);
    await page.route(`${origin}/api/v1/${f.integrationPath}`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              ...v,
              available: false,
              canTrial: false,
              canApply: false,
              unavailableReason: '材料已过期',
            },
          ],
        },
      }),
    );
    await expect(records(page)).toContainText('材料已过期');
    await expect(history(page).locator('pre').last()).toHaveText('<button>历史候选正文</button>');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      old.report.trialId,
    );
    await history(page).getByRole('button', { name: '查看最新候选' }).click();
    await expect(history(page).getByRole('combobox', { name: '查看固定候选' })).toHaveValue(
      latest.report.trialId,
    );
    await expect(history(page).getByRole('region', { name: '固定候选详情' })).toContainText(
      latest.report.trialId,
    );
    await expect(history(page)).not.toContainText('历史候选正文');
    await history(page).locator('summary').filter({ hasText: '查看原目标与候选差异' }).click();
    await history(page)
      .locator('.result-code-file summary')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(history(page).locator('pre').last()).toHaveText('较新候选正文');
  } finally {
    await close(page, f);
  }
});

for (const scope of ['list', 'detail'] as const)
  test(`候选${scope === 'list' ? '列表' : '详情'}撤权清除固定选择和共享正文`, async ({ page }) => {
    const f = await integrationFixture(origin);
    try {
      const v = await ready(f);
      const fixed = candidate(v, '2026-09-28T01:00:00.000Z', '应清除的旧正文');
      const url = `${viewUrl(f, v)}/trials`;
      let revoked = false;
      await page.route(url, (route) =>
        revoked && scope === 'list'
          ? error(route, 403, '历史读取权限已撤销')
          : route.fulfill({ json: { items: [summary(fixed)] } }),
      );
      await page.route(`${url}/${fixed.report.trialId}`, (route) =>
        revoked && scope === 'detail'
          ? error(route, 403, '历史读取权限已撤销')
          : route.fulfill({ json: fixed }),
      );
      await open(page, f);
      await expect(history(page).getByRole('region', { name: '固定候选详情' })).toContainText(
        fixed.report.trialId,
      );
      revoked = true;
      await expect(records(page)).toContainText('整合内容已清除');
      await expect(records(page)).not.toContainText(fixed.report.trialId);
      await expect(history(page)).toHaveCount(0);
      await records(page).getByRole('button', { name: '关闭', exact: true }).click();
      revoked = false;
      await page.getByRole('button', { name: '整合预检', exact: true }).click();
      await expect(records(page)).toContainText('整合内容已清除');
    } finally {
      await close(page, f);
    }
  });

test('候选共享文件省略不截断80条完整选择，手机浅色仍保留可用宽度', async ({ page }) => {
  const f = await integrationFixture(origin);
  try {
    const v = await ready(f);
    const fixed = candidate(v, '2026-09-28T01:00:00.000Z', '候选正文');
    fixed.report.selectedPaths = [
      'README.md',
      'new.txt',
      ...Array.from({ length: 78 }, (_, i) => `omitted-${String(i).padStart(2, '0')}.txt`),
    ];
    fixed.report.difference.changedFiles = 80;
    fixed.report.difference.omittedFiles = 78;
    const url = `${viewUrl(f, v)}/trials`;
    await page.route(url, (route) => route.fulfill({ json: { items: [summary(fixed)] } }));
    await page.route(`${url}/${fixed.report.trialId}`, (route) => route.fulfill({ json: fixed }));
    await open(page, f);
    await history(page).locator('summary').filter({ hasText: '完整选择范围（80个文件）' }).click();
    await expect(
      history(page)
        .getByRole('region', { name: '固定候选详情' })
        .locator('details')
        .first()
        .locator('li'),
    ).toHaveCount(80);
    await expect(history(page)).toContainText('omitted-77.txt');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() => history(page).evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => history(page).evaluate((element) => element.clientWidth))
      .toBeGreaterThan(280);
  } finally {
    await close(page, f);
  }
});
