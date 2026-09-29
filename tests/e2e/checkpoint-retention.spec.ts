import { test, expect, request as apiRequest, type Page, type Browser } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, rename, readFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import {
  writeCredentials,
  readCredentials,
  AgentStorage,
} from '../../apps/runner/src/agent/storage.js';
import { AgentConnection } from '../../apps/runner/src/agent/connection.js';
import { NodeExecutor } from '../../apps/runner/src/agent/executor.js';
import { readGitWorkspaceProgress } from '../../apps/runner/src/agent/handoff-workspace.js';
import { readBranchWorkspaceStatus } from '../../apps/runner/src/agent/branch-workspace.js';
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
  const paired = await response.json();
  expect(response.ok, JSON.stringify(paired)).toBe(true);
  const node = paired as { nodeId: string };
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
  // The shared fictional account has the same bounded node allowance as a real
  // user. Revoke only this test's owned nodes, even if its page has already closed.
  const cleanup = await apiRequest.newContext({
    storageState: await page.context().storageState(),
  });
  return {
    dir,
    root,
    home,
    oid,
    task,
    space,
    node,
    workspace: w!.id,
    close: async () => {
      try {
        const response = await cleanup.get(origin + '/api/v1/nodes', {
          headers: headers(space.id),
        });
        expect(response.ok(), await response.text()).toBe(true);
        const items = (await response.json()).items as {
          id: string;
          projectId: string;
          canRevoke: boolean;
          revokedAt: string | null;
          revision: number;
        }[];
        for (const node of items.filter(
          (n) => n.projectId === project.id && n.canRevoke && !n.revokedAt,
        )) {
          const revoked = await cleanup.post(`${origin}/api/v1/nodes/${node.id}/revoke`, {
            headers: headers(space.id),
            data: { expectedRevision: node.revision },
          });
          expect(revoked.ok(), await revoked.text()).toBe(true);
        }
      } finally {
        await cleanup.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
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

async function prepareTransfer(
  page: Page,
  f: Awaited<ReturnType<typeof setup>>,
  recipientPage = page,
) {
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
  const pairing = await post(recipientPage, 'nodes/pairings', { projectId }, f.space.id);
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

async function receiverRestoreCli(
  home: string,
  id: string,
  mode: 'plan' | 'restore' | 'report' | 'cleanup',
  publish = true,
) {
  const target = join(home, '..', 'receiver-restored-output');
  const args =
    mode === 'plan'
      ? [resolve('dist/apps/runner/src/restore-plan.js')]
      : [resolve('dist/apps/runner/src/restore-checkpoint.js'), mode];
  args.push('--state', home, '--target', resolve(target));
  if (mode === 'restore' || mode === 'plan') args.push('--transfer', id);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let output = '';
  const answered = new Set<string>();
  child.stdout.on('data', (v) => {
    output += v;
    for (const match of output.matchAll(/(?:PLAN|RESTORE|PUBLISH|REPORT|CLEAN) [0-9a-f-]{36}/g)) {
      if (answered.has(match[0])) continue;
      answered.add(match[0]);
      child.stdin.write((!publish && match[0].startsWith('PUBLISH') ? 'NO' : match[0]) + '\n');
    }
  });
  child.stderr.on('data', (v) => (output += v));
  const [code] = await once(child, 'close');
  return { code, output, target: resolve(target) };
}
async function readyReceived(page: Page, f: Fixture) {
  const t = await prepareTransfer(page, f);
  await t.panel.getByRole('button', { name: '创建传输请求', exact: true }).click();
  await expect(t.panel.getByLabel('对象传输记录')).toHaveCount(1);
  const id = (await (await page.request.get(t.path, { headers: headers(f.space.id) })).json())
    .items[0].ticket.id as string;
  const accept = await transferCli(t.receiverHome, id, 'accept', `RECEIVE ${id}\n`);
  expect(accept.code, accept.output).toBe(0);
  const send = await transferCli(f.home, id, 'send', `SEND ${id}\n`);
  expect(send.code, send.output).toBe(0);
  const receive = await transferCli(t.receiverHome, id, 'receive');
  expect(receive.code, receive.output).toBe(0);
  const scope = t.panel.getByLabel('接收副本恢复', { exact: true });
  await expect(scope).toContainText('收到对象不等于文件已恢复');
  await scope.getByRole('button', { name: '查看恢复记录', exact: true }).click();
  await expect(scope).toContainText('尚无已确认');
  return { ...t, id, scope, resultPath: `${t.path}/${id}/restores` };
}
test('接收副本恢复经真实CLI回到传输卡，来源独立、刷新历史、深浅色及手机可读', async ({ page }) => {
  const f = await setup(page);
  try {
    const t = await readyReceived(page, f);
    await t.scope.getByText('在接收节点恢复到新目录', { exact: true }).click();
    await expect(t.scope.getByLabel('接收副本恢复命令')).toContainText(`--transfer ${t.id}`);
    const p = await receiverRestoreCli(t.receiverHome, t.id, 'plan');
    expect(p.code, p.output).toBe(0);
    const restored = await receiverRestoreCli(t.receiverHome, t.id, 'restore');
    expect(restored.code, restored.output).toBe(0);
    const reported = await receiverRestoreCli(t.receiverHome, t.id, 'report');
    expect(reported.code, reported.output).toBe(0);
    await expect(t.scope).toContainText('接收节点恢复 · 最后报告');
    await expect(t.scope).toContainText('文件已发布（本机报告）');
    await t.scope.getByText('恢复来源与指纹', { exact: true }).click();
    await expect(t.scope).toContainText(t.receiver.nodeId);
    await expect(t.scope).toContainText(f.node.nodeId);
    await t.scope.getByRole('button', { name: '查看报告历史', exact: true }).click();
    await expect(t.scope.getByLabel('恢复报告历史')).toContainText('报告 #1');
    expect(await readFile(join(t.receiverRoot, 'private.txt'), 'utf8')).toBe(
      'Not touched by transfer',
    );
    expect(await readFile(join(restored.target, 'src/binary.dat'))).toEqual(
      Buffer.from([0, 1, 128, 255, 13, 10]),
    );
    await mkdir('artifacts', { recursive: true });
    await t.scope.getByLabel('恢复结果记录').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/91-receiver-restore-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.screenshot({ path: 'artifacts/92-receiver-restore-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/93-receiver-restore-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await rename(restored.target, restored.target + '-moved');
    await page.reload();
    await page.getByRole('button', { name: '代码检查点', exact: true }).click();
    await page.getByRole('button', { name: '核验与本机保留', exact: true }).click();
    await page.getByRole('button', { name: '查看对象传输', exact: true }).click();
    const scope = page.getByLabel('接收副本恢复', { exact: true });
    await scope.getByRole('button', { name: '查看恢复记录', exact: true }).click();
    await expect(scope).toContainText('文件已发布（本机报告）');
    await expect(scope).toContainText('不证明目录现在存在');
  } finally {
    await f.close();
  }
});
test('接收副本拒绝发布与明确清理分别报告，历史保留且不完成原任务或重启模型', async ({ page }) => {
  const f = await setup(page);
  try {
    const t = await readyReceived(page, f);
    const cancelled = await receiverRestoreCli(t.receiverHome, t.id, 'restore', false);
    expect(cancelled.code).toBe(1);
    const reported = await receiverRestoreCli(t.receiverHome, t.id, 'report');
    expect(reported.code, reported.output).toBe(0);
    await expect(t.scope).toContainText('恢复已取消');
    await expect(t.scope).toContainText('暂存仍保留');
    const clean = await receiverRestoreCli(t.receiverHome, t.id, 'cleanup');
    expect(clean.code, clean.output).toBe(0);
    expect((await receiverRestoreCli(t.receiverHome, t.id, 'report')).code).toBe(0);
    await expect(t.scope).toContainText('本次暂存已清理');
    await t.scope.getByRole('button', { name: '查看报告历史', exact: true }).click();
    await expect(t.scope.getByLabel('恢复报告历史')).toContainText('报告 #2');
    await expect(t.scope.getByLabel('恢复报告历史')).toContainText('暂存仍保留');
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
test('接收恢复记录临时读错保留内容，权限失效清空来源及历史且不提供路径输入', async ({ page }) => {
  const f = await setup(page);
  try {
    const t = await readyReceived(page, f);
    expect((await receiverRestoreCli(t.receiverHome, t.id, 'restore')).code).toBe(0);
    expect((await receiverRestoreCli(t.receiverHome, t.id, 'report')).code).toBe(0);
    await expect(t.scope).toContainText('文件已发布');
    await t.scope.getByRole('button', { name: '查看报告历史', exact: true }).click();
    await page.route(t.resultPath, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'READ_FAILURE', message: '接收恢复记录暂时不可读' },
        }),
      }),
    );
    await expect(t.scope).toContainText('接收恢复记录暂时不可读');
    await expect(t.scope).toContainText('文件已发布');
    await page.unroute(t.resultPath);
    await t.scope.getByRole('button', { name: '重读恢复记录', exact: true }).click();
    await expect(t.scope.getByRole('alert')).toHaveCount(0);
    await page.route(t.resultPath, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '权限失效' } }),
      }),
    );
    await expect(t.scope).toContainText('恢复记录权限已失效，内容已清除');
    await expect(t.scope.getByLabel('恢复结果记录')).toHaveCount(0);
    await expect(t.scope.getByLabel('恢复报告历史')).toHaveCount(0);
    await expect(t.scope.getByRole('textbox')).toHaveCount(0);
  } finally {
    await page.unrouteAll();
    await f.close();
  }
});

