import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, rename, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../../apps/runner/src/agent/storage.js';
import { RetentionVault } from '../../apps/runner/src/agent/checkpoint-retention.js';
const origin = 'http://127.0.0.1:4317';
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
  const account = { email: 'retention-browser-owner@example.invalid', password };
  if (initial.setupRequired)
    await post(page, 'identity/setup', {
      ...account,
      name: '林舟（对象保留测试）',
      code: 'fictional-retention-browser-setup-code-0123456789',
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
  const dir = await mkdtemp(join(tmpdir(), 'hexu-retention-browser-')),
    root = join(dir, 'repo'),
    home = join(dir, 'node');
  await mkdir(root);
  await mkdir(home, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'README.md'), 'Fictional checkpoint fixture\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 128, 255, 13, 10]));
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

type Fixture = Awaited<ReturnType<typeof setup>>;
async function prepare(page: Page, f: Fixture) {
  const r = await post(
    page,
    `tasks/${f.task.id}/checkpoint-requests`,
    {
      nodeId: f.node.nodeId,
      workspaceId: f.workspace,
      commit: f.oid,
      label: '原提交引用',
      expectedTaskRevision: 1,
      confirmReference: true,
    },
    f.space.id,
  );
  const captured = await capture(f, r.id);
  expect(captured.code, captured.output).toBe(0);
  const stored = await pending(page, f);
  const path = `${origin}/api/v1/tasks/${f.task.id}/checkpoints/${stored.checkpointId}/retentions`;
  await page.getByRole('button', { name: '代码检查点', exact: true }).click();
  await page.getByRole('button', { name: '核验与本机保留', exact: true }).click();
  await expect(page.getByLabel('本机对象保留')).toContainText('尚无对象副本');
  return {
    path,
    read: async () =>
      (await (await page.request.get(path, { headers: headers(f.space.id) })).json()).items,
  };
}
async function form(page: Page) {
  await page.getByRole('button', { name: '保留对象副本', exact: true }).click();
  return page.getByRole('checkbox', { name: /我确认请求本机保留/ });
}
async function cli(
  f: Fixture,
  id: string,
  command: 'retain-checkpoint' | 'verify-checkpoint' | 'forget-checkpoint',
  confirmation = '',
) {
  const child = spawn(
    process.execPath,
    [resolve('dist/apps/runner/src/cli.js'), command, '--request', id, '--state', f.home],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (output += v));
  child.stdin.end(confirmation + '\n');
  const [code] = await once(child, 'close');
  return { code, output };
}
test('任务明确请求并由真实CLI保留文件对象，原仓库移走后核验，深浅色与手机范围清楚', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const state = await prepare(page, f),
      consent = await form(page);
    await expect(
      page.getByRole('button', { name: '创建对象保留请求', exact: true }),
    ).toBeDisabled();
    await consent.check();
    await page.getByLabel('保留期限', { exact: true }).selectOption('1');
    await expect(consent).not.toBeChecked();
    await consent.check();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/79-retention-request-dark.png', fullPage: true });
    await page.getByRole('button', { name: '创建对象保留请求', exact: true }).click();
    await expect(page.getByLabel('对象保留记录')).toContainText('等待本机核验与保留');
    const [r] = await state.read();
    const result = await cli(f, r.request.id, 'retain-checkpoint', `RETAIN ${f.oid} 1`);
    expect(result.code, result.output).toBe(0);
    await expect(page.getByLabel('对象保留记录')).toContainText('本机已保留（上次核验）');
    await expect(page.getByLabel('保留对象范围')).toContainText('5 个 Git 对象');
    await expect(page.getByLabel('外部内容排除')).toContainText('LFS 指针 0');
    expect(await readFile(join(f.root, 'README.md'), 'utf8')).toBe(
      'Not included in the reference\n',
    );
    const originalManifest = (await state.read())[0].manifest;
    await rename(f.root, f.root + '-moved');
    const verified = await cli(f, r.request.id, 'verify-checkpoint');
    expect(verified.code, verified.output).toBe(0);
    const before = (await state.read())[0];
    expect(before.sequence).toBe(2);
    expect(before.manifest).toEqual(originalManifest);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '代码检查点', exact: true }).click();
    await page.getByRole('button', { name: '核验与本机保留', exact: true }).click();
    await expect(page.getByLabel('本机对象保留')).toContainText('不是持续在线检测');
    await page.getByLabel('本机对象保留').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/80-retention-record-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/81-retention-mobile.png', fullPage: true });
    const task = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(task.task.revision).toBe(1);
    expect(task.runs).toHaveLength(0);
    expect(task.task.description).toBe('检查点不改变这份说明。');
  } finally {
    await f.close();
  }
});
test('丢失网页回执确认同一保留请求，副本损坏可见且明确删除不会重新采集或复活', async ({ page }) => {
  const f = await setup(page);
  try {
    const state = await prepare(page, f);
    await (await form(page)).check();
    let drop = true;
    await page.route('**/checkpoints/*/retentions', async (route) => {
      if (route.request().method() !== 'POST' || !drop) return route.continue();
      drop = false;
      await route.fetch();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: '创建对象保留请求', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认上次保留操作' })).toBeVisible();
    await expect(page.getByLabel('保留期限', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '确认上次保留操作' }).click();
    await expect(page.getByLabel('请求本机对象保留')).toHaveCount(0);
    const records = await state.read();
    expect(records).toHaveLength(1);
    const id = records[0].request.id;
    const result = await cli(f, id, 'retain-checkpoint', `RETAIN ${f.oid} 7`);
    expect(result.code, result.output).toBe(0);
    const v = new RetentionVault(f.home);
    try {
      v.db.prepare("UPDATE objects SET data=zeroblob(length(data)) WHERE type='blob'").run();
    } finally {
      v.close();
    }
    const verified = await cli(f, id, 'verify-checkpoint');
    expect(verified.code, verified.output).toBe(0);
    await expect(page.getByLabel('对象保留记录')).toContainText('本机对象核验失败');
    const refused = await cli(f, id, 'forget-checkpoint', 'NO');
    expect(refused.code).toBe(1);
    expect((await state.read())[0].state).toBe('corrupt');
    const deleted = await cli(f, id, 'forget-checkpoint', `DELETE ${id}`);
    expect(deleted.code, deleted.output).toBe(0);
    await expect(page.getByLabel('对象保留记录')).toContainText('本机副本已删除');
    const repeated = await cli(f, id, 'retain-checkpoint');
    expect(repeated.code).toBe(1);
    expect(repeated.output).toContain('RETENTION_DELETED');
    expect(await readFile(join(f.root, 'README.md'), 'utf8')).toBe(
      'Not included in the reference\n',
    );
  } finally {
    await f.close();
  }
});
test('读取故障保留期限与同意，缺少深层对象不发布伪副本，取消后本机不能继续保留', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const state = await prepare(page, f);
    const consent = await form(page);
    await page.getByLabel('保留期限', { exact: true }).selectOption('30');
    await consent.check();
    await page.route('**/checkpoints/*/retentions', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'TEMPORARY', message: '保留读取暂时失败' } }),
          })
        : route.continue(),
    );
    await expect(page.getByRole('alert')).toContainText('保留读取暂时失败');
    await expect(page.getByLabel('保留期限', { exact: true })).toHaveValue('30');
    await expect(consent).toBeChecked();
    await expect(
      page.getByRole('button', { name: '创建对象保留请求', exact: true }),
    ).toBeDisabled();
    await page.unroute('**/checkpoints/*/retentions');
    await page.getByRole('button', { name: '重读保留记录' }).click();
    await expect(page.getByRole('button', { name: '创建对象保留请求', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '创建对象保留请求', exact: true }).click();
    await expect(page.getByLabel('对象保留记录')).toContainText('等待本机核验与保留');
    const [r] = await state.read();
    const blob = execFileSync('git', ['-C', f.root, 'rev-parse', `${f.oid}:src/binary.dat`], {
      encoding: 'utf8',
    }).trim();
    await rm(join(f.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const failed = await cli(f, r.request.id, 'retain-checkpoint', `RETAIN ${f.oid} 30`);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain('SNAPSHOT_INCOMPLETE');
    expect((await state.read())[0].manifest).toBeNull();
    await expect(page.getByLabel('对象保留记录')).toContainText('等待本机核验与保留');
    await page.getByRole('button', { name: '取消保留请求', exact: true }).click();
    await expect(page.getByLabel('对象保留记录')).toContainText('保留请求已取消');
    const cancelled = await cli(f, r.request.id, 'retain-checkpoint', `RETAIN ${f.oid} 30`);
    expect(cancelled.code).toBe(1);
    expect(cancelled.output).toContain('CHECKPOINT_REQUEST_CLOSED');
  } finally {
    await f.close();
  }
});
