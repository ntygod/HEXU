import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:4311';
const password = 'Fictional Browser Password 2026!';
const setupCode = 'fictional-browser-setup-code-not-real-0123456789';
const ownerEmail = 'owner-browser@example.invalid';
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
async function loginOwner(page: Page) {
  const info = await (await page.request.get(`${origin}/api/v1/identity`)).json();
  if (info.setupRequired)
    await post(page, 'identity/setup', {
      name: '林舟（测试）',
      email: ownerEmail,
      password,
      code: setupCode,
    });
  else await post(page, 'identity/sign-in', { email: ownerEmail, password });
  return (await (await page.request.get(`${origin}/api/v1/identity`)).json()).user;
}
async function select(page: Page, id: string) {
  await page.getByLabel('当前工作空间', { exact: true }).selectOption(id);
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(id);
}
async function createTaskUI(page: Page, title: string) {
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.getByLabel('要做什么', { exact: true }).fill(title);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

test('真实账号建立、邀请同事、项目只读转编辑与个人隔离，包含浅深色窄屏', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    member = await memberContext.newPage();
  try {
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: '建立你的第一个账号' })).toBeVisible();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/16-team-account-entry.png', fullPage: true });
    await page.getByLabel('你的名字', { exact: true }).fill('林舟（测试）');
    await page.getByLabel('邮箱', { exact: true }).fill(ownerEmail);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByLabel('初始化代码', { exact: true }).fill(setupCode);
    await page.getByRole('button', { name: '创建账号并开始' }).click();
    await expect(page.getByLabel('当前工作空间')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const privateId = await createTaskUI(page, '仅属于我的私有探索');
    await page.goto(origin + '/settings');
    await page.getByLabel('团队空间名称', { exact: true }).fill('合序产品研发（测试）');
    await page.getByRole('button', { name: '创建空间', exact: true }).click();
    await expect(page.getByLabel('当前工作空间')).not.toHaveValue(/^personal-/);
    const spaceId = await page.getByLabel('当前工作空间').inputValue();
    await page.goto(origin + '/settings');
    await page.getByLabel('受邀邮箱', { exact: true }).fill('member-browser@example.invalid');
    await page.getByRole('button', { name: '生成邀请链接', exact: true }).click();
    const invitation = await page.getByLabel('邀请链接', { exact: true }).inputValue();
    await member.goto(invitation);
    await member.getByLabel('你的名字', { exact: true }).fill('许宁（测试）');
    await expect(member.getByLabel('邮箱', { exact: true })).toHaveValue(
      'member-browser@example.invalid',
    );
    await member.getByLabel('密码', { exact: true }).fill(password);
    await member.getByRole('button', { name: '创建账号并加入' }).click();
    await expect(member.getByLabel('当前工作空间')).toHaveValue(spaceId);
    const denied = await member.request.get(`${origin}/api/v1/tasks/${privateId}`, {
      headers: headers(spaceId),
    });
    expect(denied.status()).toBe(404);
    await page.goto(origin + '/projects');
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('客户门户（测试）');
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '客户门户（测试）', exact: true }),
    ).toBeVisible();
    const projectURL = page.url();
    await page.locator('.project-access summary').click();
    await page.getByLabel('添加空间成员', { exact: true }).selectOption({ label: '许宁（测试）' });
    await page.getByLabel('访问权限', { exact: true }).selectOption('view');
    await page.getByRole('button', { name: '添加项目成员', exact: true }).click();
    await expect(page.getByLabel('许宁（测试）的项目权限', { exact: true })).toHaveValue('view');
    const taskId = await createTaskUI(page, '共同实现订单筛选');
    await member.goto(`${origin}/tasks/${taskId}`);
    await expect(
      member.getByRole('heading', { name: '共同实现订单筛选', exact: true }),
    ).toBeVisible();
    await expect(member.getByRole('button', { name: '编辑工作说明', exact: true })).toBeDisabled();
    await expect(member.getByRole('button', { name: '在节点上执行', exact: true })).toBeDisabled();
    await page.goto(projectURL);
    await page.locator('.project-access summary').click();
    await page.getByLabel('许宁（测试）的项目权限', { exact: true }).selectOption('edit');
    await expect(member.getByLabel('任务评论', { exact: true })).toBeVisible();
    await member.getByLabel('任务评论', { exact: true }).fill('我已补充筛选条件，接下来一起推进。');
    await member.getByRole('button', { name: '发送评论', exact: true }).click();
    await page.goto(`${origin}/tasks/${taskId}`);
    await expect(
      page.locator('.message-content').filter({ hasText: '我已补充筛选条件' }),
    ).toBeVisible();
    await page.goto(projectURL);
    await page.locator('.project-access summary').click();
    await page.screenshot({ path: 'artifacts/17-team-project-access.png', fullPage: true });
    await page.goto(origin + '/settings');
    await expect(page.getByRole('heading', { name: '空间与账号', exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/18-team-members.png', fullPage: true });
    await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/19-team-mobile-dark.png', fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: '空间与账号', exact: true })).toBeVisible();
  } finally {
    await memberContext.close();
  }
});

