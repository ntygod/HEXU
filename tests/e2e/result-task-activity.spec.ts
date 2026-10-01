import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { branchResultFixture } from '../helpers/branch-results.js';
import type { Account } from '../helpers/team.js';
import { ResultRevisions } from '../../packages/db/src/result-revisions.js';
import { executionHash } from '../../packages/db/src/node-execution.js';
import type { Message, Run, Workbench } from '../../packages/contracts/src/index.js';
import type { ResultRevision } from '../../packages/contracts/src/results.js';
import {
  parseNodeRun,
  type ExecutionEvent,
  type ExecutionPolicy,
} from '../../packages/contracts/src/node-execution.js';

const origin = 'http://127.0.0.1:4334';
type Fixture = Awaited<ReturnType<typeof branchResultFixture>>;
const extraNodes = new WeakMap<
  Fixture,
  { token: string; connection: string; workspace: string }[]
>();
const activity = (page: Page) => page.getByRole('region', { name: '任务当前执行', exact: true });
const rows = (page: Page) => activity(page).locator('[data-run-id]');
const row = (page: Page, id: string) => activity(page).locator(`[data-run-id="${id}"]`);
const pagination = (page: Page) => page.getByRole('navigation', { name: '任务执行分页' });
const pageIds = (page: Page) =>
  rows(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('data-run-id')!));
const resultUrl = (version: ResultRevision) =>
  `${origin}/results/${version.resultId}/versions/${version.id}`;
const taskState = (f: Fixture) => f.as(() => f.api.store.getTask(f.task.id));
const runState = (f: Fixture, id: string) => f.as(() => f.api.store.run(id));

function memberResult(f: Fixture) {
  return f.as(() => {
    const result = f.api.store.createResult(
      f.task.id,
      '执行与任务完成分别记录',
      '这份成果没有质量报告或发布链接，也不代表所有执行已停止。',
      randomUUID(),
    );
    return new ResultRevisions(f.api.store).current(result);
  });
}
async function branchResult(f: Fixture) {
  const source = f.begin();
  source.start();
  source.send('output', 'PINNED_SOURCE_OUTPUT');
  source.finish('failed', 'PINNED_TERMINAL_OUTPUT');
  const response = await f.api.call(f.path() + '/results', f.alice, {
    ...(await f.draft()),
    title: '固定的失败执行说明',
    body: 'PINNED_BRANCH_VERSION_ONE',
  });
  expect(response.statusCode, response.body).toBe(201);
  const saved = response.json() as { resultId: string; revisionId: string };
  const version = f.as(() =>
    new ResultRevisions(f.api.store).get(saved.resultId, saved.revisionId),
  );
  return { source, version };
}
async function synchronizeNodes(f: Fixture) {
  // The shared fixture creates dispatches with its own registry instance. Give
  // the actual control app a real protocol handshake before its completion
  // reconcile runs, rather than silently treating that old registry epoch as live.
  for (const node of [...f.ns, ...(extraNodes.get(f) ?? [])]) {
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
      },
    });
    expect(sync.statusCode, sync.body).toBe(200);
  }
}
type LiveEvidence = { send(kind: 'unknown' | 'running'): unknown };
async function open(
  page: Page,
  f: Fixture,
  version: ResultRevision,
  account: Account = f.alice,
  live: LiveEvidence[] = [],
) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await synchronizeNodes(f);
  // The app's 250ms reconciliation can observe the fixture registry's old epoch
  // during setup or the per-node handshake. A handshake alone must NOT turn an
  // unknown process into fresh. Only explicitly live protocol substitutes report
  // fresh running evidence after every node has joined the real app's epoch.
  // Deliberately unknown and terminal records are not recovered here.
  for (const execution of live) {
    execution.send('unknown');
    execution.send('running');
  }
  await f.api.app.listen({ port: 4334, host: '127.0.0.1' });
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
    ({ userId, spaceId }) => {
      sessionStorage.setItem(`hexu-space:${userId}`, spaceId);
      localStorage.setItem('hexu-theme', 'dark');
    },
    { userId: account.user.id, spaceId: account.spaceId },
  );
  await page.goto(resultUrl(version));
  await expect(activity(page)).toBeVisible();
}
async function close(page: Page, f: Fixture) {
  // Browser teardown failures must never skip service shutdown or mask the
  // original test assertion with a second navigation/context error.
  try {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  } catch {}
  try {
    await page.context().close();
  } catch {}
  await f.close();
}
async function complete(page: Page, keep: boolean) {
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '标记任务完成', exact: true });
  await expect(dialog).toContainText('任务完成与执行停止是两件事');
  await dialog.getByRole('checkbox', { name: '同时请求停止当前执行' }).setChecked(!keep);
  await dialog.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.result-eyebrow .badge')).toHaveCount(1);
  await expect(page.locator('.result-eyebrow .badge')).toHaveText('已完成');
}

