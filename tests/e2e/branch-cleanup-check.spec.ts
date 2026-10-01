import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { branchCleanupFixture } from '../helpers/branch-cleanup-check.js';
// Service/browser protection workflow. Filesystem checks are real CLI tests.
const origin = 'http://127.0.0.1:4324';
type Fixture = Awaited<ReturnType<typeof branchCleanupFixture>>;
const panel = (page: Page) => page.getByRole('dialog', { name: '清理前核对现场保护', exact: true });
const card = (page: Page) => page.getByRole('article', { name: '方案：方案 A', exact: true });
const select = (page: Page) => panel(page).getByRole('combobox', { name: '现场保护副本' });
const generate = (page: Page) => panel(page).getByRole('button', { name: '生成本机核对命令' });
const command = (page: Page) => panel(page).getByRole('region', { name: '清理前本机核对命令' });
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4324, host: '127.0.0.1' });
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
  await card(page).getByRole('button', { name: '清理前核对', exact: true }).click();
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
    if (!preserveFailure) throw new AggregateError(errors, '现场核对浏览器夹具清理失败');
    test.info().annotations.push({ type: 'cleanup', description: errors.map(String).join('\n') });
  }
}

test('已放弃方案明确选保护副本才生成固定本机命令，取消不写入，暗色与窄屏不暗示可删除', async ({
  page,
}) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    const before = JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all());
    await open(page, f);
    await expect(select(page)).toHaveValue('');
    await expect(generate(page)).toBeDisabled();
    await expect(panel(page)).toContainText('没有目录删除或解绑动作');
    await select(page).selectOption(f.material.request.id);
    await generate(page).click();
    await expect(command(page)).toContainText(`--branch '${f.view.branches[0]!.id}'`);
    await expect(command(page)).toContainText(`--retention '${f.material.request.id}'`);
    await expect(command(page)).toContainText("--state '<原方案节点状态目录>'");
    await expect(command(page)).toContainText('deletionAuthorized始终为false');
    await mkdir('artifacts', { recursive: true });
    await command(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/139-branch-cleanup-check-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await command(page).scrollIntoViewIfNeeded();
    await expect
      .poll(() => panel(page).evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect.poll(() => command(page).evaluate((el) => el.clientWidth)).toBeGreaterThan(280);
    await expect
      .poll(() =>
        command(page)
          .locator('pre')
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'artifacts/140-branch-cleanup-check-mobile-light.png' });
    await panel(page).getByRole('button', { name: '返回保留的方案' }).click();
    await card(page).getByRole('button', { name: '清理前核对', exact: true }).click();
    await expect(select(page)).toHaveValue('');
    await expect(command(page)).toHaveCount(0);
    expect(JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all())).toBe(before);
    expect(f.read().branches[0]!.workspace!.state).toBe('bound');
  } finally {
    await close(page, f);
  }
});
test('已放弃但原Run仍活跃时显示阻止原因，真实终止后需明确重新核对才能选副本', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  try {
    const run = f.begin();
    run.start();
    await f.discard();
    await open(page, f);
    await expect(panel(page)).toContainText('原节点仍有活动或未确认执行');
    await expect(select(page)).toBeDisabled();
    await expect(generate(page)).toBeDisabled();
    await f.api.call(`runs/${run.run.id}/stop`, f.alice, {});
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(generate(page)).toBeDisabled();
    run.finish('cancelled');
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(panel(page)).toContainText('请明确重新核对范围');
    await panel(page).getByRole('button', { name: '重新核对保护范围' }).click();
    await expect(select(page)).toBeEnabled();
    await select(page).selectOption(f.material.request.id);
    await generate(page).click();
    await expect(command(page)).toBeVisible();
    expect(f.read().branches[0]!.state).toBe('discarded');
  } finally {
    await close(page, f);
  }
});
test('临时读取错误保留原副本但隐藏命令，Task变化须明确更新固定修订', async ({ page }) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    await open(page, f);
    await select(page).selectOption(f.material.request.id);
    await generate(page).click();
    const url = `${origin}/api/v1/${f.path()}/cleanup-options`;
    await page.route(url, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '保护条件暂不可读' } } }),
    );
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(panel(page)).toContainText('保护条件暂不可读');
    await expect(select(page)).toHaveValue(f.material.request.id);
    await expect(command(page)).toHaveCount(0);
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
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(panel(page)).toContainText('请明确重新核对范围');
    await panel(page).getByRole('button', { name: '重新核对保护范围' }).click();
    await expect(command(page)).toHaveCount(0);
    await generate(page).click();
    await expect(command(page)).toContainText(
      `--task-revision ${f.as(() => f.api.store.getTask(f.task.id)).revision}`,
    );
    expect(f.read().branches[0]!.workspace!.state).toBe('bound');
  } finally {
    await close(page, f);
  }
});
test('已删除的副本不能维持旧核对命令，空态引导明确保留当前提交而不自动提交用户修改', async ({
  page,
}) => {
  const f = await branchCleanupFixture(origin);
  try {
    await f.discard();
    await open(page, f);
    await select(page).selectOption(f.material.request.id);
    await generate(page).click();
    f.api.store.db
      .prepare("UPDATE checkpoint_retentions SET state='deleted' WHERE id=?")
      .run(f.material.request.id);
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(panel(page)).toContainText('请明确重新核对范围');
    await expect(command(page)).toHaveCount(0);
    await expect(select(page)).toHaveValue(f.material.request.id);
    await panel(page).getByRole('button', { name: '重新核对保护范围' }).click();
    await expect(select(page)).toHaveValue('');
    await expect(panel(page)).toContainText('同一现场没有当前有效的完整对象副本');
    await expect(panel(page)).toContainText('不要自动提交或丢弃未保存修改');
    await expect(generate(page)).toBeDisabled();
  } finally {
    await close(page, f);
  }
});
test('旧已取消403不擦除新保护选择；当前撤权清空且重开不能恢复旧命令', async ({ page }) => {
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
    await expect.poll(() => pendingReads.length).toBeGreaterThan(0);
    await expect(select(page)).toBeDisabled();
    await expect(generate(page)).toBeDisabled();
    await panel(page).getByRole('button', { name: '返回保留的方案' }).click();
    await expect(panel(page)).toHaveCount(0);
    holdReads = false;
    await card(page).getByRole('button', { name: '清理前核对', exact: true }).click();
    await select(page).selectOption(f.material.request.id);
    release();
    await Promise.all(pendingReads);
    await expect(select(page)).toHaveValue(f.material.request.id);
    await expect(generate(page)).toBeEnabled();
    await expect(panel(page)).not.toContainText('旧拒绝');
    await page.unroute(url);
    await page.route(url, (route) =>
      route.fulfill({ status: 403, json: { error: { message: '当前撤权' } } }),
    );
    await panel(page).getByRole('button', { name: '重读保护条件' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(card(page)).toContainText('现场核对权限已失效，选择已清除');
    await expect(
      card(page).getByRole('button', { name: '清理前核对', exact: true }),
    ).toBeDisabled();
    expect(f.read().branches[0]!.state).toBe('discarded');
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
