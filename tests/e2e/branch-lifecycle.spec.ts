import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { branchResultFixture } from '../helpers/branch-results.js';
import { WorkBranchStore } from '../../packages/db/src/work-branches.js';
// Real service + browser with deterministic node events. No model calls or
// claim that these metadata fixtures create/delete an actual workspace.
const origin = 'http://127.0.0.1:4323';
type Fixture = Awaited<ReturnType<typeof branchResultFixture>>;
const records = (page: Page) => page.getByRole('dialog', { name: '任务方案分支', exact: true });
const card = (page: Page, name = '方案 A') =>
  records(page).getByRole('article', { name: `方案：${name}`, exact: true });
const editor = (page: Page) =>
  page.getByRole('dialog', { name: '放弃方案并保留现场', exact: true });
const consent = (page: Page) => editor(page).getByRole('checkbox', { name: /^我理解只放弃此方案/ });
const submit = (page: Page) =>
  editor(page).getByRole('button', { name: '确认放弃并保留现场', exact: true });
const previewUrl = (f: Fixture) => `${origin}/api/v1/${f.path()}/discard-preview`;
async function open(page: Page, f: Fixture) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4323, host: '127.0.0.1' });
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
async function edit(page: Page, name = '方案 A') {
  await card(page, name).getByRole('button', { name: '放弃方案并保留现场', exact: true }).click();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}