/** These are persisted defensive/legacy observation fixtures, not a claimed way to
 * launch unsupported parallel ordinary coding Runs. All normal dispatches below use
 * real control/store operations and protocol events, with no process or model. */
function observe(f: Fixture, id: string, observation: Run['observation']) {
  f.as(() =>
    f.api.store.atomic(() => {
      const run = f.api.store.run(id);
      f.api.store.db
        .prepare('UPDATE runs SET body=? WHERE id=?')
        .run(JSON.stringify({ ...run, observation, revision: run.revision + 1 }), id);
      f.api.store.db
        .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
        .run(run.taskId, 'run.updated', new Date().toISOString(), f.alice.spaceId);
    }),
  );
}
async function extraRun(f: Fixture, assist = false, taskId = f.task.id) {
  const token = randomBytes(32).toString('base64url'),
    workspace = randomUUID(),
    connection = randomUUID();
  const pairing = f.as(() => f.nodes.createPairing(f.project.id, randomUUID()));
  const node = f.nodes.pair({
    code: pairing.code!,
    nodeToken: token,
    clientId: randomUUID(),
    projectId: f.project.id,
    name: assist ? 'AI 文本协助协议节点' : '普通执行协议节点',
    platform: 'linux',
    arch: 'x64',
    workspaces: [{ id: workspace, name: '明确授权的协议目录' }],
  });
  extraNodes.set(f, [...(extraNodes.get(f) ?? []), { token, connection, workspace }]);
  f.nodes.hello(token, connection);
  const at = new Date().toISOString();
  f.nodes.sync(token, connection, 1, {
    capturedAt: at,
    workspaces: [
      {
        id: workspace,
        state: 'available',
        capturedAt: at,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
    ],
  });
  const policy: ExecutionPolicy = {
    grantId: randomUUID(),
    tool: assist ? 'claude-code' : 'codex',
    ...(assist ? { textAssistance: true } : {}),
    model: 'activity-protocol-fixture',
    mode: 'edit',
    workspaceIds: [workspace],
    timeoutSeconds: 30,
    maxTurns: 8,
    maxBudgetUsd: assist ? 1 : null,
    toolVersion: 'protocol fixture only',
  };
  f.execution.publish(token, connection, policy);
  let run: Run;
  if (assist) {
    const message = f.as(() =>
      f.api.store.addMessage(taskId, '明确选择的协议材料', null, randomUUID()),
    );
    const preview = f.as(() => f.api.store.assistance.preview(taskId, message.id));
    run = f.as(
      () =>
        f.execution.createAssistance(
          taskId,
          {
            sourceMessageId: message.id,
            expectedSourceHash: preview.sourceHash,
            expectedTaskRevision: preview.taskRevision,
            range: { start: 0, end: 4 },
            question: '只分析所选协议材料',
            nodeId: node.nodeId,
            policyHash: executionHash(policy),
            confirmMaterial: true,
            confirmExecution: true,
          },
          randomUUID(),
        ).assistance.ai!.run,
    );
  } else {
    run = f.as(() =>
      f.execution.create(
        taskId,
        parseNodeRun({
          provider: 'node',
          nodeId: node.nodeId,
          workingCopyId: workspace,
          policyHash: executionHash(policy),
          mode: 'edit',
          prompt: '普通执行协议材料',
          expectedRevision: f.api.store.getTask(taskId).revision,
          confirmExecution: true,
        }),
        randomUUID(),
      ),
    );
  }
  const command = f.execution.poll(token, connection).command!;
  expect(command.runId).toBe(run.id);
  let sequence = 0;
  const send = (kind: ExecutionEvent['kind'], result: ExecutionEvent['result'] = null) =>
    f.execution.acceptEvent(token, command.id, command.generation, {
      sequence: ++sequence,
      kind,
      text: '仅用于控制协议验证',
      result,
      terminationConfirmed: kind === 'terminal',
    });
  send('accepted');
  expect(f.execution.permit(token, connection, command.id, command.generation).allowed).toBe(true);
  send('running');
  return {
    run,
    send,
    finish: (state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => send('terminal', state),
  };
}

test('成果页完成保留执行，重新打开不派发；请求停止后等到明确终态才移出当前活动', async ({
  page,
}) => {
  const f = await branchResultFixture(origin);
  try {
    const { version } = await branchResult(f),
      peer = f.begin(1, 'codex');
    peer.start();
    const count = f.as(() => f.api.store.runs(f.task.id)).length;
    await open(page, f, version, f.alice, [peer]);
    await expect(row(page, peer.run.id)).toContainText('节点运行中');
    await expect(activity(page)).toContainText(
      '共 1 项 · 连接未知 0 项 · 正在停止 0 项 · 其他活动 1 项',
    );
    await complete(page, true);
    expect(taskState(f).status).toBe('done');
    expect(runState(f, peer.run.id).state).toBe('running');
    await expect(row(page, peer.run.id)).toContainText('节点运行中');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/168-result-task-activity-dark.png', fullPage: true });
    await page.getByRole('button', { name: '重新打开', exact: true }).click();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(count);
    await complete(page, false);
    expect(runState(f, peer.run.id).state).toBe('stopping');
    expect(runState(f, peer.run.id).node?.terminationConfirmed).toBe(false);
    await expect(row(page, peer.run.id)).toContainText('正在停止');
    await expect(activity(page)).toContainText(
      '共 1 项 · 连接未知 0 项 · 正在停止 1 项 · 其他活动 0 项',
    );
    await page.reload();
    await expect(row(page, peer.run.id)).toContainText('正在停止');
    peer.finish('cancelled', '协议夹具明确确认原执行已经结束');
    await expect(rows(page)).toHaveCount(0);
    await expect(activity(page)).toContainText('本次读取没有活动或连接未知的执行记录');
    await expect(activity(page)).toContainText('不作为所有进程已停止的确认');
    expect(runState(f, peer.run.id).node?.terminationConfirmed).toBe(true);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(count);
    await expect(page.getByLabel('查看固定版本')).toHaveValue(version.id);
  } finally {
    await close(page, f);
  }
});

test('未知观察优先于停止和三种终态，其他任务的未知执行不混入成果当前活动', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const version = memberResult(f);
    const ordinary = await extraRun(f);
    ordinary.finish('succeeded');
    const a = f.begin(),
      b = f.begin(1);
    a.start();
    b.start();
    a.finish('failed');
    b.send('unknown');
    observe(f, ordinary.run.id, 'unknown');
    observe(f, a.run.id, 'unknown');
    const otherTask = await f.api.task(f.alice, f.project.id, '不能混入当前成果的任务');
    const unrelated = await extraRun(f, false, otherTask.id);
    unrelated.finish('cancelled');
    observe(f, unrelated.run.id, 'unknown');
    await open(page, f, version);
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, unrelated.run.id)).toHaveCount(0);
    await expect(activity(page)).toContainText(
      '共 3 项 · 连接未知 3 项 · 正在停止 0 项 · 其他活动 0 项',
    );
    await complete(page, false);
    expect(runState(f, b.run.id).state).toBe('stopping');
    await expect(row(page, b.run.id).locator('.badge')).toHaveText('连接未知 · 待核对');
    await expect(activity(page)).toContainText('正在停止 0 项');
    b.finish('cancelled');
    observe(f, b.run.id, 'unknown');
    await expect(rows(page)).toHaveCount(3);
    for (const run of [ordinary.run, a.run, b.run])
      await expect(row(page, run.id).locator('.badge')).toHaveText('连接未知 · 待核对');
    await expect(activity(page)).not.toContainText('节点执行已停止');
    await expect(activity(page)).not.toContainText('本次节点已结束');
    expect([ordinary.run, a.run, b.run].map((r) => runState(f, r.id).state)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
    ]);
    for (const run of [ordinary.run, a.run, b.run]) observe(f, run.id, 'fresh');
    await expect(rows(page)).toHaveCount(0);
    await expect(activity(page)).toContainText('不作为所有进程已停止的确认');
  } finally {
    await close(page, f);
  }
});

