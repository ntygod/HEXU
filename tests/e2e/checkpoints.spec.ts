import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../../apps/runner/src/agent/storage.js';
const origin = 'http://127.0.0.1:4316';
const password = 'Fictional Checkpoint Browser Password 2026!';
const headers = (spaceId?: string) => ({
  origin,
  'x-hexu-client': 'web',
  'idempotency-key': randomUUID(),
  ...(spaceId ? { 'x-hexu-space': spaceId } : {}),
});
async function post(page: Page, path: string, body: unknown, spaceId?: string) {
  const r = await page.request.post(`${origin}/api/v1/${path}`, {
    headers: headers(spaceId),
    data: body,
  });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function setup(page: Page) {
  const initial = await (await page.request.get(origin + '/api/v1/identity')).json();
  const account = { email: 'checkpoint-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...account,
      name: '林舟（检查点测试）',
      code: 'fictional-checkpoint-browser-setup-code-0123456789',
    });
  else await post(page, 'identity/sign-in', account);
  const space = await post(page, 'spaces', { name: '检查点工作区 ' + randomUUID().slice(0, 4) });
  const project = await post(
    page,
    `spaces/${space.id}/projects`,
    { name: '订单服务研发' },
    space.id,
  );
  const task = await post(
    page,
    `spaces/${space.id}/tasks`,
    {
      title: '保留接口改造的代码起点',
      description: '检查点不改变这份说明。',
      projectId: project.id,
    },
    space.id,
  );
  const dir = await mkdtemp(join(tmpdir(), 'hexu-checkpoint-browser-')),
    root = join(dir, 'repo'),
    home = join(dir, 'node');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional checkpoint fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
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
  const oid = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(join(root, 'README.md'), 'Not included in the reference\n');
  const [w] = await authorizeDirectories([{ name: '接口研发副本', path: root }], home);
  const pairing = await post(page, 'nodes/pairings', { projectId: project.id }, space.id);
  const token = randomBytes(32).toString('base64url'),
    clientId = randomUUID();
  // Separate node channel: never forward browser cookies.
  const response = await fetch(origin + '/runner/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hexu-runner': '1' },
    body: JSON.stringify({
      protocol: 1,
      code: pairing.code,
      nodeToken: token,
      clientId,
      projectId: project.id,
      name: '我的开发电脑',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: w!.id, name: w!.name }],
    }),
  });
  expect(response.ok).toBe(true);
  const node = (await response.json()) as { nodeId: string };
  writeCredentials(home, {
    version: 1,
    controlUrl: origin,
    clientId,
    nodeToken: token,
    name: '我的开发电脑',
    projectId: project.id,
    spaceId: space.id,
    nodeId: node.nodeId,
    directories: [w!],
  });
  await page.goto(origin);
  await page.getByLabel('当前工作空间', { exact: true }).selectOption(space.id);
  await page.goto(`${origin}/tasks/${task.id}`);
  return {
    dir,
    root,
    home,
    oid,
    task,
    space,
    node,
    workspace: w!.id,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
async function fill(page: Page, f: Awaited<ReturnType<typeof setup>>) {
  await page.getByRole('button', { name: '代码检查点', exact: true }).click();
  await page.getByRole('button', { name: '记录提交检查点', exact: true }).click();
  await page.getByLabel('检查点名称', { exact: true }).fill('接口改造基线');
  await page.getByLabel('检查点来源节点', { exact: true }).selectOption(f.node.nodeId);
  await page.getByLabel('检查点授权目录', { exact: true }).selectOption(f.workspace);
  await page.getByLabel('完整提交 ID', { exact: true }).fill(f.oid);
  await page.getByRole('checkbox', { name: /我确认仅记录此提交/ }).check();
}
async function pending(page: Page, f: Awaited<ReturnType<typeof setup>>) {
  return (
    await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}/checkpoints`, {
        headers: headers(f.space.id),
      })
    ).json()
  ).requests[0];
}
async function capture(f: Awaited<ReturnType<typeof setup>>, id: string) {
  const child = spawn(
    process.execPath,
    [resolve('dist/apps/runner/src/cli.js'), 'checkpoint', '--request', id, '--state', f.home],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (v) => {
    output += v;
  });
  child.stderr.on('data', (v) => {
    output += v;
  });
  child.stdin.end(`CHECKPOINT ${f.oid}\n`);
  const [code] = await once(child, 'close');
  return { code, output };
}
test('网页指定提交到实际本机 CLI 核对，固定引用与排除项刷新可读，深浅色手机可用', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await page.getByLabel('任务评论', { exact: true }).fill('尚未发送的讨论');
    await fill(page, f);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/76-checkpoint-request-dark.png', fullPage: true });
    await page.getByRole('button', { name: '创建本机核对请求', exact: true }).click();
    await expect(page.getByLabel('检查点记录')).toContainText('等待本机核对');
    const r = await pending(page, f);
    const result = await capture(f, r.id);
    expect(result.code, result.output).toBe(0);
    await expect(page.getByLabel('检查点记录')).toContainText('引用已记录');
    await expect(page.getByLabel('未包含的工作区改动')).toContainText('工作区修改 1');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('任务评论', { exact: true })).toHaveValue('尚未发送的讨论');
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '代码检查点', exact: true }).click();
    await expect(page.getByLabel('检查点记录')).toContainText(f.oid);
    await page.getByText('查看固定对象与来源', { exact: true }).click();
    await page.screenshot({ path: 'artifacts/77-checkpoint-record-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/78-checkpoint-mobile.png', fullPage: true });
    const task = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(task.task.description).toBe('检查点不改变这份说明。');
    expect(task.task.revision).toBe(1);
    expect(task.runs).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('网页请求回执丢失确认原提交，取消阻止节点晚到发布，不产生假检查点', async ({ page }) => {
  const f = await setup(page);
  try {
    await fill(page, f);
    let drop = true;
    await page.route('**/api/v1/tasks/*/checkpoint-requests', async (route) => {
      if (!drop) return route.continue();
      drop = false;
      await route.fetch();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: '创建本机核对请求', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认上次检查点操作' })).toBeVisible();
    await expect(page.getByLabel('完整提交 ID', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次检查点操作' }).click();
    const r = await pending(page, f);
    await expect(page.getByLabel('检查点记录').locator('article')).toHaveCount(1);
    await page.getByRole('button', { name: '取消检查点请求' }).click();
    await expect(page.getByLabel('检查点记录')).toContainText('已取消');
    const result = await capture(f, r.id);
    expect(result.code).toBe(1);
    expect(result.output).toContain('CHECKPOINT_REQUEST_CLOSED');
    expect((await pending(page, f)).checkpointId).toBeNull();
  } finally {
    await f.close();
  }
});
test('无效引用不能提交，读取故障保留选择，撤销节点后不能创建或本机核对', async ({ page }) => {
  const f = await setup(page);
  try {
    await fill(page, f);
    await page.getByLabel('完整提交 ID').fill('main');
    await expect(page.getByRole('button', { name: '创建本机核对请求' })).toBeDisabled();
    await page.getByLabel('完整提交 ID').fill(f.oid);
    await page.getByRole('checkbox', { name: /我确认仅记录此提交/ }).check();
    await page.route('**/api/v1/tasks/*/checkpoint-options', (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEMPORARY', message: '节点读取暂时失败' } }),
      }),
    );
    await expect(page.getByRole('alert')).toContainText('节点读取暂时失败');
    await expect(page.getByLabel('完整提交 ID')).toHaveValue(f.oid);
    await expect(page.getByRole('button', { name: '创建本机核对请求' })).toBeDisabled();
    await page.unroute('**/api/v1/tasks/*/checkpoint-options');
    await page.getByRole('button', { name: '重读节点选项' }).click();
    await expect(page.getByRole('button', { name: '创建本机核对请求' })).toBeEnabled();
    await page.getByRole('button', { name: '创建本机核对请求' }).click();
    const r = await pending(page, f);
    await post(page, `nodes/${f.node.nodeId}/revoke`, { expectedRevision: 1 }, f.space.id);
    const result = await capture(f, r.id);
    expect(result.code).toBe(1);
    expect(result.output).toContain('NODE_REVOKED');
    await expect(page.getByLabel('检查点记录')).toContainText('原节点授权已失效');
    expect((await pending(page, f)).checkpointId).toBeNull();
  } finally {
    await f.close();
  }
});
