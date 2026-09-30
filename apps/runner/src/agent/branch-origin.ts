import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { constants as F, openSync, closeSync, readFileSync, fstatSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type {
  BranchExecutionBinding,
  BranchWorkspaceTicket,
} from '../../../../packages/contracts/src/work-branch-workspaces.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { RestorePlan } from './checkpoint-restore-journal.js';
import { snapshotEntries } from './checkpoint-restore-plan.js';
import { restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  identity,
  inode,
  PinnedRestoreParent,
  checkOwnedTree,
  readOwnedFile,
  type OwnedRestoreEntry,
  fdPath,
} from './checkpoint-restore-files.js';
import { objectHash, verifySnapshot } from './checkpoint-objects.js';
import type { LocalDirectory } from './workspaces.js';
import type { NodeCredentials, AgentStorage } from './storage.js';
import { restoreBinding } from './checkpoint-restore-preflight.js';
import { verifyBranchContinuationOrigin } from './branch-continuation-origin.js';

export interface BranchOrigin {
  version: 1;
  ticket: BranchWorkspaceTicket;
  plan: RestorePlan;
  restoreId: string;
  rootIdentity: string;
  gitIdentity: string;
  entries: OwnedRestoreEntry[];
}
export const branchOriginHash = (v: unknown) =>
  createHash('sha256').update(canonicalJson(v)).digest('hex');
export function boundBranchNode(storage: AgentStorage, credentials: NodeCredentials) {
  if (!existsSync(join(storage.home, 'branch-origin.json'))) return null;
  const origin = readBranchOrigin(storage.home),
    id = origin.ticket.id;
  const table = storage.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='branch_binding'")
    .get();
  const row =
    table &&
    (storage.db.prepare('SELECT body FROM branch_binding WHERE id=?').get(id) as
      | { body: string }
      | undefined);
  const saved = row && JSON.parse(row.body);
  if (
    !saved ||
    saved.phase !== 'settled' ||
    saved.binding !== restoreBinding(credentials) ||
    saved.result?.state !== 'bound' ||
    saved.result.nodeId !== credentials.nodeId ||
    saved.result.proof?.originHash !== branchOriginHash(origin)
  )
    throw new DomainError(
      'WORK_BRANCH_NOT_BOUND',
      '先完成 branch-bind 原登记回执，再启用此节点执行',
    );
  return {
    operationId: id,
    originHash: branchOriginHash(origin),
    branchId: origin.ticket.branchId,
  };
}
export function readBranchOrigin(home: string, expectedHash?: string): BranchOrigin {
  const path = join(home, 'branch-origin.json');
  restorePrivatePath(path, false);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 32 * 1024 * 1024)
      throw new Error('Unsupported origin file');
    const value = JSON.parse(readFileSync(fd, 'utf8')) as BranchOrigin;
    if (
      value.version !== 1 ||
      !value.ticket ||
      !value.plan ||
      !Array.isArray(value.entries) ||
      value.entries.length > 50000 ||
      (expectedHash && branchOriginHash(value) !== expectedHash)
    )
      throw new DomainError('WORK_BRANCH_ORIGIN_CHANGED', '本机方案起点记录不匹配，未执行');
    return value;
  } finally {
    closeSync(fd);
  }
}
/** Rechecks actual bytes and pinned identities, never relies on status counts or
 * an earlier receipt. The new node owns only this copied origin, no old credentials. */