test('普通与方案及AI协助均进入五项分页，手机按钮可触达，活动减少后收敛到有效页', async ({
  page,
}) => {
  const f = await branchResultFixture(origin);
  try {
    const version = memberResult(f),
      ordinary = await extraRun(f);
    ordinary.finish();
    const a = f.begin(),
      b = f.begin(1, 'codex');
    a.start();
    b.start();
    const assists = [];
    for (let index = 0; index < 4; index++) {
      const assist = await extraRun(f, true);
      assists.push(assist);
      // The control store permits only one pending non-branch dispatch per Task.
      // Older assists must settle before the next one is created.
      if (index < 3) assist.finish();
    }
    // These terminal records carry defensive unknown observations. They exercise
    // the UI without granting unsupported concurrent ordinary/assist dispatches.
    for (const item of [ordinary, ...assists.slice(0, 3)]) observe(f, item.run.id, 'unknown');
    const all = [ordinary, a, b, ...assists];
    await open(page, f, version, f.alice, [a, b, assists[3]!]);
    await expect(rows(page)).toHaveCount(5);
    await expect(activity(page)).toContainText(
      '共 7 项 · 连接未知 4 项 · 正在停止 0 项 · 其他活动 3 项',
    );
    const first = await pageIds(page);
    const privateInputs = [
      '普通执行协议材料',
      '明确选择的协议材料',
      '只分析所选协议材料',
      'RESULT_INPUT_',
    ];
    for (const input of privateInputs) await expect(activity(page)).not.toContainText(input);
    await expect(pagination(page)).toContainText('第 1 / 2 页');
    await expect(pagination(page).getByRole('button', { name: '上一页' })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    const next = pagination(page).getByRole('button', { name: '下一页' });
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeInViewport();
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await rows(page).first().boundingBox())!.width).toBeGreaterThan(240);
    expect(await activity(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/169-result-task-activity-mobile-light.png',
      fullPage: true,
    });
    await next.click();
    await expect(rows(page)).toHaveCount(2);
    const second = await pageIds(page);
    for (const input of privateInputs) await expect(activity(page)).not.toContainText(input);
    expect([...first, ...second].sort()).toEqual(all.map((r) => r.run.id).sort());
    await expect(row(page, ordinary.run.id)).toContainText('普通执行');
    await expect(activity(page)).toContainText('方案执行');
    await expect(next).toBeDisabled();
    const previous = pagination(page).getByRole('button', { name: '上一页' });
    await previous.scrollIntoViewIfNeeded();
    await expect(previous).toBeInViewport();
    await previous.press('Enter');
    await expect(rows(page)).toHaveCount(5);
    await expect(activity(page)).toContainText('AI 协助');
    await next.scrollIntoViewIfNeeded();
    await next.click();
    for (const id of first) {
      const item = all.find((candidate) => candidate.run.id === id)!;
      if (runState(f, id).observation === 'unknown') observe(f, id, 'fresh');
      else item.finish();
    }
    await expect(activity(page)).toContainText(
      '共 2 项 · 连接未知 1 项 · 正在停止 0 项 · 其他活动 1 项',
    );
    await expect(rows(page)).toHaveCount(2);
    expect(await pageIds(page)).toEqual(second);
    await expect(pagination(page)).toHaveCount(0);
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(7);
  } finally {
    await close(page, f);
  }
});

