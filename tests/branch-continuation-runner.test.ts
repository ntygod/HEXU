import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { branchWorkspaceFixture } from './helpers/branch-workspace.js';
import { branchContinuationBody } from './helpers/branch-continuation.js';
import { git } from './helpers/checkpoint-retention.js';
import { publishLocalCheckpoint } from '../apps/runner/src/agent/checkpoints.js';
import {
  configureExecution,
  writeExecutionPolicy,
} from '../apps/runner/src/agent/execution-policy.js';
import { verifyBranchOrigin } from '../apps/runner/src/agent/branch-origin.js';
import { NodeExecutor } from '../apps/runner/src/agent/executor.js';
import type { Run } from '../packages/contracts/src/index.js';

const pause = () => new Promise((r) => setTimeout(r, 25));
async function settled(
  f: Pick<Awaited<ReturnType<typeof branchWorkspaceFixture>>, 'tick' | 'api' | 'alice'>,
  id: string,
) {
  for (let i = 0; i < 100; i++) {
    await f.tick();
    await pause();
    const r = (await f.api.call(`runs/${id}`, f.alice)).json() as Run;
    if (['succeeded', 'failed', 'cancelled'].includes(r.state)) return r;
  }
  throw new Error('protocol fixture did not settle');
}
async function ready(format: 'sha1' | 'sha256' = 'sha1') {
  const f = await branchWorkspaceFixture(format);
  try {
    const p = await f.prepare();
    await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const node = await f.enableBranch(p.p),
      first = await f.runBranch(0, node);
    assert.equal(first.reply.statusCode, 201, first.reply.body);
    assert.equal((await settled(f, first.run.id)).state, 'succeeded');
    git(p.target, 'add', '.');
    git(
      p.target,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'selected result',
    );
    const commit = git(p.target, 'rev-parse', 'HEAD');
    const task = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    const request = (
      await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
        nodeId: node.c.nodeId,
        workspaceId: node.c.directories[0]!.id,
        commit,
        label: '继续的固定起点',
        expectedTaskRevision: task.revision,
        confirmReference: true,
      })
    ).json();
    const cp = await publishLocalCheckpoint(
      node.storage.home,
      request.id,
      async () => `CHECKPOINT ${commit}`,
      () => {},
    );
    const branch = (await f.read()).branches[0]!;
    const saved = await f.api.call(`${p.path}/results`, f.alice, {
      expectedRevision: branch.revision,
      expectedResultRevision: 0,
      sourceRunId: first.run.id,
      expectedRunRevision: branch.run!.revision,
      title: '可继续的方案成果',
      body: 'SELECTED_VERSION_SCOPE',
      limitations: '协议测试，不是真实模型',
      codeCheckpointId: cp.checkpointId,
    });
    assert.equal(saved.statusCode, 201, saved.body);
    const choice = await f.api.call(
      `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`,
      f.alice,
      {
        expectedSelectionRevision: 0,
        branchId: branch.id,
        resultRevisionId: saved.json().revisionId,
        note: '',
      },
    );
    assert.equal(choice.statusCode, 200, choice.body);
    await f.tick();
    return {
      ...f,
      p,
      node,
      first,
      commit,
      saved: saved.json() as { resultId: string; revisionId: string },
      body: (prompt?: string) =>
        branchContinuationBody(f.api, f.alice, f.task.id, branch.id, prompt),
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}

