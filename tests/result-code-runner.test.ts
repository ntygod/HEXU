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
import { shareResultCode } from '../apps/runner/src/agent/result-code.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';

for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format}真实Git文件/HTTP差异共享不读未提交内容，不运行外部diff，丢失回执不重新采集`,
    { skip: process.platform !== 'linux' },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hexu-result-code-')),
        root = join(dir, 'repo'),
        home = join(dir, 'node');
      await mkdir(root);
      await mkdir(home, { mode: 0o700 });
      git(root, 'init', '-q', `--object-format=${format}`);
      await writeFile(join(root, 'README.md'), 'BASE_COMMITTED\n');
      git(root, 'add', '.');
      git(
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'base',
      );
      const before = {
        objectFormat: format,
        commit: git(root, 'rev-parse', 'HEAD'),
        tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      };
      const f = await branchResultFixture(undefined, before);
      const originalFetch = globalThis.fetch;
      try {
        const node = f.ns[0]!,
          run = f.begin();
        run.start();
        run.finish(); // Explicit protocol terminal; no model invocation.
        await writeFile(join(root, 'README.md'), 'OUTPUT_COMMITTED\n');
        await writeFile(join(root, 'empty.txt'), '');
        git(root, 'add', '.');
        git(
          root,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'selected output',
        );
        const output = git(root, 'rev-parse', 'HEAD');
        await writeFile(join(root, 'README.md'), 'PRIVATE_UNCOMMITTED_NOT_SHARED\n');
        await writeFile(join(root, 'untracked.txt'), 'PRIVATE_UNTRACKED_NOT_SHARED');
        const marker = join(dir, 'external-diff-ran');
        git(root, 'config', 'diff.external', `touch ${marker}`);
        const [w] = await authorizeDirectories([{ name: '方案协议目录', path: root }], home);
        await f.api.app.listen({ port: 0, host: '127.0.0.1' });
        const address = f.api.app.server.address();
        assert(address && typeof address !== 'string');
        writeCredentials(home, {
          version: 1,
          controlUrl: `http://127.0.0.1:${address.port}`,
          nodeToken: node.token,
          nodeId: node.nodeId,
          clientId: randomUUID(),
          name: 'Git差异夹具节点',
          projectId: f.project.id,
          spaceId: f.alice.spaceId,
          directories: [{ ...w!, id: node.workspace }],
        });
        const request = (
          await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
            nodeId: node.nodeId,
            workspaceId: node.workspace,
            commit: output,
            label: '结束后所选提交',
            expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id).revision),
            confirmReference: true,
          })
        ).json();
        const cp = await publishLocalCheckpoint(
          home,
          request.id,
          async () => `CHECKPOINT ${output}`,
          () => {},
        );
        const saved = await saveResultCode(f, cp.checkpointId);
        const originalIndex = await readFile(join(root, '.git', 'index')),
          originalHead = git(root, 'rev-parse', 'HEAD');
        const lease = new WorkspaceLease(root, 'result-code-fixture-' + randomUUID());
        try {
          await assert.rejects(
            shareResultCode(
              home,
              saved.revisionId,
              async () => {
                throw new Error('must reject before prompting');
              },
              () => {},
            ),
            /占用|未知/,
          );
        } finally {
          lease.release();
        }
        let lost = format === 'sha256';
        globalThis.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          if (lost && String(input).endsWith('/result-code-publish')) {
            lost = false;
            await response.text();
            throw new TypeError('fixture lost response');
          }
          return response;
        };
        const ask = async (prompt: string) =>
          prompt.includes('SHARE_DIFF')
            ? `SHARE_DIFF ${saved.revisionId}`
            : `DIFF ${saved.revisionId}`;
        if (format === 'sha256') {
          await assert.rejects(shareResultCode(home, saved.revisionId, ask, () => {}));
          const journal = new DatabaseSync(join(home, 'result-code', 'journal.sqlite'), {
            readOnly: true,
          });
          assert(journal.prepare('SELECT body FROM publication').get());
          journal.close();
          // Moving only our unique temporary fixture proves replay does not read the repository again.
          const moved = join(dir, 'repo-moved');
          assert(moved.startsWith(dir));
          assert(root.startsWith(dir));
          await rename(root, moved);
          try {
            await shareResultCode(
              home,
              saved.revisionId,
              async () => {
                throw new Error('must replay original consent');
              },
              () => {},
            );
          } finally {
            await rename(moved, root);
          }
        } else await shareResultCode(home, saved.revisionId, ask, () => {});
        const detail = (await f.api.call(`results/${saved.resultId}`, f.alice)).json();
        const diff = detail.code.difference;
        assert.equal(diff.changedFiles, 2);
        assert(JSON.stringify(diff).includes('OUTPUT_COMMITTED'));
        assert(JSON.stringify(diff).includes('BASE_COMMITTED'));
        assert(!JSON.stringify(diff).includes('PRIVATE_'));
        assert.equal(git(root, 'rev-parse', 'HEAD'), originalHead);
        assert.deepEqual(await readFile(join(root, '.git', 'index')), originalIndex);
        assert.equal(
          await readFile(join(root, 'README.md'), 'utf8'),
          'PRIVATE_UNCOMMITTED_NOT_SHARED\n',
        );
        await assert.rejects(readFile(marker), /ENOENT/);
        await shareResultCode(
          home,
          saved.revisionId,
          async () => {
            throw new Error('successful replay must not re-read');
          },
          () => {},
        );
        const next = await saveResultCode(f, cp.checkpointId);
        await assert.rejects(
          shareResultCode(
            home,
            next.revisionId,
            async (prompt) => {
              if (prompt.includes('SHARE_DIFF')) {
                f.as(() => f.nodes.revoke(node.nodeId, 1, randomUUID()));
                return `SHARE_DIFF ${next.revisionId}`;
              }
              return `DIFF ${next.revisionId}`;
            },
            () => {},
          ),
        );
        assert.equal(
          (await f.api.call(`results/${next.resultId}`, f.alice)).json().code.difference,
          null,
        );
      } finally {
        globalThis.fetch = originalFetch;
        await f.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
