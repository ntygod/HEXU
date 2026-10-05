import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  Project,
  Task,
  TaskDetail,
  User,
  Workbench,
} from '../../packages/contracts/src/index.js';
import type { IdentityState, IdentityUser, Space } from '../../packages/contracts/src/identity.js';
import type { TaskParticipantsView } from '../../packages/contracts/src/task-participants.js';

// Registered at the end of team.spec.ts so its original first-account setup
// remains first. These fictional accounts use the ordinary team-local fixture.
const origin = 'http://127.0.0.1:4311';
const password = 'Fictional Browser Password 2026!';
const ownerEmail = 'owner-browser@example.invalid';
const setupCode = 'fictional-browser-setup-code-not-real-0123456789';
const directoryPath = '/workbench/members';
const memberPath = (id: string) => `${directoryPath}/${encodeURIComponent(id)}`;
const taskSection = (page: Page) =>
  page.getByRole('region', { name: '负责与参与的任务', exact: true });
const rows = (page: Page) => taskSection(page).locator('a.member-work-task-row');
const taskRow = (page: Page, id: string) =>
  taskSection(page).locator(`a.member-work-task-row[href="/tasks/${id}"]`);
const more = (page: Page) =>
  taskSection(page).getByRole('button', { name: '显示更多', exact: true });
const collapse = (page: Page) =>
  taskSection(page).getByRole('button', { name: '收起', exact: true });
const memberLink = (page: Page, id: string) => page.locator(`main a[href="${memberPath(id)}"]`);

const headers = (spaceId?: string) => ({
  origin,
  'x-hexu-client': 'web',
  'idempotency-key': randomUUID(),
  ...(spaceId ? { 'x-hexu-space': spaceId } : {}),
});

