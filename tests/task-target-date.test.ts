import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { migrations } from '../packages/db/src/schema.js';
import { demoProjects, demoTasks, demoUser, SPACE_ID } from '../packages/db/src/seed.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import { parseTaskCreate } from '../packages/contracts/src/index.js';
import {
  isValidTaskTargetDate,
  parseTaskTargetDate,
} from '../packages/contracts/src/task-target-date.js';
import { Store } from '../packages/db/src/store.js';

test('目标日期严格校验真实公历日期，保留 0001..9999 和世纪闰年', () => {
  for (const date of [
    '0001-01-01',
    '0099-12-31',
    '0400-02-29',
    '2000-02-29',
    '2024-02-29',
    '9999-12-31',
  ]) {
    assert.equal(isValidTaskTargetDate(date), true, date);
    assert.equal(parseTaskTargetDate(date), date);
  }
  for (const date of [
    '0000-01-01',
    '10000-01-01',
    '1900-02-29',
    '2100-02-29',
    '2025-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    ' 2026-01-01',
    '2026-01-01 ',
    '2026-01-01T00:00:00Z',
    '',
    20261008,
    false,
    undefined,
    {},
    [],
  ]) {
    assert.equal(isValidTaskTargetDate(date), false, String(date));
    assert.throws(() => parseTaskTargetDate(date), { code: 'INVALID_INPUT' });
  }
  assert.equal(parseTaskTargetDate(null), null);
});

function create(store: Store) {
  return store.createTask(
    { title: '日历规划', description: '普通人工任务', projectId: store.projects()[0]!.id },
    'create',
  );
}
function snapshot(store: Store) {
  const names = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    names.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}

