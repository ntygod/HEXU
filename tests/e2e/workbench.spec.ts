import { test, expect, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('工作台真实打开，并保留桌面截图', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(page.getByText('本地开发预览 · 执行模式明确标识')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: '收起项目导航', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开项目导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '项目导引栏' })).toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/01-workbench.png', fullPage: true });
});
test('项目看板和列表使用同一份持久化状态', async ({ page }) => {
  await page.goto('/projects/project-orders');
  await expect(page.getByRole('heading', { name: '订单管理改进', exact: true })).toBeVisible();
  await page.getByLabel('HX-032 状态').selectOption('in_progress');
  await expect(page.getByLabel('HX-032 状态')).toHaveValue('in_progress');
  await page.reload();
  await expect(page.getByLabel('HX-032 状态')).toHaveValue('in_progress');
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('.task-list').getByText('增加导出文件命名规则')).toBeVisible();
});
test('轻量新建、评论与刷新后恢复', async ({ page }) => {
  const workbenchUrl = /\/api\/v1\/workbench(?:\?.*)?$/;
  const pendingReads = new Set<Promise<void>>();
  const readErrors: unknown[] = [];
  let captureReads = true;
  let routeInstalled = false;
  let heldReadCompleted = false;
  let heldReadDrainedBeforeUnroute = false;
  let releaseHeldRead!: () => void;
  const heldReadGate = new Promise<void>((resolve) => {
    releaseHeldRead = resolve;
  });
  let markHeldReadReached!: () => void;
  let rejectHeldReadReached!: (error: unknown) => void;
  const heldReadReached = new Promise<void>((resolve, reject) => {
    markHeldReadReached = resolve;
    rejectHeldReadReached = reject;
  });
  void heldReadReached.catch(() => {});
  const observeRead = (operation: Promise<void>) => {
    const observed = operation.catch((error: unknown) => {
      readErrors.push(error);
      rejectHeldReadReached(error);
    });
    pendingReads.add(observed);
    void observed.then(() => pendingReads.delete(observed));
    return observed;
  };
  const emptyWorkbenchHandler = (route: Route) =>
    observeRead(
      (async () => {
        try {
          if (!captureReads || route.request().method() !== 'GET') {
            await route.fallback();
            return;
          }
          const response = await route.fetch();
          const data = await response.json();
          if (
            new URL(route.request().url()).searchParams.get('fixture') === 'empty-workbench-drain'
          ) {
            markHeldReadReached();
            await heldReadGate;
          }
          await route.fulfill({
            response,
            json: { ...data, projects: [], tasks: [], runs: [], results: [] },
          });
        } catch (error) {
          // Settle the browser read too; an already handled route keeps its original error.
          await route.abort().catch((abortError: unknown) => {
            readErrors.push(abortError);
          });
          throw error;
        }
      })(),
    );
  const removeEmptyWorkbenchFixture = async () => {
    captureReads = false;
    releaseHeldRead();
    while (pendingReads.size > 0) await Promise.all([...pendingReads]);
    if (routeInstalled) {
      heldReadDrainedBeforeUnroute = heldReadCompleted;
      try {
        await page.unroute(workbenchUrl, emptyWorkbenchHandler);
        routeInstalled = false;
      } catch (error) {
        readErrors.push(error);
      }
    }
    if (readErrors.length > 0)
      throw new AggregateError(readErrors, 'Empty workbench fixture failed');
  };
  let testFailed = false;
  try {
    await page.route(workbenchUrl, emptyWorkbenchHandler);
    routeInstalled = true;
    await page.goto('/');
    await page
      .locator('.resume-work')
      .getByRole('button', { name: '新建任务', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: '开始一项工作', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    // Keep an ordinary server read in flight while the creation form is open.
    observeRead(
      page
        .evaluate(async () => {
          const response = await fetch('/api/v1/workbench?fixture=empty-workbench-drain');
          return { status: response.status, data: await response.json() };
        })
        .then(({ status, data }) => {
          expect(status).toBe(200);
          expect(data).toMatchObject({ projects: [], tasks: [], runs: [], results: [] });
          heldReadCompleted = true;
        }),
    );
    await heldReadReached;
    expect(heldReadCompleted).toBe(false);
    await removeEmptyWorkbenchFixture();
    expect(heldReadDrainedBeforeUnroute).toBe(true);
    await page.getByLabel('要做什么').fill('浏览器中创建的真实任务');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '浏览器中创建的真实任务', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: '任务评论', exact: true })
      .fill('这条评论应当在刷新后仍然存在。');
    await page.getByRole('button', { name: '发送评论', exact: true }).click();
    await expect(page.getByText('这条评论应当在刷新后仍然存在。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('这条评论应当在刷新后仍然存在。', { exact: true })).toBeVisible();
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    try {
      await removeEmptyWorkbenchFixture();
    } catch (error) {
      if (!testFailed) throw error;
      test.info().annotations.push({
        type: 'fixture-cleanup-error',
        description:
          error instanceof AggregateError
            ? error.errors.map((readError: unknown) => String(readError)).join('\n')
            : String(error),
      });
    }
  }
});
test('模拟等待回复，响应后结束但不完成任务', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('演示场景').selectOption('waiting_input');
  await page.getByRole('button', { name: '开始模拟', exact: true }).click();
  await expect(page.getByText('模拟执行等待你的回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '回复模拟执行', exact: true }).fill('先处理交互');
  await page.getByRole('button', { name: '发送执行回复', exact: true }).click();
  await expect(page.getByText('本次模拟已结束', { exact: true })).toBeVisible();
  await expect(page.locator('.task-title .badge')).toHaveText('进行中');
  await page.screenshot({ path: 'artifacts/02-task-workspace.png', fullPage: true });
});
test('模拟停止会等待真实适配器确认', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '开始模拟', exact: true }).click();
  await page.getByRole('button', { name: '停止模拟', exact: true }).click();
  await expect(page.getByText('模拟执行已停止', { exact: true })).toBeVisible();
});
test('文字成果、反馈与标记完成，不需要验收表', async ({ page }) => {
  await page.goto('/tasks/task-24');
  await page.getByRole('button', { name: '分享成果', exact: true }).click();
  await page.getByLabel('成果标题').fill('已保存的导出方案');
  await page.getByLabel('这次做了什么').fill('这里是团队自己的成果说明，不是模拟模型输出。');
  await page.getByRole('dialog').getByRole('button', { name: '分享成果', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已保存的导出方案 · 当前成果' })).toBeVisible();
  await page.getByRole('textbox', { name: '成果反馈', exact: true }).fill('继续补充文件命名说明');
  await page.getByRole('button', { name: '发送反馈', exact: true }).click();
  await expect(page.getByText('继续补充文件命名说明', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(page.locator('.result-eyebrow .badge')).toHaveText('已完成');
  await page.reload();
  await expect(page.getByText('继续补充文件命名说明', { exact: true })).toBeVisible();
});
test('示例预览筛选与 CSV 导出可操作', async ({ page }) => {
  await page.goto('/results/result-orders');
  await page.getByRole('combobox', { name: '订单状态', exact: true }).selectOption('pending');
  await expect(page.getByText('共 2 条演示订单', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('orders-2026-09-demo.csv');
  await page.screenshot({ path: 'artifacts/03-results.png', fullPage: true });
});
test('命令搜索、主题和密度偏好在刷新后保留', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '全局搜索' })).toBeFocused();
  await page.getByRole('textbox', { name: '全局搜索' }).fill('浏览器中创建');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /浏览器中创建的真实任务/ })
    .click();
  await expect(
    page.getByRole('heading', { name: '浏览器中创建的真实任务', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '切换浅色模式' }).click();
  await page.getByRole('button', { name: '切换舒适密度' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'artifacts/04-dark-workspace.png', fullPage: true });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '开始一项工作' })).toBeVisible();
  await page.getByLabel('要做什么').fill('通过命令面板创建的任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '通过命令面板创建的任务', exact: true }),
  ).toBeVisible();
});
test('窄屏没有整个页面的横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    '/',
    '/projects/project-orders',
    '/tasks/task-24',
    '/results/result-orders',
  ]) {
    await page.goto(path);
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.getByRole('button', { name: '展开项目导航', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '项目导引栏' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '展开项目导航', exact: true })).toBeFocused();
    expect((await page.locator('.workbench-main').boundingBox())?.width).toBeGreaterThan(300);
    if (path === '/tasks/task-24') {
      await page.getByRole('button', { name: '代码与成果', exact: true }).click();
      await expect(page.getByRole('tab', { name: '代码变更', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '讨论', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '任务评论', exact: true })).toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.screenshot({ path: 'artifacts/05-mobile.png', fullPage: true });
});
test('任务草稿随路由保留，阅读历史不被新记录打断', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('要做什么').fill('W1 草稿与阅读位置检查');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'W1 草稿与阅读位置检查', exact: true }),
  ).toBeVisible();
  const taskId = new URL(page.url()).pathname.split('/').at(-1)!;
  const composer = page.getByRole('textbox', { name: '任务评论', exact: true });
  await composer.fill('尚未发送的讨论，只属于这个任务');
  await page.getByRole('button', { name: '上下文', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务上下文', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '上下文', exact: true })).toBeFocused();
  await page.locator('.navigation-rail').getByRole('link', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '搜索与快捷操作', exact: true }).click();
  await page.getByRole('textbox', { name: '全局搜索' }).fill('W1 草稿与阅读位置检查');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /W1 草稿与阅读位置检查/ })
    .click();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.route(`**/tasks/${taskId}/messages`, (route) => route.abort('failed'));
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.locator('.toast.error')).toBeVisible();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.unroute(`**/tasks/${taskId}/messages`);
  const addMessage = async (body: string) => {
    const response = await page.request.post(`/api/v1/tasks/${taskId}/messages`, {
      headers: { 'X-Hexu-Client': 'web', 'Idempotency-Key': crypto.randomUUID() },
      data: { body, resultId: null },
    });
    expect(response.status()).toBe(201);
  };
  for (let i = 0; i < 10; i++)
    await addMessage(`历史记录 ${i}\n` + '这是一段用于阅读位置检查的虚构讨论。\n'.repeat(10));
  await expect(page.locator('.message')).toHaveCount(10);
  const history = page.getByLabel('任务讨论记录', { exact: true });
  await history.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await addMessage('来自其他参与者的新记录');
  await expect(
    page.getByRole('button', { name: '有新记录 · 回到最新', exact: true }),
  ).toBeVisible();
  expect(await history.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  await page.getByRole('button', { name: '有新记录 · 回到最新', exact: true }).click();
  await expect(page.getByText('来自其他参与者的新记录', { exact: true })).toBeInViewport();
  await expect(composer).toHaveValue('尚未发送的讨论，只属于这个任务');
  await page.getByRole('button', { name: '收起成果面板', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开成果面板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开成果面板', exact: true }).click();
});

test('评论按文本呈现，不执行 HTML', async ({ page }) => {
  await page.goto('/tasks/task-24');
  const payload = '<img src=x onerror="window.__hexuXss=1">';
  await page.getByRole('textbox', { name: '任务评论', exact: true }).fill(payload);
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => '__hexuXss' in window)).toBe(false);
});

