import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CheckpointRetentionStore } from '../../packages/db/src/checkpoint-retention.js';
import { branchResultFixture } from './branch-results.js';

export async function branchCleanupFixture(origin?: string) {
  const f = await branchResultFixture(origin);
  try {
    const retained = new CheckpointRetentionStore(f.api.store),
      checkpoint = f.view.group.start.checkpoint;
    const pending = f.as(() =>
      retained.create(
        f.task.id,
        checkpoint.id,
        { expectedTaskRevision: f.task.revision, days: 7, confirmLocalRetention: true },
        randomUUID(),
      ),
    );
    const at = new Date().toISOString();
    const material = retained.report(f.ns[0]!.token, {
      requestId: pending.request.id,
      requestHash: pending.request.requestHash,
      sequence: 1,
      confirmPublication: true,
      report: {
        state: 'retained',
        observedAt: at,
        manifest: {
          ...f.read().branches[0]!.workspace!.ticket.manifest,
          retainedAt: at,
          expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(),
        },
      },
    });
    const discard = async () => {
      const p = (await f.api.call(f.path() + '/discard-preview', f.alice)).json();
      const r = await f.api.call(f.path() + '/discard-preserving', f.alice, {
        expectedRevision: p.branch.revision,
        expectedTaskRevision: p.taskRevision,
        confirmPreserveWorkspace: true,
        confirmExecutionContinues: true,
      });
      assert.equal(r.statusCode, 200, r.body);
    };
    const selection = () => ({
      branchId: f.view.branches[0]!.id,
      expectedRevision: f.read().branches[0]!.revision,
      expectedTaskRevision: f.as(() => f.api.store.getTask(f.task.id)).revision,
      retentionId: material.request.id,
    });
    return { ...f, material, retained, discard, selection };
  } catch (error) {
    await f.close();
    throw error;
  }
}
