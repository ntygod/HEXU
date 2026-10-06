import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/control/src/app.js';
import {
  parseAddResultReference,
  RESULT_REFERENCE_LIMIT,
  type AddResultReferenceInput,
  type ResultReference,
  type ResultReferenceList,
} from '../packages/contracts/src/result-references.js';
import { ResultReferences } from '../packages/db/src/result-references.js';
import { ResultRevisions } from '../packages/db/src/result-revisions.js';
import { Store } from '../packages/db/src/store.js';

type App = Awaited<ReturnType<typeof createApp>>;
const input: AddResultReferenceInput = {
  kind: 'report',
  title: '手动检查报告',
  url: 'https://example.test/reports/42?view=summary#notes',
  environment: '测试环境',
  sourceNote: '成员手动补充\n尚未检查外部内容',
};

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-result-references-'));
  const path = join(dir, 'preview.sqlite');
  const store = new Store(path);
  const app = await createApp({ store, native: { enabled: false, roots: [] } });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const task = store.createTask(
    { title: '普通成果任务', description: '', projectId: null },
    randomUUID(),
  );
  const result = store.createResult(task.id, '第一版', '固定第一版说明', randomUUID());
  const revisions = new ResultRevisions(store);
  const first = revisions.current(result);
  const current = { ...result, revision: 2, title: '第二版', body: '固定第二版说明' };
  const second = store.atomic(() => {
    store.db
      .prepare('UPDATE results SET body=? WHERE id=?')
      .run(JSON.stringify(current), result.id);
    return revisions.append(current, { kind: 'member' });
  });
  const other = store.createResult(task.id, '另一个成果', '独立成果', randomUUID());
  return {
    app,
    store,
    path,
    task,
    result: current,
    first,
    second,
    other,
    otherVersion: revisions.current(other),
  };
}

function url(resultId: string, revisionId: string, referenceId?: string) {
  const base = `/api/v1/results/${resultId}/versions/${revisionId}/references`;
  return referenceId ? `${base}/${referenceId}/remove` : base;
}

function post(app: App, target: string, payload: unknown, key: string = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: target,
    payload: JSON.stringify(payload),
    headers: { 'x-hexu-client': 'web', 'idempotency-key': key, 'content-type': 'application/json' },
  });
}

async function list(app: App, target: string) {
  const response = await app.inject(target);
  assert.equal(response.statusCode, 200, response.body);
  return response.json<ResultReferenceList>();
}

function mutationSnapshot(store: Store) {
  return {
    references: store.db.prepare('SELECT * FROM result_references ORDER BY rowid').all(),
    receipts: store.db.prepare('SELECT * FROM idempotency_records ORDER BY rowid').all(),
    outbox: store.db.prepare('SELECT * FROM outbox ORDER BY sequence').all(),
  };
}

function parentSnapshot(store: Store) {
  return {
    results: store.db.prepare('SELECT * FROM results ORDER BY rowid').all(),
    versions: store.db.prepare('SELECT * FROM result_revisions ORDER BY rowid').all(),
    tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(),
    runs: store.db.prepare('SELECT * FROM runs ORDER BY rowid').all(),
    messages: store.db.prepare('SELECT * FROM messages ORDER BY rowid').all(),
    completions: store.db.prepare('SELECT * FROM completion_events ORDER BY rowid').all(),
  };
}

test('manual report and release links stay on their fixed version and preserve all parent state', async (t) => {
  const { app, store, path, task, result, first, second } = await fixture(t);
  const before = parentSnapshot(store);
  const oldUrl = url(result.id, first.id);
  const newUrl = url(result.id, second.id);
  assert.deepEqual(await list(app, oldUrl), { items: [], limit: RESULT_REFERENCE_LIMIT });
  const added = await post(app, oldUrl, input);
  assert.equal(added.statusCode, 201, added.body);
  const reference = added.json<ResultReference>();
  assert.deepEqual(reference, {
    id: reference.id,
    resultId: result.id,
    resultRevisionId: first.id,
    taskId: task.id,
    ...input,
    source: 'manual',
    externalState: 'unknown',
    availability: 'not_checked',
    recordedBy: { id: store.actorId, name: store.actorName() },
    recordedAt: reference.recordedAt,
    removedAt: null,
    removedBy: null,
  });
  assert.ok(reference.id);
  assert.ok(Number.isFinite(Date.parse(reference.recordedAt)));
  assert.deepEqual((await list(app, oldUrl)).items, [reference]);
  assert.deepEqual((await list(app, newUrl)).items, []);
  const release = await post(app, newUrl, {
    kind: 'release',
    title: '<b>手动发布地址</b>',
    url: 'http://example.test/release',
  });
  assert.equal(release.statusCode, 201, release.body);
  const releaseReference = release.json<ResultReference>();
  assert.equal(releaseReference.title, '<b>手动发布地址</b>');
  assert.equal(releaseReference.environment, null);
  assert.equal(releaseReference.sourceNote, null);
  assert.deepEqual((await list(app, newUrl)).items, [releaseReference]);
  assert.deepEqual(parentSnapshot(store), before);
  const reopened = new Store(path);
  try {
    assert.deepEqual(new ResultReferences(reopened).list(result.id, first.id).items, [reference]);
    assert.deepEqual(new ResultReferences(reopened).list(result.id, second.id).items, [
      releaseReference,
    ]);
  } finally {
    reopened.close();
  }
});

