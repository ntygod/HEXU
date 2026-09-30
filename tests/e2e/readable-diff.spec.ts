import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { branchResultFixture } from '../helpers/branch-results.js';
import { codeSnapshot, recordResultCode, saveResultCode } from '../helpers/result-code.js';
import { buildCodeDifference } from '../../apps/runner/src/agent/result-code-diff.js';
import { ResultCodeStore } from '../../packages/db/src/result-code.js';
const origin = 'http://127.0.0.1:4326';
type Snapshot = Awaited<ReturnType<typeof codeSnapshot>>;
async function ready(before: Snapshot, after: Snapshot) {
  const f = await branchResultFixture(origin, before);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const save = async (snapshot: Snapshot) => {
      const cp = await recordResultCode(f, snapshot);
      const saved = await saveResultCode(f, cp.checkpointId);
      new ResultCodeStore(f.api.store).publish(
        f.ns[0]!.token,
        buildCodeDifference(
          saved.revisionId,
          saved.detail.version.source.code,
          before,
          snapshot,
          new Date().toISOString(),
        ),
      );
      return saved;
    };
    const saved = await save(after);
    await f.api.app.listen({ port: 4326, host: '127.0.0.1' });
    return { ...f, saved, save };
  } catch (error) {
    await f.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof ready>>;
async function open(page: Page, f: Fixture, bob = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  await page.goto(`${origin}/results/${f.saved.resultId}/versions/${f.saved.revisionId}`);
  await page
    .getByLabel('固定代码与差异')
    .locator('summary')
    .filter({ hasText: '查看固定代码差异' })
    .click();
}
const panel = (page: Page) => page.getByLabel('固定代码与差异');
async function file(page: Page, name: string) {
  const d = panel(page)
    .locator('.result-code-file')
    .filter({ has: page.getByText(name, { exact: true }) });
  await d.locator(':scope > summary').click();
  return d;
}
async function close(page: Page, f: Fixture) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank');
  await page.context().close();
  await f.close();
}
test('固定代码行号和增删定位、键盘展开上下文、两侧全文、深浅色与390px实际阅读宽度', async ({
  page,
}) => {
  const before = Array.from({ length: 26 }, (_, i) => `const entry${i} = ${i};`).join('\n') + '\n';
  const after = before.replace(
    'const entry13 = 13;',
    '    const entry13 = 50;\n    // <script>literal text only</script> ' +
      '保留缩进的很长说明 '.repeat(12),
  );
  const f = await ready(
    await codeSnapshot([{ name: 'README.md', text: before }]),
    await codeSnapshot([{ name: 'README.md', text: after }]),
  );
  try {
    await open(page, f);
    const d = await file(page, 'README.md');
    const table = d.getByRole('table', { name: '起点文件与所选文件行级差异' });
    await expect(d.getByLabel('文本变化行数')).toHaveText('+2 / −1 行');
    await expect(table.locator('.code-diff-deletion')).toContainText('const entry13 = 13;');
    await expect(table.locator('.code-diff-addition').first().locator('td').nth(1)).toHaveText(
      '14',
    );
    await expect(table).toContainText('<script>literal text only</script>');
    expect(await table.locator('.code-diff-addition code').first().textContent()).toBe(
      '    const entry13 = 50;',
    );
    await expect(table.getByText('const entry5 = 5;', { exact: true })).toHaveCount(0);
    const fold = table.getByRole('button', { name: /展开.*行未变内容/ }).first();
    await fold.focus();
    await page.keyboard.press('Enter');
    await expect(table.getByText('const entry5 = 5;', { exact: true })).toBeVisible();
    await table
      .getByRole('button', { name: /收起.*行未变内容/ })
      .first()
      .click();
    await mkdir('artifacts', { recursive: true });
    await table.scrollIntoViewIfNeeded();
    await d.screenshot({ path: 'artifacts/144-readable-line-diff-dark.png' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    // An element screenshot of a file taller than the viewport scrolls the
    // element's top under fixed navigation. Check normal viewport interaction
    // and capture the controls and changed lines as two actual mobile views.
    const lineButton = d.getByRole('button', { name: '行级差异', exact: true });
    const fullButton = d.getByRole('button', { name: '两侧全文', exact: true });
    await lineButton.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    for (const button of [lineButton, fullButton]) {
      expect(
        await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const inset = Math.min(8, box.height / 4, box.width / 4);
          const points = [
            [box.x + box.width / 2, box.y + inset],
            [box.x + box.width / 2, box.bottom - inset],
            [box.x + inset, box.y + box.height / 2],
            [box.right - inset, box.y + box.height / 2],
            [box.x + box.width / 2, box.y + box.height / 2],
          ];
          return (
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            points.every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
          );
        }),
      ).toBe(true);
    }
    await fullButton.click();
    await expect(d.locator('pre').last()).toHaveText(after);
    await lineButton.click();
    await lineButton.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: 'artifacts/145-readable-line-diff-mobile-light.png' });
    await table
      .locator('.code-diff-addition')
      .last()
      .evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: 'artifacts/146-readable-line-diff-mobile-changes.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await table.boundingBox())!.width).toBeGreaterThan(260);
    expect(await table.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect(
      await table
        .locator('.code-diff-addition code')
        .last()
        .evaluate((e) => getComputedStyle(e).whiteSpace),
    ).toBe('pre-wrap');
    await d.getByRole('button', { name: '两侧全文', exact: true }).click();
    await expect(d.locator('pre').first()).toHaveText(before);
    await expect(d.locator('pre').last()).toHaveText(after);
    await d.getByRole('button', { name: '行级差异', exact: true }).click();
    await expect(table).toBeVisible();
    await expect(page.locator('script').filter({ hasText: 'literal text only' })).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});
