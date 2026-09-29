import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../packages/domain/src/index.js';
import {
  parseWorkBranchCreate,
  type WorkBranchView,
} from '../packages/contracts/src/work-branches.js';
import { WorkBranchStore } from '../packages/db/src/work-branches.js';
import { Store } from '../packages/db/src/store.js';
import { retentionFixture } from './helpers/checkpoint-retention.js';

async function fixture() {
  const f = await retentionFixture();
  const path = `tasks/${f.task.id}/work-branches`;
  const body = {
    expectedTaskRevision: 1,
    checkpointId: f.first.request.checkpointId,
    branches: [
      { name: '方案 A', goal: '分批同步读取' },
      { name: '方案 B', goal: '异步后台导出' },
    ],
  };
  const create = async (key = randomUUID()) => {
    const r = await f.api.call(path, f.alice, body, key);
    assert.equal(r.statusCode, 201, r.body);
    return r.json() as WorkBranchView;
  };
  return { ...f, branchPath: path, body, plan: create };
}
test('方案定义严格限制共同提交、数量、目标与名称，不接受目录、执行或伪造状态', () => {
  const body = {
    expectedTaskRevision: 1,
    checkpointId: randomUUID(),
    branches: [
      { name: 'A', goal: 'a' },
      { name: 'B', goal: 'b' },
    ],
  };
  assert.equal(parseWorkBranchCreate(body).branches.length, 2);
  for (const extra of [
    { runId: 'x' },
    { workingCopyId: 'x' },
    { state: 'active' },
    { startHash: 'x' },
    { model: 'paid' },
    { path: '/tmp/user' },
  ])
    assert.throws(() => parseWorkBranchCreate({ ...body, ...extra }));
  for (const branches of [
    [],
    [body.branches[0]],
    Array(7).fill(body.branches[0]),
    [
      { name: 'A', goal: 'a' },
      { name: ' a ', goal: 'b' },
    ],
    [{ name: 'A', goal: '' }, body.branches[1]],
    [{ name: 'A', goal: 'x'.repeat(3001) }, body.branches[1]],
    [{ ...body.branches[0], runId: 'injected' }, body.branches[1]],
  ])
    assert.throws(() => parseWorkBranchCreate({ ...body, branches }));
});
test('真实提交引用定义多个方案，共同说明不可变，不创建目录、执行或新任务', async () => {
  const f = await fixture();
  try {
    const tables = [
      'tasks',
      'runs',
      'node_dispatches',
      'native_workspace_locks',
      'continuation_operations',
      'node_continuation_operations',
    ];
    const before = tables.map((t) =>
      JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    const file = await readFile(join(f.root, 'README.md'));
    const key = randomUUID(),
      v = await f.plan(key);
    assert.equal(v.branches.length, 2);
    assert.equal(v.group.start.checkpoint.manifest.commit, f.oid);
    assert.equal(v.group.start.checkpoint.manifest.availability, 'local_reference');
    assert.equal(
      v.group.startHash,
      createHash('sha256').update(canonicalJson(v.group.start)).digest('hex'),
    );
    for (const branch of v.branches) {
      assert.equal(branch.state, 'planned');
      assert.equal(branch.groupId, v.group.id);
      assert.equal(branch.runId, null);
      assert.equal(branch.workingCopyId, null);
      assert.equal(branch.resultId, null);
    }
    assert.equal((await f.plan(key)).group.id, v.group.id);
    assert.deepEqual(
      tables.map((t) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${t}`).all())),
      before,
    );
    assert.deepEqual(await readFile(join(f.root, 'README.md')), file);
    const changed = await f.api.call(
      `tasks/${f.task.id}`,
      f.alice,
      { expectedRevision: 1, description: '新的任务说明' },
      randomUUID(),
      'PATCH',
    );
    assert.equal(changed.statusCode, 200, changed.body);
    const again = (
      await f.api.call(`${f.branchPath}/groups/${v.group.id}`, f.alice)
    ).json() as WorkBranchView;
    assert.equal(again.taskChanged, true);
    assert.deepEqual(again.group.start, v.group.start);
    assert.equal(
      (await f.api.call(f.branchPath, f.alice, f.body, key)).json().group.id,
      v.group.id,
    );
    assert.equal((await f.api.call(f.branchPath, f.alice, f.body)).statusCode, 409);
  } finally {
    await f.close();
  }
});
test('多方案创建与事件/回执同事务，部分失败不留下半组方案，可重试原请求', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_second_plan BEFORE INSERT ON work_branch_events WHEN (SELECT count(*) FROM work_branch_events)>0 BEGIN SELECT RAISE(ABORT,'fixture second branch failure'); END;",
    );
    const failed = await f.api.call(f.branchPath, f.alice, f.body, key);
    assert.equal(failed.statusCode, 500);
    for (const table of ['work_branch_groups', 'work_branches', 'work_branch_events'])
      assert.equal(f.api.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    assert.equal(
      f.api.store.db
        .prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'work_branch.%'")
        .get()!.n,
      0,
    );
    assert.equal(
      f.api.store.db.prepare('SELECT count(*) AS n FROM idempotency_records WHERE key=?').get(key)!
        .n,
      0,
    );
    f.api.store.db.exec('DROP TRIGGER fail_second_plan;');
    assert.equal((await f.plan(key)).branches.length, 2);
  } finally {
    await f.close();
  }
});
test('放弃仅改变选定planned方案，幂等回执返回最新状态，回滚不丢失历史', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      group = await f.plan(key),
      b = group.branches[0]!,
      discardKey = randomUUID();
    f.api.store.db.exec(
      "CREATE TRIGGER fail_discard BEFORE INSERT ON outbox WHEN NEW.kind='work_branch.discard' BEGIN SELECT RAISE(ABORT,'fixture discard failure'); END;",
    );
    const path = `${f.branchPath}/${b.id}/discard`,
      input = { expectedRevision: 1 };
    assert.equal((await f.api.call(path, f.alice, input, discardKey)).statusCode, 500);
    assert.equal(
      (await f.api.call(f.branchPath, f.alice)).json().items[0].branches[0].state,
      'planned',
    );
    f.api.store.db.exec('DROP TRIGGER fail_discard;');
    const changed = await f.api.call(path, f.alice, input, discardKey);
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().branches[0].state, 'discarded');
    assert.equal(changed.json().branches[1].state, 'planned');
    assert.equal((await f.api.call(path, f.alice, input, discardKey)).statusCode, 200);
    assert.equal((await f.api.call(path, f.alice, input)).statusCode, 409);
    assert.equal((await f.plan(key)).branches[0]!.state, 'discarded');
    const history = (await f.api.call(`${f.branchPath}/${b.id}/history`, f.alice)).json().items;
    assert.deepEqual(
      history.map((v: { action: string }) => v.action),
      ['plan', 'discard'],
    );
    assert.equal((await f.api.call(`tasks/${f.task.id}`, f.alice)).json().runs.length, 0);
  } finally {
    await f.close();
  }
});
test('当前项目权限覆盖列表/直接ID/历史/旧回执，不因创建者身份或其他项目成员绕过', async () => {
  const f = await fixture();
  try {
    const invitation = await f.api.invite(f.alice),
      bob = await f.api.joinAccount(invitation.token);
    const key = randomUUID(),
      v = await f.plan(key),
      b = v.branches[0]!;
    assert.equal((await f.api.call(f.branchPath, bob)).statusCode, 404);
    await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.branchPath, bob)).statusCode, 200);
    assert.equal((await f.api.call(f.branchPath, bob, f.body)).statusCode, 403);
    assert.equal(
      (await f.api.call(`${f.branchPath}/${b.id}/discard`, bob, { expectedRevision: 1 }))
        .statusCode,
      403,
    );
    await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, {
      role: 'manage',
    });
    const ownKey = randomUUID(),
      own = await f.api.call(f.branchPath, bob, f.body, ownKey);
    assert.equal(own.statusCode, 201);
    await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, { role: 'view' });
    assert.equal((await f.api.call(f.branchPath, bob, f.body, ownKey)).statusCode, 403);
    const removed = await f.api.call(`projects/${f.project.id}/members/${bob.user.id}`, f.alice, {
      role: null,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    f.api.store.as({ user: bob.user, spaceId: bob.spaceId }, () =>
      assert.equal(
        f.api.store.events(0).events.some((e) => e.taskId === f.task.id),
        false,
      ),
    );
    for (const path of [
      f.branchPath,
      `${f.branchPath}/groups/${v.group.id}`,
      `${f.branchPath}/${b.id}/history`,
    ])
      assert.equal((await f.api.call(path, bob)).statusCode, 404);
    assert.equal((await f.api.call(f.branchPath, bob, f.body, ownKey)).statusCode, 404);
    assert.equal(
      (
        await f.api.call(
          f.branchPath,
          f.alice,
          {
            ...f.body,
            branches: [
              { name: 'X', goal: 'x' },
              { name: 'Y', goal: 'y' },
            ],
          },
          key,
        )
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test('其他任务引用、私有任务与未记录的请求不作为共同起点', async () => {
  const f = await fixture();
  try {
    const other = await f.api.task(f.alice, f.project.id),
      privateTask = await f.api.task(f.alice);
    assert.equal(
      (await f.api.call(`tasks/${other.id}/work-branches`, f.alice, f.body)).statusCode,
      404,
    );
    assert.equal(
      (await f.api.call(`tasks/${privateTask.id}/work-branches`, f.alice, f.body)).statusCode,
      422,
    );
    assert.equal(
      (await f.api.call(f.branchPath, f.alice, { ...f.body, checkpointId: randomUUID() }))
        .statusCode,
      404,
    );
    assert.equal(
      f.api.store.db.prepare('SELECT count(*) AS n FROM work_branch_groups').get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});
test('分页保持整个方案组，数据库重开保留共同起点、放弃记录与原回执', async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await f.plan()).group.id);
    const first = (await f.api.call(f.branchPath, f.alice)).json();
    assert.equal(first.items.length, 10);
    assert(first.nextCursor);
    const second = (await f.api.call(f.branchPath + '?cursor=' + first.nextCursor, f.alice)).json();
    assert.deepEqual(
      [...first.items, ...second.items].map((v: WorkBranchView) => v.group.id),
      ids.reverse(),
    );
    assert.equal(second.nextCursor, null);
    const reopened = new Store(f.api.dbPath, undefined, { team: true });
    try {
      reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
        assert.deepEqual(new WorkBranchStore(reopened).list(f.task.id), first),
      );
      assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test('迁移27保留旧任务和检查点，不从已有Run或引用自动生成方案', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'migration.sqlite');
    f.api.store.db.prepare('VACUUM INTO ?').run(path);
    const old = new DatabaseSync(path);
    const task = old.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body;
    const checkpoint = old.prepare('SELECT body FROM commit_checkpoints').get()!.body;
    old.exec(
      'DROP TABLE work_branch_events; DROP TABLE work_branches; DROP TABLE work_branch_groups; DELETE FROM schema_migrations WHERE version=27;',
    );
    old.close();
    const upgraded = new Store(path, undefined, { team: true });
    try {
      assert.equal(
        upgraded.db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body,
        task,
      );
      assert.equal(
        upgraded.db.prepare('SELECT body FROM commit_checkpoints').get()!.body,
        checkpoint,
      );
      assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM work_branches').get()!.n, 0);
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      upgraded.close();
    }
  } finally {
    await f.close();
  }
});
