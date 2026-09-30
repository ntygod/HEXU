import assert from 'node:assert/strict';
import { branchWorkspaceFixture } from './branch-workspace.js';
import { git } from './checkpoint-retention.js';
import { publishLocalCheckpoint } from '../../apps/runner/src/agent/checkpoints.js';
import { localRetentionOperation } from '../../apps/runner/src/agent/checkpoint-retention.js';

export async function branchCleanupRunnerFixture(format: 'sha1' | 'sha256' = 'sha1') {
  const f = await branchWorkspaceFixture(format);
  try {
    const p = await f.prepare();
    const c = await f.pairBranch(p.p);
    await f.bindBranch(p.p);
    const home = p.p.git!.nodeState!,
      commit = git(p.target, 'rev-parse', 'HEAD');
    const task = (await f.api.call(`tasks/${f.task.id}`, f.alice)).json().task;
    const r = await f.api.call(`tasks/${f.task.id}/checkpoint-requests`, f.alice, {
      nodeId: c.nodeId,
      workspaceId: c.directories[0]!.id,
      commit,
      label: '清理前固定保留起点',
      expectedTaskRevision: task.revision,
      confirmReference: true,
    });
    assert.equal(r.statusCode, 201, r.body);
    const cp = await publishLocalCheckpoint(
      home,
      r.json().id,
      async () => `CHECKPOINT ${commit}`,
      () => {},
    );
    const retained = await f.api.call(
      `tasks/${f.task.id}/checkpoints/${cp.checkpointId}/retentions`,
      f.alice,
      { days: 7, expectedTaskRevision: task.revision, confirmLocalRetention: true },
    );
    assert.equal(retained.statusCode, 201, retained.body);
    const retentionId = retained.json().request.id;
    await localRetentionOperation(
      home,
      retentionId,
      'retain',
      async () => `RETAIN ${commit} 7`,
      () => {},
    );
    const preview = (await f.api.call(p.path + '/discard-preview', f.alice)).json();
    const discarded = await f.api.call(p.path + '/discard-preserving', f.alice, {
      expectedRevision: preview.branch.revision,
      expectedTaskRevision: preview.taskRevision,
      confirmPreserveWorkspace: true,
      confirmExecutionContinues: true,
    });
    assert.equal(discarded.statusCode, 200, discarded.body);
    const selection = {
      branchId: p.branch.id,
      expectedRevision: (await f.read()).branches[0]!.revision,
      expectedTaskRevision: task.revision,
      retentionId,
    };
    return { ...f, p, c, home, commit, selection, yes: async () => `CHECK_BRANCH ${p.branch.id}` };
  } catch (error) {
    await f.close();
    throw error;
  }
}
