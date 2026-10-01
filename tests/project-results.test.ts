import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Result, Task } from '../packages/contracts/src/index.js';
import type { ResultDetail, ResultRevision } from '../packages/contracts/src/results.js';
import {
  parseProjectResultListQuery,
  type ProjectResultPage,
} from '../packages/contracts/src/project-results.js';
import { MemberResultVersions } from '../packages/db/src/member-result-versions.js';
import { ProjectResults } from '../packages/db/src/project-results.js';
import { ResultReferences } from '../packages/db/src/result-references.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';
import { ORIGIN, teamFixture } from './helpers/team.js';

const page = (store: Store, projectId: string, cursor: string | null = null, limit = 20) =>
  new ProjectResults(store).list(projectId, { cursor, limit });
const resultFor = (store: Store, task: Task, title = '固定成果', body = '原始正文') =>
  store.createResult(task.id, title, body, randomUUID());
const changeTaskBody = (store: Store, task: Task, changes: Partial<Task>) => {
  const next = { ...task, ...changes };
  store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(next), task.id);
  return next;
};
const snapshots = (store: Store) =>
  (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [name, JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all())]);
const previewFixture = () => {
  const store = new Store();
  const project = store.createProject({ name: '成果项目', description: '' }, randomUUID());
  const task = store.createTask(
    { title: '原任务', description: '不应出现在卡片', projectId: project.id },
    randomUUID(),
  );
  return { store, project, task };
};
async function fixture() {
  const api = await teamFixture();
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice);
    const task = (await api.task(alice, project.id)) as Task;
    const as = <T>(action: () => T) =>
      api.store.as({ user: alice.user, spaceId: alice.spaceId }, action);
    const asBob = <T>(action: () => T) =>
      api.store.as({ user: bob.user, spaceId: bob.spaceId }, action);
    const result = as(() => resultFor(api.store, task));
    const version = as(() => new ResultRevisions(api.store).current(result));
    return {
      api,
      alice,
      bob,
      project,
      task,
      result,
      version,
      as,
      asBob,
      path: `projects/${project.id}/results`,
      close: api.close,
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

test('项目成果分页严格限定cursor和limit，默认20条、上限50条', () => {
  assert.deepEqual(parseProjectResultListQuery({}), { cursor: null, limit: 20 });
  assert.deepEqual(parseProjectResultListQuery({ cursor: 'legacy-result', limit: '50' }), {
    cursor: 'legacy-result',
    limit: 50,
  });
  for (const input of [
    null,
    [],
    'bad',
    { limit: 1 },
    { limit: null },
    { limit: '0' },
    { limit: '01' },
    { limit: '-1' },
    { limit: '1.0' },
    { limit: '1e1' },
    { limit: '+1' },
    { limit: ' 1' },
    { limit: '1 ' },
    { limit: '51' },
    { limit: String(Number.MAX_SAFE_INTEGER + 1) },
    { limit: ['1', '2'] },
    { cursor: null },
    { cursor: '' },
    { cursor: ' a' },
    { cursor: 'a ' },
    { cursor: '../result' },
    { cursor: 'a'.repeat(101) },
    { cursor: 1 },
    { cursor: ['a', 'b'] },
    { projectId: 'other' },
    { taskId: 'other' },
    { status: 'done' },
    { includePrivate: true },
    { order: 'updatedAt' },
    { offset: '1' },
  ])
    assert.throws(() => parseProjectResultListQuery(input), { code: 'INVALID_INPUT' });
});

test('只投影当前不可变版本与Task卡片字段，文字和demo-preview均不推断完成或发布', () => {
  const { store, project, task } = previewFixture();
  try {
    const first = resultFor(store, task);
    const version = new ResultRevisions(store).current(first);
    const summary = page(store, project.id);
    assert.deepEqual(summary, {
      projectId: project.id,
      items: [
        {
          id: first.id,
          revisionId: version.id,
          revision: 1,
          title: version.title,
          kind: 'text',
          excerpt: version.body,
          excerptTruncated: false,
          savedAt: version.createdAt,
          task: { id: task.id, shortId: task.shortId, title: task.title, status: 'todo' },
        },
      ],
      nextCursor: null,
    });
    // Immutable title/body/save time remain authoritative even if a mutable projection drifts.
    store.db.prepare('UPDATE results SET body=? WHERE id=?').run(
      JSON.stringify({
        ...first,
        title: '不可混入的当前投影',
        body: '不同正文',
        updatedAt: '2099-01-01T00:00:00Z',
      }),
      first.id,
    );
    assert.deepEqual(page(store, project.id), summary);
    const demo = store.result('result-orders');
    const demoTask = store.getTask(demo.taskId);
    const demoItem = page(store, demoTask.projectId!).items.find((item) => item.id === demo.id)!;
    assert.equal(demoItem.kind, 'demo-preview');
    assert.equal(demoItem.revisionId, new ResultRevisions(store).current(demo).id);
    assert.equal(demoItem.task.status, demoTask.status);
    assert.equal(store.getTask(task.id).status, 'todo');
  } finally {
    store.close();
  }
});

test('SQL分页最多返回limit+1个短投影，长CJK/emoji按160个Unicode字符截取，不把完整正文或来源读入JS', (t) => {
  const { store, project, task } = previewFixture();
  try {
    const prefix = '中😀'.repeat(80);
    const longBody = prefix + '只留在数据库的正文'.repeat(10000);
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(resultFor(store, task, `成果${i}`, longBody).id);
    resultFor(store, task, '恰好160字符', prefix);
    resultFor(store, task, '保留空白', '第一行\n  第二行 😀');
    for (const method of ['results', 'result', 'tasks', 'getTask'] as const)
      t.mock.method(store, method, () => {
        throw new Error('Project summaries must not load full records');
      });
    t.mock.method(ResultRevisions.prototype, 'get', () => {
      throw new Error('No full revisions');
    });
    const original = store.db.prepare.bind(store.db);
    let projected = 0;
    t.mock.method(store.db, 'prepare', (sql: string) => {
      const statement = original(sql);
      if (sql.includes('AS excerpt')) {
        assert.match(sql, /substr\(json_extract\(v.body,'\$\.body'\),1,160\)/);
        assert.match(sql, /ORDER BY r.rowid DESC LIMIT \?/);
        const all = statement.all.bind(statement);
        t.mock.method(statement, 'all', (...parameters: Parameters<typeof statement.all>) => {
          assert.equal(parameters.at(-1), 51);
          const rows = all(...parameters);
          assert.equal(rows.length, 51);
          for (const row of rows) {
            assert(!('body' in row));
            assert(!('source' in row));
            assert([...String(row.excerpt)].length <= 160);
          }
          projected++;
          return rows;
        });
      } else assert(!/FROM (?:results|tasks|result_revisions)\b/.test(sql), sql);
      return statement;
    });
    const result = page(store, project.id, null, 50);
    assert.equal(projected, 1);
    assert.equal(result.items.length, 50);
    assert.equal(result.nextCursor, result.items.at(-1)!.id);
    assert.equal(result.items[0]!.excerpt, '第一行\n  第二行 😀');
    assert.equal(result.items[0]!.excerptTruncated, false);
    assert.equal(result.items[1]!.excerpt, prefix);
    assert.equal(result.items[1]!.excerptTruncated, false);
    for (const item of result.items.slice(2)) {
      assert.equal(item.excerpt, prefix);
      assert.equal(item.excerptTruncated, true);
      assert(!item.excerpt.includes('\ufffd'));
    }
    assert(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
    assert(!JSON.stringify(result).includes('只留在数据库'));
  } finally {
    store.close();
  }
});

test('含NUL正文保留有界可见前缀和替换标记，明确截断而不把后续内容冒充为空', () => {
  const { store, project, task } = previewFixture();
  try {
    for (const [body, excerpt] of [
      ['\0' + 'b'.repeat(180), '�'],
      ['a\0' + 'b'.repeat(180), 'a�'],
      ['中😀\0余文', '中😀�'],
      ['中'.repeat(159) + '\0末尾', '中'.repeat(159) + '�'],
      ['😀'.repeat(160) + '\0末尾', '😀'.repeat(160)],
      ['末尾\0', '末尾�'],
    ]) {
      resultFor(store, task, '含NUL', body);
      const item = page(store, project.id, null, 1).items[0]!;
      assert.equal(item.excerpt, excerpt);
      assert.equal(item.excerptTruncated, true);
      assert([...item.excerpt].length <= 160);
      assert(!item.excerpt.includes('\0'));
    }
  } finally {
    store.close();
  }
});

test('项目结果按Result创建rowid倒序分页，修订、Task编辑和中途新成果不移动或重复旧行', () => {
  const { store, project, task } = previewFixture();
  try {
    const results = Array.from({ length: 23 }, (_, i) => resultFor(store, task, `成果${i}`));
    const before = page(store, project.id);
    assert.equal(before.items.length, 20);
    assert.deepEqual(
      before.items.map((item) => item.id),
      results
        .slice(3)
        .reverse()
        .map((item) => item.id),
    );
    const oldest = results[0]!;
    const version = new ResultRevisions(store).current(oldest);
    const saved = new MemberResultVersions(store).save(
      oldest.id,
      {
        expectedRevision: 1,
        expectedRevisionId: version.id,
        title: '后来的新版本',
        body: '新的正文',
      },
      randomUUID(),
    );
    changeTaskBody(store, task, { title: '更新后的任务名' });
    const newest = resultFor(store, task, '分页之间的新成果');
    const after = page(store, project.id, before.nextCursor);
    assert.deepEqual(
      after.items.map((item) => item.id),
      results
        .slice(0, 3)
        .reverse()
        .map((item) => item.id),
    );
    assert.equal(after.nextCursor, null);
    assert.equal(after.items.at(-1)!.revisionId, saved.revisionId);
    assert.equal(after.items.at(-1)!.title, '后来的新版本');
    assert(after.items.every((item) => item.task.title === '更新后的任务名'));
    assert(!after.items.some((item) => item.id === newest.id));
    assert.deepEqual(page(store, project.id, oldest.id).items, []);
    assert.equal(page(store, project.id).items[0]!.id, newest.id);
  } finally {
    store.close();
  }
});

test('项目/空间/Task当前权限先于分页和nextCursor，私有Task和跨项目资料不泄露', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api.call(f.path, f.bob)).statusCode, 404);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    const visible = f.as(() => resultFor(f.api.store, f.task, '第二项公开成果'));
    const hiddenTask = f.as(() =>
      f.api.store.createTask(
        {
          title: '私有标题',
          description: '私有说明',
          projectId: f.project.id,
        },
        randomUUID(),
      ),
    );
    const hidden = f.as(() => resultFor(f.api.store, hiddenTask, '不应泄露的成果', '私有正文'));
    changeTaskBody(f.api.store, hiddenTask, { visibility: 'private' });
    const otherProject = await f.api.project(f.alice);
    const otherTask = await f.api.task(f.alice, otherProject.id);
    const otherResult = f.as(() => resultFor(f.api.store, otherTask, '另一个项目'));
    const privateTask = await f.api.task(f.bob);
    const personalResult = f.asBob(() => resultFor(f.api.store, privateTask, '乙自己的无项目成果'));
    const first = (await f.api.call(`${f.path}?limit=1`, f.bob)).json<ProjectResultPage>();
    assert.equal(first.items[0]!.id, visible.id);
    assert.equal(first.nextCursor, visible.id);
    const second = (
      await f.api.call(`${f.path}?limit=1&cursor=${first.nextCursor}`, f.bob)
    ).json<ProjectResultPage>();
    assert.equal(second.items[0]!.id, f.result.id);
    assert.equal(second.nextCursor, null);
    const all = (await f.api.call(f.path, f.bob)).json<ProjectResultPage>();
    assert.deepEqual(
      all.items.map((item) => item.id),
      [visible.id, f.result.id],
    );
    assert(!JSON.stringify(all).includes('私有'));
    assert(!JSON.stringify(all).includes(otherResult.id));
    for (const cursor of [hidden.id, otherResult.id, personalResult.id, randomUUID()]) {
      const response = await f.api.call(`${f.path}?cursor=${cursor}`, f.bob);
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().error.code, 'NOT_FOUND');
      assert(!response.body.includes(cursor));
    }
    // An owner sees their own private Task only if it really belongs to this project.
    assert(f.as(() => page(f.api.store, f.project.id)).items.some((item) => item.id === hidden.id));
    assert(
      !f
        .as(() => page(f.api.store, f.project.id))
        .items.some((item) => item.id === personalResult.id),
    );
    const bobsProjectTask = f.as(() =>
      f.api.store.createTask(
        {
          title: '乙的项目内私有Task',
          description: '',
          projectId: f.project.id,
        },
        randomUUID(),
      ),
    );
    const bobsResult = f.as(() => resultFor(f.api.store, bobsProjectTask, '乙的私有成果'));
    changeTaskBody(f.api.store, bobsProjectTask, {
      visibility: 'private',
      ownerUserId: f.bob.user.id,
    });
    assert(
      !f.as(() => page(f.api.store, f.project.id)).items.some((item) => item.id === bobsResult.id),
    );
    assert(
      f
        .asBob(() => page(f.api.store, f.project.id))
        .items.some((item) => item.id === bobsResult.id),
    );
  } finally {
    await f.close();
  }
});