test('手机历史成果的正文来源反馈和链接固定，完成及重新打开只改变当前任务', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const { source, version } = await branchResult(f);
    const feedback = (
      await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
        body: 'FEEDBACK_FIXED_TO_VERSION_ONE',
        resultId: version.resultId,
        resultRevisionId: version.id,
      })
    ).json() as Message;
    const reference = await f.api.call(
      `results/${version.resultId}/versions/${version.id}/references`,
      f.alice,
      {
        action: 'register',
        expectedResultRevision: version.revision,
        kind: 'report',
        title: '原版本人工报告',
        url: 'https://reports.example.invalid/fixed-first-version#summary',
      },
    );
    expect(reference.statusCode, reference.body).toBe(201);
    const newer = await f.api.call(f.path() + '/results', f.alice, {
      ...(await f.draft()),
      title: '新版本说明',
      body: 'NEW_VERSION_MUST_NOT_REPLACE_HISTORY',
    });
    expect(newer.statusCode, newer.body).toBe(201);
    const peer = f.begin(1);
    peer.start();
    await open(page, f, version, f.alice, [peer]);
    await page.setViewportSize({ width: 390, height: 844 });
    const sourcePanel = page.getByRole('region', { name: '固定成果来源' });
    const sourceToggle = sourcePanel.getByText('查看来源执行与实际输入', { exact: true });
    await sourceToggle.scrollIntoViewIfNeeded();
    await expect(sourceToggle).toBeInViewport();
    await sourceToggle.click();
    await expect(sourcePanel).toContainText(source.run.id);
    const fixedSource = await sourcePanel.textContent();
    const mark = page.getByRole('button', { name: '标记完成', exact: true });
    await mark.scrollIntoViewIfNeeded();
    await expect(mark).toBeInViewport();
    await complete(page, true);
    await expect(page).toHaveURL(resultUrl(version));
    await expect(page.getByLabel('查看固定版本')).toHaveValue(version.id);
    await expect(page.locator('.written-result')).toContainText(version.body);
    await expect(page.locator('.written-result')).not.toContainText(
      'NEW_VERSION_MUST_NOT_REPLACE_HISTORY',
    );
    expect(await sourcePanel.textContent()).toBe(fixedSource);
    await expect(page.locator(`[data-message-id="${feedback.id}"]`)).toContainText(feedback.body);
    const referenceRow = page.locator(`[data-reference-id="${reference.json().id}"]`);
    await expect(referenceRow).toContainText('原版本人工报告');
    await expect(referenceRow.getByRole('link')).toHaveAttribute(
      'href',
      'https://reports.example.invalid/fixed-first-version#summary',
    );
    await expect(row(page, peer.run.id)).toContainText('节点运行中');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/170-result-task-activity-history-mobile.png',
      fullPage: true,
    });
    const reopen = page.getByRole('button', { name: '重新打开', exact: true });
    await reopen.scrollIntoViewIfNeeded();
    await expect(reopen).toBeInViewport();
    await reopen.click();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    await page.reload();
    await expect(page.getByLabel('查看固定版本')).toHaveValue(version.id);
    await expect(page.locator(`[data-message-id="${feedback.id}"]`)).toBeVisible();
    expect(f.as(() => new ResultRevisions(f.api.store).get(version.resultId, version.id))).toEqual(
      version,
    );
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(2);
  } finally {
    await close(page, f);
  }
});

