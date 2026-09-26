import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
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
async function prepare(page: Page) {
  const state = await (await page.request.get(`${origin}/api/v1/identity`)).json();
  const email = 'node-browser-owner@example.invalid';
  if (state.setupRequired)
    await post(page, 'identity/setup', {
      email,
      password,
      name: '林舟（节点测试）',
      code: 'fictional-node-browser-setup-code-0123456789',
    });
  else await post(page, 'identity/sign-in', { email, password });
  const space = await post(page, 'spaces', { name: '合序 · 节点协作' });
  const project = await post(page, `spaces/${space.id}/projects`, { name: '客户工作台' }, space.id);
  await page.goto(origin + '/settings');
  await page.getByLabel('当前工作空间', { exact: true }).selectOption(space.id);
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(space.id);
  await expect(page.getByRole('button', { name: '连接我的节点', exact: true })).toBeEnabled();
  const dir = await mkdtemp(join(tmpdir(), 'hexu-browser-node-')),
    root = join(dir, 'repo'),
    home = join(dir, 'state');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional browser directory\n');
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
  const config = join(dir, 'runner.json');
  await writeFile(
    config,
    JSON.stringify({
      controlUrl: origin,
      name: '我的开发节点',
      workspaces: [{ name: '客户工作副本', path: root }],
    }),
  );
  return { space, project, dir, root, home, config };
}
function cli(args: string[], input?: string) {
  const child = spawn(process.execPath, [resolve('dist/apps/runner/src/cli.js'), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
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
async function pairingUI(page: Page, projectId: string) {
  await page.getByRole('button', { name: '连接我的节点', exact: true }).click();
  await page.getByLabel('共享到项目', { exact: true }).selectOption(projectId);
  await page.getByRole('button', { name: '生成一次性配对码', exact: true }).click();
  const code = await page.getByLabel('一次性配对码', { exact: true }).inputValue();
  expect(code).toHaveLength(43);
  return code;
}

test('网页配对与真实独立 CLI：在线、Git 摘要、刷新重启及撤销，浅深色与窄屏', async ({ page }) => {
  test.setTimeout(90000);
  const f = await prepare(page);
  let agent: ReturnType<typeof cli> | null = null;
  try {
    const code = await pairingUI(page, f.project.id);
    const pair = cli(['connect', '--config', f.config, '--state', f.home], code + '\nCONNECT\n');
    expect(await pair.finished, pair.output()).toBe(0);
    expect(pair.output()).not.toContain(code);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await writeFile(join(f.root, 'README.md'), 'Actual local change\n');
    await writeFile(join(f.root, 'new-file.txt'), 'Never uploaded content');
    agent = cli(['start', '--state', f.home]);
    const card = page.locator('.node-card').filter({ hasText: '我的开发节点' });
    await expect(card.locator('.badge')).toHaveText('在线');
    await expect(card.locator('.node-counts dd')).toHaveText(['0', '1', '1', '0']);
    await writeFile(join(f.root, 'second-file.txt'), 'Another local change');
    await expect(card.locator('.node-counts dd')).toHaveText(['0', '1', '2', '0']);
    await mkdir('artifacts', { recursive: true });
    await page.locator('.node-resources').screenshot({ path: 'artifacts/20-runner-online.png' });
    await page.reload();
    await expect(card.locator('.badge')).toHaveText('在线');
    await agent.stop();
    agent = null;
    await expect(card.locator('.badge')).toHaveText('离线');
    agent = cli(['start', '--state', f.home]);
    await expect(card.locator('.badge')).toHaveText('在线');
    expect(await card.count()).toBe(1);
    await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page
      .locator('.node-resources')
      .screenshot({ path: 'artifacts/21-runner-mobile-dark.png' });
    await card.getByRole('button', { name: '撤销节点', exact: true }).click();
    await page.getByRole('button', { name: '确认撤销节点', exact: true }).click();
    await expect(card.locator('.badge')).toHaveText('已撤销');
    expect(await agent.finished, agent.output()).toBe(1);
    expect(agent.output()).toContain('NODE_REVOKED');
    agent = null;
    await page.reload();
    await expect(card.locator('.badge')).toHaveText('已撤销');
    await expect(card).toContainText('历史摘要');
    await page.locator('.node-resources').screenshot({ path: 'artifacts/22-runner-revoked.png' });
  } finally {
    if (agent) await agent.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('项目只读成员可看授权摘要但不能控制节点，撤权后打开的节点卡被清除', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const f = await prepare(page),
    context = await browser.newContext(),
    member = await context.newPage();
  let agent: ReturnType<typeof cli> | null = null;
  try {
    const invite = await post(
      page,
      `spaces/${f.space.id}/invitations`,
      { email: `node-member-${randomUUID()}@example.invalid` },
      f.space.id,
    );
    await post(member, 'identity/join', {
      token: invite.token,
      name: '许宁（节点测试）',
      password,
    });
    const user = (await (await member.request.get(`${origin}/api/v1/identity`)).json()).user;
    await post(page, `projects/${f.project.id}/members/${user.id}`, { role: 'view' }, f.space.id);
    const code = await pairingUI(page, f.project.id);
    const pair = cli(['connect', '--config', f.config, '--state', f.home], code + '\nCONNECT\n');
    expect(await pair.finished, pair.output()).toBe(0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    agent = cli(['start', '--state', f.home]);
    await member.goto(origin + '/settings');
    await member.getByLabel('当前工作空间', { exact: true }).selectOption(f.space.id);
    const card = member.locator('.node-card').filter({ hasText: '我的开发节点' });
    await expect(card.locator('.badge')).toHaveText('在线');
    await expect(card.getByRole('button', { name: '撤销节点' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: '连接我的节点', exact: true })).toBeDisabled();
    const id = await card.getAttribute('data-node-id');
    await post(page, `projects/${f.project.id}/members/${user.id}`, { role: null }, f.space.id);
    await expect(card).toHaveCount(0);
    const hidden = await member.request.get(`${origin}/api/v1/nodes/${id}`, {
      headers: headers(f.space.id),
    });
    expect(hidden.status()).toBe(404);
  } finally {
    if (agent) await agent.stop();
    await context.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('网页取消配对码后，本机无法消费；不同意本机范围不会注册节点', async ({ page }) => {
  test.setTimeout(60000);
  const f = await prepare(page);
  try {
    const code = await pairingUI(page, f.project.id);
    const cancelled = cli(
      ['connect', '--config', f.config, '--state', f.home],
      code + '\nCANCEL\n',
    );
    expect(await cancelled.finished, cancelled.output()).toBe(1);
    expect(cancelled.output()).toContain('CONFIRMATION_REQUIRED');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.locator('.node-pairings')).toBeVisible();
    await page
      .locator('.node-pairings')
      .getByRole('button', { name: '取消配对', exact: true })
      .click();
    await expect(page.locator('.node-pairings')).toHaveCount(0);
    const retry = cli(['connect', '--config', f.config, '--state', f.home], code + '\nCONNECT\n');
    expect(await retry.finished, retry.output()).toBe(1);
    expect(retry.output()).toContain('PAIRING_INVALID');
    await page.reload();
    await expect(page.locator('.node-card')).toHaveCount(0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
