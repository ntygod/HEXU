import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { branchCleanupFixture } from '../helpers/branch-cleanup-check.js';
import { BranchPreservations } from '../../packages/db/src/branch-preservation.js';
import { WorkBranchStore } from '../../packages/db/src/work-branches.js';
import type {
  BranchPreservationView,
  BranchPreservationReport,
} from '../../packages/contracts/src/branch-preservation.js';
// Browser/control protocol evidence; actual directory relocation is tested by the real CLI suite.
const origin = 'http://127.0.0.1:4325';
type Fixture = Awaited<ReturnType<typeof branchCleanupFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务方案分支', exact: true });
const card = (page: Page) =>
  records(page).getByRole('article', { name: '方案：方案 A', exact: true });
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '移出并保留完整现场', exact: true });
const cancelEditor = (page: Page) =>
  page.getByRole('dialog', { name: '取消尚未开始的移出请求', exact: true });
const history = (page: Page) => card(page).getByRole('article', { name: '固定移出保留记录' });
const selected = (page: Page) => editor(page).getByRole('combobox', { name: '移出保护副本' });
const consent = (page: Page) =>
  editor(page).getByRole('checkbox', { name: /我确认请求移出完整原目录/ });
const submit = (page: Page) => editor(page).getByRole('button', { name: '保存移出保留请求' });
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4325, host: '127.0.0.1' });
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
  await page.getByRole('button', { name: '方案分支', exact: true }).click();
}
async function edit(page: Page) {
  await card(page).getByRole('button', { name: '移出并保留完整现场', exact: true }).click();
}
async function choose(page: Page, f: Fixture) {
  await selected(page).selectOption(f.material.request.id);
  await consent(page).check();
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
    if (!preserveFailure) throw new AggregateError(errors, '移出保留浏览器夹具清理失败');
    test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
  }
}
const body = (f: Fixture) => {
  const { branchId: _id, ...s } = f.selection();
  return { ...s, confirmMoveCompleteDirectory: true, confirmKeepGitAndContents: true };
};
async function create(f: Fixture) {
  const r = await f.api.call(f.path() + '/preservations', f.alice, body(f));
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as BranchPreservationView;
}
const report = (
  v: BranchPreservationView,
  sequence: 1 | 2,
  stage: BranchPreservationReport['stage'],
  destinationRef: string = randomUUID(),
): BranchPreservationReport => ({
  version: 1,
  kind: 'branch_directory_preservation',
  preservationId: v.request.id,
  inputHash: v.request.inputHash,
  sequence,
  stage,
  reason:
    stage === 'moving'
      ? 'move_prepared'
      : stage === 'preserved'
        ? 'directory_preserved'
        : stage === 'needs_attention'
          ? 'move_unknown'
          : 'move_refused',
  evidenceHash: 'a'.repeat(64),
  destinationRef,
  observedAt: new Date().toISOString(),
  confirmPublication: true,
});