test('removal retains its record and original add/remove receipts without duplicate events', async (t) => {
  const { app, store, task, result, first } = await fixture(t);
  const target = url(result.id, first.id);
  const addKey = randomUUID();
  const added = await post(app, target, input, addKey);
  const reference = added.json<ResultReference>();
  const afterAdd = mutationSnapshot(store);
  const getTask = store.getTask;
  const editChecks: string[] = [];
  // Observe the ordinary public guard; its permission behavior remains unchanged.
  store.getTask = (id, edit = false) => {
    if (edit) editChecks.push(id);
    return getTask.call(store, id, edit);
  };
  t.after(() => {
    store.getTask = getTask;
  });
  const addReplay = await post(app, target, input, addKey);
  assert.equal(addReplay.statusCode, 201, addReplay.body);
  assert.deepEqual(addReplay.json(), reference);
  assert.deepEqual(editChecks, [task.id]);
  assert.deepEqual(mutationSnapshot(store), afterAdd);
  const removeUrl = url(result.id, first.id, reference.id);
  const removeKey = randomUUID();
  const removal = await post(app, removeUrl, {}, removeKey);
  assert.equal(removal.statusCode, 200, removal.body);
  const removed = removal.json<ResultReference>();
  assert.ok(removed.removedAt);
  assert.deepEqual(removed.removedBy, { id: store.actorId, name: store.actorName() });
  assert.deepEqual({ ...removed, removedAt: null, removedBy: null }, reference);
  assert.deepEqual((await list(app, target)).items, []);
  const retained = store.db
    .prepare('SELECT body,removed_at FROM result_references WHERE id=?')
    .get(reference.id) as { body: string; removed_at: string };
  assert.deepEqual(JSON.parse(retained.body), removed);
  assert.equal(retained.removed_at, removed.removedAt);
  const afterRemove = mutationSnapshot(store);
  editChecks.length = 0;
  const removeReplay = await post(app, removeUrl, {}, removeKey);
  assert.deepEqual(removeReplay.json(), removed);
  assert.equal(removeReplay.statusCode, 200, removeReplay.body);
  const originalAddReplay = await post(app, target, input, addKey);
  assert.equal(originalAddReplay.statusCode, 201, originalAddReplay.body);
  assert.deepEqual(originalAddReplay.json(), reference);
  assert.deepEqual(editChecks, [task.id, task.id]);
  assert.deepEqual(mutationSnapshot(store), afterRemove);
  const anotherRemove = await post(app, removeUrl, {});
  assert.equal(anotherRemove.statusCode, 200, anotherRemove.body);
  assert.deepEqual(anotherRemove.json(), removed);
  assert.deepEqual(mutationSnapshot(store).references, afterRemove.references);
  assert.deepEqual(mutationSnapshot(store).outbox, afterRemove.outbox);
});

test('receipts bind exact request content and loaded version; wrong-result and same-result version links fail', async (t) => {
  const { app, store, result, first, second, other, otherVersion } = await fixture(t);
  const target = url(result.id, first.id);
  const key = randomUUID();
  const added = await post(app, target, input, key);
  assert.equal(added.statusCode, 201, added.body);
  const reference = added.json<ResultReference>();
  const before = mutationSnapshot(store);
  for (const change of [
    { title: '修改标题' },
    { title: ` ${input.title}` },
    { kind: 'release' },
    { url: 'https://example.test/another' },
    { environment: '生产环境' },
    { sourceNote: '其他来源' },
  ]) {
    const response = await post(app, target, { ...input, ...change }, key);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, 'IDEMPOTENCY_CONFLICT');
  }
  const retarget = await post(app, url(result.id, second.id), input, key);
  assert.equal(retarget.statusCode, 409, retarget.body);
  assert.equal(retarget.json().error.code, 'IDEMPOTENCY_CONFLICT');
  for (const [resultId, versionId] of [
    [result.id, 'missing-version'],
    [result.id, otherVersion.id],
    [other.id, first.id],
  ]) {
    const read = await app.inject(url(resultId!, versionId!));
    assert.equal(read.statusCode, 404, read.body);
    const write = await post(app, url(resultId!, versionId!), input);
    assert.equal(write.statusCode, 404, write.body);
  }
  for (const target of [
    url(result.id, second.id, reference.id),
    url(other.id, otherVersion.id, reference.id),
  ]) {
    const response = await post(app, target, {});
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.deepEqual(mutationSnapshot(store), before);
  const removeKey = randomUUID();
  const removed = await post(app, url(result.id, first.id, reference.id), {}, removeKey);
  assert.equal(removed.statusCode, 200, removed.body);
  const wrongReplay = await post(app, url(result.id, second.id, reference.id), {}, removeKey);
  assert.equal(wrongReplay.statusCode, 404, wrongReplay.body);
  const another = await post(app, target, { ...input, title: '其他报告' });
  const changedRemove = await post(
    app,
    url(result.id, first.id, another.json<ResultReference>().id),
    {},
    removeKey,
  );
  assert.equal(changedRemove.statusCode, 409, changedRemove.body);
  assert.equal(changedRemove.json().error.code, 'IDEMPOTENCY_CONFLICT');
});

