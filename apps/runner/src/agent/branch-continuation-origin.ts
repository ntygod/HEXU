import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { BranchContinuationBinding } from '../../../../packages/contracts/src/work-branch-workspaces.js';
import { PinnedRestoreParent, identity } from './checkpoint-restore-files.js';
import { verifyCleanCommit } from './committed-workspace.js';
import type { BranchOrigin } from './branch-origin.js';
import type { LocalDirectory } from './workspaces.js';
import type { NodeCredentials } from './storage.js';
import { lstatSync } from 'node:fs';

/** Continuation still requires its original bound parent and Git directory. */
export async function verifyBranchContinuationOrigin(
  home: string,
  credentials: NodeCredentials,
  directory: LocalDirectory,
  origin: BranchOrigin,
  from: BranchContinuationBinding,
) {
  const parent = new PinnedRestoreParent(origin.plan.target);
  try {
    if (
      identity(lstatSync(directory.root, { bigint: true })) !== origin.rootIdentity ||
      identity(lstatSync(directory.gitDir, { bigint: true })) !== origin.gitIdentity
    )
      throw new Error('Origin changed');
    await verifyCleanCommit(home, credentials, directory, from.code);
    parent.revalidate();
  } catch {
    throw new DomainError(
      'BRANCH_SELECTED_CODE_CHANGED',
      '当前目录、HEAD或文件与所选提交不一致；保留现场，请先明确处理本机修改再继续',
      409,
    );
  } finally {
    parent.close();
  }
}
