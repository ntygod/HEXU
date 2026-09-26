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
async function prepare(page: Page) {
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
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (!process.argv.includes('--help') && !process.argv.includes('--version')) appendFileSync(${JSON.stringify(join(root, 'actual-starts.txt'))}, 'one\\n');\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/native-tool.js')).href)});\n`,
  );
  await chmod(executable, 0o700);
  await writeFile(
    execution,
    JSON.stringify({
      tool: 'claude-code',
      executable,
      mode: 'edit',
      workspaces: ['订单工作副本'],
      timeoutSeconds: 30,
      maxBudgetUsd: 1,
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
async function startUI(page: Page, prompt: string) {
  await page.getByRole('button', { name: '在节点上执行', exact: true }).click();
  const select = page.getByLabel('执行节点', { exact: true });
  await expect(select.locator('option').filter({ hasText: '我的执行节点' })).toHaveCount(1);
  await expect(select.locator('option').filter({ hasText: '我的执行节点' })).toBeEnabled();
  await select.selectOption({ label: '我的执行节点 · Claude Code' });
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
    await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
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