test('新增删除空文件、仅模式和末尾换行变化及复杂比较回退保留真实范围', async ({ page }) => {
  const a = [
    { name: 'complex.txt', text: 'old\n'.repeat(600) },
    { name: 'empty-deleted.txt', text: '' },
    { name: 'mode.sh', text: 'echo safe\n' },
    { name: 'newline.txt', text: 'same\r\nlast' },
  ];
  const b = [
    { name: 'complex.txt', text: 'new\n'.repeat(600) },
    { name: 'empty-added.txt', text: '' },
    { name: 'mode.sh', text: 'echo safe\n', mode: '100755' },
    { name: 'newline.txt', text: 'same\nlast\n' },
    { name: 'binary.dat', data: Buffer.from([0, 255]) },
    { name: 'large.txt', text: 'x'.repeat(8193) },
  ];
  const f = await ready(
    await codeSnapshot(a.sort((x, y) => Buffer.compare(Buffer.from(x.name), Buffer.from(y.name)))),
    await codeSnapshot(b.sort((x, y) => Buffer.compare(Buffer.from(x.name), Buffer.from(y.name)))),
  );
  try {
    await open(page, f);
    for (const name of ['empty-added.txt', 'empty-deleted.txt']) {
      const d = await file(page, name);
      await expect(d).toContainText('空文件没有文本行');
      await expect(d.getByRole('table')).toHaveCount(0);
    }
    const mode = await file(page, 'mode.sh');
    await expect(mode).toContainText('模式变化');
    await expect(mode).toContainText('正文相同');
    await expect(mode.getByLabel('文本变化行数')).toHaveText('+0 / −0 行');
    const newline = await file(page, 'newline.txt');
    await expect(newline).toContainText('CRLF');
    await expect(newline).toContainText('末尾无换行');
    await expect(newline.getByLabel('文本变化行数')).toHaveText('+2 / −2 行');
    const complex = await file(page, 'complex.txt');
    await expect(complex).toContainText('超过本次行比较计算上限');
    await expect(complex.getByRole('button', { name: '行级差异', exact: true })).toBeDisabled();
    await expect(complex.locator('pre').first()).toHaveText('old\n'.repeat(600));
    await expect(complex.getByRole('table')).toHaveCount(0);
    const binary = await file(page, 'binary.dat');
    await expect(binary).toContainText('二进制或非UTF-8');
    await expect(binary.getByRole('group', { name: '代码阅读方式' })).toHaveCount(0);
    const large = await file(page, 'large.txt');
    await expect(large).toContainText('正文未共享');
    await expect(large.getByRole('table')).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});
test('行级差异固定旧成果版本，临时读错与新版本不替换，切换刷新后撤权清空正文', async ({ page }) => {
  const f = await ready(
    await codeSnapshot([{ name: 'README.md', text: 'base\n' }]),
    await codeSnapshot([{ name: 'README.md', text: 'version-one\n' }]),
  );
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    await open(page, f, true);
    let d = await file(page, 'README.md');
    await expect(d.getByRole('table')).toContainText('version-one');
    const oldURL = page.url();
    const second = await f.save(await codeSnapshot([{ name: 'README.md', text: 'version-two\n' }]));
    await expect(
      page
        .getByLabel('查看固定版本', { exact: true })
        .locator(`option[value="${second.revisionId}"]`),
    ).toHaveCount(1);
    await expect(page.getByLabel('查看固定版本', { exact: true })).toHaveValue(f.saved.revisionId);
    await expect(d.getByRole('table')).toContainText('version-one');
    expect(page.url()).toBe(oldURL);
    const url = `${origin}/api/v1/results/${f.saved.resultId}/versions/${f.saved.revisionId}`;
    await page.route(url, (route) =>
      route.fulfill({ status: 503, json: { error: { message: '固定差异暂不可读' } } }),
    );
    await expect(page.getByText('固定差异暂不可读', { exact: false })).toBeVisible();
    await expect(d.getByRole('table')).toContainText('version-one');
    await page.unroute(url);
    await page.getByLabel('查看固定版本', { exact: true }).selectOption(second.revisionId);
    await expect(page.getByLabel('查看固定版本', { exact: true })).toHaveValue(second.revisionId);
    await panel(page).locator('summary').filter({ hasText: '查看固定代码差异' }).click();
    d = await file(page, 'README.md');
    await expect(d.getByRole('table')).toContainText('version-two');
    await expect(d).not.toContainText('version-one');
    await page.reload();
    await expect(page.getByLabel('查看固定版本', { exact: true })).toHaveValue(second.revisionId);
    await panel(page).locator('summary').filter({ hasText: '查看固定代码差异' }).click();
    d = await file(page, 'README.md');
    await expect(d.getByRole('table')).toContainText('version-two');
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    await expect(page.getByRole('heading', { name: '无法打开成果', exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByText('version-two', { exact: true })).toHaveCount(0);
  } finally {
    await close(page, f);
  }
});
