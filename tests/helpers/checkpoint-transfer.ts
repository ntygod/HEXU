import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { retentionFixture, git } from './checkpoint-retention.js';
import { localRetentionOperation } from '../../apps/runner/src/agent/checkpoint-retention.js';
import { authorizeDirectories } from '../../apps/runner/src/agent/workspaces.js';
import { writeCredentials } from '../../apps/runner/src/agent/storage.js';
import { CheckpointTransferStore } from '../../packages/db/src/checkpoint-transfer.js';
import type {
  TransferView,
  TransferAction,
} from '../../packages/contracts/src/checkpoint-transfer.js';
import { nodeRequest } from '../../apps/runner/src/agent/connection.js';
import { localTransfer } from '../../apps/runner/src/agent/checkpoint-transfer.js';
export const silent = () => {};
export const noAsk = async () => {
  throw new Error('Must not repeat consent or capture');
};
export async function transferFixture(
  format: 'sha1' | 'sha256' = 'sha1',
  external = false,
  blob?: Buffer,
) {
  const f = await retentionFixture(format, external, blob);
  try {
    const bob = await f.api.joinAccount((await f.api.invite(f.alice)).token);
    f.api.store.as({ user: f.alice.user, spaceId: f.alice.spaceId }, () =>
      f.api.store.collaboration.setProjectMember(f.project.id, bob.user.id, 'edit', randomUUID()),
    );
    const receiverHome = join(f.dir, 'receiver-state'),
      receiverRoot = join(f.dir, 'receiver-repo');
    await mkdir(receiverHome, { mode: 0o700 });
    await mkdir(receiverRoot);
    git(receiverRoot, 'init', '-q');
    await writeFile(join(receiverRoot, 'untouched.txt'), 'Recipient private working data');
    const [w] = await authorizeDirectories(
      [{ name: '接收方私有现场', path: receiverRoot }],
      receiverHome,
    );
    const pairing = f.api.store.as({ user: bob.user, spaceId: bob.spaceId }, () =>
      f.registry.createPairing(f.project.id, randomUUID()),
    );
    const token = randomBytes(32).toString('base64url'),
      clientId = randomUUID();
    const receiver = f.registry.pair({
      code: pairing.code!,
      nodeToken: token,
      clientId,
      projectId: f.project.id,
      name: '接收节点',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: w!.id, name: w!.name }],
    });
    const receiverCredentials = {
      ...f.credentials,
      nodeId: receiver.nodeId,
      clientId,
      nodeToken: token,
      name: '接收节点',
      directories: [w!],
    };
    writeCredentials(receiverHome, receiverCredentials);
    await localRetentionOperation(
      f.home,
      f.first.request.id,
      'retain',
      async () => `RETAIN ${f.oid} 7`,
      silent,
    );
    const path = `${f.path}/${f.first.request.id}/transfers`;
    const body = { targetNodeId: receiver.nodeId, expectedTaskRevision: 1, confirmTransfer: true };
    const create = async (key = randomUUID()) => {
      const r = await f.api.call(path, f.alice, body, key);
      assert.equal(r.statusCode, 201, r.body);
      return r.json() as TransferView;
    };
    const view = await create(),
      id = view.ticket.id;
    const call = (packet: TransferAction, sender = false) =>
      nodeRequest(
        f.credentials.controlUrl,
        'checkpoint-transfer',
        packet,
        sender ? f.token : token,
      );
    const accept = () =>
      localTransfer(receiverHome, id, 'accept', async () => `RECEIVE ${id}`, silent);
    const send = () => localTransfer(f.home, id, 'send', async () => `SEND ${id}`, silent);
    const receive = () => localTransfer(receiverHome, id, 'receive', noAsk, silent);
    const read = async () => (await f.api.call(path, f.alice)).json().items as TransferView[];
    return {
      ...f,
      bob,
      receiverHome,
      receiverRoot,
      receiver,
      receiverCredentials,
      receiverToken: token,
      transferPath: path,
      transferBody: body,
      transferView: view,
      id,
      call,
      accept,
      send,
      receive,
      readTransfers: read,
      createTransfer: create,
      transfers: new CheckpointTransferStore(f.api.store),
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
