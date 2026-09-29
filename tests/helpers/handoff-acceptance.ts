import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HandoffView } from '../../packages/contracts/src/handoffs.js';
import type {
  HandoffAcceptance,
  HandoffAcceptancePreview,
} from '../../packages/contracts/src/handoff-acceptance.js';
import { localRestoreCheckpoint } from '../../apps/runner/src/agent/checkpoint-restore.js';
import { acceptLocalHandoff } from '../../apps/runner/src/agent/handoff-acceptance.js';
import { transferFixture, silent } from './checkpoint-transfer.js';

export async function handoffAcceptanceFixture(
  requestOwner = false,
  restore = true,
  format: 'sha1' | 'sha256' = 'sha1',
) {
  const f = await transferFixture(format);
  try {
    await f.accept();
    await f.send();
    await f.receive();
    const target = join(f.dir, 'handoff-restored');
    if (restore) {
      const p = await localRestoreCheckpoint(
        f.receiverHome,
        f.id,
        target,
        async (prompt) => /(?:RESTORE|PUBLISH) [0-9a-f-]{36}/.exec(prompt)![0],
        { sourceKind: 'transfer', log: silent },
      );
      assert.equal(p.state, 'restored');
    }
    const offers = `tasks/${f.task.id}/handoffs`;
    const offered = await f.api.call(offers, f.alice, {
      transferId: f.id,
      transferHash: f.transferView.ticket.requestHash,
      expectedTaskRevision: 1,
      summary: '继续实现接口',
      remainingWork: '校对异常返回',
      environment: '使用自己的测试账号',
      hours: 24,
      ...(requestOwner ? { transferOwner: true } : {}),
    });
    assert.equal(offered.statusCode, 201, offered.body);
    const h = (offered.json() as HandoffView).handoff,
      path = `${offers}/${h.id}`;
    const start = async (transferOwner = false, key = randomUUID()) => {
      const p = await f.api.call(path + '/acceptance-preview', f.bob);
      assert.equal(p.statusCode, 200, p.body);
      const preview = p.json() as HandoffAcceptancePreview;
      const body = {
        expectedHandoffRevision: preview.handoffRevision,
        expectedTaskRevision: preview.taskRevision,
        contextHash: preview.contextHash,
        transferOwner,
      };
      const r = await f.api.call(path + '/accept', f.bob, body, key);
      assert.equal(r.statusCode, 202, r.body);
      return { op: r.json() as HandoffAcceptance, body, key };
    };
    const confirm = (
      op: HandoffAcceptance,
      ask = async (prompt: string) => /ACCEPT [0-9a-f-]{36}/.exec(prompt)![0],
    ) => acceptLocalHandoff(f.receiverHome, op.ticket.id, target, ask, { log: silent });
    return { ...f, target, handoff: h, handoffPath: path, start, confirm };
  } catch (e) {
    await f.close();
    throw e;
  }
}