test('被新快照取消的旧响应不卸载任务编辑器或丢失未保存内容', async ({ page }) => {
  const headers = () => ({ 'x-hexu-client': 'web', 'idempotency-key': crypto.randomUUID() });
  const created = await page.request.post('/api/v1/spaces/space-demo/tasks', {
    headers: headers(),
    data: { title: '读取取消的编辑保留检查' },
  });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button', { name: '编辑工作说明', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑工作说明', exact: true });
  await editor.getByLabel('说明', { exact: true }).fill('不能被已取消的读取清掉的草稿');
  await page.evaluate((path) => {
    const state = { armed: true, pending: false, cancelled: false };
    Object.assign(window, { __hexuCancelledRead: state });
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const response = await fetch(input, options);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const signal = options?.signal;
      if (state.armed && url.pathname === path && signal) {
        state.armed = false;
        // Model headers arriving before an abort while the JSON body is still pending.
        response.json = () =>
          new Promise((_, reject) => {
            state.pending = true;
            const cancel = () => {
              state.cancelled = true;
              reject(new DOMException('Read cancelled', 'AbortError'));
            };
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          });
      }
      return response;
    };
  }, `/api/v1/tasks/${task.id}`);
  const update = async (body: string) => {
    const response = await page.request.post(`/api/v1/tasks/${task.id}/messages`, {
      headers: headers(),
      data: { body },
    });
    expect(response.ok()).toBe(true);
  };
  await update('第一次快照更新');
  await page.waitForFunction(
    () =>
      (window as Window & { __hexuCancelledRead?: { pending: boolean } }).__hexuCancelledRead
        ?.pending,
  );
  await update('第二次快照更新');
  await page.waitForFunction(
    () =>
      (window as Window & { __hexuCancelledRead?: { cancelled: boolean } }).__hexuCancelledRead
        ?.cancelled,
  );
  await expect(
    page.locator('.message-content').getByText('第二次快照更新', { exact: true }),
  ).toBeAttached();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('说明', { exact: true })).toHaveValue(
    '不能被已取消的读取清掉的草稿',
  );
});
