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

// Actual disk restore/report CLI, with prompts supplied only for this disposable fixture.
async function restoreResultCli(
  f: Fixture,
  id: string,
  mode: 'restore' | 'report' | 'cleanup',
  publish = true,
) {
  const args = [
    resolve('dist/apps/runner/src/restore-checkpoint.js'),
    mode,
    '--state',
    f.home,
    '--target',
    join(f.dir, 'restored-output'),
  ];
  if (mode === 'restore') args.push('--request', id);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let output = '';
  const answered = new Set<string>();
  child.stdout.on('data', (v) => {
    output += v;
    for (const match of output.matchAll(/(?:RESTORE|PUBLISH|REPORT|CLEAN) [0-9a-f-]{36}/g)) {
      if (answered.has(match[0])) continue;
      answered.add(match[0]);
      child.stdin.write((!publish && match[0].startsWith('PUBLISH') ? 'NO' : match[0]) + '\n');
    }
  });
  child.stderr.on('data', (v) => (output += v));
  const [code] = await once(child, 'close');
  return { code, output };
}
async function prepareRestoreResult(page: Page, f: Fixture) {
  const state = await prepare(page, f);
  const r = await post(
    page,
    state.path.replace(origin + '/api/v1/', ''),
    { days: 7, expectedTaskRevision: 1, confirmLocalRetention: true },
    f.space.id,
  );
  const retained = await cli(f, r.request.id, 'retain-checkpoint', `RETAIN ${f.oid} 7`);
  expect(retained.code, retained.output).toBe(0);
  await page.getByRole('button', { name: '查看恢复记录', exact: true }).click();
  await expect(page.getByLabel('本机恢复结果')).toContainText('尚无已确认');
  return {
    ...state,
    requestId: r.request.id,
    resultPath: `${state.path}/${r.request.id}/restores`,
  };
}
test('恢复结果经真实CLI回到原任务，刷新/历史/深浅色和窄屏区分发布与当前可用', async ({ page }) => {
  const f = await setup(page);
  try {
    const result = await prepareRestoreResult(page, f);
    const restored = await restoreResultCli(f, result.requestId, 'restore');
    expect(restored.code, restored.output).toBe(0);
    const report = await restoreResultCli(f, result.requestId, 'report');
    expect(report.code, report.output).toBe(0);
    const panel = page.getByLabel('本机恢复结果');
    await expect(panel).toContainText('文件已发布（本机报告）');
    await expect(panel).toContainText('不是实时文件检测');
    const payload = await (
      await page.request.get(result.resultPath, { headers: headers(f.space.id) })
    ).text();
    expect(payload).not.toContain(f.root);
    expect(payload).not.toContain('binary.dat');
    await panel.getByRole('button', { name: '查看报告历史' }).click();
    await expect(panel.getByLabel('恢复报告历史')).toContainText('报告 #1');
    await mkdir('artifacts', { recursive: true });
    await panel.getByLabel('恢复结果记录').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/85-restore-result-dark.png', fullPage: true });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: 'artifacts/86-restore-result-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/87-restore-result-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await rename(join(f.dir, 'restored-output'), join(f.dir, 'user-moved-output'));
    await page.reload();
    await page.getByRole('button', { name: '代码检查点', exact: true }).click();
    await page.getByRole('button', { name: '核验与本机保留', exact: true }).click();
    await page.getByRole('button', { name: '查看恢复记录', exact: true }).click();
    await expect(page.getByLabel('本机恢复结果')).toContainText('文件已发布（本机报告）');
    await expect(page.getByLabel('本机恢复结果')).toContainText('不证明目录现在存在');
  } finally {
    await f.close();
  }
});
test('取消后的已核验暂存和明确清理分别显示，原报告历史保留且不完成任务', async ({ page }) => {
  const f = await setup(page);
  try {
    const result = await prepareRestoreResult(page, f);
    const cancelled = await restoreResultCli(f, result.requestId, 'restore', false);
    expect(cancelled.code).toBe(1);
    expect((await restoreResultCli(f, result.requestId, 'report')).code).toBe(0);
    const panel = page.getByLabel('本机恢复结果');
    await expect(panel).toContainText('恢复已取消');
    await expect(panel).toContainText('暂存仍保留');
    expect((await restoreResultCli(f, result.requestId, 'cleanup')).code).toBe(0);
    expect((await restoreResultCli(f, result.requestId, 'report')).code).toBe(0);
    await expect(panel).toContainText('本次暂存已清理');
    await panel.getByRole('button', { name: '查看报告历史' }).click();
    await expect(panel.getByLabel('恢复报告历史')).toContainText('报告 #2');
    await expect(panel.getByLabel('恢复报告历史')).toContainText('暂存仍保留');
    const task = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(task.task.status).not.toBe('done');
    expect(task.runs).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('恢复列表暂时读错保留已有结果，权限拒绝清空内容与历史，不提供网页写路径入口', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const result = await prepareRestoreResult(page, f);
    expect((await restoreResultCli(f, result.requestId, 'restore')).code).toBe(0);
    expect((await restoreResultCli(f, result.requestId, 'report')).code).toBe(0);
    const panel = page.getByLabel('本机恢复结果');
    await expect(panel).toContainText('文件已发布');
    await page.route(result.resultPath, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'READ_FAILED', message: '恢复报告暂时不可读' } }),
      }),
    );
    await expect(panel).toContainText('恢复报告暂时不可读');
    await expect(panel).toContainText('文件已发布');
    await page.unroute(result.resultPath);
    await panel.getByRole('button', { name: '重读恢复记录' }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.route(result.resultPath, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '无权读取' } }),
      }),
    );
    await expect(page.getByText('恢复记录权限已失效，内容已清除。')).toBeVisible();
    await expect(page.getByLabel('恢复结果记录')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /恢复目标/ })).toHaveCount(0);
  } finally {
    await page.unrouteAll();
    await f.close();
  }
});