test('strict plain-text and HTTP(S) input validation never records invalid requests', async (t) => {
  const { app, store, result, first } = await fixture(t);
  const target = url(result.id, first.id);
  const before = mutationSnapshot(store);
  const invalid: unknown[] = [null, [], {}, { ...input, title: '' }, { ...input, kind: 'preview' }];
  for (const field of [
    'externalState',
    'availability',
    'source',
    'recordedBy',
    'recordedAt',
    'removedAt',
    'taskId',
    'resultRevisionId',
  ])
    invalid.push({ ...input, [field]: 'untrusted' });
  for (const [field, max] of [
    ['title', 160],
    ['url', 2048],
    ['environment', 120],
    ['sourceNote', 1000],
  ] as const) {
    invalid.push({ ...input, [field]: 'x'.repeat(max + 1) });
    invalid.push({ ...input, [field]: {} });
    invalid.push({ ...input, [field]: null });
  }
  for (const badUrl of [
    '/relative',
    '//example.test/report',
    'example.test/report',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/report',
    'ftp://example.test',
    'https:',
    'https:///missing-slashes',
    'https://',
    'https://user:password@example.test/report',
    'https://example.test/a b',
    'https://example.test/\npath',
    'https://example.test/\\path',
  ])
    invalid.push({ ...input, url: badUrl });
  invalid.push({ ...input, title: '控制\u0000字符' });
  for (const body of invalid) {
    const response = await post(app, target, body);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'INVALID_INPUT');
  }
  assert.deepEqual(mutationSnapshot(store), before);
  const prefix = 'https://example.test/';
  const boundary = {
    ...input,
    title: '字'.repeat(160),
    url: prefix + 'a'.repeat(2048 - prefix.length),
    environment: '环'.repeat(120),
    sourceNote: '说'.repeat(1000),
  };
  assert.deepEqual(parseAddResultReference(boundary), boundary);
  const valid = await post(app, target, boundary);
  assert.equal(valid.statusCode, 201, valid.body);
  const invalidRemove = await post(
    app,
    url(result.id, first.id, valid.json<ResultReference>().id),
    { removePermanently: true },
  );
  assert.equal(invalidRemove.statusCode, 400, invalidRemove.body);
  assert.equal((await list(app, target)).items.length, 1);
});

test('active reference limit is fixed per version and removal frees a slot without losing history', async (t) => {
  const { app, store, result, first, second } = await fixture(t);
  const target = url(result.id, first.id);
  const keys: string[] = [];
  const added: ResultReference[] = [];
  for (let i = 0; i < RESULT_REFERENCE_LIMIT; i++) {
    const key = randomUUID();
    keys.push(key);
    const response = await post(app, target, { ...input, title: `报告 ${i}` }, key);
    assert.equal(response.statusCode, 201, response.body);
    added.push(response.json<ResultReference>());
  }
  const full = await list(app, target);
  assert.equal(full.limit, RESULT_REFERENCE_LIMIT);
  assert.deepEqual(
    full.items.map((item) => item.id),
    added.map((item) => item.id).reverse(),
  );
  const before = mutationSnapshot(store);
  const rejected = await post(app, target, input);
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error.code, 'RESULT_REFERENCE_LIMIT');
  const replay = await post(app, target, { ...input, title: '报告 0' }, keys[0]);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), added[0]);
  assert.deepEqual(mutationSnapshot(store), before);
  const otherVersion = await post(app, url(result.id, second.id), input);
  assert.equal(otherVersion.statusCode, 201, otherVersion.body);
  const removed = await post(app, url(result.id, first.id, added[0]!.id), {});
  assert.equal(removed.statusCode, 200, removed.body);
  const replacement = await post(app, target, input);
  assert.equal(replacement.statusCode, 201, replacement.body);
  assert.equal((await list(app, target)).items.length, RESULT_REFERENCE_LIMIT);
  const count = store.db
    .prepare('SELECT COUNT(*) AS count FROM result_references WHERE result_revision_id=?')
    .get(first.id) as { count: number };
  assert.equal(count.count, RESULT_REFERENCE_LIMIT + 1);
});

