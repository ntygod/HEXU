import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  INTEGRATION_TRIAL_DIFFERENCE_LIMITS,
  parseIntegrationTrialDifference,
  type IntegrationTrialDifferenceReport,
} from '../packages/contracts/src/integration-trial.js';
import {
  parseCodeDifference,
  type CodeFileDifference,
  type CodeFileVersion,
} from '../packages/contracts/src/result-code.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
import { IntegrationStore } from '../packages/db/src/integrations.js';
import { Store } from '../packages/db/src/store.js';
import { codeHash } from '../packages/db/src/result-code.js';
import { migrations } from '../packages/db/src/schema.js';
import { integrationFixture } from './helpers/integrations.js';
import { recordResultCode } from './helpers/result-code.js';
import { CheckpointTransferStore } from '../packages/db/src/checkpoint-transfer.js';

type Fixture = Awaited<ReturnType<typeof integrationFixture>>;
const utf8Sort = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const version = (text: string, format: 'sha1' | 'sha256' = 'sha1'): CodeFileVersion => ({
  objectId: createHash(format)
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex'),
  mode: '100644',
  bytes: Buffer.byteLength(text),
});
const addition = (path: string, text = 'body'): CodeFileDifference => ({
  path,
  before: null,
  after: version(text),
  display: 'text',
  beforeText: '',
  afterText: text,
});
const plain = (): IntegrationTrialDifferenceReport => ({
  version: 1,
  kind: 'integration_trial_difference',
  integrationId: 'integration',
  trialId: 'trial',
  integrationInputHash: 'a'.repeat(64),
  preflightReportHash: 'b'.repeat(64),
  manifestHash: 'c'.repeat(64),
  selection: 'apply_source',
  selectedPaths: ['new.txt'],
  materializedAt: '2026-01-01T00:00:00.000Z',
  comparedAt: '2026-01-01T00:00:00.000Z',
  difference: { changedFiles: 1, omittedFiles: 0, files: [addition('new.txt')] },
  trialOnly: true,
  applied: false,
  writeAuthorized: false,
  confirmPublication: true,
});
const selected = (
  paths: string[],
  files: CodeFileDifference[] = [],
): IntegrationTrialDifferenceReport => ({
  ...plain(),
  selectedPaths: [...paths].sort(utf8Sort),
  difference: { changedFiles: paths.length, omittedFiles: paths.length - files.length, files },
});
const view = (f: Fixture, id: string) =>
  f.as(() => new IntegrationStore(f.api.store).get(f.task.id, id));
async function ready(f: Fixture) {
  const initial = await f.create();
  const published = await f.protocol('publish', f.report(initial));
  assert.equal(published.statusCode, 200, published.body);
  return view(f, initial.operation.id);
}
function report(f: Fixture, v: IntegrationView): IntegrationTrialDifferenceReport {
  const files = v.operation.report!.plan!.files.filter(
    (item) => ['add', 'modify', 'delete'].includes(item.action) && !item.conflict,
  );
  const objects = (snapshot: Fixture['source']) =>
    new Map(snapshot.objects.map((o) => [o.id, o.data]));
  const before = objects(f.target),
    after = objects(f.source);
  return {
    ...plain(),
    integrationId: v.operation.id,
    trialId: randomUUID(),
    integrationInputHash: v.operation.inputHash,
    preflightReportHash: v.reportHash!,
    materializedAt: new Date().toISOString(),
    comparedAt: new Date().toISOString(),
    selectedPaths: files.map((item) => item.path).sort(utf8Sort),
    difference: {
      changedFiles: files.length,
      omittedFiles: 0,
      files: files.map((item) => ({
        path: item.path,
        before: item.target,
        after: item.source,
        display: 'text',
        beforeText: item.target ? before.get(item.target.objectId)!.toString('utf8') : '',
        afterText: item.source ? after.get(item.source.objectId)!.toString('utf8') : '',
      })),
    },
  };
}
const publish = (f: Fixture, data: unknown, index = 0) =>
  f.protocol('trial-diff-publish', data, index);
const historyPath = (f: Fixture, id: string) => `${f.integrationPath}/${id}/trials`;
const unchanged = (f: Fixture) =>
  [
    'integration_operations',
    'integration_events',
    'tasks',
    'runs',
    'results',
    'result_revisions',
    'work_branches',
    'work_branch_choices',
    'node_dispatches',
    'idempotency_records',
  ].map((table) => JSON.stringify(f.api.store.db.prepare(`SELECT * FROM ${table}`).all()));

