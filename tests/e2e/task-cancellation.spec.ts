import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { branchResultFixture } from '../helpers/branch-results.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import { executionHash } from '../../packages/db/src/node-execution.js';
import { isActiveRun } from '../../packages/domain/src/index.js';
import type { Task, Workbench } from '../../packages/contracts/src/index.js';
import type {
  ExecutionEvent,
  ExecutionPolicy,
} from '../../packages/contracts/src/node-execution.js';
import type {
  AssistanceDetail,
  AssistancePreview,
} from '../../packages/contracts/src/assistance.js';
import type { TaskCompletionHistory } from '../../packages/contracts/src/task-completion-history.js';

const origin = 'http://127.0.0.1:4341';
type Action = 'cancel' | 'complete';
const dialog = (page: Page, action: Action = 'cancel') =>
  page.getByRole('dialog', {
    name: action === 'cancel' ? '取消任务' : '标记任务完成',
    exact: true,
  });
const choice = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('checkbox', { name: '同时请求停止当前执行' });
const confirm = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', {
    name: action === 'cancel' ? '确认取消任务' : '标记完成',
    exact: true,
  });
const back = (page: Page, action: Action = 'cancel') =>
  dialog(page, action).getByRole('button', {
    name: action === 'cancel' ? '返回' : '取消',
    exact: true,
  });
const entry = (page: Page, action: Action = 'cancel') =>
  page.locator(action === 'cancel' ? '.w1-task-scope' : 'main').getByRole('button', {
    name: action === 'cancel' ? '取消任务…' : '标记完成',
    exact: true,
  });
const status = (page: Page) => page.locator('.task-title .badge');
const conflictText = '任务已更新，本次取消确认已失效。请返回后查看当前任务，再重新选择取消任务。';
const executionText = '活动执行已变化，本次取消确认已失效。请返回后重新确认。';
const noActiveText = '当前没有活动执行，本次只取消任务，不请求停止执行。';