async function get<T>(page: Page, path: string, spaceId?: string): Promise<T> {
  const response = await page.request.get(`${origin}/api/v1/${path}`, {
    headers: spaceId ? { 'x-hexu-space': spaceId } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function post<T>(page: Page, path: string, data: unknown, spaceId?: string): Promise<T> {
  const response = await page.request.post(`${origin}/api/v1/${path}`, {
    headers: headers(spaceId),
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function participate(
  page: Page,
  spaceId: string,
  taskId: string,
  userId: string,
  action: 'add' | 'remove',
) {
  const current = await get<TaskParticipantsView>(page, `tasks/${taskId}/participants`, spaceId);
  await post(
    page,
    `tasks/${taskId}/participants`,
    {
      expectedRevision: current.revision,
      userId,
      action,
    },
    spaceId,
  );
}

async function fixture(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('hexu-theme', 'dark'));
    // Full team runs create the owner earlier; a focused grep run uses the same
    // established ordinary first-account setup, without synthetic identity data.
    const initial = await get<IdentityState>(page, 'identity');
    if (initial.setupRequired)
      await post(page, 'identity/setup', {
        name: '林舟（测试）',
        email: ownerEmail,
        password,
        code: setupCode,
      });
    else await post(page, 'identity/sign-in', { email: ownerEmail, password });
    const identity = await get<IdentityState>(page, 'identity');
    expect(identity.user).not.toBeNull();
    const owner = identity.user!;
    const space = await post<Space>(page, 'spaces', { name: '成员工作浏览（测试）' });
    const colleagues: IdentityUser[] = [];
    for (const name of ['许宁（测试）', '陈一（测试）', '周悦（测试）', '苏禾（测试）']) {
      const invite = await post<{ token: string }>(
        page,
        `spaces/${space.id}/invitations`,
        {
          email: `member-work-${randomUUID()}@example.invalid`,
        },
        space.id,
      );
      const joined = await browser.newContext();
      try {
        const member = await joined.newPage();
        await post(member, 'identity/join', { token: invite.token, name, password });
        const state = await get<IdentityState>(member, 'identity');
        expect(state.user).not.toBeNull();
        colleagues.push(state.user!);
      } finally {
        await joined.close();
      }
    }
    const [seventeen, eight, nine, empty] = colleagues as [
      IdentityUser,
      IdentityUser,
      IdentityUser,
      IdentityUser,
    ];
    const projects: Project[] = [];
    for (const name of ['订单工作（测试）', '客户入口（测试）']) {
      const project = await post<Project>(page, `spaces/${space.id}/projects`, { name }, space.id);
      for (const member of colleagues)
        await post(page, `projects/${project.id}/members/${member.id}`, { role: 'edit' }, space.id);
      projects.push(project);
    }
    const tasksByIndex: Task[] = [];
    // Create the descriptive examples last so the server's normal newest-first
    // order places both relationships and terminal states in the first batch.
    for (let index = 16; index >= 0; index -= 1) {
      const project = projects[index % projects.length]!;
      let task = await post<Task>(
        page,
        `spaces/${space.id}/tasks`,
        {
          title:
            index === 0
              ? '共同整理字段说明'
              : index === 1
                ? '已取消的旧入口'
                : `共同推进工作 ${index + 1}`,
          description: '成员工作只浏览当前空间已有任务，仍在原任务中协作。',
          projectId: project.id,
        },
        space.id,
      );
      const ownerId =
        index === 0 ? seventeen.id : index < 8 ? eight.id : index < 16 ? nine.id : owner.id;
      if (task.ownerUserId !== ownerId)
        task = await post<Task>(
          page,
          `tasks/${task.id}/assignment`,
          {
            expectedRevision: task.revision,
            ownerUserId: ownerId,
          },
          space.id,
        );
      await participate(page, space.id, task.id, seventeen.id, 'add');
      if (index === 0) {
        await participate(page, space.id, task.id, eight.id, 'add');
        await participate(page, space.id, task.id, nine.id, 'add');
      }
      const action =
        index === 0 ? 'complete' : index === 1 ? 'cancel' : index === 2 ? 'start' : null;
      if (action)
        await post(
          page,
          `tasks/${task.id}/${action}`,
          {
            expectedRevision: task.revision,
            activeRunAction: 'keep',
          },
          space.id,
        );
      tasksByIndex[index] = (await get<TaskDetail>(page, `tasks/${task.id}`, space.id)).task;
    }
    const privateTask = await post<Task>(
      page,
      `spaces/${space.id}/tasks`,
      {
        title: '我自己的个人工作（测试）',
        description: '当前浏览者自己的个人任务。',
        projectId: null,
      },
      space.id,
    );
    const current = () => get<Workbench>(page, 'workbench', space.id);
    const data = await current();
    expect(data.mode).toBe('team-local');
    expect(data.space?.id).toBe(space.id);
    expect(data.tasks).toHaveLength(18);
    expect(data.members.map((member) => member.id).sort()).toEqual(
      [owner.id, ...colleagues.map((member) => member.id)].sort(),
    );
    const snapshot = () =>
      Promise.all(data.tasks.map((task) => get<TaskDetail>(page, `tasks/${task.id}`, space.id)));
    const before = await snapshot();
    expect(before.every((entry) => entry.runs.length === 0)).toBe(true);
    await page.goto(origin);
    await page.getByLabel('当前工作空间', { exact: true }).selectOption(space.id);
    await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(space.id);
    await page.goto(origin);
    const browserWrites: string[] = [];
    // APIRequestContext fixture mutations are separate from browser requests.
    // Every page action below must remain read-only, including theme/navigation.
    context.on('request', (request) => {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()))
        browserWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    return {
      context,
      page,
      space,
      owner,
      seventeen,
      eight,
      nine,
      empty,
      projects,
      tasksByIndex,
      privateTask,
      data,
      current,
      snapshot,
      before,
      browserWrites,
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function memberTasks(data: Workbench, memberId: string) {
  return data.tasks.filter(
    (task) => task.ownerUserId === memberId || task.participantUserIds?.includes(memberId),
  );
}

async function expectRows(page: Page, tasks: Task[], total = tasks.length) {
  await expect(rows(page)).toHaveCount(tasks.length);
  await expect
    .poll(() => rows(page).evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    .toEqual(tasks.map((task) => `/tasks/${task.id}`));
  await expect(taskSection(page).getByRole('status')).toHaveText(
    `当前列表：已显示 ${tasks.length} / ${total} 项`,
  );
}

async function selectMember(page: Page, member: Pick<User, 'id' | 'name'>) {
  await page.goto(`${origin}${directoryPath}`);
  await memberLink(page, member.id).click();
  await expect(page).toHaveURL(`${origin}${memberPath(member.id)}`);
  await expect(page.getByRole('heading', { name: member.name, exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText(member.id);
}

async function expectUnchanged(f: Fixture, baseline = f.before) {
  expect(await f.snapshot()).toEqual(baseline);
  expect(f.browserWrites).toEqual([]);
}

async function expectReachable(target: Locator, minimumWidth = 44, minimumHeight = 44) {
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }),
  );
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(
    await target.evaluate(
      (element, minimum) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return (
          rect.width >= minimum.width &&
          rect.height >= minimum.height &&
          !!hit &&
          element.contains(hit)
        );
      },
      { width: minimumWidth, height: minimumHeight },
    ),
  ).toBe(true);
}

async function captureMember(f: Fixture, mobile: boolean) {
  const { page } = f;
  const selected = memberTasks(f.data, f.seventeen.id);
  await expectRows(page, selected.slice(0, 8), 17);
  const heading = page.getByRole('heading', { name: f.seventeen.name, exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(page.locator('main')).toContainText(f.space.name);
  await expect(page.locator('.member-work-scope')).toHaveText(
    '仅展示当前已加载且对你可见的成员与任务，不代表完整团队名册或工作记录。任务包含已完成和已取消状态。',
  );
  await expect(page.getByLabel('当前工作空间', { exact: true })).toHaveValue(f.space.id);
  await expectReachable(
    page.getByRole('link', { name: '全部成员', exact: true }),
    44,
    mobile ? 44 : 32,
  );
  for (const task of selected.slice(0, 8)) {
    const row = taskRow(page, task.id);
    await expect(row).toContainText(task.ownerUserId === f.seventeen.id ? '负责人' : '参与者');
    await expect(row).toContainText(
      f.projects.find((project) => project.id === task.projectId)!.name,
    );
    await expectReachable(row, mobile ? 280 : 320);
  }
  await expectReachable(more(page), 44, mobile ? 44 : 32);
  for (const surface of [page.locator('main'), taskSection(page), rows(page).first()]) {
    expect((await surface.boundingBox())!.width).toBeGreaterThan(mobile ? 280 : 320);
    expect(
      await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', mobile ? 'light' : 'dark');
  const path = mobile
    ? 'artifacts/243-member-work-mobile-light.png'
    : 'artifacts/242-member-work-dark.png';
  test.info().annotations.push({
    type: 'capture-surface',
    description: `${path}: fictional team-local HTTP fixtures; ${mobile ? '390×844 light' : '1440×1000 dark'} viewport, full-page capture of selected member/current space/relationships/project sources and eight actual rows plus expansion control. Critical links/controls are separately centered and checked fully visible; rows and mobile controls have 44px targets, desktop controls at least32px. Distant header/footer are not required to share one viewport.`,
  });
  await mkdir('artifacts', { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
}

export function registerMemberWorkTests() {
  test.describe.serial('member-work 普通团队浏览', () => {
    let f: Fixture;
    test.beforeAll(async ({ browser }) => {
      f = await fixture(browser);
    });
    test.afterAll(async () => {
      await f?.context.close();
    });

    test('member-work 成员关系涵盖两项目和当前个人任务，原任务与成员链接支持历史和刷新', async () => {
      const { page } = f;
      await page.getByRole('link', { name: '成员工作', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${origin}${directoryPath}`);
      await expect(
        page.getByRole('heading', { level: 1, name: '成员工作', exact: true }),
      ).toBeVisible();
      const links = page.locator('main a[href^="/workbench/members/"]');
      await expect
        .poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute('href'))))
        .toEqual(f.data.members.map((member) => memberPath(member.id)));
      for (const member of f.data.members) {
        await expect(memberLink(page, member.id)).toContainText(member.name);
        await expect(memberLink(page, member.id)).toContainText(member.id);
      }
      await memberLink(page, f.eight.id).focus();
      await page.keyboard.press('Enter');
      const eight = memberTasks(f.data, f.eight.id);
      expect(eight).toHaveLength(8);
      await expectRows(page, eight);
      await expect(more(page)).toHaveCount(0);
      await expect(collapse(page)).toHaveCount(0);
      const shared = f.tasksByIndex[0]!;
      await expect(taskRow(page, shared.id)).toContainText('参与者');
      await expect(taskRow(page, shared.id)).not.toContainText('负责人');
      await expect(taskRow(page, f.tasksByIndex[1]!.id)).toContainText('已取消');
      await expect(taskRow(page, shared.id)).toContainText('已完成');
      expect(new Set(eight.map((task) => task.projectId)).size).toBe(2);

      const memberURL = page.url();
      await page.reload();
      await expectRows(page, eight);
      await taskRow(page, shared.id).click();
      await expect(page).toHaveURL(`${origin}/tasks/${shared.id}`);
      await expect(page.getByRole('heading', { name: shared.title, exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(memberURL);
      await expectRows(page, eight);
      await page.goForward();
      await expect(page).toHaveURL(`${origin}/tasks/${shared.id}`);
      await expect(page.getByRole('heading', { name: shared.title, exact: true })).toBeVisible();
      // Opening a copied member URL in a new same-identity tab uses the original
      // member route and current selected team, without a synthetic response.
      const sharedPage = await f.context.newPage();
      try {
        await sharedPage.goto(memberURL);
        await expectRows(sharedPage, eight);
        await expect(
          sharedPage.getByRole('heading', { name: f.eight.name, exact: true }),
        ).toBeVisible();
        await sharedPage.reload();
        await expectRows(sharedPage, eight);
      } finally {
        await sharedPage.close();
      }

      await selectMember(page, f.owner);
      const own = memberTasks(f.data, f.owner.id);
      expect(own).toHaveLength(2);
      await expectRows(page, own);
      await expect(taskRow(page, f.privateTask.id)).toContainText('个人工作');
      await expect(taskRow(page, f.privateTask.id)).toContainText('负责人');
      await selectMember(page, f.empty);
      await expectRows(page, []);
      await expect(taskSection(page)).toContainText(
        '当前可见范围内没有该成员负责或明确参与的任务。',
      );
      await expect(more(page)).toHaveCount(0);
      await expect(collapse(page)).toHaveCount(0);
      await page.goto(`${origin}${memberPath('not-a-current-member')}`);
      await expect(
        page.getByRole('heading', { name: '成员当前不可见', exact: true }),
      ).toBeVisible();
      await expect(page.locator('a.member-work-task-row')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: f.owner.name, exact: true })).toHaveCount(0);
      await expectUnchanged(f);
    });

    test('member-work 八项九项与多批展开保持键盘焦点，深色桌面和浅色窄屏可达', async () => {
      const { page } = f;
      await selectMember(page, f.seventeen);
      const selected = memberTasks(f.data, f.seventeen.id);
      expect(selected).toHaveLength(17);
      await expectRows(page, selected.slice(0, 8), 17);
      const both = taskRow(page, f.tasksByIndex[0]!.id);
      await expect(both).toHaveCount(1);
      await expect(both).toContainText('负责人');
      await expect(both).toContainText('参与者');
      await captureMember(f, false);
      await more(page).focus();
      await page.keyboard.press('Enter');
      await expectRows(page, selected.slice(0, 16), 17);
      await expect(rows(page).nth(8)).toBeFocused();
      await expectReachable(more(page), 44, 32);
      await expectReachable(collapse(page), 44, 32);
      await more(page).focus();
      await page.keyboard.press('Space');
      await expectRows(page, selected);
      await expect(rows(page).nth(16)).toBeFocused();
      await expect(more(page)).toHaveCount(0);
      await collapse(page).focus();
      await page.keyboard.press('Enter');
      await expectRows(page, selected.slice(0, 8), 17);
      await expect(
        taskSection(page).getByRole('heading', { name: '负责与参与的任务', exact: true }),
      ).toBeFocused();
      await expect(collapse(page)).toHaveCount(0);

      await selectMember(page, f.nine);
      const nine = memberTasks(f.data, f.nine.id);
      expect(nine).toHaveLength(9);
      await expectRows(page, nine.slice(0, 8), 9);
      await more(page).focus();
      await page.keyboard.press('Enter');
      await expectRows(page, nine);
      await expect(rows(page).nth(8)).toBeFocused();
      await expect(more(page)).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${origin}/tasks/${nine[8]!.id}`);
      await expect(page.getByRole('heading', { name: nine[8]!.title, exact: true })).toBeVisible();
      await selectMember(page, f.seventeen);
      await expectRows(page, selected.slice(0, 8), 17);
      await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await captureMember(f, true);
      await more(page).click();
      await expectRows(page, selected.slice(0, 16), 17);
      await expectReachable(collapse(page));
      await collapse(page).click();
      await expectRows(page, selected.slice(0, 8), 17);
      await expectUnchanged(f);
    });

    test('member-work 真实参与和改派更新，同一成员去重且浏览不写入任务', async () => {
      const { page } = f;
      await page.setViewportSize({ width: 1440, height: 1000 });
      await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/events' && response.status() === 200,
        ),
        page.goto(`${origin}${memberPath(f.seventeen.id)}`),
      ]);
      await more(page).click();
      await more(page).click();
      let expected = f.before;
      const changing = f.tasksByIndex[16]!;
      const project = f.projects.find((entry) => entry.id === changing.projectId)!;
      const verify = async (total: number) => {
        const current = await f.current();
        const tasks = memberTasks(current, f.seventeen.id);
        expect(tasks).toHaveLength(total);
        await expectRows(page, tasks, total);
        await expect(
          page.getByRole('heading', { name: f.seventeen.name, exact: true }),
        ).toBeVisible();
        await expectUnchanged(f, expected);
      };
      const changeParticipation = async (action: 'add' | 'remove') => {
        await participate(page, f.space.id, changing.id, f.seventeen.id, action);
        expected = expected.map((entry) =>
          entry.task.id === changing.id
            ? {
                ...entry,
                task: {
                  ...entry.task,
                  participantUserIds: action === 'add' ? [f.seventeen.id] : [],
                },
              }
            : entry,
        );
      };
      const assign = async (ownerUserId: string) => {
        const previous = expected.find((entry) => entry.task.id === changing.id)!;
        const assigned = await post<Task>(
          page,
          `tasks/${changing.id}/assignment`,
          {
            expectedRevision: previous.task.revision,
            ownerUserId,
          },
          f.space.id,
        );
        expect(assigned.ownerUserId).toBe(ownerUserId);
        expect(assigned.revision).toBe(previous.task.revision + 1);
        expect(Date.parse(assigned.updatedAt)).toBeGreaterThanOrEqual(
          Date.parse(previous.task.updatedAt),
        );
        // Only these assignment fields and the explicitly changed participation
        // projection may differ. All remaining full TaskDetail data stays exact.
        expected = expected.map((entry) =>
          entry.task.id === changing.id
            ? {
                ...entry,
                task: {
                  ...entry.task,
                  ownerUserId,
                  revision: previous.task.revision + 1,
                  updatedAt: assigned.updatedAt,
                },
              }
            : entry,
        );
      };

      await verify(17);
      await changeParticipation('remove');
      await verify(16);
      await changeParticipation('add');
      await verify(17);
      await assign(f.seventeen.id);
      await verify(17);
      await expect(taskRow(page, changing.id)).toHaveCount(1);
      await expect(taskRow(page, changing.id)).toContainText('负责人');
      await expect(taskRow(page, changing.id)).toContainText('参与者');
      await expect(taskRow(page, changing.id)).toContainText(project.name);
      await changeParticipation('remove');
      await verify(17);
      await expect(taskRow(page, changing.id)).toContainText('负责人');
      await expect(taskRow(page, changing.id)).not.toContainText('参与者');
      await assign(f.eight.id);
      await verify(16);
      await expect(taskRow(page, changing.id)).toHaveCount(0);
    });
  });
}