test('只读成员可看当前执行但不能完成，撤权后成果与活动一并清除且直接写入拒绝', async ({ page }) => {
  const f = await branchResultFixture(origin);
  try {
    const version = memberResult(f),
      active = f.begin();
    active.start();
    expect(
      (
        await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
          role: 'view',
        })
      ).statusCode,
    ).toBe(200);
    const before = taskState(f);
    await open(page, f, version, f.bob, [active]);
    await expect(row(page, active.run.id)).toContainText('节点运行中');
    await expect(page.getByRole('button', { name: '标记完成', exact: true })).toBeDisabled();
    const deniedWrite = await f.api.call(`tasks/${f.task.id}/complete`, f.bob, {
      expectedRevision: before.revision,
      activeRunAction: 'stop',
    });
    expect(deniedWrite.statusCode).toBe(403);
    expect(taskState(f)).toEqual(before);
    expect(runState(f, active.run.id).state).toBe('running');
    expect(
      (
        await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
          role: null,
        })
      ).statusCode,
    ).toBe(200);
    await expect(page.getByRole('heading', { name: '无法打开成果', exact: true })).toBeVisible();
    await expect(activity(page)).toHaveCount(0);
    await expect(page.locator('.written-result')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(active.run.id);
    await expect(page.getByRole('button', { name: '标记完成', exact: true })).toHaveCount(0);
    const deniedRead = await f.api.call(
      `results/${version.resultId}/versions/${version.id}`,
      f.bob,
    );
    expect([403, 404]).toContain(deniedRead.statusCode);
    expect(taskState(f)).toEqual(before);
  } finally {
    await close(page, f);
  }
});

