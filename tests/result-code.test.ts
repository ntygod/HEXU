import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { branchResultFixture } from './helpers/branch-results.js';
import { codeSnapshot, recordResultCode, saveResultCode } from './helpers/result-code.js';
import { buildCodeDifference } from '../apps/runner/src/agent/result-code-diff.js';
import { ResultCodeStore } from '../packages/db/src/result-code.js';
import { CheckpointRetentionStore } from '../packages/db/src/checkpoint-retention.js';
import {
  parseCodeDifference,
  CODE_DIFF_LIMIT,
  type ResultCodeReference,
} from '../packages/contracts/src/result-code.js';

for (const format of ['sha1', 'sha256'] as const)
  test(`${format}固定代码引用与两侧差异：新增/删除/修改/模式/二进制/空文件均有来源`, async () => {
    const before = await codeSnapshot(
      [
        { name: 'change.txt', text: 'before\n' },
        { name: 'removed.txt', text: 'old' },
        { name: 'mode.sh', text: 'echo hello\n' },
        { name: 'same.txt', text: 'same' },
      ],
      format,
    );
    const after = await codeSnapshot(
      [
        { name: 'change.txt', text: 'after\n' },
        { name: 'added.txt', text: '' },
        { name: 'mode.sh', text: 'echo hello\n', mode: '100755' },
        { name: 'same.txt', text: 'same' },
        { name: 'binary.dat', data: Buffer.from([0, 255]) },
      ],
      format,
    );
    const f = await branchResultFixture(undefined, before);
    try {
      const run = f.begin();
      run.start();
      run.finish();
      const cp = await recordResultCode(f, {
        objectFormat: format,
        commit: after.commit,
        tree: after.tree,
      });
      const saved = await saveResultCode(f, cp.checkpointId),
        ref = saved.detail.version.source.code as ResultCodeReference;
      assert.equal(ref.base.commit, before.commit);
      assert.equal(ref.checkpoint.manifest.commit, after.commit);
      assert.equal(saved.detail.code.retention.state, 'not_requested');
      const packet = buildCodeDifference(
        saved.revisionId,
        ref,
        before,
        after,
        new Date().toISOString(),
      );
      assert.equal(packet.changedFiles, 5);
      assert.equal(packet.omittedFiles, 0);
      assert.equal(packet.files.find((f) => f.path === 'binary.dat')!.display, 'binary');
      assert.equal(packet.files.find((f) => f.path === 'added.txt')!.afterText, '');
      assert.equal(packet.files.find((f) => f.path === 'removed.txt')!.after, null);
      const api = new ResultCodeStore(f.api.store),
        receipt = api.publish(f.ns[0]!.token, packet);
      assert.deepEqual(api.publish(f.ns[0]!.token, packet), receipt);
      assert.throws(
        () =>
          api.publish(f.ns[0]!.token, {
            ...packet,
            comparedAt: new Date(Date.now() + 10).toISOString(),
          }),
        /覆盖/,
      );
      const detail = (
        await f.api.call(`results/${saved.resultId}/versions/${saved.revisionId}`, f.alice)
      ).json();
      assert.deepEqual(detail.version, saved.detail.version);
      assert.deepEqual(detail.code.difference, packet);
      assert.throws(() => api.publish(f.ns[1]!.token, packet), /不属于/);
      assert.throws(
        () =>
          f.api.store.db
            .prepare('DELETE FROM result_code_differences WHERE revision_id=?')
            .run(saved.revisionId),
        /immutable/,
      );
      assert.equal(f.as(() => f.api.store.getTask(f.task.id)).status, 'in_progress');
    } finally {
      await f.close();
    }
  });

test('差异预算不截断文件正文：超量、较大文件和不支持的对象保持明确限制', async () => {
  const before = await codeSnapshot([]),
    after = await codeSnapshot(
      Array.from({ length: 45 }, (_, i) => ({
        name: `file-${String(i).padStart(2, '0')}`,
        text: '中'.repeat(i === 0 ? 3000 : 1000),
      })),
    );
  const reference = {
    base: before,
    checkpoint: { manifest: after },
    hash: 'a'.repeat(64),
  } as unknown as ResultCodeReference;
  const packet = buildCodeDifference(
    randomUUID(),
    reference,
    before,
    after,
    new Date().toISOString(),
  );
  assert.equal(packet.changedFiles, 45);
  assert(packet.omittedFiles >= 5);
  assert(packet.files.some((f) => f.display === 'large'));
  assert(packet.files.some((f) => f.display === 'budget'));
  assert(Buffer.byteLength(JSON.stringify(packet)) <= CODE_DIFF_LIMIT);
  const link = await codeSnapshot([{ name: 'link', text: '/outside', mode: '120000' }]);
  assert.throws(
    () =>
      buildCodeDifference(
        randomUUID(),
        { ...reference, checkpoint: { manifest: link } } as unknown as ResultCodeReference,
        before,
        link,
        new Date().toISOString(),
      ),
    /符号链接/,
  );
  assert.throws(() =>
    parseCodeDifference({ ...packet, files: [{ ...packet.files[0], path: '../secret' }] }),
  );
  assert.throws(() =>
    parseCodeDifference({
      ...packet,
      files: [{ ...packet.files[0], afterText: '不允许隐藏正文' }],
    }),
  );
});