test('Task的JSON身份/项目/空间必须与关系字段一致，preview同样不泄露别人的私有成果', () => {
  const { store, project, task } = previewFixture();
  try {
    const result = resultFor(store, task);
    const other = store.createProject({ name: '另一项目', description: '' }, randomUUID());
    for (const changes of [
      { id: 'wrong-task' },
      { spaceId: 'wrong-space' },
      { projectId: other.id },
      { projectId: null },
      { visibility: 'private' as const, ownerUserId: 'another-person' },
    ]) {
      changeTaskBody(store, task, changes);
      assert.deepEqual(page(store, project.id), {
        projectId: project.id,
        items: [],
        nextCursor: null,
      });
      assert.throws(() => page(store, project.id, result.id), { code: 'NOT_FOUND' });
    }
    changeTaskBody(store, task, { visibility: 'private' });
    assert.equal(page(store, project.id).items[0]!.id, result.id);
    store.db
      .prepare('UPDATE results SET body=? WHERE id=?')
      .run(JSON.stringify({ ...result, taskId: 'other-task' }), result.id);
    assert.deepEqual(page(store, project.id).items, []);
  } finally {
    store.close();
  }
});

test('只读成员能读已取消任务与归档项目的成果，读取不修改任何业务记录且不联网', async (t) => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    f.as(() => f.api.store.changeTask(f.task.id, 'cancelled', 1, 'keep', randomUUID()));
    f.as(() =>
      f.api.store.projectLifecycle.change(
        f.project.id,
        {
          action: 'archive',
          expectedRevision: 1,
          activeRunAction: 'keep',
        },
        randomUUID(),
      ),
    );
    f.as(() =>
      new ResultReferences(f.api.store).create(
        f.result.id,
        f.version.id,
        {
          action: 'register',
          expectedResultRevision: 1,
          kind: 'release',
          title: '不要自动读取的链接',
          url: 'https://never-fetch.example.invalid/version',
          environment: '未核验',
        },
        randomUUID(),
      ),
    );
    f.as(() =>
      f.api.store.addMessage(
        f.task.id,
        '只在详情显示的反馈',
        f.result.id,
        randomUUID(),
        f.version.id,
      ),
    );
    const before = snapshots(f.api.store);
    const changes = f.api.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('No external fetch');
    });
    const direct = f.asBob(() => page(f.api.store, f.project.id));
    assert.equal(direct.items[0]!.task.status, 'cancelled');
    assert.equal(f.api.store.db.prepare('SELECT total_changes() AS count').get()!.count, changes);
    const response = await f.api.call(f.path, f.bob);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), direct);
    assert(!response.body.includes('never-fetch'));
    assert(!response.body.includes('只在详情显示'));
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(snapshots(f.api.store), before);
  } finally {
    await f.close();
  }
});