async function preparedPair(owner: Page, member: Page, suffix: string) {
  await loginOwner(owner);
  const space = await post(owner, 'spaces', { name: `权限测试 ${suffix}` });
  const invite = await post(
    owner,
    `spaces/${space.id}/invitations`,
    { email: `member-${suffix}@example.invalid` },
    space.id,
  );
  await post(member, 'identity/join', {
    token: invite.token,
    name: `测试成员 ${suffix}`,
    password,
  });
  const memberIdentity = (await (await member.request.get(`${origin}/api/v1/identity`)).json())
    .user;
  const project = await post(
    owner,
    `spaces/${space.id}/projects`,
    { name: `项目 ${suffix}` },
    space.id,
  );
  await post(
    owner,
    `projects/${project.id}/members/${memberIdentity.id}`,
    { role: 'edit' },
    space.id,
  );
  const task = await post(
    owner,
    `spaces/${space.id}/tasks`,
    { title: `受限任务 ${suffix}`, projectId: project.id },
    space.id,
  );
  await member.goto(origin);
  await select(member, space.id);
  await member.goto(`${origin}/tasks/${task.id}`);
  await expect(member.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  return { space, project, task, memberIdentity };
}

test('撤销项目权限清除已打开的任务，移除成员后返回个人空间', async ({ page, browser }) => {
  const context = await browser.newContext(),
    member = await context.newPage();
  try {
    const f = await preparedPair(page, member, 'revoke');
    await post(
      page,
      `projects/${f.project.id}/members/${f.memberIdentity.id}`,
      { role: null },
      f.space.id,
    );
    await expect(member.getByRole('heading', { name: f.task.title, exact: true })).toHaveCount(0);
    await expect(member.getByText('暂时无法打开任务', { exact: true })).toBeVisible();
    await post(page, `spaces/${f.space.id}/members/${f.memberIdentity.id}/remove`, {}, f.space.id);
    await expect(member.getByLabel('当前工作空间')).toHaveValue(`personal-${f.memberIdentity.id}`);
    await member.reload();
    await expect(member.getByLabel('当前工作空间')).toHaveValue(`personal-${f.memberIdentity.id}`);
    expect(
      (
        await member.request.get(`${origin}/api/v1/tasks/${f.task.id}`, {
          headers: headers(f.space.id),
        })
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
  }
});

test('会话撤销清空旧工作台，真实重新登录和刷新恢复，不把凭证存入页面存储', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext(),
    member = await context.newPage();
  try {
    const f = await preparedPair(page, member, 'session');
    const jar = await context.cookies(origin);
    expect(jar.some((c) => c.name.includes('session_token') && c.httpOnly)).toBe(true);
    await post(member, 'identity/revoke-sessions', {});
    await expect(member.getByRole('heading', { name: '欢迎回到合序' })).toBeVisible();
    await expect(member.getByRole('heading', { name: f.task.title, exact: true })).toHaveCount(0);
    await member.screenshot({ path: 'artifacts/20-team-login.png', fullPage: true });
    await member.getByLabel('邮箱', { exact: true }).fill(f.memberIdentity.email);
    await member.getByLabel('密码', { exact: true }).fill(password);
    await member.getByRole('button', { name: '登录工作台', exact: true }).click();
    await expect(member.getByLabel('当前工作空间')).toHaveValue(f.space.id);
    await member.goto(`${origin}/tasks/${f.task.id}`);
    await member.reload();
    await expect(member.getByRole('heading', { name: f.task.title, exact: true })).toBeVisible();
    const storage = await member.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain(password);
    expect(storage).not.toContain('session_token');
    await member.goto(origin + '/settings');
    await member.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(member.getByRole('heading', { name: '欢迎回到合序' })).toBeVisible();
  } finally {
    await context.close();
  }
});