test('代码来源拒绝初始旧引用、另一方案、活动节点与旧授权回执；共享正文必须匹配blob', async () => {
  const f = await branchResultFixture();
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const data = await f.draft();
    const old = await f.api.call(f.path() + '/results', f.alice, {
      ...data,
      codeCheckpointId: f.view.group.start.checkpoint.id,
    });
    assert.equal(old.statusCode, 409);
    const snapshot = await codeSnapshot([{ name: 'code.txt', text: 'new code' }]);
    const wrong = await recordResultCode(
      f,
      { objectFormat: 'sha1', commit: snapshot.commit, tree: snapshot.tree },
      1,
    );
    assert.equal(
      (
        await f.api.call(f.path() + '/results', f.alice, {
          ...data,
          codeCheckpointId: wrong.checkpointId,
        })
      ).statusCode,
      409,
    );
    const cp = await recordResultCode(f, {
      objectFormat: 'sha1',
      commit: snapshot.commit,
      tree: snapshot.tree,
    });
    const key = randomUUID(),
      body = { ...data, codeCheckpointId: cp.checkpointId };
    const saved = await f.api.call(f.path() + '/results', f.alice, body, key);
    assert.equal(saved.statusCode, 201);
    const ref = (await f.api.call(`results/${saved.json().resultId}`, f.alice)).json().version
      .source.code;
    const api = new ResultCodeStore(f.api.store);
    const packet = {
      revisionId: saved.json().revisionId,
      referenceHash: ref.hash,
      comparedAt: new Date().toISOString(),
      changedFiles: 1,
      omittedFiles: 0,
      files: [
        {
          path: 'code.txt',
          before: null,
          after: { objectId: 'd'.repeat(40), mode: '100644', bytes: 8 },
          display: 'text',
          beforeText: '',
          afterText: 'new code',
        },
      ],
    };
    assert.throws(() => api.publish(f.ns[0]!.token, packet), /blob/);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    assert.equal((await f.api.call(f.path() + '/results', f.alice, body, key)).statusCode, 409);
    assert.throws(() => api.inspect(f.ns[0]!.token, saved.json().revisionId), /撤销/);
    assert.equal((await f.api.call(`results/${saved.json().resultId}`, f.alice)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('对象副本过期/删除只改变当前可用性，不改写固定版本；发布与outbox原子回滚', async () => {
  const before = await codeSnapshot([]),
    after = await codeSnapshot([{ name: 'a.txt', text: 'fixed' }]);
  const f = await branchResultFixture(undefined, before);
  try {
    const r = f.begin();
    r.start();
    r.finish();
    const cp = await recordResultCode(f, {
      objectFormat: 'sha1',
      commit: after.commit,
      tree: after.tree,
    });
    const ret = new CheckpointRetentionStore(f.api.store);
    const t = f.as(() =>
      ret.create(
        f.task.id,
        cp.checkpointId,
        {
          expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
          days: 1,
          confirmLocalRetention: true,
        },
        randomUUID(),
      ),
    );
    const at = new Date().toISOString(),
      expiresAt = new Date(Date.parse(at) + 86400000).toISOString();
    ret.report(f.ns[0]!.token, {
      requestId: t.request.id,
      requestHash: t.request.requestHash,
      sequence: 1,
      confirmPublication: true,
      report: {
        state: 'retained',
        observedAt: at,
        manifest: {
          version: 1,
          kind: 'git_snapshot_objects',
          objectFormat: 'sha1',
          commit: after.commit,
          tree: after.tree,
          repositoryIdentity: 'c'.repeat(64),
          snapshotHash: after.snapshotHash,
          coverage: after.coverage,
          scope: 'commit_snapshot_without_ancestors_or_external_content',
          retainedAt: at,
          expiresAt,
        },
      },
    });
    const saved = (
      await f.api.call(f.path() + '/results', f.alice, {
        ...(await f.draft()),
        codeCheckpointId: cp.checkpointId,
        codeRetentionId: t.request.id,
      })
    ).json();
    const detail = (await f.api.call(`results/${saved.resultId}`, f.alice)).json();
    assert.equal(detail.code.retention.state, 'retained');
    const realClock = Date.now;
    try {
      Date.now = () => Date.parse(expiresAt) + 1;
      const expired = f.as(() => new ResultCodeStore(f.api.store).view(detail.version));
      assert.equal(expired!.retention.state, 'expired');
    } finally {
      Date.now = realClock;
    }
    const packet = buildCodeDifference(
      saved.revisionId,
      detail.version.source.code,
      before,
      after,
      new Date().toISOString(),
    );
    const api = new ResultCodeStore(f.api.store);
    f.api.store.db.exec(
      "CREATE TRIGGER fail_code_outbox BEFORE INSERT ON outbox WHEN NEW.kind='result.code_shared' BEGIN SELECT RAISE(ABORT,'fixture code outbox'); END;",
    );
    assert.throws(() => api.publish(f.ns[0]!.token, packet), /fixture code outbox/);
    assert.equal(
      f.api.store.db.prepare('SELECT COUNT(*) AS n FROM result_code_differences').get()!.n,
      0,
    );
    f.api.store.db.exec('DROP TRIGGER fail_code_outbox');
    api.publish(f.ns[0]!.token, packet);
    ret.report(f.ns[0]!.token, {
      requestId: t.request.id,
      requestHash: t.request.requestHash,
      sequence: 2,
      confirmPublication: true,
      report: { state: 'deleted', observedAt: new Date().toISOString() },
    });
    const later = (await f.api.call(`results/${saved.resultId}`, f.alice)).json();
    assert.deepEqual(later.version, detail.version);
    assert.equal(later.code.retention.state, 'deleted');
    assert.deepEqual(later.code.difference, packet);
    assert.equal(
      (
        await f.api.call(f.path() + '/results', f.alice, {
          ...(await f.draft()),
          codeCheckpointId: cp.checkpointId,
          codeRetentionId: t.request.id,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