test('候选差异严格保留选择、时间与只读语义，拒绝额外字段及正文越界', () => {
  const data = plain();
  assert.deepEqual(parseIntegrationTrialDifference(data), data);
  for (const change of [
    { version: 2 },
    { kind: 'application' },
    { selection: 'apply_target' },
    { trialOnly: false },
    { applied: true },
    { writeAuthorized: true },
    { confirmPublication: false },
    { confirmPublication: undefined },
    { integrationId: '/private' },
    { trialId: '../candidate' },
    { integrationInputHash: 'a' },
    { preflightReportHash: 'b'.repeat(40) },
    { manifestHash: 'secret' },
    { materializedAt: 'today' },
    { comparedAt: '2025-01-01T00:00:00.000Z' },
    { selectedPaths: [] },
    { selectedPaths: ['new.txt', 'new.txt'] },
    { selectedPaths: ['z', 'a'] },
    { selectedPaths: ['../secret'] },
    { selectedPaths: ['/absolute'] },
    { selectedPaths: ['C:/private'] },
    { selectedPaths: ['.git/config'] },
    { selectedPaths: ['a\\b'] },
    { selectedPaths: ['a\u0000b'] },
    { selectedPaths: ['bad\ud800'] },
    { selectedPaths: ['a'.repeat(4097)] },
    { selectedPaths: Array.from({ length: 81 }, (_, i) => `f${i}`) },
    { selectedPaths: ['other'] },
    { root: '/private' },
    { inode: 12 },
    { credentials: {} },
    { manifest: {} },
    { difference: { ...data.difference, changedFiles: 2 } },
    { difference: { ...data.difference, omittedFiles: 1 } },
    { difference: { ...data.difference, unrelatedBody: 'secret' } },
  ])
    assert.throws(
      () => parseIntegrationTrialDifference({ ...data, ...change }),
      JSON.stringify(change),
    );
  for (const key of Object.keys(data)) {
    const incomplete: Record<string, unknown> = { ...data };
    delete incomplete[key];
    assert.throws(() => parseIntegrationTrialDifference(incomplete), key);
  }
  for (const file of [
    { ...addition('new.txt'), afterText: 'short' },
    { ...addition('new.txt'), afterText: 'bo\u0000y' },
    { ...addition('new.txt'), display: 'binary' },
    { ...addition('new.txt'), after: { ...version('body'), mode: '120000' } },
    { ...addition('new.txt'), before: version('body'), beforeText: 'body' },
    { ...addition('new.txt'), after: null },
  ])
    assert.throws(() =>
      parseIntegrationTrialDifference({
        ...data,
        difference: { ...data.difference, files: [file] },
      }),
    );
});

test('完整选择最多80项，文件40项，文本8192字节，总差异24KiB及报告48KiB独立限额', () => {
  const eighty = Array.from({ length: 80 }, (_, i) => `file-${String(i).padStart(2, '0')}`);
  assert.equal(parseIntegrationTrialDifference(selected(eighty)).selectedPaths.length, 80);
  assert.equal(
    parseIntegrationTrialDifference(
      selected(
        eighty,
        eighty.slice(0, 40).map((p) => addition(p)),
      ),
    ).difference.files.length,
    40,
  );
  assert.throws(() =>
    parseIntegrationTrialDifference(
      selected(
        eighty,
        eighty.slice(0, 41).map((p) => addition(p)),
      ),
    ),
  );
  assert.equal(
    parseIntegrationTrialDifference(selected(['x'], [addition('x', 'a'.repeat(8192))])).difference
      .files[0]!.after!.bytes,
    8192,
  );
  assert.throws(() =>
    parseIntegrationTrialDifference(selected(['x'], [addition('x', 'a'.repeat(8193))])),
  );
  assert.throws(() =>
    parseIntegrationTrialDifference(selected(['x'], [addition('x', '中'.repeat(3000))])),
  );
  assert.throws(() =>
    parseIntegrationTrialDifference(
      selected(
        ['a', 'b', 'c'],
        ['a', 'b', 'c'].map((p) => addition(p, 'x'.repeat(8192))),
      ),
    ),
  );
  const long = eighty.map((p) => p + 'x'.repeat(600));
  assert.throws(() => parseIntegrationTrialDifference(selected(long)), /48 KiB/);
  // UTF-8 byte ordering differs from JS UTF-16 ordering for these valid names.
  const unicode = ['\uE000', '\u{10000}'];
  assert.deepEqual(parseIntegrationTrialDifference(selected(unicode)).selectedPaths, unicode);
  assert.throws(() =>
    parseIntegrationTrialDifference({
      ...selected(unicode),
      selectedPaths: [...unicode].reverse(),
    }),
  );
  assert.equal(INTEGRATION_TRIAL_DIFFERENCE_LIMITS.reports, 100);
});

