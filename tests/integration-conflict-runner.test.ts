import test from 'node:test';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { localIntegrationTrial } from '../apps/runner/src/agent/integration-trial.js';
import { shareIntegrationTrialDifference } from '../apps/runner/src/agent/integration-trial-difference.js';
import {
  IntegrationTrialJournal,
  withSettledIntegrationTrials,
} from '../apps/runner/src/agent/integration-trial-journal.js';
import type { IntegrationConflictSelection } from '../packages/contracts/src/integration-conflict-selection.js';
const silent = () => {},
  accept = async (p: string) => /(?:SHARE_TRIAL_DIFF|DIFF_TRIAL|TRIAL) [a-f0-9-]{36}/.exec(p)![0],
  noAsk = async () => {
    throw new Error('no new consent or writes on replay');
  };
for (const decision of ['take_source', 'keep_target'] as const)
  test(
    `真实冲突候选${decision}与独立共享保留固定决策，原目标/HEAD/index不变`,
    { skip: process.platform !== 'linux' },
    async () => {
      const f = await integrationRunnerFixture('sha1', false, true);
      try {
        const id = await f.create();
        await preflightIntegration(f.target.home, id, f.ask(id), silent);
        const before = new Map(
            await Promise.all(
              ['README.md', '.git/HEAD', '.git/index', 'target.txt'].map(
                async (p) => [p, await readFile(join(f.target.root, p))] as const,
              ),
            ),
          ),
          original = JSON.stringify((await f.read(id)).operation),
          target = join(f.dir, 'conflict-candidate');
        const conflictSelection: IntegrationConflictSelection = {
          version: 2,
          kind: 'explicit_conflict_choices',
          selectedPaths: decision === 'take_source' ? ['README.md'] : [],
          conflictChoices: [{ path: 'README.md', choice: decision }],
        };
        const result = await localIntegrationTrial(
          f.target.home,
          id,
          target,
          conflictSelection.selectedPaths,
          accept,
          { log: silent, conflictSelection },
        );
        assert.equal(result.state, 'ready');
        assert.equal(
          await readFile(join(target, 'README.md'), 'utf8'),
          decision === 'take_source' ? 'SOURCE_COMMITTED_SECRET\n' : 'TARGET_DIFFERENT\n',
        );
        for (const [p, b] of before) assert.deepEqual(await readFile(join(f.target.root, p)), b, p);
        const firstFiles = await readdir(target);
        const repeated = await localIntegrationTrial(
          f.target.home,
          id,
          target,
          conflictSelection.selectedPaths,
          noAsk,
          { log: silent, conflictSelection },
        );
        assert.equal(repeated.id, result.id);
        assert.equal(repeated.historical, true);
        assert.deepEqual(await readdir(target), firstFiles);
        await assert.rejects(
          localIntegrationTrial(f.target.home, id, target, ['README.md'], noAsk, { log: silent }),
        );
        const receipt = await shareIntegrationTrialDifference(
          f.target.home,
          id,
          result.id,
          accept,
          { log: silent },
        );
        const history = await f.api.call(`${f.path}/${id}/trials/${result.id}`, f.alice);
        assert.equal(history.statusCode, 200, history.body);
        const report = history.json().report;
        assert.equal(report.version, 2);
        assert.deepEqual(report.conflictChoices, conflictSelection.conflictChoices);
        assert.equal(report.difference.changedFiles, decision === 'take_source' ? 1 : 0);
        assert.equal(report.difference.files.length, decision === 'take_source' ? 1 : 0);
        assert.equal(JSON.stringify((await f.read(id)).operation), original);
        assert.deepEqual(
          await shareIntegrationTrialDifference(f.target.home, id, result.id, noAsk, {
            log: silent,
          }),
          receipt,
        );
        const journal = new IntegrationTrialJournal(f.target.home);
        try {
          const record = journal.byId(result.id)!;
          assert.equal(record.version, 2);
          assert.equal(record.manifest.version, 2);
          assert.equal(journal.difference(record)!.report.version, 2);
        } finally {
          journal.close();
        }
        assert.equal(await withSettledIntegrationTrials(f.target.home, async () => true), true);
      } finally {
        await f.close();
      }
    },
  );

