import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fstatSync, lstatSync } from 'node:fs';
import { basename, isAbsolute, resolve, relative, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId, exact } from '../../../../packages/contracts/src/nodes.js';
import { checkpointHash } from '../../../../packages/contracts/src/checkpoints.js';
import { retentionDate } from '../../../../packages/contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import { workspaceClaimRegistryPath } from '../workspace-lease.js';
import { identity, inode, fdPath, type PinnedRestoreParent } from './checkpoint-restore-files.js';

export interface BranchPreservedRelease {
  version: 1;
  kind: 'branch_directory_preservation_settlement';
  outcome: 'preserved' | 'not_moved';
  preservationId: string;
  claimId: string;
  root: string;
  destination: string;
  rootIdentity: string;
  gitIdentity: string;
  evidenceHash: string;
  stoppedConfirmedAt: string;
  observedAt: string;
}
export interface BranchPreservedReceipt extends BranchPreservedRelease {
  releasedAt: string;
}
const invalid = () =>
  new DomainError(
    'BRANCH_PRESERVE_RELEASE_MISMATCH',
    '原移出保留证据、目录身份或占用不一致；保留两处现场和原记录',
    409,
  );
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const hash = (r: BranchPreservedRelease) =>
  createHash('sha256').update(canonicalJson(r)).digest('hex');
export function parseBranchPreservedRelease(input: unknown): BranchPreservedRelease {
  const b = exact(input, [
    'version',
    'kind',
    'outcome',
    'preservationId',
    'claimId',
    'root',
    'destination',
    'rootIdentity',
    'gitIdentity',
    'evidenceHash',
    'stoppedConfirmedAt',
    'observedAt',
  ]);
  if (
    b.version !== 1 ||
    b.kind !== 'branch_directory_preservation_settlement' ||
    !['preserved', 'not_moved'].includes(b.outcome as string) ||
    typeof b.root !== 'string' ||
    typeof b.destination !== 'string' ||
    !isAbsolute(b.root) ||
    resolve(b.root) !== b.root ||
    !isAbsolute(b.destination) ||
    resolve(b.destination) !== b.destination ||
    inside(b.root, b.destination) ||
    inside(b.destination, b.root) ||
    typeof b.rootIdentity !== 'string' ||
    !/^\d+:\d+:\d+$/.test(b.rootIdentity) ||
    typeof b.gitIdentity !== 'string' ||
    !/^\d+:\d+:\d+$/.test(b.gitIdentity)
  )
    throw invalid();
  const id = nodeId(b.preservationId);
  if (b.claimId !== `branch-preserve:${id}`) throw invalid();
  const stoppedConfirmedAt = retentionDate(b.stoppedConfirmedAt),
    observedAt = retentionDate(b.observedAt);
  if (observedAt < stoppedConfirmedAt) throw invalid();
  return {
    version: 1,
    kind: 'branch_directory_preservation_settlement',
    outcome: b.outcome as 'preserved' | 'not_moved',
    preservationId: id,
    claimId: b.claimId,
    root: b.root,
    destination: b.destination,
    rootIdentity: b.rootIdentity,
    gitIdentity: b.gitIdentity,
    evidenceHash: checkpointHash(b.evidenceHash),
    stoppedConfirmedAt,
    observedAt,
  };
}
function registry(r: BranchPreservedRelease) {
  const path = workspaceClaimRegistryPath(r.root);
  if (workspaceClaimRegistryPath(r.destination) !== path) throw invalid();
  return path;
}
function recorded(db: DatabaseSync, r: BranchPreservedRelease): BranchPreservedReceipt | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_receipts'",
      )
      .get()
  )
    return null;
  const row = db
    .prepare('SELECT request_hash,body FROM workspace_release_receipts WHERE recovery_id=?')
    .get(r.preservationId) as { request_hash: string; body: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.body) as BranchPreservedReceipt,
      { releasedAt, ...request } = value;
    if (
      row.request_hash !== hash(r) ||
      canonicalJson(parseBranchPreservedRelease(request)) !== canonicalJson(r) ||
      retentionDate(releasedAt) < r.observedAt
    )
      throw invalid();
    return value;
  } catch {
    throw invalid();
  }
}
/** Read an exact historical receipt before ever inspecting a later directory or writer. */
export function branchPreservedReleaseReceipt(
  input: BranchPreservedRelease,
): BranchPreservedReceipt | null {
  const r = parseBranchPreservedRelease(input);
  let path: string;
  try {
    path = registry(r);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return recorded(db, r);
  } finally {
    db.close();
  }
}
/** The caller holds its original node process guard and has persisted this exact
 * release input. No integration permission is upgraded to a directory move. */
