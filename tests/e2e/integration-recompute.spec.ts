import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IntegrationView } from '../../packages/contracts/src/integrations.js';
import { integrationFixture } from '../helpers/integrations.js';
import { codeSnapshot, recordResultCode } from '../helpers/result-code.js';
// Service-backed UI with protocol metadata. Actual Git, original packets and workspace
// protections are tested in integration-recompute-runner.test.ts, not inferred here.
const origin = 'http://127.0.0.1:4322';
const records = (page: Page) => page.getByRole('dialog', { name: '任务整合预检', exact: true });
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '使用新目标重新预检', exact: true });
const target = (page: Page) =>
  editor(page).getByRole('combobox', { name: '同目录的新检查点与恢复副本', exact: true });
const material = (page: Page) =>
  editor(page).getByRole('combobox', { name: '原来源版本的完整对象', exact: true });
const consent = (page: Page) => editor(page).getByRole('checkbox', { name: /^我已核对固定原来源/ });
const submit = (page: Page) =>
  editor(page).getByRole('button', { name: '创建新的只读预检', exact: true });
async function fixture() {
  const f = await integrationFixture(origin);
  try {
    const initial = await f.create(),
      published = await f.protocol('publish', f.report(initial));
    expect(published.statusCode, published.body).toBe(200);
    const original = (
      await f.api.call(`${f.integrationPath}/${initial.operation.id}`, f.alice)
    ).json() as IntegrationView;
    const next = await codeSnapshot([
        { name: 'README.md', text: 'NEW TARGET' },
        { name: 'target.txt', text: 'TARGET ONLY' },
      ]),
      cp = await recordResultCode(f, next),
      retention = f.retain(cp.checkpointId, next),
      foreignCp = await recordResultCode(f, next, 1),
      foreignRetention = f.retain(foreignCp.checkpointId, next, 1);
    return {
      ...f,
      original,
      cp,
      retention,
      foreignRetention,
      url: `${origin}/api/v1/${f.integrationPath}/${original.operation.id}`,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4322, host: '127.0.0.1' });
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
  await records(page).getByRole('button', { name: '使用新目标重新预检', exact: true }).click();
}
async function choose(page: Page, f: Fixture) {
  await target(page).selectOption(f.retention.request.id);
  await material(page).selectOption(`retention:${f.sr.request.id}`);
  await consent(page).check();
  await expect(submit(page)).toBeEnabled();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('新目标重新预检固定旧v1，显式两项选择与确认；新记录可返回原记录，暗色/手机清楚', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const newer = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '新的无代码v2',
    });
    expect(newer.statusCode).toBe(201);
    await open(page, f);
    await expect(editor(page).getByRole('region', { name: '重新预检固定来源' })).toContainText(
      f.original.operation.source.revisionId,
    );
    await expect(editor(page)).not.toContainText('新的无代码v2');
    await expect(target(page)).toHaveValue('');
    await expect(consent(page)).not.toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await expect(target(page).locator(`option[value="${f.tr.request.id}"]`)).toHaveCount(0);
    await expect(
      target(page).locator(`option[value="${f.foreignRetention.request.id}"]`),
    ).toHaveCount(0);
    await target(page).selectOption(f.retention.request.id);
    await expect(material(page)).toHaveValue('');
    await consent(page).check();
    await expect(submit(page)).toBeDisabled();
    await material(page).selectOption(`retention:${f.sr.request.id}`);
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await mkdir('artifacts', { recursive: true });
    await target(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/134-integration-recompute-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() => editor(page).evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect.poll(() => target(page).evaluate((el) => el.clientWidth)).toBeGreaterThan(280);
    await target(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/135-integration-recompute-mobile-light.png' });
    await submit(page).click();
    await expect(editor(page)).toHaveCount(0);
    const provenance = records(page).getByRole('region', { name: '重新预检来源记录' });
    await expect(provenance).toContainText(f.original.operation.id);
    const list = (await f.api.call(f.integrationPath, f.alice)).json().items as IntegrationView[],
      created = list.find((v) => v.operation.recomputedFrom === f.original.operation.id)!;
    expect(created.operation.source).toEqual(f.original.operation.source);
    expect(created.operation.target.checkpoint.id).toBe(f.cp.checkpointId);
    expect(created.operation.application).toBeNull();
    expect(created.operation.report).toBeNull();
    await records(page).getByText('在本人节点上生成预检', { exact: true }).click();
    await expect(records(page)).toContainText(`--operation ${created.operation.id}`);
    await provenance.getByRole('button', { name: '查看原预检记录' }).click();
    await expect(records(page).getByRole('region', { name: '文件整合预检' })).toBeVisible();
    await expect(provenance).toHaveCount(0);
    expect(
      (await f.api.call(`${f.integrationPath}/${f.original.operation.id}`, f.alice)).json()
        .operation,
    ).toEqual(f.original.operation);
    await records(page).getByRole('button', { name: '返回全部预检记录' }).click();
    await expect(records(page).getByRole('article')).toHaveCount(2);
  } finally {
    await close(page, f);
  }
});
test('重新预检丢创建ACK关闭重开仍确认相同body/key，不重复创建或继承候选', async ({ page }) => {
  const f = await fixture();
  try {
    const attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(`${f.url}/recompute`, async (route) => {
      attempts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      if (attempts.length === 1)
        await route.fulfill({ status: 503, json: { error: { message: '保存成功但回执丢失' } } });
      else await route.fulfill({ response });
    });
    await open(page, f);
    await choose(page, f);
    await submit(page).click();
    await expect(editor(page).getByRole('region', { name: '重新预检请求待确认' })).toBeVisible();
    await expect(target(page)).toBeDisabled();
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('button', { name: '关闭', exact: true }).click();
    await records(page).getByRole('button', { name: '继续确认重新预检请求', exact: true }).click();
    await expect(target(page)).toHaveValue(f.retention.request.id);
    await editor(page).getByRole('button', { name: '确认上次重新预检请求', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]!.body).toEqual({
      expectedRevision: f.original.operation.revision,
      expectedTaskRevision: f.original.taskRevision,
      reportHash: f.original.reportHash,
      targetCheckpointId: f.cp.checkpointId,
      targetRetentionId: f.retention.request.id,
      sourceMaterial: { kind: 'retention', id: f.sr.request.id },
      confirmPreflight: true,
    });
    const rows = (await f.api.call(f.integrationPath, f.alice)).json().items as IntegrationView[];
    expect(rows).toHaveLength(2);
    expect(rows.filter((v) => !!v.operation.recomputedFrom)).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
test('临时读取故障与任务新修订保留选择，重核明确清除确认；材料移除不能沿用旧选择', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await open(page, f);
    await choose(page, f);
    const url = `${f.url}/recompute-options`;
    await page.route(url, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '重新预检选项暂不可读' } } }),
    );
    await editor(page).getByRole('button', { name: '重读重新预检选项' }).click();
    await expect(editor(page)).toContainText('重新预检选项暂不可读');
    await expect(target(page)).toHaveValue(f.retention.request.id);
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
    await editor(page).getByRole('button', { name: '重读重新预检选项' }).click();
    await expect(editor(page)).toContainText('明确重新核对后才能创建新预检');
    await editor(page).getByRole('button', { name: '重新核对新目标基线' }).click();
    await expect(consent(page)).not.toBeChecked();
    await expect(target(page)).toHaveValue(f.retention.request.id);
    await consent(page).check();
    await expect(submit(page)).toBeEnabled();
    f.retained.report(f.ns[0]!.token, {
      requestId: f.retention.request.id,
      requestHash: f.retention.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    await editor(page).getByRole('button', { name: '重读重新预检选项' }).click();
    await expect(submit(page)).toBeDisabled();
    await expect(target(page)).toHaveValue(f.retention.request.id);
    await editor(page).getByRole('button', { name: '重新核对新目标基线' }).click();
    await expect(target(page)).toHaveValue('');
    await expect(consent(page)).not.toBeChecked();
    expect((await f.api.call(f.integrationPath, f.alice)).json().items).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
test('已取消旧读取的403不清除新编辑器，当前撤权则清除并不自动恢复输入', async ({ page }) => {
  const f = await fixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const url = `${f.url}/recompute-options`;
    let seen = 0;
    await page.route(url, async (route) => {
      if (++seen === 1) {
        await gate;
        await route
          .fulfill({ status: 403, json: { error: { message: '旧读取撤权' } } })
          .catch(() => {});
      } else await route.continue();
    });
    await open(page, f);
    await expect.poll(() => seen).toBe(1);
    await page.keyboard.press('Escape');
    await records(page).getByRole('button', { name: '使用新目标重新预检', exact: true }).click();
    await choose(page, f);
    release();
    await expect(submit(page)).toBeEnabled();
    await expect(target(page)).toHaveValue(f.retention.request.id);
    await page.unroute(url);
    await page.route(url, (route) =>
      route.fulfill({ status: 403, json: { error: { message: '当前重新预检权限撤销' } } }),
    );
    await editor(page).getByRole('button', { name: '重读重新预检选项' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('整合内容已清除');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(url);
    await page.getByRole('button', { name: '整合预检', exact: true }).click();
    await expect(records(page)).toContainText('整合内容已清除');
  } finally {
    release();
    await close(page, f);
  }
});