async function fixture(activeRun = true) {
  const f = await branchResultFixture(origin);
  try {
    // Real team/control operations and explicit node protocol substitutes only.
    // No local browser, executor process, credentials, or paid model is launched here.
    const source = f.begin();
    source.start();
    source.finish('failed', '取消前保留的真实协议执行记录');
    const saved = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '取消前保存的成果',
      body: 'CANCELLATION_RETAINED_RESULT',
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const { resultId, revisionId } = saved.json() as { resultId: string; revisionId: string };
    const version = f.as(() => new ResultRevisions(f.api.store).get(resultId, revisionId));
    const message = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: 'CANCELLATION_RETAINED_DISCUSSION',
    });
    expect(message.statusCode, message.body).toBe(201);
    const active = activeRun ? f.begin(1, 'codex') : null;
    active?.start();
    const grant = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    return { ...f, source, active, version };
  } catch (error) {
    try {
      await f.close();
    } catch (cause) {
      reportCleanup([cause], true, '任务取消夹具初始化清理失败');
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const taskState = (f: Fixture) => f.as(() => f.api.store.getTask(f.task.id));
const runs = (f: Fixture) => f.as(() => f.api.store.runs(f.task.id));
const content = (f: Fixture) =>
  f.as(() => {
    const revisions = new ResultRevisions(f.api.store);
    return {
      messages: f.api.store.messages(f.task.id),
      result: f.api.store.result(f.version.resultId),
      versions: revisions
        .list(f.version.resultId)
        .map((v) => revisions.get(f.version.resultId, v.id)),
    };
  });
const taskEvents = (f: Fixture) =>
  f.api.store.db
    .prepare("SELECT kind FROM outbox WHERE task_id=? AND kind='task.updated' ORDER BY sequence")
    .all(f.task.id);
async function history(f: Fixture) {
  const response = await f.api.call(`tasks/${f.task.id}/completion-history?limit=10`, f.alice);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as TaskCompletionHistory).items;
}
async function role(f: Fixture, value: 'edit' | 'view' | null) {
  const response = await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
    role: value,
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function command(f: Fixture, action: Action | 'reopen' | 'start') {
  const response = await f.api.call(`tasks/${f.task.id}/${action}`, f.alice, {
    expectedRevision: taskState(f).revision,
    activeRunAction: 'keep',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function patch(
  f: Fixture,
  changes: { title?: string; description?: string; attention?: string },
) {
  const response = await f.api.call(
    `tasks/${f.task.id}`,
    f.alice,
    {
      expectedRevision: taskState(f).revision,
      ...changes,
    },
    randomUUID(),
    'PATCH',
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Task;
}
async function open(page: Page, f: Fixture, theme: 'dark' | 'light' = 'dark') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Join the control application's registry epoch, then provide fresh live evidence.
  for (const node of f.ns) {
    const headers = { authorization: `Bearer ${node.token}`, 'x-hexu-runner': '1' };
    const hello = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/hello',
      headers,
      payload: { protocol: 1, connectionId: node.connection },
    });
    expect(hello.statusCode, hello.body).toBe(200);
    const at = new Date().toISOString();
    const sync = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/sync',
      headers,
      payload: {
        connectionId: node.connection,
        sequence: 2,
        snapshot: { capturedAt: at, workspaces: [{ ...node.summary, capturedAt: at }] },
      },
    });
    expect(sync.statusCode, sync.body).toBe(200);
  }
  f.active?.send('unknown');
  f.active?.send('running');
  await f.api.app.listen({ port: 4341, host: '127.0.0.1' });
  await page.context().addCookies(
    f.bob.cookie.split('; ').map((cookie) => {
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
    ({ userId, spaceId, theme }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', theme);
    },
    { userId: f.bob.user.id, spaceId: f.bob.spaceId, theme },
  );
  await page.goto(`${origin}/tasks/${f.task.id}`);
  await expect(entry(page)).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function openDialog(page: Page, action: Action = 'cancel', active = true) {
  await entry(page, action).click();
  await expect(dialog(page, action)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  if (active) await expect(choice(page, action)).toBeChecked();
  else {
    await expect(choice(page, action)).toHaveCount(0);
    await expect(dialog(page, action)).toContainText(noActiveText);
  }
}
async function dismissNotice(page: Page) {
  const close = page.getByRole('button', { name: '关闭通知', exact: true });
  if (await close.count()) await close.click();
}
// A real text-assistance protocol Run does not change Task status/revision. It is
// useful evidence that the cancellation guard observes all Runs, not only coding.
async function assistance(f: Fixture) {
  // Branch-bound workspaces are deliberately excluded from ordinary assistance
  // options. Pair a dedicated protocol node instead of weakening that boundary.
  const token = randomBytes(32).toString('base64url'),
    workspace = randomUUID(),
    connection = randomUUID();
  const pairing = f.as(() => f.nodes.createPairing(f.project.id, randomUUID()));
  const paired = f.nodes.pair({
    code: pairing.code!,
    nodeToken: token,
    clientId: randomUUID(),
    projectId: f.project.id,
    name: '取消测试文本协助节点',
    platform: 'linux',
    arch: 'x64',
    workspaces: [{ id: workspace, name: '明确授权的协议目录' }],
  });
  const node = { ...paired, token, workspace, connection };
  const runner = async (path: string, payload: unknown) => {
    const response = await f.api.app.inject({
      method: 'POST',
      url: `/runner/v1/${path}`,
      headers: { authorization: `Bearer ${node.token}`, 'x-hexu-runner': '1' },
      payload: payload as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  await runner('hello', { protocol: 1, connectionId: node.connection });
  const at = new Date().toISOString();
  await runner('sync', {
    connectionId: node.connection,
    sequence: 1,
    snapshot: {
      capturedAt: at,
      workspaces: [
        {
          id: node.workspace,
          state: 'available',
          capturedAt: at,
          staged: 0,
          modified: 0,
          untracked: 0,
          conflicts: 0,
        },
      ],
    },
  });
  const policy: ExecutionPolicy = {
    grantId: randomUUID(),
    tool: 'claude-code',
    textAssistance: true,
    model: 'cancellation-protocol-fixture',
    mode: 'edit',
    workspaceIds: [node.workspace],
    timeoutSeconds: 30,
    maxTurns: 8,
    maxBudgetUsd: 1,
    toolVersion: 'protocol fixture only',
  };
  // Use the current app registry, since open() replaced the fixture registry epoch.
  await runner('execution-policy', { connectionId: node.connection, policy });
  const message = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
    body: '明确选择的协议材料',
  });
  expect(message.statusCode, message.body).toBe(201);
  const messageId = message.json().id as string;
  const previewResponse = await f.api.call(
    `tasks/${f.task.id}/messages/${messageId}/assistance-preview`,
    f.alice,
  );
  expect(previewResponse.statusCode, previewResponse.body).toBe(200);
  const preview = previewResponse.json() as AssistancePreview;
  const created = await f.api.call(`tasks/${f.task.id}/ai-assistances`, f.alice, {
    sourceMessageId: messageId,
    expectedSourceHash: preview.sourceHash,
    expectedTaskRevision: preview.taskRevision,
    range: { start: 0, end: 4 },
    question: '只分析所选协议材料',
    nodeId: node.nodeId,
    policyHash: executionHash(policy),
    confirmMaterial: true,
    confirmExecution: true,
  });
  expect(created.statusCode, created.body).toBe(201);
  const run = (created.json() as AssistanceDetail).assistance.ai!.run;
  const poll = await runner('execution-poll', { connectionId: node.connection });
  const dispatch = poll.json().command as { id: string; generation: string; runId: string };
  expect(dispatch.runId).toBe(run.id);
  let sequence = 0;
  const send = (kind: ExecutionEvent['kind'], result: ExecutionEvent['result'] = null) =>
    runner('execution-event', {
      dispatchId: dispatch.id,
      generation: dispatch.generation,
      event: {
        sequence: ++sequence,
        kind,
        text: '取消测试协议证据',
        result,
        terminationConfirmed: kind === 'terminal',
      },
    });
  await send('accepted');
  const permit = await runner('execution-permit', {
    connectionId: node.connection,
    dispatchId: dispatch.id,
    generation: dispatch.generation,
  });
  expect(permit.json().allowed).toBe(true);
  await send('running');
  return { run, send };
}

function reportCleanup(errors: unknown[], failed: boolean, message: string) {
  if (!errors.length) return;
  if (!failed) throw new AggregateError(errors, message);
  test
    .info()
    .annotations.push({ type: 'cleanup failure', description: errors.map(String).join('\n') });
}
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hold(page: Page, pattern: string, beforeFetch = false) {
  const requestGate = gate(),
    responseGate = gate();
  if (!beforeFetch) requestGate.resolve();
  let capturing = true;
  const captured: { method: string; body: unknown; status?: number }[] = [];
  const pending: Promise<void>[] = [],
    errors: unknown[] = [];
  const handler = async (route: Route) => {
    if (!capturing) return route.continue();
    const record = {
      method: route.request().method(),
      body: route.request().postDataJSON(),
      status: undefined as number | undefined,
    };
    captured.push(record);
    const work = (async () => {
      await requestGate.promise;
      const response = await route.fetch();
      record.status = response.status();
      await responseGate.promise;
      await route.fulfill({ response });
    })();
    // Observe failures immediately, including before the gate's expected phase.
    const observed = work.catch((error) => {
      errors.push(error);
    });
    pending.push(observed);
    await observed;
  };
  await page.route(pattern, handler);
  const check = () => {
    if (errors.length) throw new AggregateError(errors, '任务取消延迟请求失败');
  };
  return {
    captured,
    async reached(status?: number) {
      await expect
        .poll(() => {
          check();
          return status === undefined
            ? captured.length
            : captured.filter((item) => item.status === status).length;
        })
        .toBeGreaterThan(0);
    },
    stopCapture() {
      capturing = false;
    },
    releaseRequest() {
      requestGate.resolve();
    },
    async releaseAndDrain() {
      capturing = false;
      requestGate.resolve();
      responseGate.resolve();
      await Promise.all(pending);
      check();
    },
    async dispose(failed: boolean) {
      const cleanup: unknown[] = [];
      this.stopCapture();
      try {
        await this.releaseAndDrain();
      } catch (cause) {
        cleanup.push(cause);
      }
      // Stop capture, then release/drain, then unroute. Never orphan a held Route.
      try {
        await page.unroute(pattern, handler);
      } catch (cause) {
        cleanup.push(cause);
      }
      reportCleanup(cleanup, failed, '任务取消延迟请求清理失败');
    },
  };
}
type Held = Awaited<ReturnType<typeof hold>>;
async function close(page: Page, f: Fixture, failed: boolean, held: Held[] = []) {
  const errors: unknown[] = [];
  for (const item of held) {
    try {
      await item.dispose(failed || errors.length > 0);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const action of [
    () => page.unrouteAll({ behavior: 'wait' }),
    () => page.context().close(),
    () => f.close(),
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  reportCleanup(errors, failed, '任务取消团队服务清理失败');
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const initialStatus of ['todo', 'in_progress', 'done'] as const) {
  test(`无活动执行的${initialStatus}任务明确取消一次、清除关注并保留讨论成果，随后可重开`, async ({
    page,
  }) => {
    const f = await fixture(false);
    let failed = false;
    try {
      if (initialStatus === 'todo') await command(f, 'reopen');
      if (initialStatus === 'done') await command(f, 'complete');
      await patch(f, { description: '取消仍须保留的任务说明', attention: '取消前的关注事项' });
      if (initialStatus === 'done') {
        const archived = await f.api.call(`projects/${f.project.id}/lifecycle`, f.alice, {
          action: 'archive',
          expectedRevision: f.as(() => f.api.store.project(f.project.id)).revision,
          activeRunAction: 'keep',
        });
        expect(archived.statusCode, archived.body).toBe(200);
      }
      await open(page, f);
      const before = taskState(f),
        originalRuns = runs(f),
        originalContent = content(f),
        originalHistory = await history(f),
        originalEvents = taskEvents(f);
      expect(before.status).toBe(initialStatus);
      expect(originalRuns.every((run) => !isActiveRun(run.state))).toBe(true);
      const writes: unknown[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST')
          writes.push({
            path: new URL(request.url()).pathname,
            body: request.postDataJSON(),
          });
      });
      if (initialStatus === 'todo') {
        for (const dismiss of ['return', 'escape', 'close'] as const) {
          await openDialog(page, 'cancel', false);
          if (dismiss === 'return') await back(page).click();
          else if (dismiss === 'escape') await page.keyboard.press('Escape');
          else await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
          await expect(dialog(page)).toHaveCount(0);
          await expect(entry(page)).toBeFocused();
        }
        expect(writes).toEqual([]);
        expect(taskState(f)).toEqual(before);
        expect(taskEvents(f)).toEqual(originalEvents);
        expect(await history(f)).toEqual(originalHistory);
      }
      await openDialog(page, 'cancel', false);
      await expect(dialog(page)).toContainText('讨论和成果会保留');
      await expect(dialog(page)).toContainText(before.title);
      await confirm(page).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(status(page)).toHaveText('已取消');
      await expect(entry(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
      expect(writes).toEqual([
        {
          path: `/api/v1/tasks/${f.task.id}/cancel`,
          body: { expectedRevision: before.revision, activeRunAction: 'keep' },
        },
      ]);
      expect(taskState(f)).toMatchObject({
        ...before,
        status: 'cancelled',
        attention: null,
        revision: before.revision + 1,
        updatedAt: expect.any(String),
      });
      expect(taskEvents(f)).toHaveLength(originalEvents.length + 1);
      const cancelled = await history(f);
      expect(cancelled).toHaveLength(originalHistory.length + 1);
      expect(cancelled[0]).toMatchObject({
        action: 'cancel',
        actorId: f.bob.user.id,
        taskRevision: before.revision + 1,
      });
      expect(cancelled.slice(1)).toEqual(originalHistory);
      expect(runs(f)).toEqual(originalRuns);
      expect(content(f)).toEqual(originalContent);
      await page.getByRole('button', { name: '重新打开', exact: true }).click();
      await expect(status(page)).toHaveText('待处理');
      await expect(entry(page)).toBeEnabled();
      expect(taskState(f)).toMatchObject({ status: 'todo', revision: before.revision + 2 });
      expect((await history(f)).map((item) => item.action)).toEqual([
        'reopen',
        'cancel',
        ...originalHistory.map((item) => item.action),
      ]);
      expect(runs(f)).toEqual(originalRuns);
      expect(content(f)).toEqual(originalContent);
      // The new entry belongs to Task scope only, including on fixed result versions.
      await page.goto(`${origin}/results/${f.version.resultId}/versions/${f.version.id}`);
      await expect(page.locator('.written-result')).toContainText(f.version.body);
      await expect(page.getByRole('button', { name: '取消任务…', exact: true })).toHaveCount(0);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed);
    }
  });
}

test('辅助取消入口可见可点击，未知普通执行与停止中的AI协助全部计入，keep保留原执行', async ({
  page,
}) => {
  const f = await fixture();
  let failed = false;
  try {
    await open(page, f);
    const assist = await assistance(f);
    f.active!.send('unknown');
    const stopped = await f.api.call(`runs/${assist.run.id}/stop`, f.alice, {});
    expect(stopped.statusCode, stopped.body).toBe(200);
    const before = taskState(f),
      originalRuns = runs(f),
      originalContent = content(f);
    expect(originalRuns.find((run) => run.id === f.active!.run.id)).toMatchObject({
      state: 'running',
      observation: 'unknown',
    });
    expect(originalRuns.find((run) => run.id === assist.run.id)).toMatchObject({
      purpose: 'assist',
      state: 'stopping',
      node: { terminationConfirmed: false },
    });
    await expect(entry(page)).toHaveClass(/\bghost\b/);
    await entry(page).scrollIntoViewIfNeeded();
    await expect(entry(page)).toBeInViewport({ ratio: 1 });
    expect(
      await entry(page).evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/193-task-cancellation-dark.png' });
    await openDialog(page);
    await expect(dialog(page)).toContainText('当前有 2 项活动执行');
    await expect(dialog(page)).toContainText('请求停止也不等于已终止');
    await choice(page).uncheck();
    const reply = page.waitForResponse((response) =>
      response.url().endsWith(`/tasks/${f.task.id}/cancel`),
    );
    await confirm(page).click();
    const accepted = await reply;
    expect(accepted.request().postDataJSON()).toEqual({
      expectedRevision: before.revision,
      activeRunAction: 'keep',
    });
    expect(accepted.status()).toBe(200);
    await expect(dialog(page)).toHaveCount(0);
    await expect(status(page)).toHaveText('已取消');
    await expect(page.locator('.w1-run-bar')).toContainText('连接未知 · 待核对');
    expect(runs(f)).toEqual(originalRuns);
    expect(content(f)).toEqual(originalContent);
    await page.getByRole('button', { name: '重新打开', exact: true }).click();
    await expect(status(page)).toHaveText('待处理');
    expect(runs(f)).toEqual(originalRuns);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed);
  }
});

test('窄屏浅色取消默认请求停止，忙碌不重发，节点收到停止请求后仍须终止证据', async ({ page }) => {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, f, 'light');
    const before = taskState(f),
      originalRuns = runs(f),
      originalContent = content(f);
    await openDialog(page);
    for (const control of [
      dialog(page).getByRole('heading', { name: '取消任务', exact: true }),
      choice(page),
      back(page),
      confirm(page),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/194-task-cancellation-mobile-light.png' });
    const accepted = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/cancel`, true);
    held.push(accepted);
    await confirm(page).click();
    await accepted.reached();
    await expect(confirm(page)).toBeDisabled();
    await expect(choice(page)).toBeDisabled();
    await expect(back(page)).toBeDisabled();
    await confirm(page).evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await page.keyboard.press('Escape');
    await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    expect(accepted.captured).toHaveLength(1);
    expect(taskState(f)).toEqual(before);
    accepted.releaseRequest();
    await accepted.reached(200);
    await expect(status(page)).toHaveText('已取消');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    expect(accepted.captured).toEqual([
      {
        method: 'POST',
        body: { expectedRevision: before.revision, activeRunAction: 'stop' },
        status: 200,
      },
    ]);
    const stopping = runs(f).find((run) => run.id === f.active!.run.id)!;
    expect(stopping).toMatchObject({ state: 'stopping', node: { terminationConfirmed: false } });
    const node = f.ns[1]!;
    const poll = await f.api.app.inject({
      method: 'POST',
      url: '/runner/v1/execution-poll',
      headers: { authorization: `Bearer ${node.token}`, 'x-hexu-runner': '1' },
      payload: { connectionId: node.connection },
    });
    expect(poll.statusCode, poll.body).toBe(200);
    expect(poll.json()).toMatchObject({
      stopRequested: true,
      command: { runId: f.active!.run.id },
    });
    await accepted.releaseAndDrain();
    await expect(dialog(page)).toHaveCount(0);
    expect(runs(f).find((run) => run.id === f.source.run.id)).toEqual(
      originalRuns.find((run) => run.id === f.source.run.id),
    );
    expect(content(f)).toEqual(originalContent);
    // A new page still sees stopping, never an invented terminal acknowledgement.
    await page.reload();
    await expect(status(page)).toHaveText('已取消');
    await expect(page.locator('.w1-run-bar')).toContainText('正在停止');
    await expect(page.locator('.w1-run-bar')).not.toContainText('节点执行已停止');
    expect(runs(f).find((run) => run.id === stopping.id)).toMatchObject({
      state: 'stopping',
      node: { terminationConfirmed: false },
    });
    f.active!.finish('cancelled', '协议节点明确确认执行进程已结束');
    await expect(page.locator('.w1-run-bar')).toContainText('节点执行已停止');
    expect(runs(f).find((run) => run.id === stopping.id)).toMatchObject({
      state: 'cancelled',
      node: { terminationConfirmed: true },
    });
    expect(runs(f)).toHaveLength(originalRuns.length);
    expect(taskState(f).revision).toBe(before.revision + 1);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});

test('取消确认随当前降权或撤权清除，重授不复活且直接API写入同样拒绝', async ({ page }) => {
  const f = await fixture();
  let failed = false;
  try {
    await open(page, f);
    const before = taskState(f),
      originalRuns = runs(f),
      originalContent = content(f),
      originalHistory = await history(f);
    await openDialog(page);
    await choice(page).uncheck();
    await role(f, 'view');
    await expect(dialog(page)).toHaveCount(0);
    await expect(entry(page)).toBeDisabled();
    const denied = await f.api.call(`tasks/${f.task.id}/cancel`, f.bob, {
      expectedRevision: before.revision,
      activeRunAction: 'stop',
    });
    expect(denied.statusCode, denied.body).toBe(403);
    await role(f, 'edit');
    await expect(entry(page)).toBeEnabled();
    await expect(dialog(page)).toHaveCount(0);
    await openDialog(page);
    await role(f, null);
    await expect(dialog(page)).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: '当前无法访问此任务', exact: true }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(before.title);
    await expect(page.locator('body')).not.toContainText('CANCELLATION_RETAINED_DISCUSSION');
    const revoked = await f.api.call(`tasks/${f.task.id}/cancel`, f.bob, {
      expectedRevision: before.revision,
      activeRunAction: 'keep',
    });
    expect([403, 404]).toContain(revoked.statusCode);
    await role(f, 'edit');
    await expect(entry(page)).toBeEnabled();
    await expect(dialog(page)).toHaveCount(0);
    expect(taskState(f)).toEqual(before);
    expect(runs(f)).toEqual(originalRuns);
    expect(content(f)).toEqual(originalContent);
    expect(await history(f)).toEqual(originalHistory);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed);
  }
});

test('当前取消API真实403先于Workbench权限更新时也关闭确认', async ({ page }) => {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await open(page, f);
    const before = taskState(f),
      originalRuns = runs(f),
      originalHistory = await history(f);
    await openDialog(page);
    const workbench = await hold(page, `${origin}/api/v1/workbench`, true);
    held.push(workbench);
    await role(f, 'view');
    await workbench.reached();
    await expect(confirm(page)).toBeEnabled();
    const response = page.waitForResponse(
      (reply) => reply.url().endsWith(`/tasks/${f.task.id}/cancel`) && reply.status() === 403,
    );
    await confirm(page).click();
    await (await response).finished();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('任务当前不可编辑，已关闭本次取消确认');
    await workbench.releaseAndDrain();
    await expect(entry(page)).toBeDisabled();
    await role(f, 'edit');
    await expect(entry(page)).toBeEnabled();
    await expect(dialog(page)).toHaveCount(0);
    expect(taskState(f)).toEqual(before);
    expect(runs(f)).toEqual(originalRuns);
    expect(await history(f)).toEqual(originalHistory);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});

test('取消基线固定Task和修订，真实冲突不可自动重基或替换原停止选择', async ({ page }) => {
  const f = await fixture();
  let failed = false;
  try {
    await open(page, f);
    const before = taskState(f),
      originalRuns = runs(f),
      originalHistory = await history(f);
    await openDialog(page);
    await choice(page).uncheck();
    const updated = await patch(f, { title: '当前任务：请重新确认取消' });
    await expect(dialog(page).getByRole('alert')).toHaveText(conflictText);
    await expect(dialog(page)).toContainText(before.title);
    await expect(choice(page)).not.toBeChecked();
    await expect(choice(page)).toBeDisabled();
    await expect(confirm(page)).toBeDisabled();
    await expect(back(page)).toBeEnabled();
    const events = taskEvents(f);
    const conflict = await f.api.call(`tasks/${f.task.id}/cancel`, f.bob, {
      expectedRevision: before.revision,
      activeRunAction: 'stop',
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(taskEvents(f)).toEqual(events);
    expect(taskState(f)).toEqual(updated);
    expect(runs(f)).toEqual(originalRuns);
    expect(await history(f)).toEqual(originalHistory);
    await back(page).click();
    await expect(page.locator('.task-title h1')).toHaveText(updated.title);
    await openDialog(page);
    await expect(dialog(page)).toContainText(updated.title);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await choice(page).uncheck();
    const response = page.waitForResponse((reply) =>
      reply.url().endsWith(`/tasks/${f.task.id}/cancel`),
    );
    await confirm(page).click();
    expect((await response).request().postDataJSON()).toEqual({
      expectedRevision: updated.revision,
      activeRunAction: 'keep',
    });
    await expect(status(page)).toHaveText('已取消');
    expect(taskState(f).revision).toBe(updated.revision + 1);
    expect(runs(f)).toEqual(originalRuns);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed);
  }
});

test('无活动取消确认观察到新的AI协助即永久失效，不自动添加停止选择或发送命令', async ({ page }) => {
  const f = await fixture(false);
  const held: Held[] = [];
  let failed = false;
  try {
    await open(page, f);
    const before = taskState(f),
      originalHistory = await history(f);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') writes.push(request.url());
    });
    await openDialog(page, 'cancel', false);
    const assist = await assistance(f);
    expect(taskState(f)).toEqual(before);
    expect(runs(f).find((run) => run.id === assist.run.id)).toMatchObject({
      purpose: 'assist',
      state: 'running',
    });
    await expect(dialog(page).getByRole('alert').filter({ hasText: executionText })).toBeVisible();
    await expect(dialog(page)).toContainText('当前有 1 项活动执行');
    await expect(choice(page)).toHaveCount(0);
    await expect(confirm(page)).toBeDisabled();
    await assist.send('terminal', 'succeeded');
    // A real later SSE refresh proves the invalidation is sticky after the Run ends.
    const message = await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
      body: '协助已结束，旧取消确认仍不可提交',
    });
    expect(message.statusCode, message.body).toBe(201);
    await expect(page.locator('main')).toContainText('协助已结束，旧取消确认仍不可提交');
    await expect(dialog(page).getByRole('alert').filter({ hasText: executionText })).toBeVisible();
    await expect(choice(page)).toHaveCount(0);
    await expect(confirm(page)).toBeDisabled();
    expect(writes).toEqual([]);
    expect(taskState(f)).toEqual(before);
    expect(await history(f)).toEqual(originalHistory);
    await back(page).click();
    await openDialog(page, 'cancel', false);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    const workbench = await hold(page, `${origin}/api/v1/workbench`, true);
    held.push(workbench);
    const unseen = await assistance(f);
    await workbench.reached();
    // The current dialog has not observed this Run. Its original consent still
    // sends keep, which must never be silently upgraded to stop by the client.
    await expect(choice(page)).toHaveCount(0);
    await expect(confirm(page)).toBeEnabled();
    const response = page.waitForResponse((reply) =>
      reply.url().endsWith(`/tasks/${f.task.id}/cancel`),
    );
    await confirm(page).click();
    expect((await response).request().postDataJSON()).toEqual({
      expectedRevision: before.revision,
      activeRunAction: 'keep',
    });
    expect(runs(f).find((run) => run.id === unseen.run.id)).toMatchObject({
      purpose: 'assist',
      state: 'running',
      node: { terminationConfirmed: false },
    });
    await workbench.releaseAndDrain();
    await expect(status(page)).toHaveText('已取消');
    await expect(dialog(page)).toHaveCount(0);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});

for (const scenario of [
  { oldAction: 'complete', nextAction: 'cancel', outcome: 'success' },
  { oldAction: 'cancel', nextAction: 'complete', outcome: 'success' },
  { oldAction: 'cancel', nextAction: 'complete', outcome: 'refusal' },
  { oldAction: 'complete', nextAction: 'cancel', outcome: 'refusal' },
] as const) {
  const { oldAction, nextAction, outcome } = scenario;
  test(`旧${oldAction}的真实${outcome}晚回不能影响新${nextAction}确认、忙碌和通知`, async ({
    page,
  }) => {
    const f = await fixture();
    const held: Held[] = [];
    let failed = false;
    try {
      await open(page, f);
      const before = taskState(f),
        originalRuns = runs(f),
        originalContent = content(f),
        originalHistory = await history(f);
      await openDialog(page, oldAction);
      await choice(page, oldAction).uncheck();
      const old = await hold(
        page,
        `${origin}/api/v1/tasks/${f.task.id}/${oldAction}`,
        outcome === 'refusal',
      );
      held.push(old);
      await confirm(page, oldAction).click();
      await old.reached(outcome === 'success' ? 200 : undefined);
      old.stopCapture();
      await role(f, 'view');
      await expect(dialog(page, oldAction)).toHaveCount(0);
      if (outcome === 'refusal') {
        old.releaseRequest();
        await old.reached(403);
      }
      expect(old.captured).toEqual([
        {
          method: 'POST',
          body: { expectedRevision: before.revision, activeRunAction: 'keep' },
          status: outcome === 'success' ? 200 : 403,
        },
      ]);
      await role(f, 'edit');
      if (oldAction === 'cancel' && outcome === 'success') await command(f, 'reopen');
      await expect(status(page)).toHaveText(
        outcome === 'refusal' ? '进行中' : oldAction === 'complete' ? '已完成' : '待处理',
      );
      await expect(entry(page, nextAction)).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await dismissNotice(page);
      const current = taskState(f);
      await openDialog(page, nextAction);
      const newer = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/${nextAction}`, true);
      held.push(newer);
      await confirm(page, nextAction).click();
      await newer.reached();
      await expect(confirm(page, nextAction)).toBeDisabled();
      const late = page.waitForResponse((reply) =>
        reply.url().endsWith(`/tasks/${f.task.id}/${oldAction}`),
      );
      await old.releaseAndDrain();
      await (await late).finished();
      await painted(page);
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(dialog(page, nextAction)).toBeVisible();
      await expect(choice(page, nextAction)).toBeChecked();
      await expect(choice(page, nextAction)).toBeDisabled();
      await expect(confirm(page, nextAction)).toBeDisabled();
      await expect(back(page, nextAction)).toBeDisabled();
      await expect(page.locator('.toast')).toHaveCount(0);
      expect(taskState(f)).toEqual(current);
      expect(runs(f)).toEqual(originalRuns);
      newer.releaseRequest();
      await newer.reached(200);
      await newer.releaseAndDrain();
      await expect(dialog(page, nextAction)).toHaveCount(0);
      await expect(status(page)).toHaveText(nextAction === 'cancel' ? '已取消' : '已完成');
      expect(newer.captured).toEqual([
        {
          method: 'POST',
          body: { expectedRevision: current.revision, activeRunAction: 'stop' },
          status: 200,
        },
      ]);
      expect(taskState(f).revision).toBe(current.revision + 1);
      expect(runs(f).find((run) => run.id === f.active!.run.id)).toMatchObject({
        state: 'stopping',
        node: { terminationConfirmed: false },
      });
      expect(content(f)).toEqual(originalContent);
      expect((await history(f)).map((item) => item.action)).toEqual([
        nextAction,
        ...(outcome === 'success'
          ? oldAction === 'cancel'
            ? ['reopen', oldAction]
            : [oldAction]
          : []),
        ...originalHistory.map((item) => item.action),
      ]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await close(page, f, failed, held);
    }
  });
}

test('旧取消命令拥有的Workbench读取晚回不能覆盖重新授权后的新完成确认', async ({ page }) => {
  const f = await fixture();
  const held: Held[] = [];
  let failed = false;
  try {
    await open(page, f);
    const before = taskState(f),
      originalRuns = runs(f),
      originalHistory = await history(f);
    await openDialog(page);
    await choice(page).uncheck();
    const old = await hold(page, `${origin}/api/v1/tasks/${f.task.id}/cancel`);
    held.push(old);
    await confirm(page).click();
    await old.reached(200);
    await expect(status(page)).toHaveText('已取消');
    // Consume genuine SSE first, then capture the accepted command's owned refresh.
    const ownedRead = await hold(page, `${origin}/api/v1/workbench`);
    held.push(ownedRead);
    await old.releaseAndDrain();
    await ownedRead.reached(200);
    ownedRead.stopCapture();
    await role(f, 'view');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeDisabled();
    await role(f, 'edit');
    await command(f, 'reopen');
    await expect(status(page)).toHaveText('待处理');
    await dismissNotice(page);
    await openDialog(page, 'complete');
    await choice(page, 'complete').uncheck();
    const current = taskState(f);
    expect(current.revision).toBe(before.revision + 2);
    const late = page.waitForResponse(async (reply) => {
      if (!reply.url().endsWith('/api/v1/workbench') || reply.status() !== 200) return false;
      const value = (await reply.json()) as Workbench;
      return value.tasks.some(
        (task) => task.id === f.task.id && task.revision === before.revision + 1,
      );
    });
    await ownedRead.releaseAndDrain();
    await (await late).finished();
    await painted(page);
    await expect(status(page)).toHaveText('待处理');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(dialog(page, 'complete').getByRole('alert')).toHaveCount(0);
    await expect(choice(page, 'complete')).not.toBeChecked();
    await expect(choice(page, 'complete')).toBeEnabled();
    await expect(confirm(page, 'complete')).toBeEnabled();
    await expect(back(page, 'complete')).toBeEnabled();
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(taskState(f)).toEqual(current);
    expect(runs(f)).toEqual(originalRuns);
    await confirm(page, 'complete').click();
    await expect(dialog(page, 'complete')).toHaveCount(0);
    await expect(status(page)).toHaveText('已完成');
    expect(taskState(f).revision).toBe(current.revision + 1);
    expect(runs(f)).toEqual(originalRuns);
    expect((await history(f)).map((item) => item.action)).toEqual([
      'complete',
      'reopen',
      'cancel',
      ...originalHistory.map((item) => item.action),
    ]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await close(page, f, failed, held);
  }
});