async function prepareTransfer(page: Page, f: Awaited<ReturnType<typeof setup>>) {
  const result = await prepareRestoreResult(page, f);
  const receiverHome = join(f.dir, 'transfer-receiver-state'),
    receiverRoot = join(f.dir, 'transfer-receiver-root');
  await mkdir(receiverHome, { mode: 0o700 });
  await mkdir(receiverRoot);
  execFileSync('git', ['init', '-q', receiverRoot]);
  await writeFile(join(receiverRoot, 'private.txt'), 'Not touched by transfer');
  const [workspace] = await authorizeDirectories(
    [{ name: '独立接收现场', path: receiverRoot }],
    receiverHome,
  );
  const projectId = f.task.projectId;
  const pairing = await post(page, 'nodes/pairings', { projectId }, f.space.id);
  const token = randomBytes(32).toString('base64url'),
    clientId = randomUUID();
  const response = await fetch(origin + '/runner/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hexu-runner': '1' },
    body: JSON.stringify({
      protocol: 1,
      code: pairing.code,
      nodeToken: token,
      clientId,
      projectId,
      name: '同机接收节点',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: workspace!.id, name: workspace!.name }],
    }),
  });
  expect(response.ok).toBe(true);
  const receiver = (await response.json()) as { nodeId: string };
  writeCredentials(receiverHome, {
    version: 1,
    controlUrl: origin,
    clientId,
    nodeToken: token,
    name: '同机接收节点',
    projectId,
    spaceId: f.space.id,
    nodeId: receiver.nodeId,
    directories: [workspace!],
  });
  await page.getByRole('button', { name: '查看对象传输', exact: true }).click();
  const panel = page.getByLabel('受控对象传输');
  await panel.getByRole('button', { name: '向另一节点传输', exact: true }).click();
  await panel.getByLabel('接收节点', { exact: true }).selectOption(receiver.nodeId);
  await panel.getByRole('checkbox').check();
  return {
    ...result,
    receiverHome,
    receiverRoot,
    receiver,
    path: `${result.path}/${result.requestId}/transfers`,
    panel,
  };
}
async function transferCli(home: string, id: string, mode: string, input = '') {
  const child = spawn(
    process.execPath,
    [
      resolve('dist/apps/runner/src/transfer-checkpoint.js'),
      mode,
      '--transfer',
      id,
      '--state',
      home,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (output += v));
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  return { code, output };
}
test('真实双节点对象传输从网页创建到独立接收，深浅色和手机展示不混淆接手与恢复', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const t = await prepareTransfer(page, f);
    await t.panel.getByRole('button', { name: '创建传输请求', exact: true }).click();
    await expect(t.panel).toContainText('等待接收端本机同意');
    const list = await (await page.request.get(t.path, { headers: headers(f.space.id) })).json(),
      id = list.items[0].ticket.id;
    const accept = await transferCli(t.receiverHome, id, 'accept', `RECEIVE ${id}\n`);
    expect(accept.code, accept.output).toBe(0);
    await expect(t.panel).toContainText('接收端已同意，等待源节点发送');
    const send = await transferCli(f.home, id, 'send', `SEND ${id}\n`);
    expect(send.code, send.output).toBe(0);
    await expect(t.panel).toContainText('密文已就绪，等待接收端核验');
    const receive = await transferCli(t.receiverHome, id, 'receive');
    expect(receive.code, receive.output).toBe(0);
    await expect(t.panel).toContainText('接收端已核验独立副本（最后报告）');
    await expect(t.panel).toContainText('不保证对象现在仍存在');
    expect(await readFile(join(t.receiverRoot, 'private.txt'), 'utf8')).toBe(
      'Not touched by transfer',
    );
    await t.panel.getByLabel('对象传输记录').scrollIntoViewIfNeeded();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/88-transfer-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.screenshot({ path: 'artifacts/89-transfer-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/90-transfer-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await page.getByRole('button', { name: '代码检查点', exact: true }).click();
    await page.getByRole('button', { name: '核验与本机保留', exact: true }).click();
    await page.getByRole('button', { name: '查看对象传输', exact: true }).click();
    await expect(page.getByLabel('受控对象传输')).toContainText('接收端已核验独立副本');
  } finally {
    await f.close();
  }
});
test('对象传输创建回执丢失复用同一节点与请求，取消阻止本机继续收发且不删除源对象', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const t = await prepareTransfer(page, f);
    let drop = true;
    await page.route(t.path, async (route) => {
      if (route.request().method() === 'POST' && drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await t.panel.getByRole('button', { name: '创建传输请求', exact: true }).click();
    await expect(t.panel).toContainText('传输操作回执未确认');
    await expect(t.panel.getByLabel('接收节点', { exact: true })).toHaveValue(t.receiver.nodeId);
    await t.panel.getByRole('button', { name: '确认上次传输操作', exact: true }).click();
    await expect(t.panel.getByLabel('对象传输记录')).toHaveCount(1);
    const items = (await (await page.request.get(t.path, { headers: headers(f.space.id) })).json())
      .items;
    expect(items).toHaveLength(1);
    await t.panel.getByRole('button', { name: '取消对象传输', exact: true }).click();
    await expect(t.panel).toContainText('传输已取消');
    const accept = await transferCli(t.receiverHome, items[0].ticket.id, 'accept');
    expect(accept.code).toBe(1);
    await expect(page.getByLabel('对象保留记录').first()).toContainText('本机已保留');
  } finally {
    await f.close();
  }
});
test('对象传输临时读取故障保留已知状态，权限失效清空记录，不提供网页任意路径入口', async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const t = await prepareTransfer(page, f);
    await t.panel.getByRole('button', { name: '创建传输请求', exact: true }).click();
    await expect(t.panel.getByLabel('对象传输记录')).toHaveCount(1);
    await page.route(t.path, async (route) => {
      if (route.request().method() === 'GET')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'TEMPORARY_FAILURE', message: '传输读取暂时失败' },
          }),
        });
      else await route.continue();
    });
    await expect(t.panel).toContainText('传输读取暂时失败');
    await expect(t.panel.getByLabel('对象传输记录')).toHaveCount(1);
    await page.unroute(t.path);
    await t.panel.getByRole('button', { name: '重读对象传输', exact: true }).click();
    await expect(t.panel.getByRole('alert')).toHaveCount(0);
    await page.route(t.path, async (route) => {
      if (route.request().method() === 'GET')
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '当前权限失效' } }),
        });
      else await route.continue();
    });
    await expect(
      page.getByText('对象传输读取权限已失效，内容已清除。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('对象传输记录')).toHaveCount(0);
    await expect(page.getByLabel('目标路径', { exact: true })).toHaveCount(0);
  } finally {
    await f.close();
  }
});