for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format}从已选提交在原现场真实继续，新会话输入固定且保留旧成果/原仓库`,
    { skip: process.platform !== 'linux' },
    async () => {
      const f = await ready(format);
      try {
        let prompt = 'FIXTURE_CAPTURE_INPUT FIXTURE_WRITE';
        if (format === 'sha256') {
          const executable = join(f.node.storage.home, 'codex-followup-protocol-fixture.mjs');
          await writeFile(
            executable,
            `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (!process.argv.includes('--version') && !process.argv.includes('--help')) appendFileSync(${JSON.stringify(join(f.node.storage.home, 'fixture-starts.txt'))}, 'start\\n');\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/codex-tool.js')).href)});\n`,
          );
          await chmod(executable, 0o700);
          const config = join(f.node.storage.home, 'followup-policy.json');
          await writeFile(
            config,
            JSON.stringify({
              tool: 'codex',
              executable,
              mode: 'edit',
              workspaces: ['方案代码'],
              timeoutSeconds: 30,
              maxBudgetUsd: null,
            }),
          );
          writeExecutionPolicy(f.node.storage.home, await configureExecution(config, f.node.c));
          // Policy is loaded at executor startup; restart the idle agent to publish it.
          await f.node.executor.close();
          f.node.executor = new NodeExecutor(f.node.connection);
          f.active[0]!.executor = f.node.executor;
          await f.tick();
          prompt = 'CODEX_CAPTURE_INPUT';
          git(f.p.target, 'pack-refs', '--all'); // Continuation permits a normal packed branch reference.
        }
        const before = (await f.api.call(`results/${f.saved.resultId}`, f.alice)).json().version;
        await f.api.call(`tasks/${f.task.id}/messages`, f.alice, {
          body: 'UNSELECTED_LATE_FEEDBACK',
          resultId: f.saved.resultId,
          resultRevisionId: f.saved.revisionId,
        });
        const body = await f.body(prompt),
          key = randomUUID();
        const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key);
        assert.equal(r.statusCode, 201, r.body);
        const result = await settled(f, r.json().id);
        assert.equal(result.state, 'succeeded', JSON.stringify(result));
        assert.equal(result.requestedTool, format === 'sha256' ? 'codex' : 'claude-code');
        assert.equal(result.previousRunId, f.first.run.id);
        assert.equal(result.node?.sessionMode, undefined);
        const text = await readFile(join(f.p.target, 'received-context.txt'), 'utf8');
        assert(text.includes('SELECTED_VERSION_SCOPE'));
        assert(text.includes(f.commit));
        assert(text.includes(prompt));
        assert(!text.includes('UNSELECTED_LATE_FEEDBACK'));
        assert(!text.includes('BETA_ONLY'));
        assert.deepEqual(
          (await f.api.call(`results/${f.saved.resultId}`, f.alice)).json().version,
          before,
        );
        assert.equal((await f.read()).selection!.resultRevisionId, f.saved.revisionId);
        assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'Local dirty only\n');
        const count = (await readFile(join(f.node.storage.home, 'fixture-starts.txt'), 'utf8'))
          .trim()
          .split('\n').length;
        assert.equal(count, 2);
        assert.equal(
          (await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body, key)).json().id,
          result.id,
        );
        await f.tick();
        assert.equal(
          (await readFile(join(f.node.storage.home, 'fixture-starts.txt'), 'utf8'))
            .trim()
            .split('\n').length,
          2,
        );
      } finally {
        await f.close();
      }
    },
  );

test(
  '所选提交目录出现脏文件/额外文件/不同HEAD时拒绝，保留现场且不启动模型',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await ready();
    try {
      const body = await f.body('FIXTURE_CAPTURE_INPUT'),
        r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, body);
      assert.equal(r.statusCode, 201, r.body);
      const binding = (r.json() as Run).node!.workBranch!,
        c = f.node.c,
        w = c.directories[0]!;
      const check = () => verifyBranchOrigin(f.node.storage.home, c, w, binding);
      await check();
      const readme = await readFile(join(f.p.target, 'README.md'));
      await writeFile(join(f.p.target, 'README.md'), 'KEEP_MY_DIRTY_FILE');
      await assert.rejects(check, /所选提交不一致/);
      const failed = await settled(f, r.json().id);
      assert.equal(failed.state, 'failed');
      assert.equal(await readFile(join(f.p.target, 'README.md'), 'utf8'), 'KEEP_MY_DIRTY_FILE');
      assert.equal(
        (await readFile(join(f.node.storage.home, 'fixture-starts.txt'), 'utf8')).trim().split('\n')
          .length,
        1,
      );
      await writeFile(join(f.p.target, 'README.md'), readme);
      await writeFile(join(f.p.target, 'untracked-local.txt'), 'KEEP_UNTRACKED');
      await assert.rejects(check, /所选提交不一致/);
      assert.equal(
        await readFile(join(f.p.target, 'untracked-local.txt'), 'utf8'),
        'KEEP_UNTRACKED',
      );
      await rm(join(f.p.target, 'untracked-local.txt'));
      git(
        f.p.target,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'not the chosen commit',
      );
      await assert.rejects(check, /所选提交不一致/);
      assert.notEqual(git(f.p.target, 'rev-parse', 'HEAD'), f.commit);
    } finally {
      await f.close();
    }
  },
);

test(
  '启动许可返回后本机执行授权被撤销，第二次代码核验后仍不启动工具',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await ready(),
      original = globalThis.fetch;
    try {
      const r = await f.api.call(`tasks/${f.task.id}/runs`, f.alice, await f.body());
      assert.equal(r.statusCode, 201, r.body);
      let changed = false;
      globalThis.fetch = async (input, init) => {
        const reply = await original(input, init);
        if (!changed && String(input).endsWith('/execution-permit')) {
          changed = true;
          writeExecutionPolicy(f.node.storage.home, null);
        }
        return reply;
      };
      const failed = await settled(f, r.json().id);
      assert.equal(failed.state, 'failed');
      assert(changed);
      assert.equal(
        (await readFile(join(f.node.storage.home, 'fixture-starts.txt'), 'utf8')).trim().split('\n')
          .length,
        1,
      );
      assert.equal(git(f.p.target, 'rev-parse', 'HEAD'), f.commit);
    } finally {
      globalThis.fetch = original;
      await f.close();
    }
  },
);