test('无报告无Run也能完成重开；断连时状态与动作只取同份工作台快照，缺失任务不回退详情', async ({
  page,
}) => {
  const f = await branchResultFixture(origin);
  try {
    const version = memberResult(f);
    await page.route(`${origin}/api/v1/events?*`, (route) => route.abort('failed'));
    await open(page, f, version);
    await expect(activity(page)).toContainText('上次读取的任务与执行快照');
    await expect(page.locator('.result-eyebrow')).toContainText('上次读取');
    await expect(activity(page)).toContainText('本次读取没有活动或连接未知的执行记录');
    await page.getByRole('button', { name: '标记完成', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '标记任务完成' })).toHaveCount(0);
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('已完成');
    await page.getByRole('button', { name: '重新打开', exact: true }).click();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
    const refs = await f.api.call(
      `results/${version.resultId}/versions/${version.id}/references`,
      f.alice,
    );
    expect(refs.json().items).toEqual([]);
    const snapshot = (await f.api.call('workbench', f.alice)).json() as Workbench;
    let hold = true,
      missing = false;
    await page.route(`${origin}/api/v1/workbench`, async (route) => {
      if (hold) return route.fulfill({ json: snapshot });
      const response = await route.fetch();
      const current = (await response.json()) as Workbench;
      await route.fulfill({
        response,
        json: missing
          ? { ...current, tasks: current.tasks.filter((task) => task.id !== f.task.id) }
          : current,
      });
    });
    await page.reload();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    const completed = await f.api.call(`tasks/${f.task.id}/complete`, f.alice, {
      expectedRevision: taskState(f).revision,
      activeRunAction: 'keep',
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const detailTitle = '只有成果详情轮询读到的更新任务标题';
    const renamed = await f.api.call(
      `tasks/${f.task.id}`,
      f.alice,
      {
        expectedRevision: taskState(f).revision,
        title: detailTitle,
      },
      randomUUID(),
      'PATCH',
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    // A changed detail-only title proves React consumed the newer poll before
    // asserting that status/action still use the held Workbench Task snapshot.
    await expect(page.locator('.result-eyebrow').getByRole('link')).toContainText(detailTitle);
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    await expect(page.getByRole('button', { name: '标记完成', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0);
    let sentRevision: number | undefined;
    await page.route(`${origin}/api/v1/tasks/${f.task.id}/complete`, async (route) => {
      sentRevision = route.request().postDataJSON().expectedRevision;
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      hold = false;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '标记完成', exact: true }).click();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('已完成');
    expect(sentRevision).toBe(snapshot.tasks.find((task) => task.id === f.task.id)!.revision);
    await expect(activity(page)).toContainText('上次读取的任务与执行快照');
    await page.getByRole('button', { name: '重新打开', exact: true }).click();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('待处理');
    expect(f.as(() => f.api.store.runs(f.task.id))).toHaveLength(0);
    missing = true;
    await page.reload();
    await expect(page.locator('.result-eyebrow .badge')).toHaveText('当前状态不可用');
    await expect(activity(page)).toContainText('当前任务状态不可用');
    await expect(activity(page).locator('.result-task-activity-counts')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '标记完成', exact: true })).toBeDisabled();
    await expect(page.locator('.written-result')).toContainText(version.body);
    await expect(page.getByLabel('查看固定版本')).toHaveValue(version.id);
  } finally {
    await close(page, f);
  }
});
