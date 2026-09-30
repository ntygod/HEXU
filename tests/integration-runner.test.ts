import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { branchResultFixture } from './helpers/branch-results.js';
import { saveResultCode } from './helpers/result-code.js';
import { git } from './helpers/checkpoint-retention.js';
import { authorizeDirectories } from '../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../apps/runner/src/agent/storage.js';
import { publishLocalCheckpoint } from '../apps/runner/src/agent/checkpoints.js';
import { localRetentionOperation } from '../apps/runner/src/agent/checkpoint-retention.js';
import { localTransfer } from '../apps/runner/src/agent/checkpoint-transfer.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('must not repeat capture or consent');
};
async function fixture(format: 'sha1' | 'sha256' = 'sha1', transfer = false, conflict = false) {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-integration-')),
    root = join(dir, 'source-repo');
  await mkdir(root);
  git(root, 'init', '-q', `--object-format=${format}`);
  const commit = (root: string, label: string) => {
    git(root, 'add', '.');
    git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      label,
    );
    return git(root, 'rev-parse', 'HEAD');
  };
  await writeFile(join(root, 'README.md'), 'BASE\n');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  const base = commit(root, 'base'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const f = await branchResultFixture(undefined, { objectFormat: format, commit: base, tree });
  try {
    const run = f.begin();
    run.start();
    run.finish(); // Explicit metadata protocol fixture, no model.
    await f.api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = f.api.app.server.address();
    assert(address && typeof address !== 'string');
    const setup = async (index: number, root: string) => {
      const home = join(dir, `node-${index}`);
      await mkdir(home, { mode: 0o700 });
      const [w] = await authorizeDirectories([{ name: '预检夹具目录', path: root }], home),
        n = f.ns[index]!;
      const credentials = {
        version: 1 as const,
        controlUrl: `http://127.0.0.1:${address.port}`,
        nodeToken: n.token,
        nodeId: n.nodeId,
        clientId: randomUUID(),
        name: '预检夹具',
        projectId: f.project.id,
        spaceId: f.alice.spaceId,
        directories: [{ ...w!, id: n.workspace }],
      };
      writeCredentials(home, credentials);
      return { home, credentials, root, index };
    };
    const source = await setup(0, root);
    const checkpoint = async (node: typeof source, commit: string) => {
      const r = await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
        nodeId: f.ns[node.index]!.nodeId,
        workspaceId: f.ns[node.index]!.workspace,
        commit,
        label: '明确整合提交',
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmReference: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      return (
        await publishLocalCheckpoint(
          node.home,
          r.json().id,
          async () => `CHECKPOINT ${commit}`,
          silent,
        )
      ).checkpointId;
    };
    const retain = async (node: typeof source, cp: string, commit: string) => {
      const r = await f.api.call(`tasks/${f.task.id}/checkpoints/${cp}/retentions`, f.alice, {
        days: 7,
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmLocalRetention: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      const id = r.json().request.id as string;
      await localRetentionOperation(
        node.home,
        id,
        'retain',
        async () => `RETAIN ${commit} 7`,
        silent,
      );
      return id;
    };
    await writeFile(join(root, 'README.md'), 'SOURCE_COMMITTED_SECRET\n');
    await writeFile(join(root, 'new.txt'), 'NEW_COMMITTED_SECRET\n');
    const sourceCommit = commit(root, 'source'),
      sourceCp = await checkpoint(source, sourceCommit),
      sr = await retain(source, sourceCp, sourceCommit);
    const saved = await saveResultCode(f, sourceCp);
    let target = source;
    if (transfer) {
      const targetRoot = join(dir, 'target-repo');
      git(root, 'clone', '-q', '--no-hardlinks', root, targetRoot);
      target = await setup(1, targetRoot);
    }
    git(target.root, 'checkout', '--detach', '-q', base);
    await writeFile(join(target.root, 'target.txt'), 'TARGET_PRIVATE_ONLY\n');
    if (conflict) await writeFile(join(target.root, 'README.md'), 'TARGET_DIFFERENT\n');
    const targetCommit = commit(target.root, 'target'),
      targetCp = await checkpoint(target, targetCommit),
      tr = await retain(target, targetCp, targetCommit);
    let material: { kind: string; id: string } = { kind: 'retention', id: sr };
    if (transfer) {
      const r = await f.api.call(
        `tasks/${f.task.id}/checkpoints/${sourceCp}/retentions/${sr}/transfers`,
        f.alice,
        {
          targetNodeId: f.ns[1]!.nodeId,
          expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
          confirmTransfer: true,
        },
      );
      assert.equal(r.statusCode, 201, r.body);
      const id = r.json().ticket.id as string;
      await localTransfer(target.home, id, 'accept', async () => `RECEIVE ${id}`, silent);
      await localTransfer(source.home, id, 'send', async () => `SEND ${id}`, silent);
      await localTransfer(target.home, id, 'receive', noAsk, silent);
      material = { kind: 'transfer', id };
    }
    const path = `tasks/${f.task.id}/integrations`;
    const create = async () => {
      const r = await f.api.call(path, f.alice, {
        resultId: saved.resultId,
        resultRevisionId: saved.revisionId,
        targetCheckpointId: targetCp,
        targetRetentionId: tr,
        sourceMaterial: material,
        expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
        confirmPreflight: true,
      });
      assert.equal(r.statusCode, 201, r.body);
      return (r.json() as IntegrationView).operation.id;
    };
    const read = async (id: string) =>
      (await f.api.call(`${path}/${id}`, f.alice)).json() as IntegrationView;
    const ask = (id: string) => async (prompt: string) =>
      prompt.includes('SHARE_PREFLIGHT') ? `SHARE_PREFLIGHT ${id}` : `PREFLIGHT ${id}`;
    const close = async () => {
      await f.close();
      assert(dir.startsWith(tmpdir()));
      await rm(dir, { recursive: true, force: true });
    };
    return {
      ...f,
      dir,
      source,
      target,
      sr,
      tr,
      base,
      targetCommit,
      create,
      read,
      ask,
      path,
      close,
    };
  } catch (e) {
    await f.close();
    assert(dir.startsWith(tmpdir()));
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format}真实Git完整对象预检，HEAD/index/文件不变，丢失回执重发原包不重读`,
    { skip: process.platform !== 'linux' },
    async () => {
      const f = await fixture(format, false, format === 'sha256'),
        fetch = globalThis.fetch;
      try {
        const id = await f.create(),
          root = f.target.root,
          index = await readFile(join(root, '.git', 'index')),
          head = await readFile(join(root, '.git', 'HEAD'));
        const body = await readFile(join(root, 'README.md')),
          extra = await readFile(join(root, 'target.txt'));
        const marker = join(f.dir, 'external-driver');
        git(root, 'config', 'diff.external', `touch ${marker}`);
        git(root, 'config', 'merge.external.driver', `touch ${marker}`);
        let lost = true;
        globalThis.fetch = async (input, init) => {
          const response = await fetch(input, init);
          if (lost && String(input).endsWith('/integration-publish')) {
            lost = false;
            await response.text();
            throw new TypeError('lost integration acknowledgement');
          }
          return response;
        };
        const output: string[] = [];
        await assert.rejects(
          preflightIntegration(f.target.home, id, f.ask(id), (s) => output.push(s)),
        );
        const view = await f.read(id);
        assert.equal(
          view.operation.state,
          format === 'sha256' ? 'conflict' : 'awaiting_choice',
          JSON.stringify(view),
        );
        assert.equal(view.operation.report!.plan!.changedFiles, 2);
        assert.equal(view.operation.report!.plan!.applied, false);
        assert(!JSON.stringify(view).includes('SOURCE_COMMITTED_SECRET'));
        assert(!JSON.stringify(view).includes('TARGET_PRIVATE_ONLY'));
        const moved = join(f.dir, 'target-moved');
        assert(moved.startsWith(f.dir));
        assert(root.startsWith(f.dir));
        await rename(root, moved);
        try {
          await preflightIntegration(f.target.home, id, noAsk, silent);
        } finally {
          await rename(moved, root);
        }
        assert.deepEqual(await readFile(join(root, '.git', 'index')), index);
        assert.deepEqual(await readFile(join(root, '.git', 'HEAD')), head);
        assert.deepEqual(await readFile(join(root, 'README.md')), body);
        assert.deepEqual(await readFile(join(root, 'target.txt')), extra);
        await assert.rejects(readFile(marker), /ENOENT/);
        assert.equal((await f.read(id)).operation.history.length, 2);
        await preflightIntegration(f.target.home, id, noAsk, silent);
      } finally {
        globalThis.fetch = fetch;
        await f.close();
      }
    },
  );
test(
  '真实接收副本可独立预检，原副本删除和来源目录变化不回源，目标仍保留原文件',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await fixture('sha256', true);
    try {
      await localRetentionOperation(
        f.source.home,
        f.sr,
        'forget',
        async () => `DELETE ${f.sr}`,
        silent,
      );
      await writeFile(join(f.source.root, 'README.md'), 'UNSHARED_NEW_SOURCE');
      const id = await f.create();
      await preflightIntegration(f.target.home, id, f.ask(id), silent);
      assert.equal((await f.read(id)).operation.state, 'awaiting_choice');
      assert.equal(await readFile(join(f.target.root, 'README.md'), 'utf8'), 'BASE\n');
      assert.equal(await readFile(join(f.source.root, 'README.md'), 'utf8'), 'UNSHARED_NEW_SOURCE');
    } finally {
      await f.close();
    }
  },
);
test(
  '缺对象不从工作树修补；未知占用、脏目录和确认期间变化阻止发布，保留本人修改',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await fixture();
    try {
      let id = await f.create();
      const lease = new WorkspaceLease(f.target.root, 'integration-fixture-' + randomUUID());
      try {
        await assert.rejects(
          preflightIntegration(f.target.home, id, f.ask(id), silent),
          /占用|未知/,
        );
      } finally {
        lease.release();
      }
      assert.equal((await f.read(id)).operation.report, null);
      await writeFile(join(f.target.root, 'README.md'), 'KEEP_DIRTY');
      await preflightIntegration(f.target.home, id, f.ask(id), silent);
      assert.equal((await f.read(id)).operation.report!.reason, 'target_changed');
      assert.equal(await readFile(join(f.target.root, 'README.md'), 'utf8'), 'KEEP_DIRTY');
      await writeFile(join(f.target.root, 'README.md'), 'BASE\n');
      id = await f.create();
      await assert.rejects(
        preflightIntegration(
          f.target.home,
          id,
          async (p) => {
            if (p.includes('SHARE_PREFLIGHT'))
              await writeFile(join(f.target.root, 'README.md'), 'CHANGED_DURING_CONFIRM');
            return f.ask(id)(p);
          },
          silent,
        ),
        /当前目录|HEAD/,
      );
      assert.equal((await f.read(id)).operation.report, null);
      assert.equal(
        await readFile(join(f.target.root, 'README.md'), 'utf8'),
        'CHANGED_DURING_CONFIRM',
      );
      await writeFile(join(f.target.root, 'README.md'), 'BASE\n');
      const vault = new DatabaseSync(join(f.source.home, 'retained-checkpoints', 'journal.sqlite'));
      try {
        vault.prepare("DELETE FROM objects WHERE bundle_id=? AND type='blob'").run(f.sr);
      } finally {
        vault.close();
      }
      id = await f.create();
      await preflightIntegration(f.target.home, id, f.ask(id), silent);
      assert.equal((await f.read(id)).operation.report!.reason, 'objects_unavailable');
      assert.equal(git(f.target.root, 'rev-parse', 'HEAD'), f.targetCommit);
    } finally {
      await f.close();
    }
  },
);
test(
  '确认期间取消或撤销节点时不发布迟到清单，不清理目录或启动进程',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await fixture();
    try {
      let id = await f.create();
      await assert.rejects(
        preflightIntegration(
          f.target.home,
          id,
          async (p) => {
            if (p.includes('SHARE_PREFLIGHT'))
              await f.api.call(`${f.path}/${id}/cancel`, f.alice, { expectedRevision: 1 });
            return f.ask(id)(p);
          },
          silent,
        ),
      );
      assert.equal((await f.read(id)).operation.state, 'cancelled');
      assert.equal((await f.read(id)).operation.report, null);
      id = await f.create();
      await assert.rejects(
        preflightIntegration(
          f.target.home,
          id,
          async (p) => {
            if (p.includes('SHARE_PREFLIGHT'))
              f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
            return f.ask(id)(p);
          },
          silent,
        ),
      );
      assert.equal((await f.read(id)).operation.report, null);
      assert.equal(git(f.target.root, 'rev-parse', 'HEAD'), f.targetCommit);
      assert.equal(f.api.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  '未送达的固定待发包在服务端取消后明确结算，之后可以新建预检，不将旧包改投新操作',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await fixture(),
      fetch = globalThis.fetch;
    try {
      const id = await f.create();
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/integration-publish'))
          throw new TypeError('lost before delivery');
        return fetch(input, init);
      };
      await assert.rejects(preflightIntegration(f.target.home, id, f.ask(id), silent));
      globalThis.fetch = fetch;
      assert.equal((await f.read(id)).operation.report, null);
      const close = await f.api.call(`${f.path}/${id}/cancel`, f.alice, { expectedRevision: 1 });
      assert.equal(close.statusCode, 200, close.body);
      assert.deepEqual(await preflightIntegration(f.target.home, id, noAsk, silent), {
        integrationId: id,
        state: 'cancelled',
        publication: 'not_published',
      });
      const next = await f.create();
      await preflightIntegration(f.target.home, next, f.ask(next), silent);
      assert.equal((await f.read(id)).operation.state, 'cancelled');
      assert.equal((await f.read(id)).operation.report, null);
      assert.equal((await f.read(next)).operation.state, 'awaiting_choice');
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);