export function releasePreservedBranchClaim(
  input: BranchPreservedRelease,
  source: PinnedRestoreParent,
  destination: PinnedRestoreParent | null,
  root: number,
  git: number,
): BranchPreservedReceipt {
  const r = parseBranchPreservedRelease(input),
    old = branchPreservedReleaseReceipt(r);
  if (old) return old;
  const current = () => {
    source.revalidate();
    if (
      source.observation.path !== r.root ||
      identity(fstatSync(root, { bigint: true })) !== r.rootIdentity ||
      identity(fstatSync(git, { bigint: true })) !== r.gitIdentity ||
      identity(lstatSync(fdPath(root, '.git'), { bigint: true })) !== r.gitIdentity
    )
      throw invalid();
    if (r.outcome === 'preserved') {
      if (!destination || destination.observation.path !== r.destination) throw invalid();
      destination.revalidate();
      if (
        identity(lstatSync(fdPath(destination.fd, basename(r.destination)), { bigint: true })) !==
        r.rootIdentity
      )
        throw invalid();
      try {
        lstatSync(fdPath(source.fd, basename(r.root)));
        throw invalid();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    } else if (
      identity(lstatSync(fdPath(source.fd, basename(r.root)), { bigint: true })) !== r.rootIdentity
    )
      throw invalid();
  };
  const db = new DatabaseSync(registry(r));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    const receipt = recorded(db, r);
    if (receipt) {
      db.exec('COMMIT');
      return receipt;
    }
    current();
    if (Date.parse(r.observedAt) > Date.now()) throw invalid();
    const claimIdentity = inode(fstatSync(root, { bigint: true }));
    const overlapping = (
      db.prepare('SELECT root,dispatch_id,identity FROM claims').all() as {
        root: string;
        dispatch_id: string;
        identity: string;
      }[]
    ).filter(
      (c) =>
        c.identity === claimIdentity ||
        inside(c.root, r.root) ||
        inside(r.root, c.root) ||
        (r.outcome === 'preserved' &&
          (inside(c.root, r.destination) || inside(r.destination, c.root))),
    );
    if (
      overlapping.length !== 1 ||
      overlapping[0]!.root !== r.root ||
      overlapping[0]!.dispatch_id !== r.claimId ||
      overlapping[0]!.identity !== claimIdentity
    )
      throw invalid();
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_release_receipts(recovery_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS workspace_release_immutable_update BEFORE UPDATE ON workspace_release_receipts BEGIN SELECT RAISE(ABORT,'workspace release receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS workspace_release_immutable_delete BEFORE DELETE ON workspace_release_receipts BEGIN SELECT RAISE(ABORT,'workspace release receipts are immutable'); END;`);
    const result = { ...r, releasedAt: new Date().toISOString() };
    db.prepare('INSERT INTO workspace_release_receipts VALUES(?,?,?,?)').run(
      r.preservationId,
      r.claimId,
      hash(r),
      JSON.stringify(result),
    );
    current();
    const removed = db
      .prepare('DELETE FROM claims WHERE root=? AND dispatch_id=? AND identity=?')
      .run(r.root, r.claimId, claimIdentity);
    if (removed.changes !== 1) throw invalid();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    if (cause instanceof DomainError) throw cause;
    throw new DomainError(
      'BRANCH_PRESERVE_RELEASE_UNKNOWN',
      '原占用结算未确认；只核对原持久收据，不推测锁缺失是成功',
      409,
    );
  } finally {
    db.close();
  }
}
