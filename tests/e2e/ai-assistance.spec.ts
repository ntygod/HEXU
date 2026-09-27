import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const origin = 'http://127.0.0.1:4314';
const password = 'Fictional AI Browser Password 2026!';
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
async function prepare(page: Page) {
  const initial = await (await page.request.get(`${origin}/api/v1/identity`)).json();
  const identity = { email: 'ai-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...identity,
      name: '林舟（节点测试）',
      code: 'fictional-ai-assistance-browser-setup-code-0123456789',
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
    `#!${process.execPath}\nconst {textFixture}=await import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/text-tool.js')).href)});await textFixture(${JSON.stringify(join(dir, 'captures.jsonl'))});\n`,
  );
  await chmod(executable, 0o700);
  await writeFile(
    execution,
    JSON.stringify({
      tool: 'claude-code',
      textAssistance: true,
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
  const message = await post(
    page,
    `tasks/${task.id}/messages`,
    { body: 'SELECTED_ERROR\r\nUNSELECTED_SECRET' },
    space.id,
  );
  return { dir, root, home, execution, task, space, message };
}
async function authorize(f: Awaited<ReturnType<typeof prepare>>) {
  const enabled = cli(
    ['enable-execution', '--config', f.execution, '--state', f.home],
    'EXECUTE\n',
  );
  expect(await enabled.finished, enabled.output()).toBe(0);
  return cli(['start', '--state', f.home]);
}
async function configure(page: Page, question = '分析文本里的错误') {
  await page.getByRole('button', { name: '请 AI 分析片段', exact: true }).click();
  await page.getByLabel('AI 协助问题', { exact: true }).fill(question);
  const field = page.getByLabel('选择 AI 协助片段', { exact: true });
  await field.focus();
  await field.press('Control+Home');
  for (let i = 0; i < 14; i++) await field.press('Shift+ArrowRight');
  await expect
    .poll(() => field.evaluate((f: HTMLTextAreaElement) => f.selectionEnd - f.selectionStart))
    .toBe(14);
  await page.getByRole('button', { name: '使用 AI 所选片段', exact: true }).click();
  const nodes = page.getByLabel('AI 执行节点', { exact: true });
  await expect(nodes.locator('option').filter({ hasText: '我的执行节点' })).toHaveCount(1);
  await nodes.selectOption({ label: '我的执行节点 · Claude Code' });
  await expect(page.getByLabel('AI 账户与范围', { exact: true })).toContainText('空临时目录');
  await page.getByLabel('确认将本次预览材料发送给 Claude Code', { exact: true }).check();
  await page.getByLabel('确认使用所选节点本机账户并承担本次费用', { exact: true }).check();
  await expect(page.getByRole('button', { name: '启动 AI 文本协助', exact: true })).toBeEnabled();
}
async function current(page: Page, f: Awaited<ReturnType<typeof prepare>>) {
  return (
    await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}/assistances?state=all`, {
        headers: headers(f.space.id),
      })
    ).json()
  ).items[0];
}
async function records(f: Awaited<ReturnType<typeof prepare>>) {
  return (await readFile(join(f.dir, 'captures.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}
test('明确材料与费用后 AI 文本协助独立运行，结果回到任务，深浅色和手机可读', async ({ page }) => {
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await configure(page);
    await expect(page.getByLabel('本次模型材料预览', { exact: true })).not.toContainText(
      'UNSELECTED_SECRET',
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/70-ai-assistance-material-dark.png', fullPage: true });
    await page.getByRole('button', { name: '启动 AI 文本协助', exact: true }).click();
    await expect(page.getByLabel('AI 协助执行状态', { exact: true })).toContainText(
      '节点已确认进程结束',
    );
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText('协议替身建议');
    const item = await current(page, f),
      captured = await records(f);
    expect(captured).toHaveLength(1);
    expect(captured[0].input).toBe(item.ai.inputText);
    expect(captured[0].files).toEqual([]);
    expect(captured[0].cwd).not.toBe(f.root);
    const detail = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(detail.task.status).toBe('todo');
    expect(detail.task.revision).toBe(f.task.revision);
    expect(detail.messages).toHaveLength(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.goto(`${origin}/assistances/${item.id}`);
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText('协议替身建议');
    await page.screenshot({ path: 'artifacts/71-ai-assistance-result-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/72-ai-assistance-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  } finally {
    await agent?.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('AI 创建回执丢失只确认同一授权，主任务不重复执行，运行取消保留真实停止状态', async ({
  page,
}) => {
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await configure(page, 'HANG_TEXT');
    let drop = true;
    const attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(`**/api/v1/tasks/${f.task.id}/ai-assistances`, async (route) => {
      attempts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      if (drop) {
        drop = false;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: '启动 AI 文本协助', exact: true }).click();
    await expect(page.getByLabel('协助操作待确认', { exact: true })).toBeVisible();
    await expect(page.getByLabel('AI 执行节点', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次协助操作', exact: true }).click();
    await expect(page.getByLabel('AI 协助执行状态', { exact: true })).toContainText(
      '节点已报告实际进程启动',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    await expect(page.getByRole('button', { name: '结束协助', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '取消 AI 协助', exact: true }).click();
    await page.getByRole('button', { name: '确认取消 AI 协助', exact: true }).click();
    await expect(page.getByLabel('AI 协助执行状态', { exact: true })).toContainText(
      '节点已确认进程结束',
    );
    expect((await records(f)).length).toBe(1);
    const item = await current(page, f);
    expect(item.state).toBe('cancelled');
    expect(item.ai.run.node.terminationConfirmed).toBe(true);
  } finally {
    await agent?.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('AI 材料变化要求重新确认；不兼容提供方输出显示失败，没有建议或自动重试', async ({ page }) => {
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    agent = await authorize(f);
    await configure(page, 'TOOLS_ENABLED');
    await page.getByLabel('AI 协助问题', { exact: true }).fill('TOOLS_ENABLED 修改问题');
    await expect(
      page.getByRole('button', { name: '启动 AI 文本协助', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('确认将本次预览材料发送给 Claude Code', { exact: true }).check();
    await page.getByLabel('确认使用所选节点本机账户并承担本次费用', { exact: true }).check();
    await page.getByRole('button', { name: '启动 AI 文本协助', exact: true }).click();
    await expect(page.getByLabel('AI 协助执行状态', { exact: true })).toContainText('节点执行失败');
    await expect(page.getByLabel('协助回复记录', { exact: true })).toContainText(
      '尚未取得有效 AI 建议',
    );
    const item = await current(page, f);
    await page.reload();
    await expect(page.getByRole('button', { name: '协助记录', exact: true })).toBeVisible();
    expect((await records(f)).length).toBe(1);
    expect(item.ai.run.state).toBe('failed');
  } finally {
    await agent?.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});