async function prepareHandoff(page: Page, browser: Browser) {
  const f = await setup(page),
    receiverContext = await browser.newContext();
  try {
    const recipientPage = await receiverContext.newPage();
    const invitation = await post(
      page,
      `spaces/${f.space.id}/invitations`,
      { email: `handoff-${randomUUID()}@example.invalid` },
      f.space.id,
    );
    await post(recipientPage, 'identity/join', {
      token: invitation.token,
      name: '接手同事',
      password,
    });
    const joined = await (await recipientPage.request.get(origin + '/api/v1/identity')).json();
    await post(
      page,
      `projects/${f.task.projectId}/members/${joined.user.id}`,
      { role: 'edit' },
      f.space.id,
    );
    const t = await prepareTransfer(page, f, recipientPage);
    await t.panel.getByRole('button', { name: '创建传输请求', exact: true }).click();
    await expect(t.panel).toContainText('等待接收端本机同意');
    const transfer = (
      await (await page.request.get(t.path, { headers: headers(f.space.id) })).json()
    ).items[0];
    const id = transfer.ticket.id;
    for (const result of [
      await transferCli(t.receiverHome, id, 'accept', `RECEIVE ${id}\n`),
      await transferCli(f.home, id, 'send', `SEND ${id}\n`),
      await transferCli(t.receiverHome, id, 'receive'),
    ])
      expect(result.code, result.output).toBe(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '接手邀请', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '任务接手邀请' });
    await panel.getByRole('button', { name: '准备接手邀请', exact: true }).click();
    await panel.getByRole('combobox', { name: '接收者与已接收副本', exact: true }).selectOption(id);
    return {
      ...f,
      panel,
      recipientPage,
      recipientId: joined.user.id,
      transferId: id,
      receiverHome: t.receiverHome,
      path: `${origin}/api/v1/tasks/${f.task.id}/handoffs`,
      close: async () => {
        await receiverContext.close().catch(() => {});
        await f.close();
      },
    };
  } catch (error) {
    await receiverContext.close().catch(() => {});
    await f.close();
    throw error;
  }
}

