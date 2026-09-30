import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  objectHash,
  verifySnapshot,
  type SnapshotObject,
} from '../../apps/runner/src/agent/checkpoint-objects.js';
import { CheckpointStore } from '../../packages/db/src/checkpoints.js';
import type { branchResultFixture } from './branch-results.js';

export async function codeSnapshot(
  files: { name: string; text?: string; data?: Buffer; mode?: string }[],
  objectFormat: 'sha1' | 'sha256' = 'sha1',
) {
  const objects = new Map<string, SnapshotObject>();
  const put = (type: SnapshotObject['type'], data: Buffer) => {
    const id = objectHash(objectFormat, type, data);
    objects.set(id, { id, type, data });
    return id;
  };
  const tree = put(
    'tree',
    Buffer.concat(
      files.map((file) => {
        const oid = put('blob', file.data ?? Buffer.from(file.text ?? ''));
        return Buffer.concat([
          Buffer.from(`${file.mode ?? '100644'} ${file.name}\0`),
          Buffer.from(oid, 'hex'),
        ]);
      }),
    ),
  );
  const commit = put('commit', Buffer.from(`tree ${tree}\n\ncode difference fixture\n`));
  return {
    objectFormat,
    commit,
    tree,
    ...(await verifySnapshot(objectFormat, commit, tree, async (id) => objects.get(id)!.data)),
  };
}
export async function recordResultCode(
  f: Awaited<ReturnType<typeof branchResultFixture>>,
  snapshot: { commit: string; tree: string; objectFormat: 'sha1' | 'sha256' },
  index = 0,
) {
  const cp = new CheckpointStore(f.api.store),
    node = f.ns[index]!;
  const request = f.as(() =>
    cp.create(
      f.task.id,
      {
        nodeId: node.nodeId,
        workspaceId: node.workspace,
        commit: snapshot.commit,
        label: '本轮代码提交',
        expectedTaskRevision: f.api.store.getTask(f.task.id).revision,
        confirmReference: true,
      },
      randomUUID(),
    ),
  );
  const at = new Date().toISOString();
  return cp.publish(node.token, {
    requestId: request.id,
    requestHash: request.requestHash,
    confirmPublication: true,
    manifest: {
      version: 1,
      kind: 'git_commit_reference',
      objectFormat: snapshot.objectFormat,
      commit: snapshot.commit,
      tree: snapshot.tree,
      repositoryIdentity: 'c'.repeat(64),
      verifiedAt: at,
      verifiedObjects: 'commit_and_root_tree',
      availability: 'local_reference',
      workingCopy: { ...node.summary, capturedAt: at },
    },
  });
}
export async function saveResultCode(
  f: Awaited<ReturnType<typeof branchResultFixture>>,
  checkpointId: string,
) {
  const body = { ...(await f.draft()), codeCheckpointId: checkpointId };
  const reply = await f.api.call(f.path() + '/results', f.alice, body);
  assert.equal(reply.statusCode, 201, reply.body);
  const saved = reply.json() as { resultId: string; revisionId: string };
  return {
    ...saved,
    body,
    detail: (await f.api.call(`results/${saved.resultId}`, f.alice)).json(),
  };
}