test('add and remove atomically roll back reference, receipt, and outbox when a write fails', async (t) => {
  const { app, store, result, first } = await fixture(t);
  const target = url(result.id, first.id);
  const parent = parentSnapshot(store);
  for (const stage of ['outbox', 'idempotency_records']) {
    const addKey = randomUUID();
    const before = mutationSnapshot(store);
    store.db.exec(`CREATE TEMP TRIGGER reject_reference_write BEFORE INSERT ON ${stage}
      BEGIN SELECT RAISE(ABORT,'ordinary reference transaction test'); END`);
    const failed = await post(app, target, input, addKey);
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(mutationSnapshot(store), before);
    store.db.exec('DROP TRIGGER reject_reference_write');
    const retried = await post(app, target, input, addKey);
    assert.equal(retried.statusCode, 201, retried.body);
    const reference = retried.json<ResultReference>();
    const beforeRemove = mutationSnapshot(store);
    const removeKey = randomUUID();
    store.db.exec(`CREATE TEMP TRIGGER reject_reference_write BEFORE INSERT ON ${stage}
      BEGIN SELECT RAISE(ABORT,'ordinary reference transaction test'); END`);
    const failedRemove = await post(app, url(result.id, first.id, reference.id), {}, removeKey);
    assert.equal(failedRemove.statusCode, 500, failedRemove.body);
    assert.deepEqual(mutationSnapshot(store), beforeRemove);
    store.db.exec('DROP TRIGGER reject_reference_write');
    const retriedRemove = await post(app, url(result.id, first.id, reference.id), {}, removeKey);
    assert.equal(retriedRemove.statusCode, 200, retriedRemove.body);
  }
  assert.deepEqual(parentSnapshot(store), parent);
});

test('migration 32 starts with no inferred links and preserves existing immutable version bytes', async (t) => {
  const { app, store, path } = await fixture(t);
  const before = parentSnapshot(store);
  await app.close();
  // Rebuild the pre-32 Result structures, retaining any later unrelated migrations.
  const baseline = new DatabaseSync(path);
  baseline.exec(`DROP TABLE result_references;
    DROP INDEX result_revisions_reference_identity;
    DELETE FROM schema_migrations WHERE version=32;`);
  baseline.close();
  const migrated = new Store(path);
  try {
    assert.deepEqual(parentSnapshot(migrated), before);
    assert.deepEqual(migrated.db.prepare('SELECT * FROM result_references').all(), []);
    assert.equal(
      (
        migrated.db.prepare('SELECT version FROM schema_migrations WHERE version=32').get() as {
          version: number;
        }
      ).version,
      32,
    );
  } finally {
    migrated.close();
  }
});

test('legacy result and new reference migrations rebuild together without inferred references', async (t) => {
  const { app, store, path, result, task } = await fixture(t);
  const parents = parentSnapshot(store);
  assert.deepEqual(store.db.prepare('SELECT * FROM result_references').all(), []);
  await app.close();
  const baseline = new DatabaseSync(path);
  baseline.exec(`DROP TABLE result_references;
    DROP TABLE work_branch_choices;
    DROP TABLE result_revisions;
    ALTER TABLE node_dispatches DROP COLUMN terminal_sequence;
    DELETE FROM schema_migrations WHERE version IN (29,32);`);
  baseline.close();
  const migrated = new Store(path);
  try {
    const version = new ResultRevisions(migrated).current(result);
    assert.equal(version.resultId, result.id);
    assert.equal(version.taskId, task.id);
    assert.equal(version.revision, result.revision);
    assert.equal(version.title, result.title);
    assert.equal(version.body, result.body);
    assert.deepEqual(version.source, { kind: 'legacy' });
    assert.equal(version.createdBy, null);
    assert.deepEqual(new ResultReferences(migrated).list(result.id, version.id).items, []);
    const after = parentSnapshot(migrated);
    assert.deepEqual(after.results, parents.results);
    assert.deepEqual(after.tasks, parents.tasks);
    assert.deepEqual(after.runs, parents.runs);
    assert.deepEqual(after.messages, parents.messages);
    assert.deepEqual(after.completions, parents.completions);
    assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    migrated.close();
  }
});
