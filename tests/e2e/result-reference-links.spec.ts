import {
  test as base,
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
} from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { Result, Task, TaskDetail } from '../../packages/contracts/src/index.js';
import type { ResultDetail, ResultRevision } from '../../packages/contracts/src/results.js';
import type { ResultReference } from '../../packages/contracts/src/result-references.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import { teamFixture } from '../helpers/team.js';
import { prepareScreenshot } from '../helpers/task-reliability.js';

const origin = 'http://127.0.0.1:4345';
type LinkInput = {
  kind: 'report' | 'release';
  title: string;
  url: string;
  environment?: string;
  sourceNote?: string;
};
type Packet = { path: string; body: string | null; key: string };
type Disposable = { dispose(failed: boolean): Promise<void> };
const panel = (page: Page) => page.getByRole('region', { name: '报告与发布链接', exact: true });
const form = (page: Page) =>
  panel(page).getByRole('form', { name: '添加此版本的外部链接', exact: true });
const add = (page: Page) => panel(page).getByRole('button', { name: '添加链接', exact: true });
const save = (page: Page) => form(page).getByRole('button', { name: '保存链接', exact: true });
const close = (page: Page) => panel(page).getByRole('button', { name: '收起编辑', exact: true });
const pending = (page: Page) => panel(page).getByLabel('链接请求待确认', { exact: true });
const reread = (page: Page) =>
  panel(page).getByRole('button', { name: '重新读取链接', exact: true });
const recover = (page: Page, action: 'add' | 'remove') =>
  panel(page).getByRole('button', {
    name: action === 'add' ? '确认原添加请求' : '确认原移除请求',
    exact: true,
  });
const picker = (page: Page) => page.getByRole('combobox', { name: '查看固定版本', exact: true });
const row = (page: Page, input: Pick<LinkInput, 'kind' | 'title'>) =>
  panel(page).getByRole('article', {
    name: `${input.kind === 'report' ? '报告' : '发布'}链接：${input.title}`,
    exact: true,
  });