test('旧记录和普通创建不补日期，创建契约不扩张；人类投影只读为 null', () => {
  const store = new Store();
  try {
    const task = create(store);
    assert.equal(Object.hasOwn(task, 'targetDate'), false);
    assert.throws(() => parseTaskCreate({ title: '新任务', targetDate: '2026-10-08' }), {
      code: 'INVALID_INPUT',
    });
    const before = snapshot(store);
    assert.equal(store.detail(task.id).task.targetDate, null);
    assert.equal(store.workbench().tasks.find((t) => t.id === task.id)!.targetDate, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_target_dates').get()!.n, 0);
    assert.deepEqual(snapshot(store), before);
  } finally {
    store.close();
  }
});

test('日期写入、普通内容 PATCH 省略保留、null 清除；内部 Task JSON 不带日期', () => {
  const store = new Store();
  try {
    const task = create(store);
    const saved = store.patchTask(
      task.id,
      { expectedRevision: 1, targetDate: '2028-02-29' },
      'date',
    );
    assert.equal(saved.targetDate, '2028-02-29');
    assert.equal(saved.revision, 2);
    assert.equal(store.detail(task.id).task.targetDate, '2028-02-29');
    assert.equal(Object.hasOwn(store.getTask(task.id), 'targetDate'), false);
    assert.equal(Object.hasOwn(store.tasks().find((t) => t.id === task.id)!, 'targetDate'), false);
    assert.equal(
      Object.hasOwn(
        JSON.parse(
          store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id)!.body as string,
        ),
        'targetDate',
      ),
      false,
    );
    const edited = store.patchTask(task.id, { expectedRevision: 2, title: '改标题' }, 'title');
    assert.equal(edited.targetDate, '2028-02-29');
    assert.equal(
      store.patchTask(task.id, { expectedRevision: 3, targetDate: null }, 'clear').targetDate,
      null,
    );
    assert.equal(store.detail(task.id).task.targetDate, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_target_dates').get()!.n, 0);
  } finally {
    store.close();
  }
});

test('旧修订拒绝，旧原键回放固定首次日期，不能覆盖后来的日期或清除', () => {
  const store = new Store();
  try {
    const task = create(store);
    const payload = { expectedRevision: 1, targetDate: '2026-10-08' };
    const first = store.patchTask(task.id, payload, 'first');
    store.patchTask(task.id, { expectedRevision: 2, targetDate: '2026-10-09' }, 'second');
    const before = snapshot(store);
    assert.deepEqual(store.patchTask(task.id, payload, 'first'), first);
    assert.throws(() => store.patchTask(task.id, payload, 'stale'), { code: 'REVISION_CONFLICT' });
    assert.throws(
      () => store.patchTask(task.id, { ...payload, targetDate: '2026-10-10' }, 'first'),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.deepEqual(snapshot(store), before);
    assert.equal(store.detail(task.id).task.targetDate, '2026-10-09');
  } finally {
    store.close();
  }
});

test('无效日期不产生持久效果；日期、Task、通知、回执任一步失败都回滚', () => {
  for (const [table, operation] of [
    ['task_target_dates', 'INSERT'],
    ['tasks', 'UPDATE'],
    ['outbox', 'INSERT'],
    ['idempotency_records', 'INSERT'],
  ]) {
    const store = new Store();
    try {
      const task = create(store);
      const before = snapshot(store);
      assert.throws(
        () =>
          store.patchTask(task.id, { expectedRevision: 1, targetDate: '2026-02-30' }, 'invalid'),
        { code: 'INVALID_INPUT' },
      );
      assert.deepEqual(snapshot(store), before);
      store.db.exec(
        `CREATE TRIGGER fail_date_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'date rollback'); END;`,
      );
      assert.throws(
        () => store.patchTask(task.id, { expectedRevision: 1, targetDate: '2026-10-08' }, 'date'),
        /date rollback/,
      );
      assert.deepEqual(snapshot(store), before);
      store.db.exec('DROP TRIGGER fail_date_write');
      assert.equal(
        store.patchTask(task.id, { expectedRevision: 1, targetDate: '2026-10-08' }, 'date')
          .targetDate,
        '2026-10-08',
      );
    } finally {
      store.close();
    }
  }
});

test('日期修改不写其他业务表或任务状态，重启后保留当前日期及原回执', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-date-'));
  let store = new Store(join(dir, 'test.sqlite'));
  try {
    const task = create(store);
    const before = snapshot(store);
    const body = { expectedRevision: 1, targetDate: '0001-01-01' };
    const receipt = store.patchTask(task.id, body, 'date');
    assert.equal(receipt.status, task.status);
    const after = snapshot(store);
    for (const name of Object.keys(before))
      if (!['tasks', 'task_target_dates', 'outbox', 'idempotency_records'].includes(name))
        assert.deepEqual(after[name], before[name], name);
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    assert.equal(store.detail(task.id).task.targetDate, '0001-01-01');
    assert.deepEqual(store.patchTask(task.id, body, 'date'), receipt);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 v34 数据库升级到 v35 不改旧 Task/回执；后续日期重启保留且旧回放不漂移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-date-v34-'));
  const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  let store: Store | undefined;
  try {
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations.filter((item) => item.version <= 34)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?)').run(migration.version);
    }
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='task_target_dates'").get(),
      undefined,
    );
    const project = demoProjects[0]!;
    const original = demoTasks.find((task) => task.projectId === project.id)!;
    const oldBody = { expectedRevision: 1, title: '升级前保存的标题' };
    const oldReceipt = { ...original, title: oldBody.title, revision: 2 };
    assert.equal(Object.hasOwn(oldReceipt, 'targetDate'), false);
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
      project.id,
      SPACE_ID,
      JSON.stringify(project),
    );
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(
      original.id,
      SPACE_ID,
      project.id,
      JSON.stringify(oldReceipt),
    );
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', 'true');
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('data_mode', 'preview');
    db.prepare('INSERT INTO idempotency_records VALUES(?,?,?,?)').run(
      `${demoUser.id}:task.patch:${original.id}`,
      'legacy-patch',
      createHash('sha256').update(canonicalJson(oldBody)).digest('hex'),
      JSON.stringify(oldReceipt),
    );
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id=?').get(original.id);
    const oldRows = db.prepare('SELECT * FROM idempotency_records').all();
    db.close();
    store = new Store(path);
    assert.equal(
      store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version,
      35,
    );
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks WHERE id=?').get(original.id), taskRow);
    assert.deepEqual(store.db.prepare('SELECT * FROM idempotency_records').all(), oldRows);
    assert.equal(store.detail(original.id).task.targetDate, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_target_dates').get()!.n, 0);
    assert.deepEqual(store.patchTask(original.id, oldBody, 'legacy-patch'), oldReceipt);
    const currentBody = { expectedRevision: 2, targetDate: '2028-02-29' };
    const currentReceipt = store.patchTask(original.id, currentBody, 'new-date');
    store.close();
    store = new Store(path);
    const beforeReplay = snapshot(store);
    assert.equal(store.detail(original.id).task.targetDate, '2028-02-29');
    assert.deepEqual(store.patchTask(original.id, currentBody, 'new-date'), currentReceipt);
    assert.deepEqual(store.patchTask(original.id, oldBody, 'legacy-patch'), oldReceipt);
    assert.deepEqual(snapshot(store), beforeReplay);
  } finally {
    try {
      db.close();
    } catch {}
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