test('试应用允许大小写和NFC重命名的删除/新增；同侧冲突拒绝且旧Result跨侧规则不变', () => {
  for (const [oldPath, newPath] of [
    ['Readme', 'README'],
    ['e\u0301.txt', 'é.txt'],
  ]) {
    const files: CodeFileDifference[] = [
      {
        path: oldPath!,
        before: version('old'),
        after: null,
        display: 'text',
        beforeText: 'old',
        afterText: '',
      },
      addition(newPath!, 'new'),
    ];
    const data = selected([oldPath!, newPath!], files);
    assert.equal(parseIntegrationTrialDifference(data).difference.files.length, 2);
    assert.throws(
      () =>
        parseCodeDifference({
          revisionId: 'revision',
          referenceHash: 'a'.repeat(64),
          comparedAt: data.comparedAt,
          ...data.difference,
        }),
      /重复或冲突/,
    );
    assert.throws(
      () =>
        parseIntegrationTrialDifference(
          selected([oldPath!, newPath!], [addition(oldPath!), addition(newPath!)]),
        ),
      /冲突/,
    );
  }
  assert.throws(
    () =>
      parseIntegrationTrialDifference(
        selected(['folder', 'folder/file'], [addition('folder'), addition('folder/file')]),
      ),
    /目录冲突/,
  );
  assert.throws(
    () =>
      parseIntegrationTrialDifference(
        selected(['src/a', 'SRC/b'], [addition('src/a'), addition('SRC/b')]),
      ),
    /冲突/,
  );
  assert.deepEqual(
    parseCodeDifference({
      revisionId: 'revision',
      referenceHash: 'a'.repeat(64),
      comparedAt: plain().comparedAt,
      ...plain().difference,
    }).files,
    plain().difference.files,
  );
});

test('SHA1/SHA256候选正文验证，分享回执与历史不可变且不改变原整合Task/Run/Result', async () => {
  for (const format of ['sha1', 'sha256'] as const) {
    const f = await integrationFixture(undefined, format);
    try {
      const v = await ready(f),
        data = report(f, v),
        before = unchanged(f);
      assert.equal(v.canTrial, true);
      assert.equal(v.canApply, true);
      const result = await publish(f, data);
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(Object.keys(result.json()).sort(), [
        'hash',
        'integrationId',
        'receivedAt',
        'trialId',
      ]);
      assert.equal(result.json().hash, codeHash(data));
      const outbox = JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all());
      assert.deepEqual(
        (await publish(f, Object.fromEntries(Object.entries(data).reverse()))).json(),
        result.json(),
      );
      assert.equal(JSON.stringify(f.api.store.db.prepare('SELECT * FROM outbox').all()), outbox);
      assert.deepEqual(unchanged(f), before);
      assert.deepEqual(view(f, v.operation.id).operation, v.operation);
      const history = await f.api.call(historyPath(f, v.operation.id), f.alice);
      assert.equal(history.statusCode, 200, history.body);
      assert.deepEqual(history.json().items, [
        {
          trialId: data.trialId,
          hash: codeHash(data),
          materializedAt: data.materializedAt,
          comparedAt: data.comparedAt,
          receivedAt: result.json().receivedAt,
          selectedPathCount: 2,
          changedFiles: 2,
          omittedFiles: 0,
        },
      ]);
      const detail = await f.api.call(`${historyPath(f, v.operation.id)}/${data.trialId}`, f.alice);
      assert.deepEqual(detail.json(), {
        report: data,
        hash: codeHash(data),
        receivedAt: result.json().receivedAt,
      });
      const reopened = new Store(f.api.dbPath, undefined, { team: true });
      try {
        assert.deepEqual(
          reopened.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
            new IntegrationStore(reopened).getTrial(f.task.id, v.operation.id, data.trialId),
          ),
          detail.json(),
        );
      } finally {
        reopened.close();
      }
      for (const change of [
        { manifestHash: 'd'.repeat(64) },
        { comparedAt: new Date(Date.parse(data.comparedAt) + 1).toISOString() },
      ])
        assert.equal((await publish(f, { ...data, ...change })).statusCode, 409);
      assert.throws(
        () =>
          f.api.store.db
            .prepare('UPDATE integration_trial_differences SET body=? WHERE trial_id=?')
            .run('{}', data.trialId),
        /immutable/,
      );
      assert.throws(
        () =>
          f.api.store.db
            .prepare('DELETE FROM integration_trial_differences WHERE trial_id=?')
            .run(data.trialId),
        /immutable/,
      );
    } finally {
      await f.close();
    }
  }
});

