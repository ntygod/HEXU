import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const origin = 'http://127.0.0.1:4312';
const password = 'Fictional Node Browser Password 2026!';
const headers = (spaceId?: string) => ({
  origin,
  'x-hexu-client': 'web',
  'idempotency-key': randomUUID(),
  ...(spaceId ? { 'x-hexu-space': spaceId } : {}),
});
async function post(page: Page, path: string, body: unknown, spaceId?: string) {
  const response = await page.request.post(`${origin}/api/v1/${path}`, {
    headers: headers(spaceId),
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
function cli(args: string[], input?: string) {
  const child = spawn(process.execPath, [resolve('dist/apps/runner/src/cli.js'), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Whitelist and override: no inherited provider keys, native bins or personal settings.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'sk-ant-node-browser-protocol-fixture-not-a-real-key',
      OPENAI_API_KEY: 'sk-openai-node-browser-protocol-fixture-not-a-real-key',
    },
  });
  let output = '';
  child.stdout.on('data', (v) => {
    output += v;
  });
  child.stderr.on('data', (v) => {
    output += v;
  });
  if (input !== undefined) child.stdin.end(input);
  const finished = new Promise<number | null>((res, rej) => {
    child.once('error', rej);
    child.once('close', res);
  });
  return {
    child,
    finished,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await finished;
    },
  };
}
async function prepare(page: Page, retainedTool?: 'codex' | 'claude-code') {
  const codexSessions = retainedTool === 'codex';
  const initial = await (await page.request.get(`${origin}/api/v1/identity`)).json();
  const identity = { email: 'node-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...identity,
      name: '林舟（节点测试）',
      code: 'fictional-node-browser-setup-code-0123456789',
    });
  else await post(page, 'identity/sign-in', identity);
  const space = await post(page, 'spaces', { name: '合序 · 节点执行' });
  const project = await post(
    page,
    `spaces/${space.id}/projects`,
    { name: '订单导出体验' },
    space.id,
  );
  const task = await post(
    page,
    `spaces/${space.id}/tasks`,
    {
      title: '完善订单导出说明（协议替身）',
      description: '虚构测试任务，不调用真实模型。',
      projectId: project.id,
    },
    space.id,
  );
  const dir = await mkdtemp(join(tmpdir(), 'hexu-execution-browser-')),
    root = join(dir, 'repo'),
    home = join(dir, 'state');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional browser node execution checkout\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const config = join(dir, 'runner.json'),
    execution = join(dir, 'execution-config.json'),
    executable = join(dir, 'claude-fixture.mjs');
  await writeFile(
    config,
    JSON.stringify({
      controlUrl: origin,
      name: '我的执行节点',
      workspaces: [{ name: '订单工作副本', path: root }],
    }),
  );
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (!process.argv.includes('--help') && !process.argv.includes('--version')) appendFileSync(${JSON.stringify(join(root, 'actual-starts.txt'))}, 'one\\n');\nawait import(${JSON.stringify(pathToFileURL(resolve(`dist/tests/fixtures/${codexSessions ? 'codex-tool' : 'native-tool'}.js`)).href)});\n`,
  );
  await chmod(executable, 0o700);
  await writeFile(
    execution,
    JSON.stringify({
      tool: codexSessions ? 'codex' : 'claude-code',
      ...(retainedTool ? { retainSessions: true } : {}),
      executable,
      mode: 'edit',
      workspaces: ['订单工作副本'],
      timeoutSeconds: 30,
      maxBudgetUsd: codexSessions ? null : 1,
    }),
  );
  const pairing = await post(page, 'nodes/pairings', { projectId: project.id }, space.id);
  const pair = cli(['connect', '--config', config, '--state', home], pairing.code + '\nCONNECT\n');
  expect(await pair.finished, pair.output()).toBe(0);
  await page.goto(origin + '/');
  await page.getByLabel('当前工作空间', { exact: true }).selectOption(space.id);
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(space.id);
  await page.goto(`${origin}/tasks/${task.id}`);
  return { dir, root, home, execution, task, space };
}
async function authorize(f: Awaited<ReturnType<typeof prepare>>) {
  const enabled = cli(
    ['enable-execution', '--config', f.execution, '--state', f.home],
    'EXECUTE\n',
  );
  expect(await enabled.finished, enabled.output()).toBe(0);
  return cli(['start', '--state', f.home]);
}
async function startUI(page: Page, prompt: string, tool = 'Claude Code') {
  await page.getByRole('button', { name: '在节点上执行', exact: true }).click();
  const select = page.getByLabel('执行节点', { exact: true });
  await expect(select.locator('option').filter({ hasText: '我的执行节点' })).toHaveCount(1);
  await expect(select.locator('option').filter({ hasText: '我的执行节点' })).toBeEnabled();
  await select.selectOption({ label: `我的执行节点 · ${tool}` });
  await page.getByLabel('授权工作目录', { exact: true }).selectOption({ label: '订单工作副本' });
  await page.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
  await page.getByLabel('本次要求', { exact: true }).fill(prompt);
  await page.getByRole('checkbox').check();
}
async function detail(page: Page, f: Awaited<ReturnType<typeof prepare>>) {
  return (
    await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, { headers: headers(f.space.id) })
  ).json();
}

test('网页明确授权后由实际独立 CLI 执行，保留输出、来源和刷新状态', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_WRITE');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/23-node-execution-config.png', fullPage: true });
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('succeeded');
    await expect(page.locator('.node-run-status')).toContainText('订单工作副本');
    await expect(page.locator('.node-run-steps .reached')).toHaveCount(5);
    await expect(
      page.locator('.message-content').filter({ hasText: 'fixture response [REDACTED]' }).first(),
    ).toBeVisible();
    expect(await readFile(join(f.root, 'native-output.txt'), 'utf8')).toBe('fixture edit\n');
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\n');
    const data = await detail(page, f);
    expect(data.runs).toHaveLength(1);
    expect(data.task.status).toBe('in_progress');
    expect(data.runs[0].node.startedAt).toBeTruthy();
    await page.reload();
    await expect(page.locator('.node-run-steps .reached')).toHaveCount(5);
    await page.screenshot({ path: 'artifacts/24-node-execution-completed.png', fullPage: true });
    await agent.stop();
    agent = null;
    agent = cli(['start', '--state', f.home]);
    await expect.poll(async () => (await detail(page, f)).runs[0].state).toBe('succeeded');
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\n');
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('节点运行中停止确认，手机深色页面不把关闭或离线当作完成', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_HANG');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('running');
    await expect(page.locator('.node-run-steps .reached')).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await mkdir('artifacts', { recursive: true });
    await expect(page.locator('.toast')).not.toBeVisible();
    await page.screenshot({ path: 'artifacts/25-node-execution-mobile-dark.png', fullPage: true });
    await page.getByRole('button', { name: '停止节点执行', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('cancelled');
    const data = await detail(page, f);
    expect(data.runs[0].node.terminationConfirmed).toBe(true);
    expect(data.task.status).toBe('in_progress');
    await page.reload();
    await expect(page.locator('.node-run-steps .reached')).toHaveCount(5);
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('只配对摘要或本机拒绝执行授权时，网页不能启动模型', async ({ page }) => {
  test.setTimeout(60000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    const denied = cli(['enable-execution', '--config', f.execution, '--state', f.home], 'NO\n');
    expect(await denied.finished, denied.output()).toBe(1);
    expect(denied.output()).toContain('CONFIRMATION_REQUIRED');
    agent = cli(['start', '--state', f.home]);
    await page.getByRole('button', { name: '在节点上执行', exact: true }).click();
    await expect(page.getByRole('heading', { name: '还没有启用执行的节点' })).toBeVisible();
    await expect(page.getByRole('button', { name: '在节点上开始', exact: true })).toBeDisabled();
    expect((await detail(page, f)).runs).toHaveLength(0);
    await expect
      .poll(async () => {
        try {
          await readFile(join(f.root, 'actual-starts.txt'));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function openNextInputs(page: Page) {
  if (!(await page.getByRole('dialog', { name: '下一轮要求与记录', exact: true }).isVisible()))
    await page.getByRole('button', { name: /^要求与使用记录/ }).click();
}
async function closeNextInputs(page: Page) {
  const drawer = page.getByRole('dialog', { name: '下一轮要求与记录', exact: true });
  if (await drawer.isVisible())
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
}

test('运行中记录下一轮要求，结束后沿原目录接续，选择与来源可刷新追踪', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_HANG');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('running');
    await page.getByLabel('下一轮要求', { exact: true }).fill('保留订单数据，下一轮补空状态');
    await page.getByRole('button', { name: '保存到下一轮', exact: true }).click();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toContainText('待下一轮选择');
    expect((await detail(page, f)).runs).toHaveLength(1);
    await page.reload();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toContainText('保留订单数据');
    await closeNextInputs(page);
    await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
    await expect(page.getByLabel('原执行处理方式', { exact: true })).toHaveValue('wait');
    await expect(page.getByRole('button', { name: '保存等待接续', exact: true })).toBeDisabled();
    expect((await detail(page, f)).runs).toHaveLength(1);
    expect((await detail(page, f)).runs[0].state).toBe('running');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '停止节点执行', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('cancelled');
    await writeFile(join(f.root, 'keep-dirty.txt'), 'User uncommitted file\n');
    await page.getByLabel('下一轮要求', { exact: true }).fill('这条不选择，不要自动带入');
    await page.getByRole('button', { name: '保存到下一轮', exact: true }).click();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toHaveCount(2);
    await closeNextInputs(page);
    await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
    await expect(page.getByLabel('执行节点', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('授权工作目录', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('checkbox', { name: '带入：保留订单数据，下一轮补空状态', exact: true }),
    ).not.toBeChecked();
    await page
      .getByRole('checkbox', { name: '带入：保留订单数据，下一轮补空状态', exact: true })
      .check();
    await page.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
    await page.getByLabel('本次要求', { exact: true }).fill('FIXTURE_CAPTURE_INPUT');
    await page.locator('.node-context-preview summary').click();
    await expect(page.locator('.node-context-preview pre')).toContainText(
      '保留订单数据，下一轮补空状态',
    );
    await expect(page.locator('.node-context-preview pre')).not.toContainText('这条不选择');
    await page.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/26-node-continuation-selection.png', fullPage: true });
    await page.getByRole('button', { name: '确认同目录接续', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('succeeded');
    const data = await detail(page, f);
    expect(data.runs).toHaveLength(2);
    expect(data.runs[1].previousRunId).toBe(data.runs[0].id);
    expect(data.runs[1].node.workingCopyId).toBe(data.runs[0].node.workingCopyId);
    expect(data.task.status).toBe('in_progress');
    const input = await readFile(join(f.root, 'received-context.txt'), 'utf8');
    expect(input).toContain('保留订单数据，下一轮补空状态');
    expect(input).not.toContain('这条不选择');
    expect(await readFile(join(f.root, 'keep-dirty.txt'), 'utf8')).toBe('User uncommitted file\n');
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\none\n');
    await page.reload();
    await expect(page.locator('.node-continuation-origin')).toContainText('带入 1 条要求');
    await openNextInputs(page);
    await expect(
      page.locator('.next-input-item').filter({ hasText: '保留订单数据' }),
    ).toContainText('已随新执行启动');
    await openNextInputs(page);
    await expect(page.locator('.next-input-item').filter({ hasText: '这条不选择' })).toContainText(
      '待下一轮选择',
    );
    await closeNextInputs(page);
    await page.screenshot({ path: 'artifacts/27-node-continuation-completed.png', fullPage: true });
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('下一轮要求可编辑撤回并持久保存，手机深色不溢出，保存不自动执行', async ({ page }) => {
  test.setTimeout(60000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_WRITE');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('succeeded');
    await page.getByLabel('下一轮要求', { exact: true }).fill('补充筛选条件');
    await page.getByRole('button', { name: '保存到下一轮', exact: true }).click();
    await openNextInputs(page);
    await page.getByRole('button', { name: '编辑要求', exact: true }).click();
    await page.getByLabel('下一轮要求', { exact: true }).fill('补充月份筛选，保留未提交修改');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toContainText('补充月份筛选');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await expect(page.locator('.toast')).not.toBeVisible();
    await page.screenshot({ path: 'artifacts/28-next-round-mobile-dark.png', fullPage: true });
    await page.getByRole('button', { name: '撤回要求', exact: true }).click();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toContainText('已撤回');
    await page.reload();
    await openNextInputs(page);
    await expect(page.locator('.next-input-item')).toContainText('已撤回');
    expect((await detail(page, f)).runs).toHaveLength(1);
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\n');
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('接续材料变化需重新确认，已完成任务接续明确重开而不丢历史', async ({ page }) => {
  test.setTimeout(60000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_WRITE');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('succeeded');
    await closeNextInputs(page);
    await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
    await page.getByLabel('本次要求', { exact: true }).fill('继续分析，不改文件');
    await page.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await post(
      page,
      `tasks/${f.task.id}/messages`,
      { body: '新的人工说明：注意空数据' },
      f.space.id,
    );
    await expect(page.getByRole('checkbox', { name: /我确认本次目录与模式/ })).not.toBeChecked({
      timeout: 12000,
    });
    await expect(page.getByRole('button', { name: '确认同目录接续', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const current = await detail(page, f);
    await post(
      page,
      `tasks/${f.task.id}/complete`,
      { expectedRevision: current.task.revision, activeRunAction: 'keep' },
      f.space.id,
    );
    await page.reload();
    await closeNextInputs(page);
    await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
    await page.getByLabel('本次要求', { exact: true }).fill('重新打开后继续分析');
    await page.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await page.getByRole('button', { name: '重开任务并接续', exact: true }).click();
    // 202 saves an Operation first; the old completed source is not the new result.
    await expect
      .poll(
        async () => {
          const runs = (await detail(page, f)).runs;
          return runs.length === 2 && runs[1].state === 'succeeded';
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const next = await detail(page, f);
    expect(next.task.status).toBe('in_progress');
    expect(next.runs).toHaveLength(2);
    expect(next.runs[1].previousRunId).toBe(next.runs[0].id);
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function arrangeUI(page: Page, mode: 'wait' | 'request_stop') {
  await closeNextInputs(page);
  await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
  await page.getByLabel('原执行处理方式', { exact: true }).selectOption(mode);
  await page.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
  await page.getByLabel('本次要求', { exact: true }).fill('FIXTURE_WRITE');
  await page.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
  await page
    .getByRole('button', { name: mode === 'wait' ? '保存等待接续' : '停止后接续', exact: true })
    .click();
}

test('节点运行中直接安排停止后继续，202 状态保留且实际只启动两次', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_HANG');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('running');
    await writeFile(join(f.root, 'keep-user-edit.txt'), 'Uncommitted original\n');
    await arrangeUI(page, 'request_stop');
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('已创建新执行', { timeout: 20000 });
    await expect
      .poll(
        async () => {
          const runs = (await detail(page, f)).runs;
          return runs.length === 2 && runs[1].state === 'succeeded';
        },
        { timeout: 25000 },
      )
      .toBe(true);
    const data = await detail(page, f);
    expect(data.runs[0].state).toBe('cancelled');
    expect(data.runs[0].node.terminationConfirmed).toBe(true);
    expect(data.runs[1].previousRunId).toBe(data.runs[0].id);
    expect(data.task.status).toBe('in_progress');
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\none\n');
    expect(await readFile(join(f.root, 'keep-user-edit.txt'), 'utf8')).toBe(
      'Uncommitted original\n',
    );
    await page.reload();
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('已创建新执行');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/29-node-operation-completed.png', fullPage: true });
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('节点等待接续刷新后可取消，手机深色显示安排与实际运行的区别', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_HANG');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('running');
    await arrangeUI(page, 'wait');
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('等待原执行结束');
    await page.reload();
    await expect(page.getByRole('button', { name: '取消接续安排', exact: true })).toBeVisible();
    expect((await detail(page, f)).runs).toHaveLength(1);
    expect((await detail(page, f)).runs[0].state).toBe('running');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: 'artifacts/30-node-operation-waiting-mobile.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: '取消接续安排', exact: true }).click();
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('接续已取消');
    await page.getByRole('button', { name: '停止节点执行', exact: true }).click();
    await expect
      .poll(async () => (await detail(page, f)).runs[0].state, { timeout: 20000 })
      .toBe('cancelled');
    await page.reload();
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('接续已取消');
    expect((await detail(page, f)).runs).toHaveLength(1);
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\n');
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('等待接续期间修改人工材料会暂停，历史保留原要求而不是自动采用新内容', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await startUI(page, 'FIXTURE_HANG');
    await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await page.route(`**/api/v1/tasks/${f.task.id}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await expect
      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
      .toBe('running');
    await arrangeUI(page, 'wait');
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('等待原执行结束');
    await post(
      page,
      `tasks/${f.task.id}/messages`,
      { body: '新范围：暂不采用已有自动接续' },
      f.space.id,
    );
    await expect(
      page.locator('.node-continuation-status .continuation-status-title strong'),
    ).toHaveText('需要处理');
    await page.reload();
    await expect(page.getByRole('button', { name: '重新配置接续', exact: true })).toBeVisible();
    await page.locator('.node-continuation-status > .continuation-records > summary').click();
    await expect(page.locator('.node-continuation-status .continuation-prompt')).toHaveText(
      'FIXTURE_WRITE',
    );
    await page.locator('.node-continuation-status .node-context-preview summary').click();
    await expect(
      page.locator('.node-continuation-status .node-context-preview pre'),
    ).not.toContainText('新范围：暂不采用已有自动接续');
    expect((await detail(page, f)).runs).toHaveLength(1);
    expect((await detail(page, f)).runs[0].state).toBe('running');
    await page.screenshot({
      path: 'artifacts/31-node-operation-needs-attention.png',
      fullPage: true,
    });
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const tool of ['codex', 'claude-code'] as const) {
  const toolName = tool === 'codex' ? 'Codex' : 'Claude Code';
  const writePrompt = tool === 'codex' ? 'CODEX_WRITE' : 'FIXTURE_WRITE';
  test(`${toolName} 原生会话：重启独立节点后明确恢复，使用同一私有历史并保留新 Run`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const f = await prepare(page, tool);
    let agent: ReturnType<typeof cli> | null = null;
    try {
      agent = await authorize(f);
      await startUI(page, writePrompt, toolName);
      await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
      await expect
        .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
        .toBe('succeeded');
      await expect(page.locator('.native-session-record')).toContainText(
        `${toolName} 会话已在节点私有保留`,
      );
      const first = (await detail(page, f)).runs[0];
      await agent.stop();
      agent = cli(['start', '--state', f.home]);
      await closeNextInputs(page);
      await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
      const way = page.getByLabel('接续会话方式', { exact: true });
      await expect(way.locator('option[value="resume"]')).toHaveJSProperty('disabled', false, {
        timeout: 15000,
      });
      await way.selectOption('resume');
      await expect(
        page.getByText('下方预览仅是新增文本，不是完整历史。', { exact: false }),
      ).toBeVisible();
      await page.getByLabel('本次要求', { exact: true }).fill('SESSION_RECALL');
      await expect(page.getByRole('checkbox').last()).toBeEnabled();
      await page.getByRole('checkbox').last().check();
      await mkdir('artifacts', { recursive: true });
      await page.screenshot({
        path: `artifacts/32-${tool}-native-resume-choice.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: '恢复原生会话并开始', exact: true }).click();
      await expect.poll(async () => (await detail(page, f)).runs.length).toBe(2);
      await expect
        .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
        .toBe('succeeded');
      await expect(page.locator('.native-session-record')).toContainText(
        `${toolName} 原生恢复完成`,
      );
      const second = (await detail(page, f)).runs.at(-1);
      expect(second.previousRunId).toBe(first.id);
      expect(second.node.nativeSession.ref).toBe(first.node.nativeSession.ref);
      expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\none\n');
      await page.reload();
      await expect(page.locator('.native-session-record')).toContainText(
        `${toolName} 原生恢复完成`,
      );
      await page.screenshot({ path: `artifacts/33-${tool}-native-resumed.png`, fullPage: true });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/34-${tool}-native-mobile-dark.png`,
        fullPage: true,
      });
    } finally {
      if (agent) await agent.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test(`${toolName} 会话清理后恢复失败不降级，下一次明确新会话仍可使用`, async ({ page }) => {
    test.setTimeout(90000);
    const f = await prepare(page, tool);
    let agent: ReturnType<typeof cli> | null = null;
    try {
      agent = await authorize(f);
      await startUI(page, writePrompt, toolName);
      await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
      await expect
        .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
        .toBe('succeeded');
      const source = (await detail(page, f)).runs[0],
        ref = source.node.nativeSession.ref;
      await agent.stop();
      agent = null;
      const cleanup = cli(
        ['forget-native-session', '--state', f.home, '--session', ref],
        `FORGET ${ref}\n`,
      );
      expect(await cleanup.finished, cleanup.output()).toBe(0);
      agent = cli(['start', '--state', f.home]);
      await closeNextInputs(page);
      await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
      await page.getByLabel('接续会话方式', { exact: true }).selectOption('resume');
      await page.getByLabel('本次要求', { exact: true }).fill('SESSION_RECALL');
      await expect(page.getByRole('checkbox').last()).toBeEnabled({ timeout: 15000 });
      await page.getByRole('checkbox').last().check();
      await page.getByRole('button', { name: '恢复原生会话并开始', exact: true }).click();
      await expect.poll(async () => (await detail(page, f)).runs.length).toBe(2);
      await expect
        .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
        .toBe('failed');
      expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\n');
      await expect(
        page.locator('.message-content').filter({
          hasText:
            tool === 'codex'
              ? '原生会话不存在、已删除或未确认安全结束'
              : '本机 Claude 会话未确认安全结束或已移除',
        }),
      ).toBeVisible();
      await closeNextInputs(page);
      await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
      await expect(
        page.getByLabel('接续会话方式').locator('option[value="resume"]'),
      ).toHaveJSProperty('disabled', true);
      await expect(page.getByLabel('接续会话方式')).toHaveValue('new');
      await page.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
      await page.getByLabel('本次要求', { exact: true }).fill(writePrompt);
      await expect(page.getByRole('checkbox').last()).toBeEnabled();
      await page.getByRole('checkbox').last().check();
      await page.getByRole('button', { name: '确认同目录接续', exact: true }).click();
      await expect
        .poll(async () => (await detail(page, f)).runs.length, { timeout: 20000 })
        .toBe(3);
      await expect
        .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
        .toBe('succeeded');
      expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\none\n');
      expect((await detail(page, f)).runs.at(-1).node.nativeSession.ref).not.toBe(ref);
    } finally {
      if (agent) await agent.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}