test('已读游标不绕过后来Task私有化、项目撤权、空间撤权、跨空间或失效会话', async () => {
  const f = await fixture();
  try {
    const member = `projects/${f.project.id}/members/${f.bob.user.id}`;
    await f.api.call(member, f.alice, { role: 'edit' });
    f.as(() => resultFor(f.api.store, f.task, '第二条'));
    const first = (await f.api.call(`${f.path}?limit=1`, f.bob)).json<ProjectResultPage>();
    const cursorPath = `${f.path}?cursor=${first.nextCursor}`;
    changeTaskBody(f.api.store, f.task, { visibility: 'private' });
    assert.equal((await f.api.call(cursorPath, f.bob)).statusCode, 404);
    assert.deepEqual((await f.api.call(f.path, f.bob)).json<ProjectResultPage>().items, []);
    changeTaskBody(f.api.store, f.task, {});
    await f.api.call(member, f.alice, { role: 'view' });
    assert.equal((await f.api.call(cursorPath, f.bob)).statusCode, 200);
    await f.api.call(member, f.alice, { role: null });
    for (const path of [f.path, cursorPath]) {
      assert.equal((await f.api.call(path, f.bob)).statusCode, 404);
      assert.equal(
        (await f.api.call(path, { ...f.alice, spaceId: `personal-${f.alice.user.id}` })).statusCode,
        404,
      );
      assert.equal((await f.api.call(path, null)).statusCode, 401);
    }
    await f.api.call(member, f.alice, { role: 'view' });
    f.api.store.db
      .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
      .run(f.bob.spaceId, f.bob.user.id);
    assert.equal((await f.api.call(cursorPath, f.bob)).statusCode, 403);
    assert.throws(() => f.asBob(() => page(f.api.store, f.project.id)), { code: 'NOT_FOUND' });
    assert.equal((await f.api.call('identity/sign-out', f.alice, {})).statusCode, 200);
    assert.equal((await f.api.call(f.path, f.alice)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('列表已显示的固定revisionId在新版本保存后仍打开原版本，刷新才读新版', async () => {
  const f = await fixture();
  try {
    const displayed = (await f.api.call(f.path, f.alice)).json<ProjectResultPage>().items[0]!;
    const response = await f.api.call(`results/${f.result.id}/versions`, f.alice, {
      expectedRevision: 1,
      expectedRevisionId: f.version.id,
      title: '新版本标题',
      body: '新版本正文',
    });
    assert.equal(response.statusCode, 201, response.body);
    const old = (
      await f.api.call(`results/${displayed.id}/versions/${displayed.revisionId}`, f.alice)
    ).json<ResultDetail>();
    assert.equal(old.version.id, f.version.id);
    assert.equal(old.version.body, displayed.excerpt);
    assert.equal(old.version.title, displayed.title);
    assert.equal(old.result.revision, 2);
    const refreshed = (await f.api.call(f.path, f.alice)).json<ProjectResultPage>().items[0]!;
    assert.equal(refreshed.id, displayed.id);
    assert.equal(refreshed.revision, 2);
    assert.notEqual(refreshed.revisionId, displayed.revisionId);
    assert.equal(refreshed.excerpt, '新版本正文');
  } finally {
    await f.close();
  }
});

test('并发另一连接提交新版本时单页保持同一只读快照，下一次读取看到新版', async (t) => {
  const f = await fixture();
  const writer = new Store(join(f.api.dir, 'workspace.sqlite'), undefined, { team: true });
  try {
    const prepare = f.api.store.db.prepare.bind(f.api.store.db);
    let saved = false;
    t.mock.method(f.api.store.db, 'prepare', (sql: string) => {
      if (sql.includes('AS excerpt') && !saved) {
        saved = true;
        writer.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
          new MemberResultVersions(writer).save(
            f.result.id,
            {
              expectedRevision: 1,
              expectedRevisionId: f.version.id,
              title: '并发新版',
              body: '并发新正文',
            },
            randomUUID(),
          ),
        );
      }
      return prepare(sql);
    });
    const first = f.as(() => page(f.api.store, f.project.id)).items[0]!;
    assert.equal(saved, true);
    assert.equal(first.revisionId, f.version.id);
    assert.equal(first.title, f.version.title);
    assert.equal(first.excerpt, f.version.body);
    const second = f.as(() => page(f.api.store, f.project.id)).items[0]!;
    assert.equal(second.revision, 2);
    assert.equal(second.excerpt, '并发新正文');
    assert.equal(
      f.as(() => new ResultRevisions(f.api.store).get(first.id, first.revisionId)).body,
      f.version.body,
    );
  } finally {
    writer.close();
    await f.close();
  }
});

test('缺失当前版本明确409，不回退旧版或捏造历史；只在下一页遇到坏行才报错', () => {
  const { store, project, task } = previewFixture();
  try {
    const missing = resultFor(store, task, '不可用历史');
    store.db
      .prepare('UPDATE results SET body=? WHERE id=?')
      .run(JSON.stringify({ ...missing, revision: 2 }), missing.id);
    const newer = resultFor(store, task, '正常新行');
    const first = page(store, project.id, null, 1);
    assert.equal(first.items[0]!.id, newer.id);
    assert.equal(first.nextCursor, newer.id);
    const before = snapshots(store);
    assert.throws(() => page(store, project.id, first.nextCursor, 1), {
      code: 'RESULT_VERSION_MISSING',
      status: 409,
    });
    assert.throws(() => page(store, project.id), { code: 'RESULT_VERSION_MISSING' });
    assert.deepEqual(snapshots(store), before);
    assert.equal(new ResultRevisions(store).list(missing.id).length, 1);
    // A legacy snapshot can be the only known revision; lower revisions need not exist.
    const legacy: Result = { ...missing, id: randomUUID(), title: '已知旧版', revision: 7 };
    store.db
      .prepare('INSERT INTO results VALUES(?,?,?)')
      .run(legacy.id, task.id, JSON.stringify(legacy));
    const version = new ResultRevisions(store).append(legacy, { kind: 'legacy' }, '', true);
    const summary = page(store, project.id, null, 1).items[0]!;
    assert.equal(summary.revision, 7);
    assert.equal(summary.revisionId, version.id);
    assert.equal(new ResultRevisions(store).list(legacy.id).length, 1);
  } finally {
    store.close();
  }
});

test('错误版本身份不跨成果/Task拼接，隐藏的缺失版本不影响有权读取的页面', async () => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    const task = await f.api.task(f.alice, f.project.id, '隐藏Task');
    const hidden = f.as(() => resultFor(f.api.store, task));
    f.api.store.db
      .prepare('UPDATE results SET body=? WHERE id=?')
      .run(JSON.stringify({ ...hidden, revision: 2 }), hidden.id);
    changeTaskBody(f.api.store, task, { visibility: 'private' });
    const visible = (await f.api.call(f.path, f.bob)).json<ProjectResultPage>();
    assert.deepEqual(
      visible.items.map((item) => item.id),
      [f.result.id],
    );
    assert.equal(visible.nextCursor, null);
    assert.equal((await f.api.call(f.path, f.alice)).statusCode, 409);
    let revision = 2;
    for (const changes of [
      { resultId: hidden.id },
      { taskId: task.id },
      { revision: 999 },
      { id: 'wrong-version' },
    ]) {
      revision++;
      const version: ResultRevision = { ...f.version, ...changes, id: changes.id ?? randomUUID() };
      const rowId = randomUUID();
      f.api.store.db
        .prepare('INSERT INTO result_revisions(id,result_id,revision,body) VALUES(?,?,?,?)')
        .run(
          rowId,
          f.result.id,
          revision,
          JSON.stringify({
            ...version,
            id: changes.id ?? rowId,
            revision: changes.revision ?? revision,
          }),
        );
      f.api.store.db
        .prepare('UPDATE results SET body=? WHERE id=?')
        .run(JSON.stringify({ ...f.result, revision }), f.result.id);
      const response = await f.api.call(f.path, f.bob);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'RESULT_VERSION_MISSING');
    }
  } finally {
    await f.close();
  }
});

test('真实HTTP提供项目分页、严格拒绝重复/未知查询、私有游标与撤权，无结果项目保持空页', async () => {
  const f = await fixture();
  try {
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    const empty = await f.api.project(f.alice);
    const base = await f.api.app.listen({ host: '127.0.0.1', port: 0 });
    const get = async (path: string, cookie = f.alice.cookie) => {
      const response = await fetch(`${base}/api/v1/${path}`, {
        headers: { cookie, origin: ORIGIN, 'x-hexu-space': f.alice.spaceId },
      });
      return { status: response.status, data: await response.json() };
    };
    const actual = await get(`${f.path}?limit=1`, f.bob.cookie);
    assert.equal(actual.status, 200);
    assert.equal(actual.data.items[0].id, f.result.id);
    assert.equal(actual.data.items[0].revisionId, f.version.id);
    assert.deepEqual((await get(`projects/${empty.id}/results`)).data, {
      projectId: empty.id,
      items: [],
      nextCursor: null,
    });
    for (const query of [
      'limit=1&limit=2',
      'cursor=a&cursor=b',
      'limit=51',
      'limit=0',
      'status=done',
      'limit=01',
      'cursor=..%2Fbad',
    ])
      assert.equal((await get(`${f.path}?${query}`)).status, 400, query);
    assert.equal((await get(`${f.path}?cursor=unknown`)).status, 404);
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, { role: null });
    assert.equal((await get(`${f.path}?cursor=${f.result.id}`, f.bob.cookie)).status, 404);
  } finally {
    await f.close();
  }
});
