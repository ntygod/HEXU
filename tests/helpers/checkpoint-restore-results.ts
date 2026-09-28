import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retentionFixture } from './checkpoint-retention.js';
import { localRetentionOperation } from '../../apps/runner/src/agent/checkpoint-retention.js';
import { CheckpointRestoreResultStore } from '../../packages/db/src/checkpoint-restore-results.js';
import type { RestoreResultPacket } from '../../packages/contracts/src/checkpoint-restore-results.js';
export const silent = () => {};
export const accept = async (prompt: string) =>
  /(?:RESTORE|PUBLISH|CLEAN|REPORT) [0-9a-f-]{36}/.exec(prompt)![0];
export const noAsk = async () => {
  throw new Error('No recapture, new consent or file operation allowed');
};
export async function restoreResultFixture(format: 'sha1' | 'sha256' = 'sha1') {
  const f = await retentionFixture(format);
  await localRetentionOperation(
    f.home,
    f.first.request.id,
    'retain',
    async () => `RETAIN ${f.oid} 7`,
    silent,
  );
  const source = (await f.read())[0]!;
  const results = new CheckpointRestoreResultStore(f.api.store);
  const as = <T>(fn: () => T) =>
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, fn);
  const list = () =>
    as(() => results.list(f.task.id, f.first.request.checkpointId, f.first.request.id, null));
  // Protocol fixture metadata only; real disk reporting is tested separately.
  const packet = (): RestoreResultPacket => ({
    requestId: f.first.request.id,
    requestHash: f.first.request.requestHash,
    restoreId: randomUUID(),
    sequence: 1,
    confirmPublication: true,
    report: {
      version: 1,
      kind: 'local_restore_observation',
      planHash: 'a'.repeat(64),
      snapshotHash: source.manifest!.snapshotHash,
      state: 'cancelled',
      materialState: 'staging',
      cleanup: 'retained',
      completedFiles: 2,
      writtenBytes: 48,
      totalFiles: 2,
      totalBytes: 48,
      verifiedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
    },
  });
  return { ...f, source, results, as, list, packet, target: join(f.dir, 'restore-target') };
}