test('完整移出有独立确认且取消不提交，暗色范围与手机命令可读，完成报告不伪装永久删除', async ({
  page,
}) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    const nodes = JSON.stringify(f.api.store.db.prepare('SELECT * FROM runner_nodes').all());
    await open(page, f);
    await edit(page);
    await expect(selected(page)).toHaveValue('');
    await expect(consent(page)).not.toBeChecked();
    await expect(submit(page)).toBeDisabled();
    await choose(page, f);
    await editor(page).getByRole('button', { name: '返回方案记录' }).click();
    expect(f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservations').get()!.n).toBe(0);
    await edit(page);
    await expect(selected(page)).toHaveValue('');
    await choose(page, f);
    await expect(editor(page)).toContainText('不是永久删除，不释放磁盘空间');
    await mkdir('artifacts', { recursive: true });
    await consent(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/141-branch-preservation-confirm-dark.png' });
    await submit(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(history(page)).toContainText('等待本人本机确认');
    await expect(history(page).getByLabel('完整移出保留命令')).toContainText(
      "--target '<全新私有保留绝对目录>'",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await history(page).getByLabel('完整移出保留命令').scrollIntoViewIfNeeded();
    await expect
      .poll(() => history(page).evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        history(page)
          .getByLabel('完整移出保留命令')
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await expect.poll(() => history(page).evaluate((el) => el.clientWidth)).toBeGreaterThan(280);
    await page.screenshot({ path: 'artifacts/142-branch-preservation-command-mobile-light.png' });
    const store = new BranchPreservations(f.api.store),
      v = f.as(() => store.list(f.task.id, f.selection().branchId)).items[0]!,
      first = report(v, 1, 'moving');
    store.publish(f.ns[0]!.token, first);
    await expect(history(page)).toContainText('本机处置已开始');
    await expect(history(page).getByRole('button', { name: '取消未开始的移出请求' })).toHaveCount(
      0,
    );
    store.publish(f.ns[0]!.token, report(v, 2, 'preserved', first.destinationRef));
    await expect(card(page)).toContainText('原路径执行登记已关闭 · 完整现场已保留');
    await expect(history(page)).toContainText('不是永久删除，保留位置未自动登记');
    await expect(
      card(page).getByRole('button', { name: '移出并保留完整现场', exact: true }),
    ).toHaveCount(0);
    expect(JSON.stringify(f.api.store.db.prepare('SELECT * FROM runner_nodes').all())).toBe(nodes);
  } finally {
    await close(page, f);
  }
});
test('创建ACK未知跨关闭/分页/重开仍确认同body/key，并返回固定原方案与原移出记录', async ({
  page,
}) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    const sent: { body: unknown; key: string | undefined }[] = [];
    await page.route(`${origin}/api/v1/${f.path()}/preservations`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      sent.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      const r = await route.fetch();
      expect(r.status()).toBe(201);
      if (sent.length === 1)
        await route.fulfill({ status: 503, json: { error: { message: '请求已保存但回复丢失' } } });
      else await route.fulfill({ response: r });
    });
    await open(page, f);
    await edit(page);
    await choose(page, f);
    await submit(page).click();
    await expect(editor(page).getByRole('region', { name: '移出请求待确认' })).toBeVisible();
    for (let i = 0; i < 12; i++)
      f.as(() =>
        new WorkBranchStore(f.api.store).create(
          f.task.id,
          {
            expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
            checkpointId: f.view.group.start.checkpoint.id,
            branches: [
              { name: '后来A' + i, goal: '新的方案' },
              { name: '后来B' + i, goal: '另一方案' },
            ],
          },
          randomUUID(),
        ),
      );
    await editor(page).getByRole('button', { name: '返回方案记录' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(records(page).getByRole('region', { name: '未确认的移出操作' })).toContainText(
      '方案 A',
    );
    await records(page).getByRole('button', { name: '更早方案组' }).click();
    await expect(card(page)).toBeVisible();
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await records(page).getByRole('button', { name: '继续确认移出操作' }).click();
    await expect(consent(page)).toBeChecked();
    await expect(selected(page)).toHaveValue(f.material.request.id);
    await editor(page).getByRole('button', { name: '确认上次移出操作' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await expect(history(page)).toContainText('等待本人本机确认');
    expect(f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservations').get()!.n).toBe(1);
  } finally {
    await close(page, f);
  }
});
test('取消只有独立确认才生效，丢ACK仍锚定原取消记录，不跳到后来新请求', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    const first = await create(f);
    await open(page, f);
    await history(page).getByRole('button', { name: '取消未开始的移出请求' }).click();
    await expect(
      cancelEditor(page).getByRole('button', { name: '确认取消原移出请求' }),
    ).toBeDisabled();
    await cancelEditor(page).getByRole('button', { name: '返回方案记录' }).click();
    expect(
      f.as(() =>
        new BranchPreservations(f.api.store).get(
          f.task.id,
          f.selection().branchId,
          first.request.id,
        ),
      ).state,
    ).toBe('requested');
    const sent: { body: unknown; key: string | undefined }[] = [];
    await page.route(
      `${origin}/api/v1/${f.path()}/preservations/${first.request.id}/cancel`,
      async (route) => {
        sent.push({
          body: route.request().postDataJSON(),
          key: route.request().headers()['idempotency-key'],
        });
        const r = await route.fetch();
        expect(r.status()).toBe(200);
        if (sent.length === 1)
          await route.fulfill({ status: 503, json: { error: { message: '取消回执未知' } } });
        else await route.fulfill({ response: r });
      },
    );
    await history(page).getByRole('button', { name: '取消未开始的移出请求' }).click();
    await cancelEditor(page).getByRole('checkbox').check();
    await cancelEditor(page).getByRole('button', { name: '确认取消原移出请求' }).click();
    await expect(cancelEditor(page).getByRole('region', { name: '移出请求待确认' })).toBeVisible();
    const newer = await create(f);
    await cancelEditor(page).getByRole('button', { name: '返回方案记录' }).click();
    await records(page).getByRole('button', { name: '继续确认移出操作' }).click();
    await cancelEditor(page).getByRole('button', { name: '确认上次移出操作' }).click();
    await expect(cancelEditor(page)).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await expect(history(page)).toContainText(first.request.id);
    await expect(history(page)).toContainText('请求已取消');
    await expect(card(page)).toContainText('有更新的移出记录');
    await card(page).getByRole('combobox', { name: '移出保留记录' }).selectOption(newer.request.id);
    await expect(history(page)).toContainText('等待本人本机确认');
  } finally {
    await close(page, f);
  }
});
test('临时读取错误保留移出选区，任务新修订须明确核对后重新同意', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    await open(page, f);
    await edit(page);
    await choose(page, f);
    const url = `${origin}/api/v1/${f.path()}/cleanup-options`;
    await page.route(url, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '保护材料暂不可读' } } }),
    );
    await editor(page).getByRole('button', { name: '重读移出条件' }).click();
    await expect(editor(page)).toContainText('保护材料暂不可读');
    await expect(consent(page)).toBeChecked();
    await expect(selected(page)).toHaveValue(f.material.request.id);
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
    await editor(page).getByRole('button', { name: '重读移出条件' }).click();
    await expect(editor(page)).toContainText('请明确重新核对范围并再次确认');
    await editor(page).getByRole('button', { name: '重新核对移出范围' }).click();
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await submit(page).click();
    await expect(history(page)).toContainText('等待本人本机确认');
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).toBe('done');
  } finally {
    await close(page, f);
  }
});
test('删除或过期副本不能沿用旧移出许可，明确重核后清空失效选择', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    await open(page, f);
    await edit(page);
    await choose(page, f);
    f.api.store.db
      .prepare("UPDATE checkpoint_retentions SET state='deleted' WHERE id=?")
      .run(f.material.request.id);
    await editor(page).getByRole('button', { name: '重读移出条件' }).click();
    await expect(editor(page)).toContainText('请明确重新核对范围');
    await expect(submit(page)).toBeDisabled();
    await expect(selected(page)).toHaveValue(f.material.request.id);
    await editor(page).getByRole('button', { name: '重新核对移出范围' }).click();
    await expect(selected(page)).toHaveValue('');
    await expect(consent(page)).not.toBeChecked();
    await expect(editor(page)).toContainText('没有原本人同一现场的有效对象副本');
    expect(f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservations').get()!.n).toBe(0);
  } finally {
    await close(page, f);
  }
});
test('节点开始后当前取消确认不能生效；未知观察保留原命令与占用提示，不提供再次移动', async ({
  page,
}) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    const v = await create(f),
      store = new BranchPreservations(f.api.store);
    await open(page, f);
    await history(page).getByRole('button', { name: '取消未开始的移出请求' }).click();
    await cancelEditor(page).getByRole('checkbox').check();
    const first = report(v, 1, 'moving');
    store.publish(f.ns[0]!.token, first);
    await expect(cancelEditor(page)).toContainText('本机处置已开始');
    await expect(
      cancelEditor(page).getByRole('button', { name: '确认取消原移出请求' }),
    ).toBeDisabled();
    await cancelEditor(page).getByRole('button', { name: '返回方案记录' }).click();
    store.publish(f.ns[0]!.token, report(v, 2, 'needs_attention', first.destinationRef));
    await expect(history(page)).toContainText('结果未确认');
    await expect(history(page)).toContainText('保留原位置、新位置、日志、凭证和占用');
    await expect(
      card(page).getByRole('button', { name: '移出并保留完整现场', exact: true }),
    ).toHaveCount(0);
    await expect(history(page).getByLabel('完整移出保留命令')).toContainText(v.request.id);
    await mkdir('artifacts', { recursive: true });
    await history(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/143-branch-preservation-unknown.png' });
  } finally {
    await close(page, f);
  }
});
test('旧已取消403不能擦掉新移出确认，当前撤权清空后重开不恢复原许可', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  let failed = false;
  let holdReads = true;
  let release = () => {};
  const pendingReads: Promise<void>[] = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.discard();
    const url = `${origin}/api/v1/${f.path()}/cleanup-options`;
    await page.route(url, async (route) => {
      if (!holdReads || route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      // SSE 刷新可取消并重发读取；关闭旧编辑器前，所有旧读取都必须保持挂起。
      const pending = gate.then(() =>
        route.fulfill({ status: 403, json: { error: { message: '旧拒绝' } } }),
      );
      pendingReads.push(pending);
      await pending;
    });
    await open(page, f);
    await edit(page);
    await expect.poll(() => pendingReads.length).toBeGreaterThan(0);
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('button', { name: '返回方案记录' }).click();
    await expect(editor(page)).toHaveCount(0);
    holdReads = false;
    await edit(page);
    await choose(page, f);
    release();
    await Promise.all(pendingReads);
    await expect(selected(page)).toHaveValue(f.material.request.id);
    await expect(consent(page)).toBeChecked();
    await expect(submit(page)).toBeEnabled();
    await expect(editor(page)).not.toContainText('旧拒绝');
    await page.unroute(url);
    await page.route(url, (route) =>
      route.fulfill({ status: 403, json: { error: { message: '当前权限已撤销' } } }),
    );
    await editor(page).getByRole('button', { name: '重读移出条件' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('移出编辑权限已失效，确认内容已清除');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(url);
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await expect(
      card(page).getByRole('button', { name: '移出并保留完整现场', exact: true }),
    ).toBeDisabled();
    expect(f.api.store.db.prepare('SELECT COUNT(*) n FROM branch_preservations').get()!.n).toBe(0);
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
