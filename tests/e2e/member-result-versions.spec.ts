import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { teamFixture } from '../helpers/team.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import type { Message, Task } from '../../packages/contracts/src/index.js';
import type { MemberResultVersionReceipt } from '../../packages/contracts/src/member-result-versions.js';
const origin = 'http://127.0.0.1:4331';
async function fixture() {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair(),
      project = await api.project(alice);
    await api.call(`projects/${project.id}/members/${bob.user.id}`, alice, { role: 'edit' });
    const task = (await api.task(alice, project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const result = as(() =>
      api.store.createResult(task.id, '原文字成果', 'FIRST_VERSION_BODY', randomUUID()),
    );
    const version = as(() => new ResultRevisions(api.store).current(result));
    const detail = () => as(() => new ResultRevisions(api.store).detail(result.id));
    const save = async (title: string, body: string) => {
      const current = detail().version;
      const r = await api.call(`results/${result.id}/versions`, alice, {
        expectedRevision: current.revision,
        expectedRevisionId: current.id,
        title,
        body,
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as MemberResultVersionReceipt;
    };
    return {
      api,
      alice,
      bob,
      project,
      task,
      result,
      version,
      detail,
      save,
      as,
      close: () => api.close(),
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const url = (f: Fixture, version = f.version.id) =>
  `${origin}/results/${f.result.id}/versions/${version}`;
const endpoint = (f: Fixture) => `${origin}/api/v1/results/${f.result.id}/versions`;
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: '保存文字成果新版本', exact: true });
async function open(page: Page, f: Fixture, bob = false, revision = f.version.id) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await f.api.app.listen({ port: 4331, host: '127.0.0.1' });
  const account = bob ? f.bob : f.alice;
  await page.context().addCookies(
    account.cookie.split('; ').map((cookie) => {
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
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(url(f, revision));
}
async function edit(page: Page) {
  await page
    .getByRole('button', { name: /^(编辑并保存新版本|继续编辑文字修订|确认原文字修订请求)$/ })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('明确保存同一文字成果v2，当前编辑者署名；键盘手机与原反馈后续Task仍定位v1', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const message = (
      await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
        body: 'FEEDBACK_ON_FIRST',
        resultId: f.result.id,
        resultRevisionId: f.version.id,
      })
    ).json() as Message;
    const followup = (
      await f.api.call(
        `results/${f.result.id}/versions/${f.version.id}/feedback/${message.id}/follow-ups`,
        f.alice,
        { title: '旧版后续工作', description: '保留原版来源' },
      )
    ).json() as Task;
    const taskBefore = f.as(() => f.api.store.getTask(f.task.id)),
      count = f.as(() => f.api.store.results(f.task.id)).length;
    await open(page, f, true);
    await edit(page);
    const e = dialog(page);
    await expect(e.getByLabel('文字修订固定基线')).toContainText('基于v1');
    await expect(e.getByLabel('新版本标题')).toBeFocused();
    await e.getByLabel('新版本标题').fill('补充取消行为的成果');
    await e.getByLabel('新版本说明').fill('SECOND_VERSION_BODY\n明确说明取消边界，不改旧版。');
    await e.getByText('查看本次原说明', { exact: true }).click();
    await expect(e.getByLabel('文字修订固定基线')).toContainText('FIRST_VERSION_BODY');
    await mkdir('artifacts', { recursive: true });
    await e.screenshot({ path: 'artifacts/159-member-version-editor-dark.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await e.screenshot({ path: 'artifacts/160-member-version-editor-mobile-light.png' });
    expect(await e.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await e.getByLabel('新版本说明').boundingBox())!.width).toBeGreaterThan(240);
    await e.getByLabel('新版本说明').press('Control+Enter');
    await expect(e).toHaveCount(0);
    await expect(page).toHaveURL(url(f));
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(
      'FEEDBACK_ON_FIRST',
    );
    const detail = f.detail();
    expect(detail.result.id).toBe(f.result.id);
    expect(detail.version.revision).toBe(2);
    expect(detail.version.createdBy?.id).toBe(f.bob.user.id);
    expect(f.as(() => f.api.store.results(f.task.id))).toHaveLength(count);
    expect(f.as(() => f.api.store.getTask(f.task.id))).toEqual(taskBefore);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
    expect(f.as(() => new ResultRevisions(f.api.store).get(f.result.id, f.version.id))).toEqual(
      f.version,
    );
    await page.getByRole('link', { name: '查看已保存的v2', exact: true }).click();
    await expect(page).toHaveURL(url(f, detail.version.id));
    await expect(page.locator('.written-result')).toContainText('SECOND_VERSION_BODY');
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0);
    await page.getByLabel('查看固定版本').selectOption(f.version.id);
    await expect(page).toHaveURL(url(f));
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(
      'FEEDBACK_ON_FIRST',
    );
    await page.screenshot({ path: 'artifacts/161-member-version-history-mobile.png' });
    await page.goto(`${origin}/tasks/${followup.id}`);
    const fixed = page.getByLabel('后续任务的固定来源');
    await fixed.locator(':scope > summary').click();
    await fixed.getByRole('link', { name: '查看原版本中的反馈', exact: true }).click();
    await expect(page).toHaveURL(url(f) + `/messages/${message.id}`);
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await page.reload();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
  } finally {
    await close(page, f);
  }
});
test('文字修订关闭保留草稿、另一成果隔离；临时预览读取失败不覆盖编辑，放弃不发布', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const second = f.as(() =>
      f.api.store.createResult(f.task.id, '另一份成果', 'OTHER_RESULT_BODY', randomUUID()),
    );
    await open(page, f);
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('UNSENT_DRAFT');
    await page.keyboard.press('Escape');
    expect(f.detail().version.revision).toBe(1);
    await page.locator('a[href="/results"]').first().click();
    const secondCard = page.locator(`.work-result-card[href="/results/${second.id}"]`);
    await expect(secondCard).toHaveCount(1);
    await secondCard.click();
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('OTHER_RESULT_BODY');
    await page.keyboard.press('Escape');
    await page.locator('a[href="/results"]').first().click();
    const firstCard = page.locator(`.work-result-card[href="/results/${f.result.id}"]`);
    await expect(firstCard).toHaveCount(1);
    await firstCard.click();
    let deny = true;
    await page.route(
      `${origin}/api/v1/results/${f.result.id}/member-version-preview`,
      async (route) => {
        if (deny)
          await route.fulfill({ status: 503, json: { error: { message: '临时读取失败' } } });
        else await route.continue();
      },
    );
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('UNSENT_DRAFT');
    await expect(
      dialog(page).getByRole('button', { name: '保存为新版本', exact: true }),
    ).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: '重读最新版本' })).toBeVisible();
    deny = false;
    await dialog(page).getByRole('button', { name: '重读最新版本' }).click();
    await expect(
      dialog(page).getByRole('button', { name: '保存为新版本', exact: true }),
    ).toBeEnabled();
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('UNSENT_DRAFT');
    await dialog(page).getByRole('button', { name: '放弃未提交修订' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('FIRST_VERSION_BODY');
    await dialog(page).getByLabel('新版本说明').fill('ONLY_PAGE_SESSION');
    await page.keyboard.press('Escape');
    await page.reload();
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('FIRST_VERSION_BODY');
    expect(f.detail().version.revision).toBe(1);
  } finally {
    await close(page, f);
  }
});
test('另一编辑者保存不会自动重设编辑基线；先核对并明确放弃旧草稿才能改从v2保存v3', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await open(page, f, true);
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('MY_LOCAL_DRAFT');
    const second = await f.save('另一编辑者v2', 'OTHER_EDITOR_VERSION_2');
    await expect(dialog(page).getByLabel('文字成果已有新版本')).toContainText('另一份v2已保存');
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('MY_LOCAL_DRAFT');
    await expect(dialog(page).getByLabel('文字修订固定基线')).toContainText('基于v1');
    await expect(
      dialog(page).getByRole('button', { name: '保存为新版本', exact: true }),
    ).toBeDisabled();
    await dialog(page).getByText('查看最新标题和说明', { exact: true }).click();
    await expect(dialog(page).getByLabel('文字成果已有新版本')).toContainText(
      'OTHER_EDITOR_VERSION_2',
    );
    await page.keyboard.press('Escape');
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('MY_LOCAL_DRAFT');
    await dialog(page).getByRole('button', { name: '放弃草稿并载入最新版' }).click();
    await expect(dialog(page).getByLabel('文字修订固定基线')).toContainText('基于v2');
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('OTHER_EDITOR_VERSION_2');
    await dialog(page).getByLabel('新版本说明').fill('REVIEWED_VERSION_3');
    await dialog(page).getByRole('button', { name: '保存为新版本', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(f.detail().version.revision).toBe(3);
    expect(
      f.as(() => new ResultRevisions(f.api.store).get(f.result.id, second.revisionId)).body,
    ).toBe('OTHER_EDITOR_VERSION_2');
    expect(f.detail().version.body).toBe('REVIEWED_VERSION_3');
  } finally {
    await close(page, f);
  }
});
test('文字版本丢ACK后同原基线正文和key确认，已有v3时仍返回原v2且不追加v4', async ({ page }) => {
  const f = await fixture();
  try {
    let drop = true;
    const attempts: { body: string | null; key: string }[] = [];
    await page.route(endpoint(f), async (route) => {
      attempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key']!,
      });
      const response = await route.fetch();
      if (drop) {
        drop = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await open(page, f);
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('ORIGINAL_PACKET_V2');
    await dialog(page).getByRole('button', { name: '保存为新版本', exact: true }).click();
    await expect(dialog(page).getByLabel('原文字修订请求待确认')).toBeVisible();
    await expect(dialog(page).getByLabel('新版本说明')).toBeDisabled();
    const second = f.detail().version;
    expect(second.revision).toBe(2);
    await f.save('后来v3', 'LATER_VERSION_3');
    await page.keyboard.press('Escape');
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('ORIGINAL_PACKET_V2');
    await dialog(page).getByRole('button', { name: '确认原请求是否已保存' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(f.detail().version.revision).toBe(3);
    expect(f.detail().version.body).toBe('LATER_VERSION_3');
    await page.getByRole('link', { name: '查看已保存的v2', exact: true }).click();
    await expect(page).toHaveURL(url(f, second.id));
    await expect(page.locator('.written-result')).toContainText('ORIGINAL_PACKET_V2');
  } finally {
    await close(page, f);
  }
});
test('文字修订降权清除草稿，重新授权后晚到失败不能恢复旧正文或基线', async ({ page }) => {
  const f = await fixture();
  let release = () => {},
    observed = () => {};
  const blocked = new Promise<void>((r) => {
      release = r;
    }),
    sent = new Promise<void>((r) => {
      observed = r;
    });
  try {
    await page.route(endpoint(f), async (route) => {
      observed();
      await blocked;
      await route.fulfill({ status: 409, json: { error: { message: '晚到修订失败' } } });
    });
    await open(page, f, true);
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('REVOKED_DRAFT');
    await dialog(page).getByRole('button', { name: '保存为新版本', exact: true }).click();
    await sent;
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await expect(dialog(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '编辑并保存新版本', exact: true }),
    ).toBeDisabled();
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('FIRST_VERSION_BODY');
    await expect(dialog(page).getByLabel('新版本说明')).toBeDisabled();
    const received = page.waitForResponse((r) => r.url() === endpoint(f) && r.status() === 409);
    release();
    await (await received).finished();
    await expect(dialog(page).getByLabel('新版本说明')).toBeEnabled();
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('FIRST_VERSION_BODY');
    expect(f.detail().version.revision).toBe(1);
  } finally {
    release();
    await close(page, f);
  }
});
test('达到既有100版本上限时明确说明不可追加，原版反馈与查看最新版仍保持定位', async ({ page }) => {
  const f = await fixture();
  try {
    const message = (
      await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
        body: 'OLD_ANCHORED_FEEDBACK',
        resultId: f.result.id,
        resultRevisionId: f.version.id,
      })
    ).json() as Message;
    for (let i = 2; i <= 100; i++) await f.save(`文字成果v${i}`, `BODY_VERSION_${i}`);
    expect(f.detail().revisions).toHaveLength(100);
    const latest = f.detail().version;
    await open(page, f);
    await expect(page.getByLabel('查看固定版本')).toHaveValue(f.version.id);
    await expect(page.locator('.written-result')).toContainText('FIRST_VERSION_BODY');
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(
      'OLD_ANCHORED_FEEDBACK',
    );
    await page.getByRole('link', { name: '查看最新版后修订', exact: true }).click();
    await expect(page).toHaveURL(url(f, latest.id));
    await edit(page);
    await expect(dialog(page)).toContainText('已达100个固定版本');
    await expect(dialog(page).getByLabel('新版本说明')).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: '保存为新版本', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByLabel('查看固定版本').selectOption(f.version.id);
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(
      'OLD_ANCHORED_FEEDBACK',
    );
    expect(f.detail().version.revision).toBe(100);
  } finally {
    await close(page, f);
  }
});
test('取消旧预览的晚到拒绝不关闭新编辑，挂起写入后SPA转到另一成果不抢回导航或污染草稿', async ({
  page,
}) => {
  const f = await fixture();
  let releaseRead = () => {},
    releaseWrite = () => {},
    readReached = () => {},
    writeReached = () => {},
    writeDone = () => {};
  const pendingReads: Promise<void>[] = [];
  const heldRead = new Promise<void>((r) => {
      releaseRead = r;
    }),
    heldWrite = new Promise<void>((r) => {
      releaseWrite = r;
    });
  const sawRead = new Promise<void>((r) => {
    readReached = r;
  });
  const sawWrite = new Promise<void>((r) => {
      writeReached = r;
    }),
    doneWrite = new Promise<void>((r) => {
      writeDone = r;
    });
  try {
    const second = f.as(() =>
      f.api.store.createResult(f.task.id, '另一份成果', 'SECOND_UNSAVED_SOURCE', randomUUID()),
    );
    let holdReads = true;
    await page.route(
      `${origin}/api/v1/results/${f.result.id}/member-version-preview`,
      async (route) => {
        if (!holdReads) {
          await route.continue();
          return;
        }
        readReached();
        // SSE 刷新可在首次打开期间取消并重发预览；这一轮所有读取都必须保持挂起。
        const pending = heldRead.then(() =>
          route.fulfill({ status: 403, json: { error: { message: '已取消旧读取的拒绝' } } }),
        );
        pendingReads.push(pending);
        await pending;
      },
    );
    await page.route(endpoint(f), async (route) => {
      const response = await route.fetch();
      writeReached();
      await heldWrite;
      await route.fulfill({ response });
      writeDone();
    });
    await open(page, f);
    await edit(page);
    await sawRead;
    await expect(dialog(page).getByLabel('新版本说明')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    holdReads = false;
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('PENDING_VERSION_TWO');
    releaseRead();
    await Promise.all(pendingReads);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('PENDING_VERSION_TWO');
    await dialog(page).getByRole('button', { name: '保存为新版本', exact: true }).click();
    await sawWrite;
    await expect(dialog(page).getByLabel('新版本说明')).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.locator('a[href="/results"]').first().click();
    await page.locator(`.work-result-card[href="/results/${second.id}"]`).click();
    await edit(page);
    await dialog(page).getByLabel('新版本说明').fill('SECOND_RESULT_LOCAL_DRAFT');
    releaseWrite();
    await doneWrite;
    await expect(page).toHaveURL(`${origin}/results/${second.id}`);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('SECOND_RESULT_LOCAL_DRAFT');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('a[href="/results"]').first().click();
    await page.locator(`.work-result-card[href="/results/${f.result.id}"]`).click();
    await edit(page);
    await expect(dialog(page).getByLabel('新版本说明')).toHaveValue('PENDING_VERSION_TWO');
    await expect(dialog(page).getByLabel('原文字修订请求待确认')).toHaveCount(0);
    expect(f.detail().version.revision).toBe(2);
    expect(f.as(() => new ResultRevisions(f.api.store).detail(second.id)).version.revision).toBe(1);
  } finally {
    releaseRead();
    releaseWrite();
    await close(page, f);
  }
});