test('正式接手邀请固定工作说明，丢失回执只确认原请求，另一成员可拒绝而不改变运行与负责人', async ({
  page,
  browser,
}) => {
  const f = await prepareHandoff(page, browser);
  try {
    await f.panel
      .getByRole('textbox', { name: '工作摘要', exact: true })
      .fill('继续接口改造，保留幂等回执');
    await f.panel.getByRole('textbox', { name: '剩余工作', exact: true }).fill('完成异常分支说明');
    let drop = true;
    await page.route(f.path, async (route) => {
      if (route.request().method() === 'POST' && drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await f.panel.getByRole('button', { name: '发布邀请', exact: true }).click();
    await expect(f.panel.getByLabel('接手邀请回执待确认')).toBeVisible();
    await expect(f.panel.getByRole('textbox', { name: '工作摘要', exact: true })).toHaveValue(
      '继续接口改造，保留幂等回执',
    );
    await f.panel.getByRole('button', { name: '确认上次邀请操作', exact: true }).click();
    await expect(f.panel.getByLabel('接手邀请记录')).toHaveCount(1);
    await expect(f.panel).toContainText('接收者需在本机核对原恢复目录');
    await expect(f.panel.getByRole('button', { name: '接受接手', exact: true })).toHaveCount(0);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/94-handoff-offer-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.screenshot({ path: 'artifacts/95-handoff-offer-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/96-handoff-offer-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await f.recipientPage.goto(origin);
    await f.recipientPage.getByLabel('当前工作空间', { exact: true }).selectOption(f.space.id);
    await f.recipientPage.goto(`${origin}/tasks/${f.task.id}`);
    await f.recipientPage.getByRole('button', { name: '接手邀请', exact: true }).click();
    const recipientPanel = f.recipientPage.getByRole('dialog', { name: '任务接手邀请' });
    await expect(recipientPanel).toContainText('继续接口改造，保留幂等回执');
    await recipientPanel.getByRole('button', { name: '拒绝邀请', exact: true }).click();
    await expect(f.panel).toContainText('已拒绝');
    await f.panel.getByRole('button', { name: '查看流转记录', exact: true }).click();
    await expect(f.panel.getByLabel('邀请流转记录')).toContainText('拒绝邀请 · 接手同事');
    const current = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(current.task.ownerUserId).toBe(f.task.ownerUserId);
    expect(current.task.revision).toBe(f.task.revision);
    expect(current.runs).toHaveLength(0);
    const list = await (await page.request.get(f.path, { headers: headers(f.space.id) })).json();
    expect(list.items).toHaveLength(1);
  } finally {
    await page.unrouteAll().catch(() => {});
    await f.close();
  }
});

test('接手邀请编辑保留暂时读错和版本冲突中的文字，确认撤权则清空草稿', async ({
  page,
  browser,
}) => {
  const f = await prepareHandoff(page, browser);
  try {
    await f.panel
      .getByRole('textbox', { name: '工作摘要', exact: true })
      .fill('编辑中的邀请，不应被轮询替换');
    await page.route(f.path + '/options', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TRANSIENT', message: '接手材料暂不可用' } }),
      }),
    );
    await expect(f.panel).toContainText('接手材料暂不可用');
    await expect(f.panel.getByRole('textbox', { name: '工作摘要', exact: true })).toHaveValue(
      '编辑中的邀请，不应被轮询替换',
    );
    await expect(f.panel.getByRole('button', { name: '发布邀请', exact: true })).toBeDisabled();
    await page.unroute(f.path + '/options');
    await f.panel.getByRole('button', { name: '重读接手材料', exact: true }).click();
    const update = await page.request.patch(`${origin}/api/v1/tasks/${f.task.id}`, {
      headers: headers(f.space.id),
      data: { expectedRevision: 1, title: '后续任务说明' },
    });
    expect(update.ok(), await update.text()).toBe(true);
    await expect(f.panel.getByLabel('邀请任务版本变化')).toBeVisible();
    await expect(f.panel.getByRole('button', { name: '发布邀请', exact: true })).toBeDisabled();
    await f.panel.getByRole('button', { name: '已核对当前任务与邀请内容', exact: true }).click();
    await expect(f.panel.getByRole('button', { name: '发布邀请', exact: true })).toBeEnabled();
    await page.route(f.path + '/options', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '当前权限失效' } }),
      }),
    );
    await expect(f.panel).toContainText('未保存内容已清除');
    await expect(f.panel.getByRole('textbox', { name: '工作摘要', exact: true })).toHaveCount(0);
    await page.unroute(f.path + '/options');
    await expect(f.panel.getByRole('button', { name: '准备接手邀请', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '接手邀请', exact: true }).click();
    await f.panel.getByRole('button', { name: '准备接手邀请', exact: true }).click();
    await expect(f.panel.getByRole('textbox', { name: '工作摘要', exact: true })).toHaveValue(
      '后续任务说明',
    );
  } finally {
    await page.unrouteAll().catch(() => {});
    await f.close();
  }
});