test('分享核对原完整预检、选择、模式、对象格式与blob正文；错来源和错节点不发布', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      data = report(f, v),
      before = unchanged(f);
    for (const change of [
      { integrationInputHash: 'd'.repeat(64) },
      { preflightReportHash: 'e'.repeat(64) },
      { materializedAt: '2000-01-01T00:00:00.000Z' },
      { comparedAt: new Date(Date.now() + 120000).toISOString() },
      {
        selectedPaths: ['target.txt'],
        difference: { changedFiles: 1, omittedFiles: 1, files: [] },
      },
      {
        difference: {
          ...data.difference,
          files: data.difference.files.map((file) => ({
            ...file,
            after: file.after ? { ...file.after, mode: '100755' } : null,
          })),
        },
      },
      {
        difference: {
          ...data.difference,
          files: data.difference.files.map((file) => ({
            ...file,
            after: file.after ? { ...file.after, objectId: 'e'.repeat(64) } : null,
          })),
        },
      },
    ])
      assert.equal(
        (await publish(f, { ...data, ...change })).statusCode,
        409,
        JSON.stringify(change),
      );
    const changedText = structuredClone(data);
    changedText.difference.files[0]!.afterText = 'x'.repeat(
      changedText.difference.files[0]!.after!.bytes,
    );
    assert.equal((await publish(f, changedText)).statusCode, 400);
    assert.equal((await publish(f, data, 1)).statusCode, 404);
    assert.deepEqual(unchanged(f), before);
    const other = await f.create();
    assert.equal(
      (
        await publish(f, {
          ...data,
          integrationId: other.operation.id,
          integrationInputHash: other.operation.inputHash,
        })
      ).statusCode,
      409,
    );
    assert.deepEqual((await f.api.call(historyPath(f, v.operation.id), f.alice)).json(), {
      items: [],
    });
    assert.equal(
      (await f.api.call(`${historyPath(f, other.operation.id)}/${data.trialId}`, f.alice))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('候选生成投影只允许完整可用预检的无冲突增改删，实际应用仍仅新增', async () => {
  const f = await integrationFixture();
  try {
    const initial = await f.create();
    assert.equal(initial.canTrial, false);
    const preflight = f.report(initial);
    preflight.plan.files = preflight.plan.files.filter((file) => file.action === 'modify');
    preflight.plan.changedFiles = preflight.plan.files.length;
    assert.equal((await f.protocol('publish', preflight)).statusCode, 200);
    const v = view(f, initial.operation.id);
    assert.equal(v.canTrial, true);
    assert.equal(v.canApply, false);
    const response = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: ['README.md'],
      confirmApplication: true,
    });
    assert.equal(response.statusCode, 409);
    const incomplete = await f.create(),
      partial = f.report(incomplete);
    partial.plan.omittedFiles = 1;
    partial.plan.changedFiles++;
    assert.equal((await f.protocol('publish', partial)).statusCode, 200);
    const partialView = view(f, incomplete.operation.id);
    assert.equal(partialView.canTrial, false);
    assert.equal((await publish(f, report(f, partialView))).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('候选删除与大小写重命名遵循原预检引用；冲突和已存在项不能混入完整选择', async () => {
  const f = await integrationFixture();
  try {
    const initial = await f.create(),
      preflight = f.report(initial),
      original = preflight.plan.files.find((file) => file.action === 'modify')!;
    // The control service verifies fixed plan references, not full object-tree membership.
    // This protocol metadata fixture exercises a node's already-published rename plan.
    preflight.plan.files = [
      { ...original, source: null, action: 'delete', conflict: null },
      { ...original, path: 'Readme.md', base: null, target: null, action: 'add', conflict: null },
    ];
    preflight.plan.changedFiles = 2;
    assert.equal((await f.protocol('publish', preflight)).statusCode, 200);
    const v = view(f, initial.operation.id),
      data = report(f, v);
    assert.equal(v.canTrial, true);
    assert.equal((await publish(f, data)).statusCode, 200);
    assert.equal(data.difference.files.find((file) => file.path === 'README.md')!.after, null);
    assert.equal(data.difference.files.find((file) => file.path === 'Readme.md')!.before, null);
    for (const action of ['conflict', 'already_present'] as const) {
      const initial = await f.create(),
        preflight = f.report(initial),
        item = preflight.plan.files[0]!;
      preflight.plan.files = [
        {
          ...item,
          action,
          target:
            action === 'already_present'
              ? item.source
              : { ...item.target!, objectId: 'e'.repeat(40) },
          conflict: action === 'conflict' ? 'both_changed' : null,
        },
      ];
      preflight.plan.changedFiles = 1;
      preflight.plan.conflicts = action === 'conflict' ? 1 : 0;
      preflight.plan.alreadyPresent = action === 'already_present' ? 1 : 0;
      const published = await f.protocol('publish', preflight);
      assert.equal(published.statusCode, 200, published.body);
      const v = view(f, initial.operation.id);
      assert.equal(v.canTrial, false);
      const data = {
        ...report(f, v),
        selectedPaths: [item.path],
        difference: { changedFiles: 1, omittedFiles: 1, files: [] },
      };
      assert.equal((await publish(f, data)).statusCode, 409);
    }
  } finally {
    await f.close();
  }
});

test('旧候选首次分享及精确回执不受后来实际应用阶段影响，也不改应用历史', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      frozen = report(f, v);
    const selected = await f.api.call(`${f.integrationPath}/${v.operation.id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: ['new.txt'],
      confirmApplication: true,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    const application = (selected.json() as IntegrationView).operation.application!;
    const receipt = await publish(f, frozen);
    assert.equal(receipt.statusCode, 200, receipt.body);
    for (const stage of ['applying', 'completed'] as const) {
      assert.equal(
        (
          await f.protocol('apply-publish', {
            integrationId: v.operation.id,
            applicationId: application.id,
            inputHash: application.inputHash,
            sequence: stage === 'applying' ? 1 : 2,
            stage,
            observedAt: new Date().toISOString(),
            appliedPaths: stage === 'applying' ? [] : application.paths,
            reason: null,
            confirmPublication: true,
          })
        ).statusCode,
        200,
      );
      const current = view(f, v.operation.id),
        before = unchanged(f);
      assert.equal(current.canTrial, false);
      assert.deepEqual((await publish(f, frozen)).json(), receipt.json());
      assert.equal((await publish(f, { ...frozen, trialId: randomUUID() })).statusCode, 200);
      assert.deepEqual(unchanged(f), before);
      assert.deepEqual(view(f, v.operation.id).operation, current.operation);
    }
  } finally {
    await f.close();
  }
});

test('收到后材料到期不抹历史或精确回执；旧候选首次共享不依赖后来操作状态', async (t) => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      data = report(f, v),
      store = new IntegrationStore(f.api.store);
    const receipt = store.publishTrialDifference(f.ns[0]!.token, data);
    assert.equal(
      (
        await f.api.call(`${f.integrationPath}/${v.operation.id}/cancel`, f.alice, {
          expectedRevision: v.operation.revision,
        })
      ).statusCode,
      200,
    );
    const cancelled = view(f, v.operation.id).operation;
    const next = { ...data, trialId: randomUUID() };
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86400000 });
    assert.deepEqual(store.publishTrialDifference(f.ns[0]!.token, data), receipt);
    assert.equal(store.publishTrialDifference(f.ns[0]!.token, next).hash, codeHash(next));
    const unavailable = view(f, v.operation.id);
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.canTrial, false);
    assert.deepEqual(unavailable.operation, cancelled);
    assert.equal(f.as(() => store.listTrials(f.task.id, v.operation.id)).items.length, 2);
    assert.deepEqual(
      f.as(() => store.getTrial(f.task.id, v.operation.id, data.trialId)).report,
      data,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('同一整合最多100份、精确重放不占名额，稳定新到旧排序及跨整合trialId不可覆盖', async (t) => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      other = await ready(f),
      original = report(f, v),
      store = new IntegrationStore(f.api.store);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const first = { ...original, trialId: 'trial-000' },
      receipt = store.publishTrialDifference(f.ns[0]!.token, first);
    for (let i = 1; i < 100; i++)
      store.publishTrialDifference(f.ns[0]!.token, {
        ...original,
        trialId: `trial-${String(i).padStart(3, '0')}`,
      });
    assert.deepEqual(store.publishTrialDifference(f.ns[0]!.token, first), receipt);
    assert.throws(
      () => store.publishTrialDifference(f.ns[0]!.token, { ...original, trialId: 'trial-over' }),
      /100/,
    );
    assert.throws(
      () =>
        store.publishTrialDifference(f.ns[0]!.token, {
          ...report(f, other),
          trialId: first.trialId,
        }),
      /不能替换/,
    );
    const history = f.as(() => store.listTrials(f.task.id, v.operation.id)).items;
    assert.equal(history.length, 100);
    assert.deepEqual(
      history.map((item) => item.trialId),
      Array.from({ length: 100 }, (_, i) => `trial-${String(99 - i).padStart(3, '0')}`),
    );
    assert.equal(
      f.api.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='integration.trial_shared'")
        .get()!.n,
      100,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('报告及共享事件同事务，outbox失败后无回执或半份报告', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      data = report(f, v),
      before = unchanged(f);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_trial BEFORE INSERT ON outbox WHEN NEW.kind='integration.trial_shared' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await publish(f, data)).statusCode, 500);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM integration_trial_differences').get()!.n,
      0,
    );
    assert.deepEqual(unchanged(f), before);
    f.api.store.db.exec('DROP TRIGGER fail_trial');
    assert.equal((await publish(f, data)).statusCode, 200);
    assert.equal(
      f.api.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='integration.trial_shared'")
        .get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test('来源/目标当前授权在旧回执之前，节点撤权后历史仍由当前Task读权限控制', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      data = report(f, v),
      store = new IntegrationStore(f.api.store);
    store.publishTrialDifference(f.ns[0]!.token, data);
    const db = f.api.store.db,
      node = f.ns[0]!.nodeId;
    const grants = db.prepare('SELECT grants FROM runner_nodes WHERE id=?').get(node)!.grants;
    db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(node);
    for (const item of [data, { ...data, trialId: randomUUID() }])
      assert.throws(() => store.publishTrialDifference(f.ns[0]!.token, item));
    assert.deepEqual(
      f.as(() => store.getTrial(f.task.id, v.operation.id, data.trialId)).report,
      data,
    );
    db.prepare('UPDATE runner_nodes SET grants=? WHERE id=?').run(grants!, node);
    f.as(() => f.nodes.revoke(node, 1, randomUUID()));
    assert.equal((await publish(f, data)).statusCode, 401);
    assert.equal(
      (await f.api.call(`${historyPath(f, v.operation.id)}/${data.trialId}`, f.alice)).statusCode,
      200,
    );
    await f.api.call(`projects/${f.project.id}/members/${f.bob.user.id}`, f.alice, {
      role: 'view',
    });
    assert.equal((await f.api.call(historyPath(f, v.operation.id), f.bob)).statusCode, 200);
    const taskBody = db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body as string;
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
      JSON.stringify({
        ...JSON.parse(taskBody),
        visibility: 'private',
        ownerUserId: f.bob.user.id,
      }),
      f.task.id,
    );
    assert.notEqual((await f.api.call(historyPath(f, v.operation.id), f.alice)).statusCode, 200);
    assert.notEqual(
      (await f.api.call(`${historyPath(f, v.operation.id)}/${data.trialId}`, f.alice)).statusCode,
      200,
    );
    assert.equal((await f.api.call(historyPath(f, v.operation.id), f.bob)).statusCode, 200);
    assert.equal(
      (await f.api.call(`${historyPath(f, v.operation.id)}/${data.trialId}`, f.bob)).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test('独立来源撤权阻止新共享及旧回执；来源副本删除不抹历史，目标修订与Task先核对', async () => {
  const f = await integrationFixture();
  try {
    const cp = await recordResultCode(f, f.target, 1),
      target = f.retain(cp.checkpointId, f.target, 1),
      transfers = new CheckpointTransferStore(f.api.store);
    const transfer = f.as(() =>
      transfers.create(
        f.task.id,
        f.sourceCp.checkpointId,
        f.sr.request.id,
        {
          targetNodeId: f.ns[1]!.nodeId,
          expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
          confirmTransfer: true,
        },
        randomUUID(),
      ),
    );
    // Deterministic protocol-metadata fixture; this does not assert real transfer bytes.
    f.api.store.db
      .prepare("UPDATE checkpoint_transfers SET state='received',received_at=? WHERE id=?")
      .run(new Date().toISOString(), transfer.ticket.id);
    const created = await f.api.call(f.integrationPath, f.alice, {
      ...f.body(),
      targetCheckpointId: cp.checkpointId,
      targetRetentionId: target.request.id,
      sourceMaterial: { kind: 'transfer', id: transfer.ticket.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await f.protocol('publish', f.report(created.json()), 1)).statusCode, 200);
    const v = view(f, created.json().operation.id),
      data = report(f, v),
      store = new IntegrationStore(f.api.store);
    const receipt = store.publishTrialDifference(f.ns[1]!.token, data);
    const db = f.api.store.db,
      targetNode = f.ns[1]!.nodeId;
    for (const change of ['revision', 'task'] as const) {
      const task = db.prepare('SELECT body FROM tasks WHERE id=?').get(f.task.id)!.body as string;
      if (change === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision+1 WHERE id=?').run(targetNode);
      if (change === 'task')
        db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
          JSON.stringify({
            ...JSON.parse(task),
            visibility: 'private',
            ownerUserId: f.bob.user.id,
          }),
          f.task.id,
        );
      for (const item of [data, { ...data, trialId: randomUUID() }])
        assert.throws(() => store.publishTrialDifference(f.ns[1]!.token, item), change);
      if (change === 'revision')
        db.prepare('UPDATE runner_nodes SET revision=revision-1 WHERE id=?').run(targetNode);
      if (change === 'task') db.prepare('UPDATE tasks SET body=? WHERE id=?').run(task, f.task.id);
    }
    assert.deepEqual(store.publishTrialDifference(f.ns[1]!.token, data), receipt);
    f.retained.report(f.ns[0]!.token, {
      requestId: f.sr.request.id,
      requestHash: f.sr.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    assert.deepEqual(store.publishTrialDifference(f.ns[1]!.token, data), receipt);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    for (const item of [data, { ...data, trialId: randomUUID() }])
      assert.throws(() => store.publishTrialDifference(f.ns[1]!.token, item), /授权|撤销/);
    assert.deepEqual(
      f.as(() => store.getTrial(f.task.id, v.operation.id, data.trialId)).report,
      data,
    );
    assert.equal(view(f, v.operation.id).canTrial, false);
  } finally {
    await f.close();
  }
});

test('项目降权永久撤销节点旧回执，新报告阻止但仍能查看已共享历史', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      data = report(f, v);
    assert.equal((await publish(f, data)).statusCode, 200);
    f.api.store.db
      .prepare("UPDATE collab_project_members SET role='view' WHERE project_id=? AND user_id=?")
      .run(f.project.id, f.alice.user.id);
    for (const item of [data, { ...data, trialId: randomUUID() }])
      assert.equal((await publish(f, item)).statusCode, 401);
    assert.equal(
      (await f.api.call(`${historyPath(f, v.operation.id)}/${data.trialId}`, f.alice)).statusCode,
      200,
    );
    assert.equal(view(f, v.operation.id).canTrial, false);
  } finally {
    await f.close();
  }
});

test('migration34只增独立候选证据表，原操作/事件字节不变且数据库拒绝覆盖删除', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE integration_operations(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE integration_events(body TEXT);',
    );
    db.prepare('INSERT INTO integration_operations VALUES(?,?)').run('i', '{"old":"unaltered"}');
    db.prepare('INSERT INTO integration_events VALUES(?)').run('{"history":true}');
    db.exec(migrations.find((m) => m.version === 34)!.sql);
    assert.equal(
      db.prepare('SELECT body FROM integration_operations').get()!.body,
      '{"old":"unaltered"}',
    );
    assert.equal(db.prepare('SELECT body FROM integration_events').get()!.body, '{"history":true}');
    const insert = db.prepare('INSERT INTO integration_trial_differences VALUES(?,?,?,?,?)');
    insert.run('i', 'trial', 'hash', 'at', '{}');
    assert.throws(() => insert.run('i', 'trial', 'other', 'at', '{}'), /UNIQUE/);
    assert.throws(() => insert.run('missing', 'new', 'hash', 'at', '{}'), /FOREIGN KEY/);
    assert.throws(
      () => db.exec("UPDATE integration_trial_differences SET hash='changed'"),
      /immutable/,
    );
    assert.throws(() => db.exec('DELETE FROM integration_trial_differences'), /immutable/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

const candidateApplyBody = (v: IntegrationView, r: IntegrationTrialDifferenceReport) => ({
  expectedRevision: v.operation.revision,
  expectedTaskRevision: v.taskRevision,
  reportHash: v.reportHash,
  paths: r.selectedPaths,
  confirmApplication: true,
  candidate: {
    trialId: r.trialId,
    reportHash: codeHash(r),
    manifestHash: r.manifestHash,
    confirmExistingChanges: true,
  },
});
test('固定候选写回另行授权全部路径，旧新增请求不能升级修改，报告历史不变', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      r = report(f, v),
      key = randomUUID();
    assert(r.selectedPaths.includes('README.md'));
    assert.equal((await publish(f, r)).statusCode, 200);
    const path = `${f.integrationPath}/${v.operation.id}/apply`,
      body = candidateApplyBody(v, r);
    const { candidate, ...oldBody } = body;
    assert.equal((await f.api.call(path, f.alice, oldBody)).statusCode, 409);
    for (const wrong of [
      { ...body, candidate: { ...candidate, confirmExistingChanges: false } },
      { ...body, candidate: { ...candidate, confirmExistingChanges: undefined } },
      { ...body, candidate: { ...candidate, privatePath: '/not-uploaded' } },
      { ...body, candidate: null },
      { ...body, candidate: { ...candidate, reportHash: 'a'.repeat(64) } },
      { ...body, candidate: { ...candidate, manifestHash: 'a'.repeat(64) } },
      { ...body, paths: ['README.md'] },
    ])
      assert.notEqual((await f.api.call(path, f.alice, wrong)).statusCode, 200);
    const queued = await f.api.call(path, f.alice, body, key);
    assert.equal(queued.statusCode, 200, queued.body);
    const q = queued.json() as IntegrationView,
      a = q.operation.application!;
    assert.deepEqual(a.candidate, candidate);
    assert.equal(
      a.inputHash,
      codeHash({
        integrationId: v.operation.id,
        applicationId: a.id,
        reportHash: v.reportHash,
        paths: [...r.selectedPaths].sort(),
        candidate,
      }),
    );
    assert.notEqual(
      a.inputHash,
      codeHash({
        integrationId: v.operation.id,
        applicationId: a.id,
        reportHash: v.reportHash,
        paths: [...r.selectedPaths].sort(),
      }),
      'old runners reject the broader input',
    );
    assert.deepEqual((await f.api.call(path, f.alice, body, key)).json(), q);
    assert.deepEqual(q.operation.report, v.operation.report);
    assert.deepEqual(
      f.as(() => new IntegrationStore(f.api.store).getTrial(f.task.id, v.operation.id, r.trialId))
        .report,
      r,
    );
    assert.equal((await f.api.call(path, f.alice, oldBody, key)).statusCode, 409);
  } finally {
    await f.close();
  }
});
test('候选授权不能借另一操作/新候选或旧回执越过当前权限', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      other = await ready(f),
      r = report(f, v),
      r2 = report(f, other);
    assert.equal((await publish(f, r)).statusCode, 200);
    assert.equal((await publish(f, r2)).statusCode, 200);
    const path = `${f.integrationPath}/${v.operation.id}/apply`,
      body = candidateApplyBody(v, r),
      key = randomUUID();
    const crossed = candidateApplyBody(v, r2);
    assert.equal((await f.api.call(path, f.alice, crossed)).statusCode, 404);
    const newer = { ...r, trialId: randomUUID(), manifestHash: 'd'.repeat(64) };
    assert.equal((await publish(f, newer)).statusCode, 200);
    assert.equal(
      (
        await f.api.call(path, f.alice, {
          ...body,
          candidate: { ...body.candidate, trialId: newer.trialId },
        })
      ).statusCode,
      409,
    );
    assert.equal((await f.api.call(path, f.alice, body, key)).statusCode, 200);
    f.api.store.db.prepare("UPDATE runner_nodes SET grants='[]' WHERE id=?").run(f.ns[0]!.nodeId);
    assert.equal((await f.api.call(path, f.alice, body, key)).statusCode, 409);
    const history = view(f, v.operation.id);
    assert.deepEqual(history.operation.application!.candidate, body.candidate);
    assert.equal(history.available, false);
  } finally {
    await f.close();
  }
});
test('候选选择事务失败不留下应用、历史或幂等回执，之后原请求可成功', async () => {
  const f = await integrationFixture();
  try {
    const v = await ready(f),
      r = report(f, v);
    assert.equal((await publish(f, r)).statusCode, 200);
    const before = unchanged(f),
      body = candidateApplyBody(v, r),
      key = randomUUID();
    const path = `${f.integrationPath}/${v.operation.id}/apply`;
    f.api.store.db.exec(
      "CREATE TRIGGER fail_candidate_application BEFORE INSERT ON outbox WHEN NEW.kind LIKE 'integration.%' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.equal((await f.api.call(path, f.alice, body, key)).statusCode, 500);
    assert.deepEqual(unchanged(f), before);
    f.api.store.db.exec('DROP TRIGGER fail_candidate_application');
    assert.equal((await f.api.call(path, f.alice, body, key)).statusCode, 200);
  } finally {
    await f.close();
  }
});