test('已登记方案明确放弃但不删现场；取消不提交，暗色和手机确认范围清楚', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const original = f.read().branches[0]!,
      workspaces = JSON.stringify(
        f.api.store.db.prepare('SELECT * FROM work_branch_workspaces').all(),
      );
    await open(page, f);
    await edit(page);
    await expect(submit(page)).toBeDisabled();
    await expect(consent(page)).not.toBeChecked();
    await expect(editor(page)).toContainText('不停止或清理进程，不删除文件');
    await consent(page).check();
    await editor(page).getByRole('button', { name: '返回方案列表' }).click();
    expect(f.read().branches[0]!.state).toBe('planned');
    await edit(page);
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await mkdir('artifacts', { recursive: true });
    await consent(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/136-branch-discard-confirm-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect
      .poll(() => editor(page).evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        editor(page)
          .locator('.work-branch-lifecycle')
          .evaluate((el) => el.clientWidth),
      )
      .toBeGreaterThan(280);
    await consent(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/137-branch-discard-confirm-mobile-light.png' });
    await submit(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    await expect(card(page)).toContainText('独立现场已登记');
    await expect(card(page).getByRole('button', { name: '准备方案首轮执行' })).toHaveCount(0);
    await card(page).getByRole('button', { name: '查看方案历史' }).click();
    await expect(card(page).getByRole('list', { name: '方案历史' })).toContainText(
      '放弃方案并保留现场',
    );
    expect(f.read().branches[0]!.workingCopyId).toBe(original.workingCopyId);
    expect(
      JSON.stringify(f.api.store.db.prepare('SELECT * FROM work_branch_workspaces').all()),
    ).toBe(workspaces);
    expect(f.api.store.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n).toBe(0);
    await page.reload();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await expect(card(page)).toContainText('已放弃 · 现场保留');
  } finally {
    await close(page, f);
  }
});
test('放弃中的原执行仍可独立停止；停止待确认不伪报结束，另一未知执行继续保留观察', async ({
  page,
}) => {
  const f = await branchResultFixture(origin);
  try {
    const a = f.begin(),
      b = f.begin(1, 'codex');
    a.start();
    b.start();
    await open(page, f);
    await edit(page);
    await consent(page).check();
    await submit(page).click();
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    await expect(card(page).getByRole('button', { name: '停止此方案执行' })).toBeEnabled();
    expect(f.read().branches[0]!.run!.state).toBe('running');
    expect(f.read().branches[1]!.run!.state).toBe('running');
    await mkdir('artifacts', { recursive: true });
    await card(page).getByRole('button', { name: '停止此方案执行' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/138-discarded-branch-still-running.png' });
    await card(page).getByRole('button', { name: '停止此方案执行' }).click();
    await expect(card(page)).toContainText('停止请求已保存，正在等待节点确认');
    expect(f.read().branches[0]!.run!.node!.terminationConfirmed).toBe(false);
    expect(f.read().branches[1]!.run!.state).toBe('running');
    a.finish('cancelled', '保留已写输出');
    await expect(card(page).getByRole('button', { name: '停止此方案执行' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: '保存方案成果' })).toBeVisible();
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    b.send('unknown', '第二条执行状态未确认');
    await edit(page, '方案 B');
    await expect(editor(page)).toContainText('连接或原进程状态未确认，目录仍保留占用');
    await consent(page).check();
    await submit(page).click();
    await expect(card(page, '方案 B')).toContainText('已放弃 · 现场保留');
    await expect(card(page, '方案 B')).toContainText('连接或原进程状态未确认，目录仍保留占用');
    expect(f.read().branches[1]!.run!.observation).toBe('unknown');
    expect(f.read().branches[1]!.run!.node!.terminationConfirmed).toBe(false);
  } finally {
    await close(page, f);
  }
});
test('当前选择先明确取消才可放弃，保留成果与选择历史但不再提供重新选用', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const saved = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    expect(saved.statusCode).toBe(201);
    const choicePath = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`;
    expect(
      (
        await f.api.call(choicePath, f.alice, {
          expectedSelectionRevision: 0,
          branchId: f.view.branches[0]!.id,
          resultRevisionId: saved.json().revisionId,
          note: '原选择保留',
        })
      ).statusCode,
    ).toBe(200);
    await open(page, f);
    await edit(page);
    await expect(editor(page).getByRole('region', { name: '放弃方案受阻' })).toContainText(
      '请先在比较中明确取消或替换选择',
    );
    await expect(consent(page)).toBeDisabled();
    await expect(submit(page)).toBeDisabled();
    await editor(page).getByRole('link', { name: '去比较中明确取消或替换选择' }).click();
    await page.getByRole('button', { name: '取消当前选择', exact: true }).click();
    await page
      .getByRole('dialog', { name: '记录方案选择', exact: true })
      .getByRole('button', { name: '确认取消选择', exact: true })
      .click();
    await expect(page.getByLabel('当前方案选择')).toContainText('尚未选择方案');
    await page.goBack();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await edit(page);
    await consent(page).check();
    await submit(page).click();
    const link = card(page).getByRole('link', { name: '方案 A 成果 · v1', exact: true });
    await expect(link).toHaveAttribute(
      'href',
      `/results/${saved.json().resultId}/versions/${saved.json().revisionId}`,
    );
    await records(page).getByRole('link', { name: '比较与选择方案', exact: true }).click();
    const column = page.getByRole('article', { name: '比较方案：方案 A', exact: true });
    await expect(column).toContainText('已放弃 · 现场与成果历史保留');
    await expect(column.getByRole('button', { name: '选用这个版本' })).toHaveCount(0);
    await expect(column.getByRole('link', { name: '查看此版本与反馈' })).toHaveAttribute(
      'href',
      `/results/${saved.json().resultId}/versions/${saved.json().revisionId}`,
    );
    await page.getByText('选择历史（2）', { exact: true }).click();
    await expect(page.locator('.branch-choice-history')).toContainText('原选择保留');
  } finally {
    await close(page, f);
  }
});
test('放弃回执未知跨分页及关闭列表保持原body/key，确认后返回固定方案组不迷失原记录', async ({
  page,
}) => {
  const f = await branchResultFixture(origin);
  try {
    const requests: { body: unknown; key: string | undefined }[] = [],
      url = `${origin}/api/v1/${f.path()}/discard-preserving`;
    await page.route(url, async (route) => {
      requests.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (requests.length === 1)
        await route.fulfill({ status: 503, json: { error: { message: '放弃已保存但回执丢失' } } });
      else await route.fulfill({ response });
    });
    await open(page, f);
    await edit(page);
    await consent(page).check();
    await submit(page).click();
    await expect(editor(page).getByRole('region', { name: '放弃方案请求待确认' })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    for (let index = 0; index < 12; index++)
      f.as(() =>
        new WorkBranchStore(f.api.store).create(
          f.task.id,
          {
            expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
            checkpointId: f.view.group.start.checkpoint.id,
            branches: [
              { name: `后来 A ${index}`, goal: '独立新定义' },
              { name: `后来 B ${index}`, goal: '独立新定义' },
            ],
          },
          randomUUID(),
        ),
      );
    await editor(page).getByRole('button', { name: '返回方案列表' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(records(page).getByRole('region', { name: '未确认的方案放弃' })).toContainText(
      '方案 A',
    );
    await records(page).getByRole('button', { name: '更早方案组' }).click();
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await records(page).getByRole('button', { name: '继续确认放弃请求' }).click();
    await expect(consent(page)).toBeChecked();
    await editor(page).getByRole('button', { name: '确认上次放弃请求' }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    await expect(records(page).getByRole('region', { name: '未确认的方案放弃' })).toHaveCount(0);
    await expect(records(page).getByRole('button', { name: '返回全部方案组' })).toBeVisible();
    const events = (await f.api.call(f.path() + '/history', f.alice)).json().items;
    expect(
      events.filter((e: { action: string }) => e.action === 'discard_preserving'),
    ).toHaveLength(1);
  } finally {
    await close(page, f);
  }
});
test('放弃临时读错保留确认，Task新修订需明确重核且重新同意', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    await open(page, f);
    await edit(page);
    await consent(page).check();
    const url = previewUrl(f);
    await page.route(url, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '方案暂时不可读' } } }),
    );
    await editor(page).getByRole('button', { name: '重读放弃条件' }).click();
    await expect(editor(page)).toContainText('方案暂时不可读');
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
    await editor(page).getByRole('button', { name: '重读放弃条件' }).click();
    await expect(editor(page)).toContainText('请明确重新核对并再次确认');
    await editor(page).getByRole('button', { name: '重新核对放弃范围' }).click();
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await expect(submit(page)).toBeEnabled();
    await submit(page).click();
    await expect(card(page)).toContainText('已放弃 · 现场保留');
    expect(f.as(() => f.api.store.getTask(f.task.id)).status).toBe('done');
  } finally {
    await close(page, f);
  }
});
test('旧已取消读取的403不卸载新确认，当前撤权清除输入且不因重开恢复', async ({ page }) => {
  const f = await branchResultFixture(origin);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const url = previewUrl(f);
    let seen = 0;
    await page.route(url, async (route) => {
      if (++seen === 1) {
        await gate;
        await route
          .fulfill({ status: 403, json: { error: { message: '旧读取拒绝' } } })
          .catch(() => {});
      } else await route.continue();
    });
    await open(page, f);
    await edit(page);
    await expect.poll(() => seen).toBe(1);
    await page.keyboard.press('Escape');
    await edit(page);
    await consent(page).check();
    release();
    await expect(submit(page)).toBeEnabled();
    await page.unroute(url);
    await page.route(url, (route) =>
      route.fulfill({ status: 403, json: { error: { message: '当前放弃权限拒绝' } } }),
    );
    await editor(page).getByRole('button', { name: '重读放弃条件' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(records(page)).toContainText('放弃确认已清除');
    await records(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(url);
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await expect(card(page).getByRole('button', { name: '放弃方案并保留现场' })).toBeDisabled();
    expect(f.read().branches[0]!.state).toBe('planned');
  } finally {
    release();
    await close(page, f);
  }
});

test('其他编辑者放弃尚未选用方案时，已打开选择说明保留但不能提交或复活方案', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    expect((await f.api.call(f.path() + '/results', f.alice, await f.draft())).statusCode).toBe(
      201,
    );
    await open(page, f);
    await records(page).getByRole('link', { name: '比较与选择方案', exact: true }).click();
    const column = page.getByRole('article', { name: '比较方案：方案 A', exact: true });
    await column.getByRole('button', { name: '选用这个版本' }).click();
    const choice = page.getByRole('dialog', { name: '记录方案选择', exact: true });
    await choice.getByLabel('选择说明', { exact: true }).fill('保留我的选择说明，不自动换方案');
    const p = (await f.api.call(f.path() + '/discard-preview', f.alice)).json();
    expect(
      (
        await f.api.call(f.path() + '/discard-preserving', f.alice, {
          expectedRevision: p.branch.revision,
          expectedTaskRevision: p.taskRevision,
          confirmPreserveWorkspace: true,
          confirmExecutionContinues: true,
        })
      ).statusCode,
    ).toBe(200);
    await expect(choice).toContainText('此方案已被放弃，不能创建新选择');
    await expect(choice.getByLabel('选择说明', { exact: true })).toHaveValue(
      '保留我的选择说明，不自动换方案',
    );
    await expect(choice.getByRole('button', { name: '保存选择', exact: true })).toBeDisabled();
    await choice.locator('form').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(column).toContainText('已放弃 · 现场与成果历史保留');
    expect(f.read().selection).toBeNull();
    expect(f.read().branches[0]!.state).toBe('discarded');
  } finally {
    await close(page, f);
  }
});