export async function verifyBranchOrigin(
  home: string,
  c: NodeCredentials,
  directory: LocalDirectory,
  binding: BranchExecutionBinding,
) {
  const origin = readBranchOrigin(home, binding.originHash),
    t = origin.ticket;
  if (
    t.id !== binding.operationId ||
    t.branchId !== binding.branchId ||
    t.groupId !== binding.groupId ||
    t.startHash !== binding.startHash ||
    t.manifest.commit !== binding.commit ||
    t.spaceId !== c.spaceId ||
    t.projectId !== c.projectId ||
    origin.plan.target.path !== directory.root ||
    directory.gitDir !== join(directory.root, '.git')
  )
    throw new DomainError('WORK_BRANCH_ORIGIN_CHANGED', '方案、共同起点与本机目录绑定不一致');
  if (binding.continueFrom) {
    await verifyBranchContinuationOrigin(home, c, directory, origin, binding.continueFrom);
    return origin;
  }
  const parent = new PinnedRestoreParent(origin.plan.target);
  let root: number | undefined, git: number | undefined;
  try {
    root = parent.openStage(basename(directory.root), origin.rootIdentity);
    if (inode(fstatSync(root)) !== directory.rootIdentity) throw new Error('Root identity changed');
    const owned = new Map(origin.entries.map((e) => [e.path, e]));
    checkOwnedTree(root, owned, { name: '.git', identity: origin.gitIdentity });
    if (owned.size !== origin.plan.entries.length) throw new Error('Inventory mismatch');
    for (const e of origin.plan.entries) {
      const row = owned.get(e.path);
      if (!row || row.kind !== e.kind) throw new Error('Inventory mismatch');
      if (
        e.kind === 'file' &&
        objectHash(t.manifest.objectFormat, 'blob', readOwnedFile(root, row, owned, e.bytes)) !==
          e.objectId
      )
        throw new DomainError(
          'WORK_BRANCH_FILES_CHANGED',
          '方案首轮前代码已有变化，未从不同起点执行',
        );
    }
    git = openSync(fdPath(root, '.git'), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    if (
      identity(fstatSync(git, { bigint: true })) !== origin.gitIdentity ||
      inode(fstatSync(git)) !== directory.gitIdentity
    )
      throw new Error('Git identity changed');
    const metadataBytes = (name: string, max: number) => {
      const parts = name.split('/'),
        opened: number[] = [];
      let parent = git!;
      try {
        for (const part of parts.slice(0, -1)) {
          parent = openSync(fdPath(parent, part), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
          opened.push(parent);
        }
        const file = openSync(
          fdPath(parent, parts.at(-1)!),
          F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK,
        );
        opened.push(file);
        const s = fstatSync(file);
        if (!s.isFile() || s.size > max || s.nlink !== 1) throw new Error('Git metadata changed');
        return readFileSync(file);
      } finally {
        for (const fd of opened.reverse()) closeSync(fd);
      }
    };
    const head = metadataBytes('HEAD', 200).toString('utf8');
    if (
      head !== binding.commit + '\n' &&
      (head !== 'ref: refs/heads/work\n' ||
        metadataBytes('refs/heads/work', 100).toString('utf8') !== binding.commit + '\n')
    )
      throw new DomainError('WORK_BRANCH_HEAD_CHANGED', '当前Git起点已变化，未启动方案');
    const snapshot = await verifySnapshot(
      t.manifest.objectFormat,
      binding.commit,
      t.manifest.tree,
      async (id, type, max) => {
        const raw = inflateSync(
          metadataBytes(`objects/${id.slice(0, 2)}/${id.slice(2)}`, max + 65536),
          { maxOutputLength: max + 100 },
        );
        const zero = raw.indexOf(0),
          data = raw.subarray(zero + 1);
        if (
          zero < 0 ||
          raw.subarray(0, zero).toString() !== `${type} ${data.length}` ||
          data.length > max ||
          objectHash(t.manifest.objectFormat, type, data) !== id
        )
          throw new Error('Object changed');
        return data;
      },
    );
    if (snapshot.snapshotHash !== t.manifest.snapshotHash) throw new Error('Snapshot changed');
    const actual = snapshotEntries(
      t.manifest.objectFormat,
      t.manifest.tree,
      snapshot,
      directory.root,
    );
    if (canonicalJson(actual.entries) !== canonicalJson(origin.plan.entries))
      throw new DomainError('WORK_BRANCH_PLAN_CHANGED', '本机文件清单与共同提交的实际Git树不一致');
    parent.revalidate();
    checkOwnedTree(root, owned, { name: '.git', identity: origin.gitIdentity });
    return origin;
  } finally {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
    parent.close();
  }
}