test(
  '真实CLI只接受显式版本2选择或旧files其一，0变更保留目标命令不隐式采用来源',
  { skip: process.platform !== 'linux' },
  async () => {
    const executable = resolve('dist/apps/runner/src/integration-trial.js');
    const invalid = spawnSync(
      process.execPath,
      [
        executable,
        '--operation',
        'id',
        '--state',
        '/does-not-exist',
        '--target',
        '/does-not-exist',
        '--files',
        '["file"]',
        '--selection',
        '{}',
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /INVALID_INPUT/);
    const f = await integrationRunnerFixture('sha1', false, true);
    try {
      const id = await f.create();
      await preflightIntegration(f.target.home, id, f.ask(id), silent);
      const target = join(f.dir, 'cli-keep-target'),
        selection: IntegrationConflictSelection = {
          version: 2,
          kind: 'explicit_conflict_choices',
          selectedPaths: [],
          conflictChoices: [{ path: 'README.md', choice: 'keep_target' }],
        };
      const child = spawn(
        process.execPath,
        [
          executable,
          '--operation',
          id,
          '--state',
          f.target.home,
          '--target',
          target,
          '--selection',
          JSON.stringify(selection),
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      let output = '';
      child.stdout.on('data', (d) => {
        output += d;
      });
      child.stderr.on('data', (d) => {
        output += d;
      });
      const exited = once(child, 'exit');
      child.stdin.end(`TRIAL ${id}\n`);
      const [code] = await exited;
      assert.equal(code, 0, output);
      assert.match(output, /实际来源变更 0 项/);
      assert.match(output, /保留目标整文件/);
      assert.equal(await readFile(join(target, 'README.md'), 'utf8'), 'TARGET_DIFFERENT\n');
      assert.equal((await f.read(id)).operation.application, null);
    } finally {
      await f.close();
    }
  },
);

for (const keepReadme of [false, true])
  test(
    `真实冲突混合增改删写回与原文件恢复${keepReadme ? '排除明确保留目标项' : '按当前目标而非旧base反转'}`,
    { skip: process.platform !== 'linux' },
    async () => {
      const { applyIntegration } = await import(
        '../apps/runner/src/agent/integration-application.js'
      );
      const { restoreIntegrationFiles } = await import(
        '../apps/runner/src/agent/integration-file-restoration.js'
      );
      const { WorkspaceLease } = await import('../apps/runner/src/workspace-lease.js');
      const f = await integrationRunnerFixture(
        'sha1',
        false,
        true,
        { 'restore.txt': 'SOURCE RESTORE\n' },
        {
          baseFiles: { 'delete.txt': 'BASE DELETE\n', 'restore.txt': 'BASE RESTORE\n' },
          sourceDeletePaths: ['delete.txt'],
          targetDeletePaths: ['restore.txt'],
          targetFiles: {
            'delete.txt': 'TARGET DELETE EDIT\n',
            'new.txt': 'TARGET INDEPENDENT ADD\n',
          },
        },
      );
      let applicationId: string | undefined, restorationId: string | undefined;
      try {
        const id = await f.create();
        await preflightIntegration(f.target.home, id, f.ask(id), silent);
        const v = await f.read(id);
        assert.equal(v.operation.report!.plan!.conflicts, 4);
        const originals = new Map(
          await Promise.all(
            ['README.md', 'delete.txt', 'new.txt', 'target.txt', '.git/HEAD', '.git/index'].map(
              async (p) => [p, await readFile(join(f.target.root, p))] as const,
            ),
          ),
        );
        const paths = ['README.md', 'delete.txt', 'new.txt', 'restore.txt'],
          selection: IntegrationConflictSelection = {
            version: 2,
            kind: 'explicit_conflict_choices',
            selectedPaths: paths.filter((p) => p !== 'README.md' || !keepReadme),
            conflictChoices: paths.map((path) => ({
              path,
              choice: path === 'README.md' && keepReadme ? 'keep_target' : 'take_source',
            })),
          };
        const candidate = await localIntegrationTrial(
          f.target.home,
          id,
          join(f.dir, 'mixed-conflict-candidate'),
          selection.selectedPaths,
          accept,
          { log: silent, conflictSelection: selection },
        );
        assert.equal(candidate.state, 'ready');
        const shared = await shareIntegrationTrialDifference(
          f.target.home,
          id,
          candidate.id,
          accept,
          { log: silent },
        );
        const current = await f.read(id),
          applied = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
            expectedRevision: current.operation.revision,
            expectedTaskRevision: current.taskRevision,
            reportHash: current.reportHash,
            paths: selection.selectedPaths,
            confirmApplication: true,
            candidate: {
              trialId: candidate.id,
              reportHash: shared.hash,
              manifestHash: candidate.manifestHash,
              confirmExistingChanges: true,
            },
          });
        assert.equal(applied.statusCode, 200, applied.body);
        applicationId = applied.json().operation.application.id;
        const result = await applyIntegration(
          f.target.home,
          id,
          async () => `STOPPED_AND_APPLY ${applicationId}`,
          silent,
          undefined,
          { backup: join(f.dir, 'mixed-original-backup') },
        );
        assert.equal(result.state, 'completed', JSON.stringify(result));
        assert.deepEqual(result.appliedPaths, selection.selectedPaths);
        assert.equal(
          await readFile(join(f.target.root, 'README.md'), 'utf8'),
          keepReadme ? 'TARGET_DIFFERENT\n' : 'SOURCE_COMMITTED_SECRET\n',
        );
        assert.equal(
          await readFile(join(f.target.root, 'restore.txt'), 'utf8'),
          'SOURCE RESTORE\n',
        );
        assert.equal(
          await readFile(join(f.target.root, 'new.txt'), 'utf8'),
          'NEW_COMMITTED_SECRET\n',
        );
        await assert.rejects(lstat(join(f.target.root, 'delete.txt')), { code: 'ENOENT' });
        assert.deepEqual(await applyIntegration(f.target.home, id, noAsk, silent), result);
        const done = await f.read(id);
        assert.equal(done.operation.report!.plan!.conflicts, 4);
        const restoration = await f.api.call(`${f.path}/${id}/restore`, f.alice, {
          applicationId,
          applicationInputHash: done.operation.application!.inputHash,
          completedReportHash: done.completedReportHash,
          paths: selection.selectedPaths,
          expectedRevision: done.operation.revision,
          expectedTaskRevision: done.taskRevision,
          confirmFileRestoration: true,
        });
        assert.equal(restoration.statusCode, 200, restoration.body);
        restorationId = restoration.json().restoration.id;
        const restored = await restoreIntegrationFiles(
          f.target.home,
          id,
          restorationId!,
          async () => `STOPPED_AND_RESTORE ${restorationId}`,
          silent,
          undefined,
          { backup: join(f.dir, 'mixed-current-backup') },
        );
        assert.equal(restored.state, 'completed', JSON.stringify(restored));
        assert.deepEqual(restored.restoredPaths, selection.selectedPaths);
        for (const [p, b] of originals)
          assert.deepEqual(await readFile(join(f.target.root, p)), b, p);
        await assert.rejects(lstat(join(f.target.root, 'restore.txt')), { code: 'ENOENT' });
      } finally {
        for (const id of [applicationId, restorationId])
          if (id)
            try {
              new WorkspaceLease(f.target.root, `integration:${id}`, true).release();
            } catch {}
        await f.close();
      }
    },
  );
