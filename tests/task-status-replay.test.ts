import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, type Task } from '../packages/contracts/src/index.js';
import { Store } from '../packages/db/src/store.js';
import { createApp } from '../apps/control/src/app.js';
import { teamFixture } from './helpers/team.js';

const snapshot = (store: Store) => {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
};
const run = (store: Store, task: Task) =>
  store.createRun(
    task.id,
    {
      provider: 'mock',
      requestedTool: 'codex',
      scenario: 'success',
      prompt: '仅协议夹具，不调用模型',
      expectedRevision: task.revision,
      reopenTask: false,
    },
    randomUUID(),
  );

for (const [action, activeRunAction] of [
  ['complete', 'stop'],
  ['complete', 'keep'],
  ['cancel', 'stop'],
  ['cancel', 'keep'],
] as const) {
  test(`真实HTTP ${action}/${activeRunAction}旧回执保留原Task，不重复业务写入或停止后来Run`, async () => {
    const store = new Store();
    const app = await createApp({ store, native: { enabled: false, roots: [] } });
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      let task = store.createTask(
        { title: '原确认标题', description: '原说明', projectId: null },
        'create',
      );
      task = store.patchTask(
        task.id,
        { expectedRevision: task.revision, attention: '待确认' },
        'attention',
      );
      const originalRun = run(store, task);
      const payload = {
        expectedRevision: store.getTask(task.id).revision,
        activeRunAction,
      };
      const key = `${action}-${activeRunAction}-original`;
      const post = (command: string, body: unknown, requestKey: string) =>
        fetch(`${origin}/api/v1/tasks/${task.id}/${command}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hexu-client': 'web',
            'idempotency-key': requestKey,
          },
          body: JSON.stringify(body),
        });
      const committed = await post(action, payload, key);
      assert.equal(committed.status, 200);
      const receipt = (await committed.json()) as Task;
      assert.equal(receipt.status, action === 'complete' ? 'done' : 'cancelled');
      assert.equal(receipt.revision, payload.expectedRevision + 1);
      assert.equal(receipt.attention, null);
      assert.equal(
        store.run(originalRun.id).state,
        activeRunAction === 'stop' ? 'cancelled' : 'queued',
      );
      assert.equal(
        store.db
          .prepare('SELECT count(*) AS n FROM completion_events WHERE task_id=?')
          .get(task.id)!.n,
        1,
      );
      const storedReceipt = store.db
        .prepare('SELECT result FROM idempotency_records WHERE key=?')
        .get(key)!.result;

      // Keep the first response as the oracle for an acknowledgement lost by the UI.
      // Later work must not rebase its request or replace its stored Task projection.
      const reopened = await post(
        'reopen',
        { expectedRevision: receipt.revision, activeRunAction: 'keep' },
        'reopen',
      );
      assert.equal(reopened.status, 200);
      task = (await reopened.json()) as Task;
      task = store.patchTask(
        task.id,
        { expectedRevision: task.revision, title: '后来的标题', attention: '后来的关注' },
        'later-edit',
      );
      if (activeRunAction === 'keep')
        for (const state of ['preparing', 'running', 'succeeded'] as const)
          store.stepRun(originalRun.id, state);
      const laterRun = run(store, task);
      store.stepRun(laterRun.id, 'preparing');
      store.stepRun(laterRun.id, 'running');
      const currentTask = store.getTask(task.id);
      const before = snapshot(store);

      const replay = await post(action, payload, key);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receipt);
      assert.deepEqual(store.getTask(task.id), currentTask);
      assert.equal(store.run(laterRun.id).state, 'running');
      assert.equal(
        store.db
          .prepare('SELECT count(*) AS n FROM completion_events WHERE task_id=?')
          .get(task.id)!.n,
        2,
      );
      assert.equal(
        store.db.prepare('SELECT result FROM idempotency_records WHERE key=?').get(key)!.result,
        storedReceipt,
      );
      assert.deepEqual(snapshot(store), before);

      for (const [command, body, requestKey, expectedCode] of [
        [
          action,
          { ...payload, activeRunAction: activeRunAction === 'stop' ? 'keep' : 'stop' },
          key,
          'IDEMPOTENCY_CONFLICT',
        ],
        [
          action,
          { ...payload, expectedRevision: currentTask.revision },
          key,
          'IDEMPOTENCY_CONFLICT',
        ],
        [action === 'complete' ? 'cancel' : 'complete', payload, key, 'IDEMPOTENCY_CONFLICT'],
        [action, payload, 'stale-without-receipt', 'REVISION_CONFLICT'],
      ] as const) {
        const rejected = await post(command, body, requestKey);
        assert.equal(rejected.status, 409);
        assert.equal(
          ((await rejected.json()) as { error: { code: string } }).error.code,
          expectedCode,
        );
        assert.deepEqual(snapshot(store), before);
      }
      assert.equal(
        store.db
          .prepare('SELECT count(*) AS n FROM idempotency_records WHERE key=?')
          .get('stale-without-receipt')!.n,
        0,
      );
    } finally {
      await app.close();
    }
  });
}

test('完成和取消的旧回执不能越过当前项目降权、撤权或空间撤权', async () => {
  const f = await teamFixture();
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const rolePath = `projects/${project.id}/members/${bob.user.id}`;
    assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
    const requests = [];
    for (const action of ['complete', 'cancel'] as const) {
      const task = await f.task(alice, project.id, `${action}原标题`);
      const payload = { expectedRevision: task.revision, activeRunAction: 'keep' };
      const key = `${action}-authorized`;
      const path = `tasks/${task.id}/${action}`;
      const first = await f.call(path, bob, payload, key);
      assert.equal(first.statusCode, 200, first.body);
      const receipt = first.json<Task>();
      const changed = await f.call(
        `tasks/${task.id}`,
        alice,
        { expectedRevision: receipt.revision, title: `${action}后来标题` },
        `${action}-later`,
        'PATCH',
      );
      assert.equal(changed.statusCode, 200, changed.body);
      requests.push({ action, task, payload, key, path, receipt });
    }

    for (const [role, status, error] of [
      ['view', 403, 'FORBIDDEN'],
      [null, 404, 'NOT_FOUND'],
    ] as const) {
      assert.equal((await f.call(rolePath, alice, { role })).statusCode, 200);
      const before = snapshot(f.store);
      for (const request of requests) {
        for (const payload of [request.payload, { ...request.payload, activeRunAction: 'stop' }]) {
          const denied = await f.call(request.path, bob, payload, request.key);
          assert.equal(denied.statusCode, status, denied.body);
          assert.equal(denied.json().error.code, error);
        }
        // Also exercise Store directly: the HTTP preHandler is not the only guard.
        assert.throws(
          () =>
            f.store.as(bob, () =>
              f.store.changeTask(
                request.task.id,
                request.action === 'complete' ? 'done' : 'cancelled',
                request.payload.expectedRevision,
                'keep',
                request.key,
              ),
            ),
          (cause: unknown) => cause instanceof DomainError && cause.code === error,
        );
      }
      assert.deepEqual(snapshot(f.store), before);
    }

    assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
    const restored = snapshot(f.store);
    for (const request of requests) {
      const replay = await f.call(request.path, bob, request.payload, request.key);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), request.receipt);
    }
    assert.deepEqual(snapshot(f.store), restored);
    assert.equal(
      (await f.call(`spaces/${alice.spaceId}/members/${bob.user.id}/remove`, alice, {})).statusCode,
      200,
    );
    const revoked = snapshot(f.store);
    for (const request of requests) {
      const denied = await f.call(request.path, bob, request.payload, request.key);
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().error.code, 'SPACE_ACCESS_REVOKED');
    }
    assert.deepEqual(snapshot(f.store), revoked);
  } finally {
    await f.close();
  }
});

test('另一SQLite连接在外层检查后提交撤权，完成/取消/重开旧回执仍在事务内拒绝且不产生业务写入', async (t) => {
  const f = await teamFixture();
  const other = new DatabaseSync(f.dbPath);
  try {
    const { alice, bob } = await f.pair();
    const project = await f.project(alice);
    const rolePath = `projects/${project.id}/members/${bob.user.id}`;
    assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
    const requests = [];
    for (const [action, status] of [
      ['complete', 'done'],
      ['cancel', 'cancelled'],
      ['reopen', 'todo'],
    ] as const) {
      let task: Task = await f.task(alice, project.id, `${action}并发撤权`);
      if (action === 'reopen') {
        const completed = await f.call(`tasks/${task.id}/complete`, alice, {
          expectedRevision: task.revision,
          activeRunAction: 'keep',
        });
        assert.equal(completed.statusCode, 200, completed.body);
        task = completed.json<Task>();
      }
      const payload = { expectedRevision: task.revision, activeRunAction: 'keep' as const };
      const key = `${action}-race-receipt`;
      const response = await f.call(`tasks/${task.id}/${action}`, bob, payload, key);
      assert.equal(response.statusCode, 200, response.body);
      requests.push({ task, status, payload, key, receipt: response.json<Task>() });
    }

    const mutate = f.store.mutate.bind(f.store);
    let beforeBegin: (() => void) | undefined;
    t.mock.method(
      f.store,
      'mutate',
      <T>(
        scope: string,
        key: string,
        payload: unknown,
        action: () => T,
        beforeReplay?: () => void,
      ): T => {
        if (scope.startsWith('task.status:')) {
          const interleave = beforeBegin;
          beforeBegin = undefined;
          interleave?.();
        }
        return mutate(scope, key, payload, action, beforeReplay);
      },
    );

    for (const request of requests) {
      for (const [role, error] of [
        ['view', 'FORBIDDEN'],
        [null, 'NOT_FOUND'],
      ] as const) {
        assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
        const before = snapshot(f.store);
        let revoked: ReturnType<typeof snapshot> | undefined;
        let interleaved = false;
        beforeBegin = () => {
          // changeTask has passed its outer permission check, but mutate has not
          // begun its transaction. A separate connection must really commit here:
          // this catches the pre-existing status receipt gap, not a port regression.
          other.exec('BEGIN IMMEDIATE');
          try {
            if (role === null)
              other
                .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
                .run(project.id, bob.user.id);
            else
              other
                .prepare(
                  'UPDATE collab_project_members SET role=? WHERE project_id=? AND user_id=?',
                )
                .run(role, project.id, bob.user.id);
            other.exec('COMMIT');
          } catch (cause) {
            other.exec('ROLLBACK');
            throw cause;
          }
          interleaved = true;
          revoked = snapshot(f.store);
          assert.notDeepEqual(revoked.collab_project_members, before.collab_project_members);
          for (const [table, rows] of Object.entries(before))
            if (table !== 'collab_project_members') assert.deepEqual(revoked[table], rows);
        };

        assert.throws(
          () =>
            f.store.as(bob, () =>
              f.store.changeTask(
                request.task.id,
                request.status,
                request.payload.expectedRevision,
                request.payload.activeRunAction,
                request.key,
              ),
            ),
          (cause: unknown) => cause instanceof DomainError && cause.code === error,
        );
        assert.equal(interleaved, true);
        assert.deepEqual(snapshot(f.store), revoked);

        // Restored access returns the same saved receipt, without another status
        // change, completion event, outbox entry, or idempotency write.
        assert.equal((await f.call(rolePath, alice, { role: 'edit' })).statusCode, 200);
        const restored = snapshot(f.store);
        assert.deepEqual(
          f.store.as(bob, () =>
            f.store.changeTask(
              request.task.id,
              request.status,
              request.payload.expectedRevision,
              request.payload.activeRunAction,
              request.key,
            ),
          ),
          request.receipt,
        );
        assert.deepEqual(snapshot(f.store), restored);
      }
    }
  } finally {
    t.mock.restoreAll();
    other.close();
    await f.close();
  }
});
