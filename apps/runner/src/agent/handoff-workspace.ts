import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { HandoffAcceptance } from '../../../../packages/contracts/src/handoff-acceptance.js';
import { readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { validateHandoffAcceptanceReply } from './handoff-acceptance.js';
import { prepareRestoredGitWorkspace, assertRestoredGitSettled } from './restored-git-workspace.js';
export {
  readGitWorkspaceProgress,
  cleanupRestoredGitWorkspace as cleanupHandoffWorkspace,
} from './restored-git-workspace.js';
export type { GitWorkspaceProgress } from './restored-git-workspace.js';
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
function localAcceptance(
  home: string,
  id: string,
  target: string,
  binding: string,
  op: HandoffAcceptance,
) {
  const dir = join(home, 'handoff-acceptances'),
    file = join(dir, 'journal.sqlite');
  restorePrivatePath(dir, true);
  restorePrivatePath(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM handoff_confirmations WHERE id=?').get(id) as
      | {
          binding: string;
          target: string;
          phase: string;
          packet: string | null;
          request_hash: string;
          workspace_ref: string;
        }
      | undefined;
    if (
      !row ||
      row.phase !== 'settled' ||
      !row.packet ||
      row.binding !== binding ||
      row.target !== target ||
      row.request_hash !== op.ticket.requestHash ||
      row.workspace_ref !== op.proof?.workspaceRef ||
      digest(JSON.parse(row.packet)) !== op.proofHash
    )
      throw new DomainError(
        'WORKSPACE_SOURCE_MISMATCH',
        '需原接收者已确认回执的同一接手目录，不重放接受或导入其他现场',
      );
  } finally {
    db.close();
  }
}

export function assertGitWorkspaceSettled(home: string) {
  assertRestoredGitSettled(home);
  assertRestoredGitSettled(home, 'branch-workspaces');
}
export async function prepareHandoffWorkspace(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  home = resolve(home);
  return prepareRestoredGitWorkspace(
    home,
    id,
    target,
    ask,
    async () => {
      const c = readCredentials(home);
      const op = validateHandoffAcceptanceReply(
        await nodeRequest<HandoffAcceptance>(
          c.controlUrl,
          'handoff-acceptance',
          { action: 'workspace-source', operationId: id },
          c.nodeToken,
        ),
        id,
      );
      if (
        op.state !== 'succeeded' ||
        op.ticket.nodeId !== c.nodeId ||
        op.ticket.projectId !== c.projectId ||
        op.ticket.spaceId !== c.spaceId ||
        !op.proof
      )
        throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '当前身份不是原已接受的接手来源');
      localAcceptance(home, id, target, restoreBinding(c), op);
      return {
        sourceKind: 'transfer',
        sourceId: op.ticket.transferId,
        ownerId: op.ticket.recipientId,
        commit: op.snapshot.material.commit,
        snapshotHash: op.ticket.snapshotHash,
        restoreId: op.proof.restoreId,
        planHash: op.proof.planHash,
        nodeName: `接手现场 ${id.slice(0, 8)}`,
        workspaceName: '接手代码',
      };
    },
    'handoff-workspaces',
    log,
  );
}
