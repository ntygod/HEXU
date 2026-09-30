import assert from 'node:assert/strict';
import { branchResultFixture } from './branch-results.js';
import { codeSnapshot, recordResultCode, saveResultCode } from './result-code.js';
import type { teamFixture, Account } from './team.js';
import type { BranchContinuationPreview } from '../../packages/contracts/src/work-branch-workspaces.js';
import type { NodeExecutionOption } from '../../packages/contracts/src/node-execution.js';

export async function branchContinuationBody(
  api: Awaited<ReturnType<typeof teamFixture>>,
  account: Account,
  taskId: string,
  branchId: string,
  prompt = 'CONTINUED_PROMPT_ONLY',
) {
  const reply = await api.call(
    `tasks/${taskId}/node-options?workBranchId=${branchId}&continueSelected=true`,
    account,
  );
  assert.equal(reply.statusCode, 200, reply.body);
  const options = reply.json() as {
    items: NodeExecutionOption[];
    branchContinuation: BranchContinuationPreview;
    taskRevision: number;
    taskContextHash: string;
    taskStatus: string;
  };
  const p = options.branchContinuation,
    option = options.items.find((n) => n.nodeId === p.nodeId)!;
  assert(option?.available, option?.reason);
  return {
    provider: 'node',
    nodeId: p.nodeId,
    workingCopyId: p.workingCopyId,
    policyHash: option.policyHash,
    mode: 'edit',
    prompt,
    expectedRevision: options.taskRevision,
    expectedTaskContextHash: options.taskContextHash,
    reopenTask: options.taskStatus === 'done',
    confirmExecution: true,
    workBranch: p.selection,
  };
}
export async function branchContinuationFixture(
  origin?: string,
  peerActive = false,
  format: 'sha1' | 'sha256' = 'sha1',
) {
  const base = await codeSnapshot([{ name: 'README.md', text: 'BASE' }], format);
  const f = await branchResultFixture(origin, base);
  try {
    const source = f.begin();
    source.start();
    source.send('output', 'UNSELECTED_RUN_OUTPUT');
    source.finish();
    const target = await codeSnapshot([{ name: 'README.md', text: 'SELECTED_COMMIT' }], format);
    const cp = await recordResultCode(f, {
      objectFormat: format,
      commit: target.commit,
      tree: target.tree,
    });
    const saved = await saveResultCode(f, cp.checkpointId);
    const choicePath = `tasks/${f.task.id}/work-branches/groups/${f.view.group.id}/selection`;
    const choice = {
      expectedSelectionRevision: 0,
      branchId: f.view.branches[0]!.id,
      resultRevisionId: saved.revisionId,
      note: '',
    };
    const r = await f.api.call(choicePath, f.alice, choice);
    assert.equal(r.statusCode, 200, r.body);
    const peer = peerActive ? f.begin(1, 'codex') : null;
    peer?.start();
    const protocol = async (index: number, path: string, body: unknown) => {
      const reply = await f.api.app.inject({
        method: 'POST',
        url: '/runner/v1/' + path,
        headers: { 'x-hexu-runner': '1', authorization: `Bearer ${f.ns[index]!.token}` },
        payload: body as Record<string, unknown>,
      });
      assert.equal(reply.statusCode, 200, reply.body);
      return reply.json();
    };
    // Use the actual API instance's connection epoch, not the direct-store fixture registry.
    for (const [i, n] of f.ns.entries()) {
      await protocol(i, 'hello', { protocol: 1, connectionId: n.connection });
      const row = f.api.store.db
        .prepare('SELECT body FROM node_execution_policies WHERE node_id=?')
        .get(n.nodeId) as { body: string } | undefined;
      if (row)
        await protocol(i, 'execution-policy', {
          connectionId: n.connection,
          policy: JSON.parse(row.body),
        });
    }
    const body = () => branchContinuationBody(f.api, f.alice, f.task.id, f.view.branches[0]!.id);
    return { ...f, source, base, target, saved, choice, choicePath, body, protocol, peer };
  } catch (e) {
    await f.close();
    throw e;
  }
}