async function recipientAcceptance(f: Awaited<ReturnType<typeof prepareHandoff>>) {
  const items = (
    await (await f.recipientPage.request.get(f.path, { headers: headers(f.space.id) })).json()
  ).items;
  const id = items[0].handoff.id as string;
  await f.recipientPage.goto(origin);
  await f.recipientPage.getByLabel('当前工作空间', { exact: true }).selectOption(f.space.id);
  await f.recipientPage.goto(`${origin}/tasks/${f.task.id}`);
  await f.recipientPage.getByRole('button', { name: '接手邀请', exact: true }).click();
  const panel = f.recipientPage.getByRole('dialog', { name: '任务接手邀请' });
  await panel.getByRole('button', { name: '接受接手', exact: true }).click();
  await panel.getByRole('button', { name: '核对并接受', exact: true }).click();
  return { panel, path: `${f.path}/${id}` };
}
async function acceptanceCli(home: string, operationId: string, target: string) {
  const child = spawn(
    process.execPath,
    [
      resolve('dist/apps/runner/src/accept-handoff.js'),
      '--state',
      home,
      '--operation',
      operationId,
      '--target',
      target,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  let output = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (output += v));
  child.stdin.end(`ACCEPT ${operationId}\n`);
  const [code] = await once(child, 'close');
  return { code, output };
}

test('接受接手经本机真实文件核验，原请求回执与可选负责人移交一起落盘且不启动Run', async ({
  page,
  browser,
}) => {
  const f = await prepareHandoff(page, browser);
  try {
    await f.panel.getByRole('checkbox', { name: /同时邀请对方担任负责人/ }).check();
    await f.panel.getByRole('button', { name: '发布邀请', exact: true }).click();
    await expect(f.panel.getByLabel('接手邀请记录')).toHaveCount(1);
    const restored = await receiverRestoreCli(f.receiverHome, f.transferId, 'restore');
    expect(restored.code, restored.output).toBe(0);
    const r = await recipientAcceptance(f);
    await r.panel.getByRole('checkbox', { name: /我同时接受负责人职责/ }).check();
    let drop = true;
    await f.recipientPage.route(r.path + '/accept', async (route) => {
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await r.panel.getByRole('button', { name: '开始本机确认', exact: true }).click();
    await expect(r.panel.getByLabel('接手确认回执待确认')).toBeVisible();
    await r.panel.getByRole('button', { name: '确认上次接手请求', exact: true }).click();
    await expect(r.panel.getByLabel('接手确认记录')).toHaveCount(1);
    await expect(r.panel).toContainText('等待接收节点本机确认');
    const records = await (
      await f.recipientPage.request.get(r.path + '/acceptances', { headers: headers(f.space.id) })
    ).json();
    const op = records.items[0];
    expect(op.state).toBe('waiting_local');
    await expect(r.panel.getByLabel('本机接手确认命令')).toContainText(op.ticket.id);
    const accepted = await acceptanceCli(f.receiverHome, op.ticket.id, restored.target);
    expect(accepted.code, accepted.output).toBe(0);
    await expect(r.panel.getByLabel('接手确认记录')).toContainText('接手已提交');
    await expect(r.panel.getByLabel('接手邀请记录')).toContainText('已接受接手');
    const detail = await (
      await f.recipientPage.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(detail.task.operatorUserId).toBe(f.recipientId);
    expect(detail.task.ownerUserId).toBe(f.recipientId);
    expect(detail.runs).toHaveLength(0);
    await f.recipientPage.emulateMedia({ reducedMotion: 'reduce' });
    await mkdir('artifacts', { recursive: true });
    await f.recipientPage.screenshot({
      path: 'artifacts/97-handoff-accepted-dark.png',
      fullPage: true,
    });
    await f.recipientPage.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await f.recipientPage.screenshot({
      path: 'artifacts/98-handoff-accepted-light.png',
      fullPage: true,
    });
    await f.recipientPage.setViewportSize({ width: 390, height: 844 });
    await f.recipientPage.screenshot({
      path: 'artifacts/99-handoff-accepted-mobile.png',
      fullPage: true,
    });
    expect(
      await f.recipientPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await f.recipientPage.keyboard.press('Escape');
    await expect(f.recipientPage.getByLabel('当前操作者', { exact: true })).toContainText(
      '接手同事',
    );
  } finally {
    await f.recipientPage.unrouteAll().catch(() => {});
    await f.close();
  }
});

test('接受接手固定当前讨论，撤权暂停原确认且权限恢复不自动接受，编辑者可取消', async ({
  page,
  browser,
}) => {
  const f = await prepareHandoff(page, browser);
  try {
    await f.panel.getByRole('button', { name: '发布邀请', exact: true }).click();
    await expect(f.panel.getByLabel('接手邀请记录')).toHaveCount(1);
    const r = await recipientAcceptance(f);
    await expect(r.panel.getByRole('button', { name: '开始本机确认', exact: true })).toBeEnabled();
    await post(
      page,
      `tasks/${f.task.id}/messages`,
      { body: '接手之前请先核对新的异常处理要求' },
      f.space.id,
    );
    await expect(r.panel.getByLabel('接手确认内容变化')).toBeVisible();
    await expect(r.panel.getByRole('button', { name: '开始本机确认', exact: true })).toBeDisabled();
    await r.panel.getByRole('button', { name: '已核对最新接手内容', exact: true }).click();
    await r.panel.getByRole('button', { name: '开始本机确认', exact: true }).click();
    await expect(r.panel).toContainText('等待接收节点本机确认');
    await post(
      page,
      `projects/${f.task.projectId}/members/${f.recipientId}`,
      { role: 'view' },
      f.space.id,
    );
    await expect(r.panel).toContainText('接手确认需要重新核对');
    await expect(r.panel.getByLabel('本机接手确认命令')).toHaveCount(0);
    await post(
      page,
      `projects/${f.task.projectId}/members/${f.recipientId}`,
      { role: 'edit' },
      f.space.id,
    );
    await expect(r.panel).toContainText('接手确认需要重新核对');
    await f.panel.getByRole('button', { name: '查看接手处理', exact: true }).click();
    await f.panel.getByRole('button', { name: '取消这次接手确认', exact: true }).click();
    await expect(r.panel).toContainText('接手确认已取消');
    const task = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(task.task.operatorUserId).toBeUndefined();
    expect(task.runs).toHaveLength(0);
  } finally {
    await f.close();
  }
});

async function acceptedWorkspace(page: Page, browser: Browser) {
  const f = await prepareHandoff(page, browser);
  try {
    await f.panel.getByRole('button', { name: '发布邀请', exact: true }).click();
    const restored = await receiverRestoreCli(f.receiverHome, f.transferId, 'restore');
    expect(restored.code, restored.output).toBe(0);
    const r = await recipientAcceptance(f);
    await r.panel.getByRole('button', { name: '开始本机确认', exact: true }).click();
    await expect(r.panel).toContainText('等待接收节点本机确认');
    const op = (
      await (
        await f.recipientPage.request.get(r.path + '/acceptances', { headers: headers(f.space.id) })
      ).json()
    ).items[0];
    const result = await acceptanceCli(f.receiverHome, op.ticket.id, restored.target);
    expect(result.code, result.output).toBe(0);
    await r.panel.getByRole('button', { name: '准备接手现场研发', exact: true }).click();
    return { ...f, receiverPanel: r.panel, op, target: restored.target };
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function workspaceCommand(entry: string, args: string[], input: string) {
  const child = spawn(process.execPath, [resolve('dist/apps/runner/src/' + entry), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'sk-ant-handoff-browser-protocol-fixture-not-a-real-key',
    },
  });
  let output = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (output += v));
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  expect(code, output).toBe(0);
  return output;
}

test('接手现场经Git准备、本人配对和执行授权后，在原任务网页创建新Run', async ({
  page,
  browser,
}) => {
  const f = await acceptedWorkspace(page, browser);
  let storage: AgentStorage | undefined,
    connection: AgentConnection | undefined,
    executor: NodeExecutor | undefined;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  try {
    const guide = f.receiverPanel.getByLabel('接手现场研发', { exact: true });
    await expect(guide.getByLabel('接手Git准备命令')).toContainText(f.op.ticket.id);
    await expect(guide).toContainText('网页尚未获知本机准备结果');
    await workspaceCommand(
      'prepare-handoff-workspace.js',
      ['prepare', '--state', f.receiverHome, '--operation', f.op.ticket.id, '--target', f.target],
      `GIT ${f.op.ticket.id}\n`,
    );
    const p = readGitWorkspaceProgress(f.receiverHome, f.op.ticket.id)!;
    expect(p.state).toBe('ready');
    await guide.getByRole('button', { name: '生成原项目配对码', exact: true }).click();
    const field = guide.getByLabel('接手现场配对码', { exact: true });
    await expect(field).toHaveAttribute('type', 'password');
    const code = await field.inputValue();
    await workspaceCommand(
      'cli.js',
      ['connect', '--state', p.nodeState!, '--config', p.configPath!],
      `${code}\nCONNECT\n`,
    );
    const executable = join(f.dir, 'handoff-claude-protocol-fixture.mjs');
    await writeFile(
      executable,
      `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/native-tool.js')).href)});\n`,
    );
    await chmod(executable, 0o700);
    const execution = join(f.dir, 'handoff-execution.json');
    await writeFile(
      execution,
      JSON.stringify({
        tool: 'claude-code',
        executable,
        mode: 'edit',
        workspaces: ['接手代码'],
        timeoutSeconds: 30,
        maxBudgetUsd: 1,
      }),
    );
    await workspaceCommand(
      'cli.js',
      ['enable-execution', '--state', p.nodeState!, '--config', execution],
      'EXECUTE\n',
    );
    process.env.ANTHROPIC_API_KEY = 'sk-ant-handoff-browser-protocol-fixture-not-a-real-key';
    storage = new AgentStorage(p.nodeState!);
    connection = new AgentConnection(storage);
    executor = new NodeExecutor(connection);
    await connection.cycle();
    await executor.tick();
    await expect(guide).toContainText('节点已配对');
    await expect(field).toHaveCount(0);
    await guide.getByRole('button', { name: '查看节点并准备新 Run', exact: true }).click();
    const run = f.recipientPage.getByRole('dialog', { name: '在我的节点上执行', exact: true });
    const credentials = readCredentials(p.nodeState!);
    await run.getByLabel('执行节点', { exact: true }).selectOption(credentials.nodeId!);
    await run
      .getByLabel('授权工作目录', { exact: true })
      .selectOption(credentials.directories[0]!.id);
    await run.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
    await run.getByLabel('本次要求', { exact: true }).fill('FIXTURE_WRITE');
    await run.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await run.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect(run).toHaveCount(0);
    await expect
      .poll(async () => {
        await connection!.cycle();
        await executor!.tick();
        return (
          await (
            await f.recipientPage.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
              headers: headers(f.space.id),
            })
          ).json()
        ).runs[0]?.state;
      })
      .toBe('succeeded');
    expect(await readFile(join(f.target, 'native-output.txt'), 'utf8')).toBe('fixture edit\n');
    await f.recipientPage.keyboard.press('Escape');
    await f.recipientPage.reload();
    await expect(f.recipientPage.getByLabel('当前操作者', { exact: true })).toContainText(
      '接手同事',
    );
    await expect(f.recipientPage.locator('main')).toContainText(
      `接手现场 ${f.op.ticket.id.slice(0, 8)}`,
    );
  } finally {
    await executor?.close();
    await connection?.goodbye();
    storage?.close();
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
    await f.close();
  }
});

test('接手研发配对丢失回执不泄露或重复生成，关闭与降权清空临时码', async ({ page, browser }) => {
  const f = await acceptedWorkspace(page, browser);
  try {
    const guide = f.receiverPanel.getByLabel('接手现场研发', { exact: true });
    const requests: string[] = [];
    let drop = true;
    await f.recipientPage.route(`${origin}/api/v1/nodes/pairings`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().headers()['idempotency-key']!);
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await guide.getByRole('button', { name: '生成原项目配对码', exact: true }).click();
    await guide.getByRole('button', { name: '确认上次配对请求', exact: true }).click();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    await expect(guide).toContainText('无法从回执或刷新恢复');
    await expect(guide.getByLabel('接手现场配对码', { exact: true })).toHaveCount(0);
    await guide.getByRole('button', { name: '取消这次配对', exact: true }).click();
    await guide.getByRole('button', { name: '生成原项目配对码', exact: true }).click();
    await expect(guide.getByLabel('接手现场配对码', { exact: true })).toHaveValue(
      /^[A-Za-z0-9_-]{43}$/,
    );
    await guide.getByRole('button', { name: '收起研发准备', exact: true }).click();
    await guide.getByRole('button', { name: '准备接手现场研发', exact: true }).click();
    await expect(guide.getByLabel('接手现场配对码', { exact: true })).toHaveCount(0);
    await guide.getByRole('button', { name: '生成原项目配对码', exact: true }).click();
    await expect(guide.getByLabel('接手现场配对码', { exact: true })).toHaveCount(1);
    await mkdir('artifacts', { recursive: true });
    // Mask the one-time code even for fictional test identities.
    await f.recipientPage.screenshot({
      path: 'artifacts/100-handoff-workspace-dark.png',
      fullPage: true,
      mask: [guide.getByLabel('接手现场配对码', { exact: true })],
    });
    await f.recipientPage.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await f.recipientPage.screenshot({
      path: 'artifacts/101-handoff-workspace-light.png',
      fullPage: true,
      mask: [guide.getByLabel('接手现场配对码', { exact: true })],
    });
    await f.recipientPage.setViewportSize({ width: 390, height: 844 });
    await f.recipientPage.screenshot({
      path: 'artifacts/102-handoff-workspace-mobile.png',
      fullPage: true,
      mask: [guide.getByLabel('接手现场配对码', { exact: true })],
    });
    expect(
      await f.recipientPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await post(
      page,
      `projects/${f.task.projectId}/members/${f.recipientId}`,
      { role: 'view' },
      f.space.id,
    );
    await expect(guide).toHaveCount(0);
    await expect(f.receiverPanel.getByLabel('接手确认记录')).toContainText('接手已提交');
  } finally {
    await f.recipientPage.unrouteAll().catch(() => {});
    await f.close();
  }
});

async function branchEditor(page: Page, f: Fixture) {
  await prepare(page, f);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '方案分支', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '任务方案分支', exact: true });
  await panel.getByRole('button', { name: '定义一组方案', exact: true }).click();
  const checkpointId = (await pending(page, f)).checkpointId;
  await panel.getByLabel('共同提交引用', { exact: true }).selectOption(checkpointId);
  await panel.getByLabel('方案 1 目标', { exact: true }).fill('分批同步读取订单');
  await panel.getByLabel('方案 2 目标', { exact: true }).fill('采用后台异步任务');
  return panel;
}
test('方案分支固定真实共同提交，未知回执不重复创建，刷新和放弃各自保留历史', async ({ page }) => {
  const f = await setup(page);
  try {
    const panel = await branchEditor(page, f);
    const path = `${origin}/api/v1/tasks/${f.task.id}/work-branches`;
    const requests: { key: string; body: unknown }[] = [];
    await panel.getByLabel('方案 2 名称', { exact: true }).fill('方案 A');
    await expect(panel).toContainText('同组方案名称不能重复');
    await expect(panel.getByRole('button', { name: '保存方案组', exact: true })).toBeDisabled();
    await panel.getByLabel('方案 2 名称', { exact: true }).fill('方案 B');
    let drop = true;
    await page.route(path, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push({
        key: route.request().headers()['idempotency-key']!,
        body: route.request().postDataJSON(),
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await panel.getByRole('button', { name: '保存方案组', exact: true }).click();
    await expect(panel.getByLabel('方案请求待确认', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('方案 1 目标', { exact: true })).toHaveValue('分批同步读取订单');
    await panel.getByRole('button', { name: '确认上次方案请求', exact: true }).click();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    await expect(panel.getByLabel('共同起点方案组', { exact: true })).toHaveCount(1);
    const a = panel.getByRole('article', { name: '方案：方案 A', exact: true });
    const b = panel.getByRole('article', { name: '方案：方案 B', exact: true });
    await expect(a).toContainText('待准备');
    await expect(b).toContainText('尚无独立目录、Run 或结果');
    await panel.getByText('共同起点与范围', { exact: true }).click();
    await expect(panel).toContainText(f.oid);
    await a.getByRole('button', { name: '放弃此方案', exact: true }).click();
    await expect(a).toContainText('已放弃');
    await expect(b).toContainText('待准备');
    await a.getByRole('button', { name: '查看方案历史', exact: true }).click();
    await expect(a.getByLabel('方案历史', { exact: true })).toContainText('定义方案');
    await expect(a.getByLabel('方案历史', { exact: true })).toContainText('放弃方案');
    await mkdir('artifacts', { recursive: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: 'artifacts/103-work-branches-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/104-work-branches-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await expect(a).toContainText('已放弃');
    await expect(b).toContainText('采用后台异步任务');
    const detail = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(detail.runs).toHaveLength(0);
    expect(detail.task.revision).toBe(1);
    expect(await readFile(join(f.root, 'README.md'), 'utf8')).toBe(
      'Not included in the reference\n',
    );
  } finally {
    await page.unrouteAll().catch(() => {});
    await f.close();
  }
});

test('方案编辑固定任务基线，暂时读错保留目标，明确失权清空编辑与只读历史', async ({ page }) => {
  const f = await setup(page);
  try {
    const panel = await branchEditor(page, f);
    const path = `${origin}/api/v1/tasks/${f.task.id}/work-branches`;
    const changed = await page.request.patch(`${origin}/api/v1/tasks/${f.task.id}`, {
      headers: headers(f.space.id),
      data: { expectedRevision: 1, description: '导出必须包含新增的退款字段' },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect(panel.getByLabel('共同任务版本变化')).toContainText('退款字段');
    await expect(panel.getByRole('button', { name: '保存方案组', exact: true })).toBeDisabled();
    await expect(panel.getByLabel('方案 2 目标', { exact: true })).toHaveValue('采用后台异步任务');
    await panel.getByRole('button', { name: '已核对共同任务说明', exact: true }).click();
    await page.route(path + '/options', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEMPORARY', message: '方案起点暂时不可读' } }),
      }),
    );
    await expect(panel).toContainText('方案起点暂时不可读');
    await expect(panel.getByLabel('方案 1 目标', { exact: true })).toHaveValue('分批同步读取订单');
    await page.unroute(path + '/options');
    await panel.getByRole('button', { name: '重读共同起点', exact: true }).click();
    await expect(panel.getByRole('button', { name: '保存方案组', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '保存方案组', exact: true }).click();
    await expect(panel.getByLabel('共同起点方案组', { exact: true })).toHaveCount(1);
    await panel.getByRole('button', { name: '定义一组方案', exact: true }).click();
    await panel.getByLabel('方案 1 目标', { exact: true }).fill('临时私有目标');
    await page.route(path + '/options', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '编辑权限失效' } }),
      }),
    );
    await expect(panel).toContainText('临时方案已清除');
    await expect(panel.getByLabel('方案定义编辑', { exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('共同起点方案组', { exact: true })).toHaveCount(1);
    await page.route(path, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: '任务不可访问' } }),
      }),
    );
    await expect(panel).toContainText('方案读取权限已失效');
    await expect(panel.getByLabel('共同起点方案组', { exact: true })).toHaveCount(0);
  } finally {
    await page.unrouteAll().catch(() => {});
    await f.close();
  }
});

async function readyBranchSource(page: Page, f: Fixture) {
  const state = await prepare(page, f);
  const source = await post(
    page,
    state.path.replace(origin + '/api/v1/', ''),
    { days: 7, expectedTaskRevision: 1, confirmLocalRetention: true },
    f.space.id,
  );
  const retained = await cli(f, source.request.id, 'retain-checkpoint', `RETAIN ${f.oid} 7`);
  expect(retained.code, retained.output).toBe(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '方案分支', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '任务方案分支', exact: true });
  await panel.getByRole('button', { name: '定义一组方案', exact: true }).click();
  await panel
    .getByLabel('共同提交引用', { exact: true })
    .selectOption((await pending(page, f)).checkpointId);
  await panel.getByLabel('方案 1 目标', { exact: true }).fill('独立目录实现订单读取');
  await panel.getByLabel('方案 2 目标', { exact: true }).fill('另一个方案保持待准备');
  await panel.getByRole('button', { name: '保存方案组', exact: true }).click();
  const card = panel.getByRole('article', { name: '方案：方案 A', exact: true });
  await card.getByRole('button', { name: '准备独立现场', exact: true }).click();
  await card.getByLabel('原对象副本', { exact: true }).selectOption(source.request.id);
  return { panel, card, source };
}
async function prepareBranchCli(home: string, operationId: string, target: string) {
  const child = spawn(
    process.execPath,
    [
      resolve('dist/apps/runner/src/prepare-branch-workspace.js'),
      'prepare',
      '--state',
      home,
      '--operation',
      operationId,
      '--target',
      target,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  let output = '';
  const answered = new Set<string>();
  child.stdout.on('data', (v) => {
    output += v;
    for (const match of output.matchAll(/(?:BRANCH|RESTORE|PUBLISH|GIT) [0-9a-f-]{36}/g)) {
      if (answered.has(match[0])) continue;
      answered.add(match[0]);
      child.stdin.write(match[0] + '\n');
    }
  });
  child.stderr.on('data', (v) => (output += v));
  const [code] = await once(child, 'close');
  expect(code, output).toBe(0);
  return readBranchWorkspaceStatus(home, operationId)!;
}
test('方案独立现场通过实际CLI准备/配对/登记，网页授权首轮Run并保留另一方案', async ({ page }) => {
  test.setTimeout(90000); // Full file preparation, three CLI confirmations and a real protocol process.
  const f = await setup(page);
  let agent: ReturnType<typeof spawn> | undefined, finished: Promise<unknown> | undefined;
  let output = '';
  try {
    const { panel, card } = await readyBranchSource(page, f);
    await card.getByRole('button', { name: '创建现场准备请求', exact: true }).click();
    await expect(card).toContainText('等待本人本机准备');
    const list = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}/work-branches`, {
        headers: headers(f.space.id),
      })
    ).json();
    const branch = list.items[0].branches[0],
      op = branch.workspace;
    await expect(card.getByLabel('方案现场准备命令')).toContainText(op.ticket.id);
    const target = join(f.dir, 'parallel-alpha');
    const prepared = await prepareBranchCli(f.home, op.ticket.id, target);
    await expect(card).toContainText('现场已报告');
    await card.getByText('本机现场操作', { exact: true }).click();
    // Details may remain open from the waiting stage; ensure the pairing action is visible.
    if (!(await card.getByRole('button', { name: '生成原项目配对码', exact: true }).isVisible()))
      await card.getByText('本机现场操作', { exact: true }).click();
    await card.getByRole('button', { name: '生成原项目配对码', exact: true }).click();
    const code = await card.getByLabel('方案现场配对码', { exact: true }).inputValue();
    await workspaceCommand(
      'cli.js',
      ['connect', '--state', prepared.git!.nodeState!, '--config', prepared.git!.configPath!],
      `${code}\nCONNECT\n`,
    );
    await workspaceCommand(
      'prepare-branch-workspace.js',
      ['bind', '--state', prepared.git!.nodeState!],
      `BIND ${branch.id}\n`,
    );
    await expect(card).toContainText('独立现场已登记');
    const executable = join(f.dir, 'branch-browser-claude-protocol-fixture.mjs');
    await writeFile(
      executable,
      `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/native-tool.js')).href)});\n`,
    );
    await chmod(executable, 0o700);
    const config = join(f.dir, 'branch-execution.json');
    await writeFile(
      config,
      JSON.stringify({
        tool: 'claude-code',
        executable,
        mode: 'edit',
        workspaces: ['方案代码'],
        timeoutSeconds: 30,
        maxBudgetUsd: 1,
      }),
    );
    await workspaceCommand(
      'cli.js',
      ['enable-execution', '--state', prepared.git!.nodeState!, '--config', config],
      'EXECUTE\n',
    );
    agent = spawn(
      process.execPath,
      [resolve('dist/apps/runner/src/cli.js'), 'start', '--state', prepared.git!.nodeState!],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ANTHROPIC_API_KEY: 'sk-ant-branch-browser-protocol-fixture-not-a-real-key',
        },
      },
    );
    agent.stdout!.on('data', (v) => (output = (output + v).slice(-16000)));
    agent.stderr!.on('data', (v) => (output = (output + v).slice(-16000)));
    finished = once(agent, 'close');
    await card.getByRole('button', { name: '准备方案首轮执行', exact: true }).click();
    const run = page.getByRole('dialog', { name: '在方案节点上执行', exact: true });
    await expect(run.getByLabel('执行节点', { exact: true })).toBeDisabled();
    await expect(run.getByLabel('授权工作目录', { exact: true })).toBeDisabled();
    await expect(run.getByLabel('本次要求', { exact: true })).toHaveValue('独立目录实现订单读取');
    await run.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
    await run.getByLabel('本次要求', { exact: true }).fill('FIXTURE_CAPTURE_INPUT FIXTURE_WRITE');
    await run.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
    await run.getByRole('button', { name: '在节点上开始', exact: true }).click();
    await expect(run).toHaveCount(0);
    await expect
      .poll(
        async () => {
          return (
            await (
              await page.request.get(`${origin}/api/v1/tasks/${f.task.id}/work-branches`, {
                headers: headers(f.space.id),
              })
            ).json()
          ).items[0].branches[0].run?.state;
        },
        { timeout: 20000 },
      )
      .toBe('succeeded');
    await expect(card.getByLabel('独立节点执行进度')).toContainText('已确认结束');
    await expect(panel.getByRole('article', { name: '方案：方案 B', exact: true })).toContainText(
      '尚无独立目录、Run 或结果',
    );
    expect(await readFile(join(target, 'native-output.txt'), 'utf8')).toBe('fixture edit\n');
    expect(await readFile(join(f.root, 'README.md'), 'utf8')).toBe(
      'Not included in the reference\n',
    );
    const input = await readFile(join(target, 'received-context.txt'), 'utf8');
    expect(input).toContain('独立目录实现订单读取');
    expect(input).not.toContain('另一个方案保持待准备');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/105-branch-workspace-dark.png', fullPage: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/106-branch-workspace-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await page.getByRole('button', { name: '方案分支', exact: true }).click();
    await expect(card.getByLabel('独立节点执行进度')).toContainText('已确认结束');
  } finally {
    if (agent?.exitCode === null && agent.signalCode === null) agent.kill('SIGTERM');
    await finished;
    if (test.info().status !== test.info().expectedStatus)
      await test.info().attach('branch-agent.log', { body: output, contentType: 'text/plain' });
    await f.close();
  }
});
test('方案现场请求未知回执保留原选择，重复确认和取消不重建现场', async ({ page }) => {
  const f = await setup(page);
  try {
    const { card, source } = await readyBranchSource(page, f);
    const values = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}/work-branches`, {
        headers: headers(f.space.id),
      })
    ).json();
    const id = values.items[0].branches[0].id,
      path = `${origin}/api/v1/tasks/${f.task.id}/work-branches/${id}/workspaces`;
    let drop = true;
    const keys: string[] = [];
    await page.route(path, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push(route.request().headers()['idempotency-key']!);
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await card.getByRole('button', { name: '创建现场准备请求', exact: true }).click();
    await expect(card.getByLabel('现场请求待确认')).toBeVisible();
    await expect(card.getByLabel('原对象副本', { exact: true })).toHaveValue(source.request.id);
    await card.getByRole('button', { name: '确认上次现场请求', exact: true }).click();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(card).toContainText('等待本人本机准备');
    await card.getByRole('button', { name: '取消此现场准备', exact: true }).click();
    await expect(card).toContainText('现场准备已取消');
    await expect(card.getByRole('button', { name: '准备独立现场', exact: true })).toBeVisible();
    const detail = await (
      await page.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
        headers: headers(f.space.id),
      })
    ).json();
    expect(detail.runs).toHaveLength(0);
  } finally {
    await page.unrouteAll().catch(() => {});
    await f.close();
  }
});