const packet = (request: Request): Packet => ({
  path: new URL(request.url()).pathname,
  body: request.postData(),
  key: request.headers()['idempotency-key'] ?? '',
});
const report: LinkInput = {
  kind: 'report',
  title: '核对 <b>报告</b>',
  url: 'https://reports.example.invalid/check?raw=%3Cb%3Etext%3C%2Fb%3E',
  environment: '测试 <b>环境</b>',
  sourceNote: '成员填写 <script>来源说明</script>',
};
const release: LinkInput = {
  kind: 'release',
  title: '发布入口 · 外部状态未知',
  url: 'http://release.example.invalid/build/ordinary',
  environment: '预览环境',
  sourceNote: '仅记录人工提供的地址',
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function reportCleanup(errors: unknown[], failed: boolean) {
  if (!errors.length) return;
  if (failed)
    for (const error of errors)
      base.info().annotations.push({ type: 'cleanup-error', description: String(error) });
  else throw new AggregateError(errors, '成果链接夹具清理失败');
}

async function fixture(page: Page) {
  const api = await teamFixture(origin);
  const disposables: Disposable[] = [];
  try {
    // The normal member fixture owns its project and can edit it. No permission
    // changes, execution, branch producers or native artifacts are involved.
    const editor = await api.space(await api.setup());
    const project = await api.project(editor);
    const task = (await api.task(editor, project.id, '普通文字成果的版本链接')) as Task;
    const created = await api.call(`tasks/${task.id}/results`, editor, {
      title: '第一版文字成果',
      body: '第一版正文保持原样。',
    });
    expect(created.statusCode, created.body).toBe(201);
    const result = created.json<Result>();
    const versions = api.store.as({ user: editor.user, spaceId: editor.spaceId }, () => {
      const revisions = new ResultRevisions(api.store);
      const first = revisions.current(result);
      const current: Result = {
        ...result,
        revision: 2,
        title: '第二版文字成果',
        body: '第二版正文与第一版各自固定。',
        updatedAt: new Date(Date.parse(result.updatedAt) + 1000).toISOString(),
      };
      // Fixture-only ordinary member append: keep the current projection and the
      // second immutable snapshot consistent without manufacturing a Run.
      api.store.db
        .prepare('UPDATE results SET body=? WHERE id=?')
        .run(JSON.stringify(current), result.id);
      const second = revisions.append(current, { kind: 'member' });
      return [first, second] as const;
    });
    async function read<T>(path: string): Promise<T> {
      const response = await api.call(path, editor);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<T>();
    }
    const path = (version: ResultRevision) => `results/${result.id}/versions/${version.id}`;
    const references = (version = versions[0]) => `${path(version)}/references`;
    const beforeTask = await read<TaskDetail>(`tasks/${task.id}`);
    const beforeDetails = await Promise.all(
      versions.map((version) => read<ResultDetail>(path(version))),
    );
    const beforeCurrent = await read<ResultDetail>(`results/${result.id}`);
    expect(beforeTask.runs).toEqual([]);
    expect(beforeDetails.map((detail) => detail.version)).toEqual(versions);
    expect(versions.map((version) => version.source)).toEqual([
      { kind: 'member' },
      { kind: 'member' },
    ]);
    expect(beforeCurrent.version).toEqual(versions[1]);
    await api.app.listen({ port: 4345, host: '127.0.0.1' });
    await page.context().addCookies(
      editor.cookie.split('; ').map((cookie) => {
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(
      ({ userId, spaceId }) => {
        sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
        if (!localStorage.getItem('hexu-theme')) localStorage.setItem('hexu-theme', 'dark');
      },
      { userId: editor.user.id, spaceId: editor.spaceId },
    );
    return {
      api,
      editor,
      task,
      result,
      versions,
      read,
      path,
      references,
      disposables,
      beforeTask,
      async open(version = versions[0]) {
        await page.goto(`${origin}/${path(version)}`);
        await expect(picker(page)).toHaveValue(version.id);
        await expect(panel(page)).toBeVisible();
        await expect(add(page)).toBeEnabled();
      },
      async list(version = versions[0]) {
        return (await read<{ items: ResultReference[]; limit: number }>(references(version))).items;
      },
      async seed(input: LinkInput, version = versions[0]) {
        const response = await api.call(references(version), editor, input);
        expect(response.statusCode, response.body).toBe(201);
        return response.json<ResultReference>();
      },
      async unchanged() {
        expect(await read<TaskDetail>(`tasks/${task.id}`)).toEqual(beforeTask);
        expect(await read<ResultDetail>(`results/${result.id}`)).toEqual(beforeCurrent);
        expect(
          await Promise.all(versions.map((version) => read<ResultDetail>(path(version)))),
        ).toEqual(beforeDetails);
      },
      async dispose(failed: boolean) {
        const errors: unknown[] = [];
        for (const disposable of [...disposables].reverse()) {
          try {
            await disposable.dispose(failed);
          } catch (error) {
            errors.push(error);
          }
        }
        // Close the browser connection (including SSE) before the isolated app.
        try {
          await page.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await api.close();
        } catch (error) {
          errors.push(error);
        }
        reportCleanup(errors, failed);
      },
    };
  } catch (error) {
    try {
      await page.close();
      await api.close();
    } catch (cleanup) {
      reportCleanup([cleanup], true);
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ references: Fixture }>({
  references: async ({ page }, use) => {
    const f = await fixture(page);
    let failed = false;
    try {
      await use(f);
      failed = test.info().status !== test.info().expectedStatus;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.dispose(failed);
    }
  },
});

async function routeFixture(
  page: Page,
  f: Fixture,
  url: string,
  handle: (route: Route) => Promise<void>,
  release: () => void = () => {},
) {
  let capturing = true;
  const pendingRoutes = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const handler = (route: Route) => {
    const work = (async () => {
      if (capturing) await handle(route);
      else await route.continue();
    })();
    pendingRoutes.add(work);
    // Observe rejection now, not just when cleanup eventually starts.
    void work.then(
      () => pendingRoutes.delete(work),
      (error: unknown) => {
        errors.push(error);
        pendingRoutes.delete(work);
      },
    );
    return work;
  };
  await page.route(url, handler);
  let disposed = false;
  const disposable = {
    async dispose(failed: boolean) {
      if (disposed) return;
      disposed = true;
      capturing = false;
      release();
      while (pendingRoutes.size) await Promise.allSettled([...pendingRoutes]);
      try {
        await page.unroute(url, handler);
      } catch (error) {
        errors.push(error);
      }
      reportCleanup(errors, failed);
    },
  };
  f.disposables.push(disposable);
  return disposable;
}
async function edit(page: Page, input: LinkInput) {
  await add(page).click();
  await expect(form(page)).toBeVisible();
  await form(page).getByLabel('链接类型', { exact: true }).selectOption(input.kind);
  await form(page).getByLabel('链接标题', { exact: true }).fill(input.title);
  await form(page).getByLabel('链接地址', { exact: true }).fill(input.url);
  await form(page)
    .getByLabel('环境（可选）', { exact: true })
    .fill(input.environment ?? '');
  await form(page)
    .getByLabel('来源说明（可选）', { exact: true })
    .fill(input.sourceNote ?? '');
}
async function expectFrozen(page: Page, input: LinkInput) {
  for (const [label, value] of [
    ['链接标题', input.title],
    ['链接地址', input.url],
    ['环境（可选）', input.environment ?? ''],
    ['来源说明（可选）', input.sourceNote ?? ''],
  ] as const) {
    await expect(form(page).getByLabel(label, { exact: true })).toBeDisabled();
    await expect(form(page).getByLabel(label, { exact: true })).toHaveValue(value);
  }
  await expect(form(page).getByLabel('链接类型', { exact: true })).toBeDisabled();
}
async function addLink(page: Page, input: LinkInput) {
  await edit(page, input);
  await save(page).click();
  await expect(row(page, input)).toBeVisible();
  await expect(form(page)).toHaveCount(0);
}
async function beginRemove(page: Page, input: LinkInput) {
  await row(page, input).getByRole('button', { name: '移除链接', exact: true }).click();
  return panel(page).getByRole('button', { name: '确认移除此链接', exact: true });
}
async function doubleActivate(control: Locator) {
  // Two synchronous activations exercise the mutation guard before React paints.
  await control.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
}
async function changeUrl(page: Page, path: string) {
  await page.evaluate((target) => {
    history.pushState(history.state, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function screenshot(
  page: Page,
  target: Locator,
  content: Locator,
  filename: string,
  mobile = false,
) {
  await mkdir('artifacts', { recursive: true });
  await prepareScreenshot(page, target, content);
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 32);
  await page.screenshot({ path: `artifacts/${filename}` });
}
function failure(route: Route) {
  return route.fulfill({
    status: 500,
    json: { error: { code: 'INTERNAL_ERROR', message: '测试：普通请求暂时失败，请确认原请求。' } },
  });
}

// Screenshot plan: 247 dark desktop shows populated version references; 248 light
// mobile shows the actual link and local controls; 249 light mobile shows the
// frozen original package with its recovery action. Each target is scrolled into
// view, hit-tested and checked for overflow; no distant header/footer requirement.
test('报告与发布链接以纯文本展示，真实增删只改变固定版本的可选关联', async ({
  page,
  references: f,
}) => {
  await f.open();
  await addLink(page, report);
  await addLink(page, release);
  const first = await f.list();
  expect(first).toHaveLength(2);
  for (const input of [report, release]) {
    const item = first.find((reference) => reference.kind === input.kind)!;
    expect(item).toMatchObject({
      ...input,
      resultId: f.result.id,
      resultRevisionId: f.versions[0].id,
      taskId: f.task.id,
      source: 'manual',
      externalState: 'unknown',
      availability: 'not_checked',
      removedAt: null,
      removedBy: null,
    });
    expect(item.recordedBy).toEqual({ id: f.editor.user.id, name: f.editor.user.name });
    expect(item.recordedAt).toBeTruthy();
    const article = row(page, input);
    await expect(article.getByRole('link', { name: input.title, exact: true })).toHaveAttribute(
      'href',
      input.url,
    );
    for (const text of [input.url, input.environment!, input.sourceNote!])
      await expect(article).toContainText(text);
    await expect(article).toContainText('未知');
    await expect(article).toContainText('可用性未检查');
    await expect(article.locator('b, script, iframe, img')).toHaveCount(0);
  }
  await expect(picker(page)).toHaveValue(f.versions[0].id);
  await expect(page.getByRole('link', { name: '打开此版本固定链接', exact: true })).toHaveAttribute(
    'href',
    `/${f.path(f.versions[0])}`,
  );
  const target = row(page, report).getByRole('link', { name: report.title, exact: true });
  await panel(page)
    .getByRole('heading', { name: '报告与发布链接', exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(
    page,
    row(page, report).getByRole('button', { name: '移除链接', exact: true }),
    panel(page),
    '247-result-reference-links-dark.png',
  );
  await expect(
    panel(page).getByText('人工关联到当前固定版本 v1，报告和发布链接均为可选项。', { exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, target, panel(page), '248-result-reference-links-mobile-light.png', true);
  await prepareScreenshot(
    page,
    row(page, report).getByRole('button', { name: '移除链接', exact: true }),
    panel(page),
  );
  expect(
    (await row(page, report).getByRole('button', { name: '移除链接', exact: true }).boundingBox())!
      .height,
  ).toBeGreaterThanOrEqual(44);

  await picker(page).selectOption(f.versions[1].id);
  await expect(picker(page)).toHaveValue(f.versions[1].id);
  await expect(panel(page).getByRole('article')).toHaveCount(0);
  expect(await f.list(f.versions[1])).toEqual([]);
  const secondRelease = {
    ...release,
    title: '第二版自己的发布地址',
    url: 'https://release.example.invalid/build/version-2',
  };
  await addLink(page, secondRelease);
  await picker(page).selectOption(f.versions[0].id);
  await expect(row(page, report)).toBeVisible();
  await expect(row(page, release)).toBeVisible();
  await expect(row(page, secondRelease)).toHaveCount(0);
  await beginRemove(page, report);
  await panel(page).getByRole('button', { name: '取消移除', exact: true }).click();
  await expect(
    row(page, report).getByRole('button', { name: '移除链接', exact: true }),
  ).toBeFocused();
  await (await beginRemove(page, report)).click();
  await expect(row(page, report)).toHaveCount(0);
  expect((await f.list()).map((item) => item.id)).toEqual([
    first.find((item) => item.kind === 'release')!.id,
  ]);
  expect((await f.list(f.versions[1])).map((item) => item.title)).toEqual([secondRelease.title]);
  await f.unchanged();
});

test('没有报告或发布链接也可从成果页按原语义完成任务', async ({ page, references: f }) => {
  await f.open();
  expect(await f.list()).toEqual([]);
  expect(await f.list(f.versions[1])).toEqual([]);
  await page.locator('main').getByRole('button', { name: '标记完成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '标记任务完成', exact: true });
  // A task without active execution uses the existing direct completion path.
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator('main').getByRole('button', { name: '重新打开', exact: true }),
  ).toBeEnabled();
  expect((await f.read<TaskDetail>(`tasks/${f.task.id}`)).task).toMatchObject({
    status: 'done',
    revision: f.beforeTask.task.revision + 1,
  });
  expect(await f.list()).toEqual([]);
  expect(await f.list(f.versions[1])).toEqual([]);
  expect((await f.read<ResultDetail>(`results/${f.result.id}`)).version).toEqual(f.versions[1]);
});

for (const action of ['add', 'remove'] as const)
  for (const mode of ['before-commit', 'lost-ack'] as const) {
    test(`${action} ${mode}：重复点击与收起重开只恢复原键和原正文`, async ({
      page,
      references: f,
    }) => {
      const seeded = action === 'remove' ? await f.seed(report) : null;
      await f.open();
      const endpoint = `${origin}/api/v1/${f.references()}${seeded ? `/${seeded.id}/remove` : ''}`;
      const sent = deferred(),
        releaseFirst = deferred();
      const records: Packet[] = [];
      const responses: ResultReference[] = [];
      await routeFixture(
        page,
        f,
        endpoint,
        async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          records.push(packet(route.request()));
          if (records.length === 1) {
            if (mode === 'lost-ack') {
              const response = await route.fetch();
              expect(response.status()).toBe(action === 'add' ? 201 : 200);
              responses.push((await response.json()) as ResultReference);
            }
            sent.resolve();
            await releaseFirst.promise;
            return mode === 'before-commit' ? route.abort('failed') : failure(route);
          }
          const response = await route.fetch();
          expect(response.status()).toBe(action === 'add' ? 201 : 200);
          responses.push((await response.json()) as ResultReference);
          await route.fulfill({ response });
        },
        releaseFirst.resolve,
      );
      if (action === 'add') {
        await edit(page, report);
        await doubleActivate(save(page));
      } else await doubleActivate(await beginRemove(page, report));
      await sent.promise;
      expect(records).toHaveLength(1);
      expect(records[0]!.key).toBeTruthy();
      expect(JSON.parse(records[0]!.body!)).toEqual(action === 'add' ? report : {});
      if (action === 'add') {
        await expectFrozen(page, report);
        await close(page).click();
        await expect(form(page)).toHaveCount(0);
        await add(page).click();
        await expectFrozen(page, report);
      }
      releaseFirst.resolve();
      await expect(recover(page, action)).toBeEnabled();
      await expect(pending(page)).toContainText(report.title);
      await expect(pending(page)).toContainText(report.url);
      expect((await f.list()).length).toBe(
        action === 'add' ? (mode === 'lost-ack' ? 1 : 0) : mode === 'lost-ack' ? 0 : 1,
      );
      // A query-only history change does not create another reference target.
      await changeUrl(page, `/${f.path(f.versions[0])}?view=original-request`);
      await expect(recover(page, action)).toBeEnabled();
      await expect(pending(page)).toContainText(report.title);
      if (action === 'add' && mode === 'before-commit') {
        await close(page).click();
        await expect(recover(page, action)).toBeFocused();
        await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await screenshot(
          page,
          recover(page, action),
          pending(page),
          '249-result-reference-links-pending-mobile.png',
          true,
        );
        await expect(pending(page)).toContainText(report.environment!);
        await expect(pending(page)).toContainText(report.sourceNote!);
      }
      await doubleActivate(recover(page, action));
      await expect(pending(page)).toHaveCount(0);
      if (action === 'add') await expect(row(page, report)).toBeVisible();
      else await expect(row(page, report)).toHaveCount(0);
      expect(records).toHaveLength(2);
      expect(records[1]).toEqual(records[0]);
      if (mode === 'lost-ack') expect(responses[1]).toEqual(responses[0]);
      const list = await f.list();
      expect(list).toHaveLength(action === 'add' ? 1 : 0);
      expect(await f.list(f.versions[1])).toEqual([]);
      await f.unchanged();
    });
  }

for (const action of ['add', 'remove'] as const) {
  test(`${action} 成功回执后的读取500只重试GET，不重发写请求`, async ({ page, references: f }) => {
    const seeded = action === 'remove' ? await f.seed(release) : null;
    await f.open();
    const records: Packet[] = [];
    let accepted = false,
      failReads = true,
      failedReads = 0;
    const pattern = `${origin}/api/v1/${f.references()}**`;
    await routeFixture(page, f, pattern, async (route) => {
      if (route.request().method() === 'POST') {
        records.push(packet(route.request()));
        const response = await route.fetch();
        expect(response.status()).toBe(action === 'add' ? 201 : 200);
        accepted = true;
        return route.fulfill({ response });
      }
      if (accepted && failReads && route.request().method() === 'GET') {
        failedReads++;
        return failure(route);
      }
      return route.continue();
    });
    if (action === 'add') {
      await edit(page, release);
      await save(page).click();
    } else {
      expect(seeded).toBeTruthy();
      await (await beginRemove(page, release)).click();
    }
    await expect(
      panel(page)
        .getByRole('status')
        .filter({ hasText: action === 'add' ? '已保存链接' : '已移除链接' }),
    ).toBeVisible();
    await expect(panel(page).getByRole('alert')).toContainText('操作已确认');
    await expect(reread(page)).toBeEnabled();
    await expect(recover(page, action)).toHaveCount(0);
    await expect(pending(page)).toHaveCount(0);
    expect(accepted).toBe(true);
    expect(failedReads).toBeGreaterThan(0);
    expect(records).toHaveLength(1);
    failReads = false;
    await reread(page).click();
    if (action === 'add') await expect(row(page, release)).toBeVisible();
    else await expect(row(page, release)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    expect(records).toHaveLength(1);
    expect(await f.list()).toHaveLength(action === 'add' ? 1 : 0);
    await f.unchanged();
  });
}

for (const late of ['read', 'write'] as const)
  for (const outcome of [200, 500] as const) {
    test(`旧版本${late === 'read' ? '读取' : '写入'}迟到${outcome}不覆盖新版本和查询导航后的编辑`, async ({
      page,
      references: f,
    }) => {
      const old = await f.seed(report);
      await f.open();
      const captured = deferred(),
        releaseOld = deferred(),
        delivered = deferred();
      let held = false;
      const endpoint = `${origin}/api/v1/${f.references()}`;
      await routeFixture(
        page,
        f,
        endpoint,
        async (route) => {
          const method = late === 'read' ? 'GET' : 'POST';
          if (held || route.request().method() !== method) return route.continue();
          held = true;
          const response = await route.fetch();
          expect(response.status()).toBe(late === 'read' ? 200 : 201);
          captured.resolve();
          await releaseOld.promise;
          if (outcome === 500) await failure(route);
          else await route.fulfill({ response });
          delivered.resolve();
        },
        releaseOld.resolve,
      );
      if (late === 'write') {
        await edit(page, release);
        await save(page).click();
      } else {
        await reread(page).click();
      }
      await captured.promise;
      await changeUrl(page, `/${f.path(f.versions[1])}?view=keep-new-draft`);
      await expect(picker(page)).toHaveValue(f.versions[1].id);
      await expect(add(page)).toBeEnabled();
      const draft = { ...release, title: '第二版尚未提交的新草稿' };
      await edit(page, draft);
      releaseOld.resolve();
      await delivered.promise;
      await expect(form(page)).toBeVisible();
      await expect(form(page).getByLabel('链接标题', { exact: true })).toHaveValue(draft.title);
      await expect(form(page).getByLabel('链接地址', { exact: true })).toHaveValue(draft.url);
      await expect(form(page).getByLabel('链接类型', { exact: true })).toHaveValue(draft.kind);
      await expect(form(page).getByLabel('环境（可选）', { exact: true })).toHaveValue(
        draft.environment!,
      );
      await expect(form(page).getByLabel('来源说明（可选）', { exact: true })).toHaveValue(
        draft.sourceNote!,
      );
      await expect(panel(page).getByRole('alert')).toHaveCount(0);
      await expect(save(page)).toBeEnabled();
      await expect(panel(page).getByRole('article')).toHaveCount(0);
      await expect(pending(page)).toHaveCount(0);
      expect(await f.list(f.versions[1])).toEqual([]);
      const first = await f.list();
      expect(first.some((item) => item.id === old.id)).toBe(true);
      expect(first).toHaveLength(late === 'write' ? 2 : 1);
      await f.unchanged();
    });
  }
